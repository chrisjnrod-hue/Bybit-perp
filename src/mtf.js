// MTF alignment checks updated to optionally open trades via trader and to persist confirmation alerts.
const { info, debug } = require('./logger');
const { MTF_TFS, MTF_CHECK_ON_5M, OPEN_TRADES } = require('./config');
const { sendTelegram } = require('./telegram');
const { readSignals, writeSignals } = require('./storage');

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
      await this.evaluateAlignment(root);
    }
  }

  async evaluateAlignment(root) {
    const symbol = root.symbol;
    const rootTF = root.tf;
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

    if (negatives.length === 0) {
      const text = `<b>MTF alignment</b>\n${symbol}\nRootTF: ${rootTF}\nAll positive: ${positives.map(p => p.tf).join(',')}\nStrength:${cumulativeStrength.toFixed(4)}`;
      await sendTelegram(text);
      readSignals(); // ensure file exists
      writeSignals([...readSignals(), { id: root.id, type: 'mtf', symbol, detail: 'all_positive', created: Date.now() }]);
      info('MTF alignment all positive', symbol);
      if (OPEN_TRADES && this.trader) {
        const balanceResp = await this.trader.rest.getWalletBalance();
        const bal = Number(balanceResp?.result?.list?.[0]?.wallet_balance || balanceResp?.result?.USDT?.equity || 0);
        const amountUsd = this.trader.positionSizeFromBalance(bal, this.trader.openTrades.length + 1);
        await this.trader.openTrade(symbol, 'Buy', amountUsd);
      }
      return;
    }

    if (negatives.length >= 1 && negatives.length < tfs.length) {
      const text = `<b>MTF partial</b>\n${symbol}\nPositive: ${positives.map(p => p.tf).join(',')}\nWaiting for: ${negatives.map(n => n.tf).join(',')}`;
      await sendTelegram(text);
      writeSignals([...readSignals(), { id: root.id, type: 'mtf', symbol, detail: 'partial_wait', positives, negatives, created: Date.now() }]);
      info('MTF partial', symbol);
      return;
    }

    if (negatives.length === 1 && negatives[0].tf === 'D') {
      const st = sdata['D'];
      if (st && st.macd && st.macd.hist !== null && st.macd.prevHist !== null && st.macd.hist > st.macd.prevHist) {
        const text = `<b>MTF accept daily rising</b>\n${symbol}\nDaily hist rising: ${st.macd.prevHist.toFixed(6)} -> ${st.macd.hist.toFixed(6)}`;
        await sendTelegram(text);
        writeSignals([...readSignals(), { id: root.id, type: 'mtf', symbol, detail: 'daily_rising', created: Date.now() }]);
        info('MTF accepted daily rising', symbol);
        if (OPEN_TRADES && this.trader) {
          const balanceResp = await this.trader.rest.getWalletBalance();
          const bal = Number(balanceResp?.result?.list?.[0]?.wallet_balance || balanceResp?.result?.USDT?.equity || 0);
          const amountUsd = this.trader.positionSizeFromBalance(bal, this.trader.openTrades.length + 1);
          await this.trader.openTrade(symbol, 'Buy', amountUsd);
        }
        return;
      }
    }
  }
}

module.exports = MTF;
