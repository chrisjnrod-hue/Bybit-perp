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
    price = Number(price);
    if (this.value === null) {
      this.value = price;
    } else {
      this.value = price * this.k + this.value * (1 - this.k);
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
    const p = Number(price);
    const f = this.fast.update(p);
    const s = this.slow.update(p);
    if (f == null || s == null) return null;
    this.macd = f - s;
    const sig = this.signal.update(this.macd);
    if (sig == null) return null;
    // store prevHist before computing new hist
    this.prevHist = this.hist;
    this.hist = this.macd - sig;
    return { macd: this.macd, signal: sig, hist: this.hist, prevHist: this.prevHist };
  }

  // helper getter (safe)
  get(name) {
    if (name === 'hist') return this.hist;
    if (name === 'prevHist') return this.prevHist;
    if (name === 'macd') return this.macd;
    if (name === 'signal') return this.signal && this.signal.value;
    return undefined;
  }
}

module.exports = { EMA, MACD };