// mtf.js - simplified multi-timeframe evaluator
const { info, debug } = require('./logger');
const { MTF_TFS = [], MTF_CHECK_ON_5M = true, OPEN_TRADES } = require('./config');

class MTF {
  constructor(scanner, trader = null) {
    this.scanner = scanner;
    this.trader = trader;
    this.scanner.on('root_signal', (r) => this.evaluateAlignment(r).catch(e => debug('mtf root_signal err', e && e.message ? e.message : e)));
    this.scanner.on('candle_open', (c) => {
      if (!MTF_CHECK_ON_5M) return;
      if (String(c.tf) !== '5') return;
      const active = this.scanner.getActiveRootSignals();
      for (const r of active) this.evaluateAlignment(r).catch(e => debug('mtf onCandle err', e && e.message ? e.message : e));
    });
    info('MTF initialized (checkOn5m=' + !!MTF_CHECK_ON_5M + ')');
  }

  async evaluateAlignment(root) {
    if (!root || !root.symbol) return;
    const symbol = String(root.symbol).toUpperCase();
    const sdata = this.scanner.getSymbolStatus(symbol);
    if (!sdata) return;
    const positives = [], negatives = [];
    let cumulativeStrength = 0;
    for (const tf of (Array.isArray(MTF_TFS) ? MTF_TFS : [])) {
      const st = sdata[tf];
      if (!st || !st.macd) { negatives.push({ tf, hist: null }); continue; }
      const hist = (typeof st.macd.hist !== 'undefined') ? st.macd.hist : (st.macd.get ? st.macd.get('hist') : null);
      const prevHist = (typeof st.macd.prevHist !== 'undefined') ? st.macd.prevHist : (st.macd.get ? st.macd.get('prevHist') : null);
      debug('mtf read', { symbol, tf, hist, prevHist });
      const hasFlip = (prevHist != null && prevHist < 0 && hist != null && hist >= 0);
      if (hist != null && (hist > 0 || hasFlip)) {
        positives.push({ tf, hist, hasFlip });
        cumulativeStrength += Math.max(0, Number(hist) || 0);
      } else negatives.push({ tf, hist });
    }

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

    const mtfInfo = { status, positives, negatives, cumulativeStrength, evaluatedAt: Date.now() };
    debug('mtf evaluated', { symbol, rootId: root.id, mtfInfo });
    try {
      const updated = this.scanner.updateRootMTF(root.id, mtfInfo);
      if (!updated) debug('mtf updateRootMTF returned null for', root.id, symbol);
      else info('mtf: updated root', root.id, symbol, 'status', mtfInfo.status);
    } catch (e) { debug('mtf update error', e && e.message ? e.message : e); }

    if (status === 'all_positive' && OPEN_TRADES && this.trader) {
      try {
        const balanceResp = await this.trader.rest.getWalletBalance();
        const bal = Number(balanceResp?.result?.list?.[0]?.wallet_balance || balanceResp?.result?.USDT?.equity || 0);
        const amountUsd = this.trader.positionSizeFromBalance(bal, this.trader.openTrades.length + 1);
        await this.trader.openTrade(symbol, 'Buy', amountUsd);
        info('mtf: opened trade', { symbol, amountUsd });
      } catch (err) { debug('mtf openTrade error', err && err.message ? err.message : err); }
    }
  }
}

module.exports = MTF;
