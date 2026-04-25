// mtf.js - improved MTF evaluator
// - evaluates on root_signal and root_created immediately
// - re-evaluates when MACD buckets become ready (macd_ready / macd_prev_result)
// - robust flip detection consistent with scanner (eps + threshold)
// - detailed debug logs for per-TF decisions

const { info, debug } = require('./logger');
const cfg = require('./config');
const { MTF_TFS = [], MTF_CHECK_ON_5M = true, OPEN_TRADES } = cfg;

class MTF {
  constructor(scanner, trader = null) {
    this.scanner = scanner;
    this.trader = trader;

    // Evaluate immediately when a root is created or signalled
    this.scanner.on('root_signal', (root) => {
      try { this.evaluateAlignment(root).catch(e => debug('mtf root_signal err', e && e.message ? e.message : e)); }
      catch (e) { debug('mtf root_signal handler error', e && e.message ? e.message : e); }
    });
    this.scanner.on('root_created', ({ sig }) => {
      try { this.evaluateAlignment(sig).catch(e => debug('mtf root_created err', e && e.message ? e.message : e)); }
      catch (e) { debug('mtf root_created handler error', e && e.message ? e.message : e); }
    });

    // When MACD for a (symbol,tf) becomes ready or prev-result arrives, re-evaluate any active roots for that symbol.
    this.scanner.on('macd_ready', ({ symbol, tf }) => {
      try {
        this._onMacdReady(symbol, tf).catch(e => debug('mtf macd_ready err', e && e.message ? e.message : e));
      } catch (e) { debug('mtf macd_ready handler error', e && e.message ? e.message : e); }
    });
    this.scanner.on('macd_prev_result', ({ symbol, tf, macdPrevResult }) => {
      try {
        this._onMacdPrevResult(symbol, tf, macdPrevResult).catch(e => debug('mtf macd_prev_result err', e && e.message ? e.message : e));
      } catch (e) { debug('mtf macd_prev_result handler error', e && e.message ? e.message : e); }
    });

    // Also evaluate on 5m candle open if configured (alignment may change)
    this.scanner.on('candle_open', (c) => {
      if (!MTF_CHECK_ON_5M) return;
      if (String(c.tf) !== '5') return;
      try {
        const active = this.scanner.getActiveRootSignals();
        if (!active || active.length === 0) return;
        for (const root of active) {
          this.evaluateAlignment(root).catch(e => debug('mtf onCandle err', e && e.message ? e.message : e));
        }
      } catch (e) { debug('mtf onCandle handler error', e && e.message ? e.message : e); }
    });

    info('MTF initialized (checkOn5m=' + !!MTF_CHECK_ON_5M + ', tfs=' + JSON.stringify(MTF_TFS) + ')');
  }

  // When a MACD bucket becomes ready for a symbol/tf, evaluate any active roots for that symbol.
  async _onMacdReady(symbol, tf) {
    if (!symbol) return;
    if (!MTF_TFS || !MTF_TFS.includes(tf)) {
      debug('mtf: macd_ready for TF not in MTF_TFS, skipping', { symbol, tf });
      return;
    }
    const roots = this.scanner.getActiveRootSignals().filter(r => r.symbol === symbol);
    if (!roots || roots.length === 0) {
      debug('mtf: macd_ready but no active roots for symbol', symbol, tf);
      return;
    }
    debug('mtf: macd_ready triggering evaluate for', symbol, tf, 'rootsCount', roots.length);
    for (const r of roots) {
      await this.evaluateAlignment(r).catch(e => debug('mtf evaluateAlignment on macd_ready error', e && e.message ? e.message : e));
    }
  }

  // When scanner emits macd_prev_result for a symbol/tf, re-evaluate roots for that symbol.
  async _onMacdPrevResult(symbol, tf, macdPrevResult) {
    if (!symbol) return;
    if (!MTF_TFS || !MTF_TFS.includes(tf)) {
      // still useful to log but skip heavy evaluation
      debug('mtf: macd_prev_result TF not in MTF_TFS, ignored', { symbol, tf });
      return;
    }
    const roots = this.scanner.getActiveRootSignals().filter(r => r.symbol === symbol);
    if (!roots || roots.length === 0) return;
    debug('mtf: macd_prev_result triggering evaluate for', symbol, tf, 'rootsCount', roots.length, 'macdPrevResult', macdPrevResult);
    for (const r of roots) {
      await this.evaluateAlignment(r).catch(e => debug('mtf evaluateAlignment on macd_prev_result error', e && e.message ? e.message : e));
    }
  }

