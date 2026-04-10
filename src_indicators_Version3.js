// Simple incremental EMA and MACD calculator per symbol/TF
// MACD config: fast=12, slow=26, signal=9

class EMA {
  constructor(period) {
    this.period = period;
    this.k = 2 / (period + 1);
    this.value = null;
  }

  update(price) {
    if (price == null || Number.isNaN(price)) return this.value;
    if (this.value === null) {
      // initialize EMA with first price seen
      this.value = Number(price);
    } else {
      this.value = Number(price) * this.k + this.value * (1 - this.k);
    }
    return this.value;
  }
}

class MACD {
  constructor() {
    this.fast = new EMA(12);
    this.slow = new EMA(26);
    this.signal = new EMA(9);
    this.macd = null;
    this.hist = null;
    this.prevHist = null;
  }

  // call update sequentially with price points (close/open)
  update(price) {
    if (price == null || Number.isNaN(price)) return null;
    const f = this.fast.update(price);
    const s = this.slow.update(price);
    if (f == null || s == null) return null;
    this.macd = f - s;
    const sig = this.signal.update(this.macd);
    if (sig == null) return null;
    this.prevHist = this.hist;
    this.hist = this.macd - sig;
    return { macd: this.macd, signal: sig, hist: this.hist, prevHist: this.prevHist };
  }
}

module.exports = { EMA, MACD };