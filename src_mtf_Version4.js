// mtf.js (updated) - now updates scanner root MTF status instead of sending telegrams directly.
const { info, debug } = require('./logger');
const { MTF_TFS, MTF_CHECK_ON_5M, OPEN_TRADES } = require('./config');

class MTF {
  constructor(scanner, trader = null) {
    this.scanner = scanner;
    this.trader = trader;
    this.scanner.on('candle_open', (c) => this.onCandle(c));
  }

  async onCandle({ symbol, tf, start }) {
    if (!MTF_CHECK_ON_5M) return;
    if (String(tf) !== '5') return;
    const active = this.scanner.getActiveRootSignals();
    if (!active || active.length === 0) return;
    for (const root of active) {
      // evaluate alignment for each active root
      await this.evaluateAlignment(root);
    }
  }

  async evaluateAlignment(root) {
    const symbol = root.symbol;
    const sdata = this.scanner.symbolData[symbol];
    if (!sdata) return;
    const tfs = MTF_TFS;
    const positives = [];
    const negatives = [];
    let cumulativeStrength = 0;
    for (const tf of tfs) {
      const st = sdata[tf];
      if (!st || !st.macd) continue;
      const hist = st.macd.hist;
      const prevHist = st.macd.prevHist;
      const hasFlip = prevHist !== null && prevHist < 0 && hist >= 0;
      if (hist !== null && (hist > 0 || hasFlip)) {
        positives.push({ tf, hist, hasFlip });
        cumulativeStrength += Math.max(0, hist);
      } else negatives.push({ tf, hist });
    }

    // Build mtfInfo object summarizing status
    let status = 'partial';
    if (negatives.length === 0) status = 'all_positive';
    else if (negatives.length === 1 && negatives[0].tf === 'D') {
      const st = sdata['D'];
      if (st && st.macd && st.macd.hist !== null && st.macd.prevHist !== null && st.macd.hist > st.macd.prevHist) {
        status = 'daily_rising';
      }
    }

    const mtfInfo = {
      status,
      positives,
      negatives,
      cumulativeStrength,
      evaluatedAt: Date.now()
    };

    // Update scanner's root MTF info (scanner will persist and emit root_updated)
    this.scanner.updateRootMTF(root.id, mtfInfo);

    // Optionally open trades if aligned and OPEN_TRADES set (scanner/trader will handle)
    if (status === 'all_positive' && OPEN_TRADES && this.trader) {
      try {
        const balanceResp = await this.trader.rest.getWalletBalance();
        const bal = Number(balanceResp?.result?.list?.[0]?.wallet_balance || balanceResp?.result?.USDT?.equity || 0);
        const amountUsd = this.trader.positionSizeFromBalance(bal, this.trader.openTrades.length + 1);
        await this.trader.openTrade(symbol, 'Buy', amountUsd);
      } catch (err) {
        debug('mtf openTrade error', err.message || err);
      }
    }
  }
}

module.exports = MTF;