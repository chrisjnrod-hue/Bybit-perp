// mtf.js (updated) - now updates scanner root MTF status instead of sending telegrams directly.
// Improvements:
// - Subscribes to both 5m 'candle_open' and 'root_signal' so MTF evaluates promptly.
// - Normalizes symbol casing and guards access to MACD internals.
// - Adds debug/info logs with MACD hist/prevHist to help diagnose missing updates.
const { info, debug } = require('./logger');
const { MTF_TFS, MTF_CHECK_ON_5M, OPEN_TRADES } = require('./config');

class MTF {
  constructor(scanner, trader = null) {
    this.scanner = scanner;
    this.trader = trader;

    // Evaluate on 5m candle opens
    this.scanner.on('candle_open', (c) => this.onCandle(c));

    // Also evaluate when a new root is created so we don't rely only on the next 5m candle
    this.scanner.on('root_signal', (root) => {
      try {
        // Evaluate alignment for this single root immediately (non-blocking)
        this.evaluateAlignment(root).catch(err => debug('mtf root_signal evaluate error', err && err.message ? err.message : err));
      } catch (e) {
        debug('mtf root_signal handler error', e && e.message ? e.message : e);
      }
    });

    info('MTF initialized (checkOn5m=' + !!MTF_CHECK_ON_5M + ')');
  }

  async onCandle({ symbol, tf, start }) {
    try {
      if (!MTF_CHECK_ON_5M) return;
      // normalize tf to string and compare
      if (String(tf) !== '5') return;
      const active = this.scanner.getActiveRootSignals();
      if (!active || active.length === 0) return;
      // iterate active roots and evaluate alignment
      for (const root of active) {
        // avoid blocking the candle handler too long
        this.evaluateAlignment(root).catch(err => debug('mtf evaluateAlignment error', err && err.message ? err.message : err));
      }
    } catch (err) {
      debug('mtf onCandle error', err && err.message ? err.message : err);
    }
  }

  async evaluateAlignment(root) {
    if (!root || !root.symbol) return;
    const symbol = String(root.symbol).toUpperCase();
    const sdata = this.scanner.symbolData && this.scanner.symbolData[symbol];
    if (!sdata) {
      debug('mtf: no symbol data for', symbol);
      return;
    }

    const tfs = Array.isArray(MTF_TFS) ? MTF_TFS : [];
    const positives = [];
    const negatives = [];
    let cumulativeStrength = 0;

    // Read MACD values for each TF
    for (const tf of tfs) {
      const st = sdata[tf];
      if (!st || !st.macd) {
        negatives.push({ tf, hist: null, reason: 'no_macd' });
        continue;
      }

      // Read hist/prevHist safely (MACD implementation may expose these)
      const hist = (typeof st.macd.hist !== 'undefined') ? st.macd.hist : (st.macd.get ? st.macd.get('hist') : undefined);
      const prevHist = (typeof st.macd.prevHist !== 'undefined') ? st.macd.prevHist : (st.macd.get ? st.macd.get('prevHist') : undefined);

      // log what we found for diagnostics
      debug('mtf read macd', { symbol, tf, hist, prevHist });

      // determine flip on this TF (prevHist not null/undefined and negative, hist >= 0)
      const hasFlip = (prevHist != null) && (prevHist < 0) && (hist != null) && (hist >= 0);

      // treat hist presence cautiously: require hist != null (not null/undefined)
      if (hist != null && (hist > 0 || hasFlip)) {
        positives.push({ tf, hist, hasFlip });
        cumulativeStrength += Math.max(0, Number(hist) || 0);
      } else {
        negatives.push({ tf, hist });
      }
    }

    // Build mtf status
    let status = 'partial';
    if (negatives.length === 0) status = 'all_positive';
    else if (negatives.length === 1 && String(negatives[0].tf) === 'D') {
      // special case: daily rising
      const stD = sdata['D'];
      if (stD && stD.macd) {
        const dhist = (typeof stD.macd.hist !== 'undefined') ? stD.macd.hist : (stD.macd.get ? stD.macd.get('hist') : undefined);
        const dprev = (typeof stD.macd.prevHist !== 'undefined') ? stD.macd.prevHist : (stD.macd.get ? stD.macd.get('prevHist') : undefined);
        if (dhist != null && dprev != null && dhist > dprev) {
          status = 'daily_rising';
        }
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

    // Update scanner's root MTF info (this will persist and emit root_updated)
    try {
      const updated = this.scanner.updateRootMTF(root.id, mtfInfo);
      if (!updated) {
        debug('mtf: updateRootMTF returned null for', root.id, symbol);
      } else {
        info('mtf: updated root', root.id, symbol, 'status', mtfInfo.status);
      }
    } catch (err) {
      debug('mtf updateRootMTF error', err && err.message ? err.message : err);
    }

    // Optionally open trades if aligned and OPEN_TRADES set (scanner/trader will handle)
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