  // Main evaluation logic per root
  async evaluateAlignment(root) {
    if (!root || !root.symbol) return;
    const symbol = String(root.symbol).toUpperCase();
    const sdata = this.scanner.getSymbolStatus(symbol);
    if (!sdata) {
      debug('mtf: no symbol data for', symbol);
      return;
    }

    const tfs = Array.isArray(MTF_TFS) ? MTF_TFS : [];
    const positives = [];
    const negatives = [];
    let cumulativeStrength = 0;

    for (const tf of tfs) {
      const st = sdata[tf];
      if (!st || !st.macd) {
        negatives.push({ tf, hist: null, reason: 'no_macd' });
        continue;
      }

      let hist = null;
      let prevHist = null;
      try {
        // Prefer stored fields on MACD
        hist = typeof st.macd.hist !== 'undefined' ? st.macd.hist : (st.macd.get ? st.macd.get('hist') : null);
        prevHist = typeof st.macd.prevHist !== 'undefined' ? st.macd.prevHist : (st.macd.get ? st.macd.get('prevHist') : null);
      } catch (e) {
        debug('mtf: error reading MACD fields', { symbol, tf, e: e && e.message ? e.message : e });
      }

      const threshold = cfg.MACD_HIST_POSITIVE_THRESHOLD ?? 0;
      const eps = Number(process.env.MACD_EPS || 1e-6);

      debug('mtf per-tf', { symbol, rootId: root.id, tf, hist, prevHist, threshold, eps, macdReady: !!st.macdReady });

      // Determine hasFlip robustly (same logic as scanner)
      let hasFlip = false;
      if (typeof prevHist === 'number' && typeof hist === 'number') {
        if (prevHist < -eps && hist > eps) hasFlip = true;
        else if (prevHist < threshold && hist >= threshold) hasFlip = true;
        else if (prevHist < 0 && hist >= 0) hasFlip = true;
      }

      // If prevHist missing but hist strongly positive and macdReady is true, treat as positive (no flip)
      const isPositiveNow = (typeof hist === 'number' && hist > eps) || (typeof hist === 'number' && hist >= threshold);
      if ((hist != null && (hist > 0 || hasFlip)) || (st.macdReady && isPositiveNow)) {
        positives.push({ tf, hist, prevHist, hasFlip });
        cumulativeStrength += Math.max(0, Number(hist) || 0);
      } else {
        negatives.push({ tf, hist, prevHist, hasFlip });
      }
    }

    // Determine summary status
    let status = 'partial';
    if (negatives.length === 0) status = 'all_positive';
    else if (negatives.length === 1 && String(negatives[0].tf) === 'D') {
      const stD = sdata['D'];
      if (stD && stD.macd) {
        const dhist = typeof stD.macd.hist !== 'undefined' ? stD.macd.hist : (stD.macd.get ? stD.macd.get('hist') : null);
        const dprev = typeof stD.macd.prevHist !== 'undefined' ? stD.macd.prevHist : (stD.macd.get ? stD.macd.get('prevHist') : null);
        if (dhist != null && dprev != null && dhist > dprev) status = 'daily_rising';
      }
    }

    const mtfInfo = {
      status,
      positives,
      negatives,
      cumulativeStrength,
      evaluatedAt: Date.now()
    };

    debug('mtf evaluated', { symbol, rootId: root.id, mtfInfo });

    try {
      const updated = this.scanner.updateRootMTF(root.id, mtfInfo);
      if (!updated) debug('mtf: updateRootMTF returned null for', root.id, symbol);
      else info('mtf: updated root', root.id, symbol, 'status', mtfInfo.status);
    } catch (err) {
      debug('mtf updateRootMTF error', err && err.message ? err.message : err);
    }

    // Optional: open trades if all_positive and OPEN_TRADES set
    if (status === 'all_positive' && OPEN_TRADES && this.trader) {
      try {
        const balanceResp = await this.trader.rest.getWalletBalance();
        const bal = Number(balanceResp?.result?.list?.[0]?.wallet_balance || balanceResp?.result?.USDT?.equity || 0);
        const amountUsd = this.trader.positionSizeFromBalance(bal, this.trader.openTrades.length + 1);
        await this.trader.openTrade(symbol, 'Buy', amountUsd);
        info('mtf: opened trade', { symbol, amountUsd });
      } catch (err) {
        debug('mtf openTrade error', err && err.message ? err.message : err);
      }
    }
  }
}

module.exports = MTF;