// alerter.js - aggregates root + mtf signals and sends grouped Telegram messages.
const { sendTelegram } = require('./telegram');
const { info, debug } = require('./logger');

class Alerter {
  constructor(scanner, opts = {}) {
    this.scanner = scanner;
    this.debounceMs = opts.debounceMs || 1500;
    this.timer = null;
    this.lastSentText = '';
    this.lastSentSingleId = null;

    this.scanner.on('root_updated', () => this.onUpdate());
    this.scanner.on('root_expired', () => this.onUpdate());
    this.scanner.on('startup', () => this.onUpdate());
    this.scanner.on('root_signal', (sig) => {
      this.onUpdate();
      this.sendSingleRoot(sig).catch(e => debug('sendSingleRoot err', e && e.message ? e.message : e));
    });

    info('Alerter initialized (debounceMs=' + this.debounceMs + ')');
    setImmediate(() => this.onUpdate());
  }

  onUpdate() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sendAggregated(), this.debounceMs);
  }

  buildMessage() {
    const roots = this.scanner.getActiveRootSignals();
    if (!roots || roots.length === 0) return '<b>Bybit perps root summary</b>\nNo active root signals.';
    const byTf = {};
    for (const r of roots) {
      byTf[r.tf] = byTf[r.tf] || [];
      byTf[r.tf].push(r);
    }
    const tfCounts = Object.keys(byTf).map(tf => `${tf}:${byTf[tf].length}`).join(' | ');
    let text = `<b>Bybit perps root summary</b>\n${tfCounts}\n\n`;
    const tfOrder = Object.keys(byTf).sort((a,b) => {
      const an = isNaN(Number(a)) ? 1e6 : Number(a);
      const bn = isNaN(Number(b)) ? 1e6 : Number(b);
      return an - bn;
    });
    for (const tf of tfOrder) {
      const list = byTf[tf];
      text += `<b>${tf} (${list.length})</b>\n`;
      for (const s of list) {
        const mtf = s.mtf || { status: 'pending' };
        const positives = mtf.positives ? mtf.positives.map(p => p.tf).join(',') : '-';
        const negatives = mtf.negatives ? mtf.negatives.map(n => n.tf).join(',') : '-';
        const pct24 = typeof s.pct24 === 'number' ? s.pct24.toFixed(2) : 'n/a';
        const strength = typeof s.strength === 'number' ? s.strength.toFixed(4) : 'n/a';
        text += `${s.symbol} | 24h%: ${pct24} | Strength: ${strength}\nMTF: ${mtf.status} | Pos: ${positives} | Neg: ${negatives}\n\n`;
      }
    }
    return text;
  }

  async sendAggregated() {
    try {
      const text = this.buildMessage();
      if (text === this.lastSentText) { debug('Alerter: aggregated unchanged, skip'); return; }
      this.lastSentText = text;
      const res = await sendTelegram(text);
      info('Alerter: sent aggregated Telegram message', res && res.ok ? 'ok' : res);
    } catch (err) {
      debug('Alerter: sendAggregated err', err && err.message ? err.message : err);
    }
  }

  async sendSingleRoot(sig) {
    if (!sig || !sig.id) return;
    if (this.lastSentSingleId === sig.id) { debug('Alerter: duplicate single suppressed', sig.id); return; }
    this.lastSentSingleId = sig.id;
    const mtf = sig.mtf || { status: 'pending' };
    const pct24 = typeof sig.pct24 === 'number' ? sig.pct24.toFixed(2) : 'n/a';
    const strength = typeof sig.strength === 'number' ? sig.strength.toFixed(4) : 'n/a';
    const msg = `<b>ROOT SIGNAL</b>\n${sig.symbol} | TF: ${sig.tf}\nStrength: ${strength} | 24h%: ${pct24}\nMTF: ${mtf.status}\nStart: ${sig.start}\nID: ${sig.id}`;
    try {
      const res = await sendTelegram(msg);
      info('Alerter: sent single root Telegram message', res && res.ok ? 'ok' : res);
    } catch (err) {
      debug('Alerter: sendSingleRoot error', err && err.message ? err.message : err);
    }
  }
}

module.exports = Alerter;