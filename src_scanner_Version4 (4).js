// Orchestrates subscriptions, maintains per-symbol/TF MACD state, detects root flips and manages alerts.
// Updated to parse both kline.{interval}.{symbol} and kline.{interval}.linear.{symbol} topics.
const EventEmitter = require('events');
const BybitWS = require('./bybit-ws');
const { MACD } = require('./indicators');
const { info, debug, warn } = require('./logger');
const {
  STABLE_COINS,
  ROOT_TFS,
  MTF_TFS,
  MTF_CHECK_ON_5M,
  PUSH_SIGNALS_ON_START,
  MIN_24H_VOL_CHANGE_PCT,
  MIN_24H_PRICE_CHANGE_PCT,
  REST_FALLBACK_IF_WS_FAIL,
  SIGNALS_FILE
} = require('./config');
const { sendTelegram } = require('./telegram');
const BybitREST = require('./bybit-rest');
const { readSignals, writeSignals } = require('./storage');
const uuid = require('uuid').v4;

class Scanner extends EventEmitter {
  constructor(trader = null) {
    super();
    this.ws = new BybitWS();
    this.rest = new BybitREST();
    this.trader = trader;
    this.symbols = new Set();
    this.symbolData = {}; // symbol -> tf -> {macd,...}
    this.activeRootSignals = {}; // key -> signal
    this.ready = false;
    this.ws.on('message', (msg) => this.handleWSMessage(msg));
    this.ws.on('connected', () => debug('WS connected in scanner'));
    // load persisted signals at startup
    this.loadPersistedSignals();
  }

  loadPersistedSignals() {
    const s = readSignals();
    const roots = s.filter(x => x.type === 'root' && x.status === 'active');
    for (const r of roots) {
      const key = `${r.symbol}|${r.tf}|${r.start}`;
      this.activeRootSignals[key] = r;
    }
    info('Loaded persisted root signals', Object.keys(this.activeRootSignals).length);
  }

  async start() {
    this.ws.connect();
    // wait a bit for WS instrument info; fallback allowed
    setTimeout(async () => {
      if (this.symbols.size === 0 && REST_FALLBACK_IF_WS_FAIL) {
        info('No symbols from WS - using REST fallback to fetch instruments');
        await this.fetchSymbolsByREST();
        this.subscribeAll();
        if (PUSH_SIGNALS_ON_START) {
          sendTelegram(`<b>Bybit bot</b> started via REST fallback. Discovered ${this.symbols.size} symbols.`);
        }
      }
    }, 5000);
    this.ready = true;
  }

  async fetchSymbolsByREST() {
    try {
      const resp = await this.rest.getSymbols();
      const list = resp?.result?.list || resp?.result || resp?.data || [];
      for (const inst of list) {
        const symbol = inst.symbol || inst.name || inst.instId || inst.symbol_name;
        if (!symbol) continue;
        if (!symbol.endsWith('USDT')) continue;
        // skip stable bases
        const base = symbol.replace('USDT', '');
        if (STABLE_COINS.includes(base)) continue;
        this.symbols.add(symbol);
        this.initSymbol(symbol);
      }
      info('REST fetched symbols', this.symbols.size);
    } catch (err) {
      warn('fetchSymbolsByREST error', err.message);
    }
  }

  initSymbol(symbol) {
    if (!this.symbolData[symbol]) {
      this.symbolData[symbol] = {};
      for (const tf of Array.from(new Set([...ROOT_TFS, ...MTF_TFS]))) {
        this.symbolData[symbol][tf] = {
          macd: new MACD(),
          lastCandleStart: null,
          lastOpen: null,
          lastClose: null,
          alertedRootId: null
        };
      }
    }
  }

  subscribeAll() {
    for (const symbol of this.symbols) {
      for (const tf of Array.from(new Set([...ROOT_TFS, ...MTF_TFS]))) {
        this.ws.subKline(symbol, tf);
      }
    }
    info('Subscribed to klines for', this.symbols.size, 'symbols');
  }

  async handleWSMessage(msg) {
    // instrument info topic
    if (msg.topic && msg.topic.startsWith('instrument')) {
      await this.handleInstrumentInfo(msg);
      return;
    }
    // kline topic: supports formats:
    //  - kline.{interval}.{symbol}
    //  - kline.{interval}.linear.{symbol} (older/other variants)
    if (msg.topic && msg.topic.startsWith('kline')) {
      const parts = msg.topic.split('.');
      const interval = parts[1]; // always at index 1
      // symbol may be at parts[2] or parts[3] if 'linear' exists
      let symbol = parts[2];
      if (!symbol && parts[3]) symbol = parts[3];
      if (parts[2] === 'linear' && parts[3]) symbol = parts[3];
      // fallback: if topic format unexpected, try last part
      if (!symbol) symbol = parts[parts.length - 1];

      const data = msg.data || msg;
      const candles = Array.isArray(data) ? data : [data];
      for (const k of candles) {
        const start = k.start || k.t || k.open_time || k.ts || k.k?.start;
        const open = Number(k.open ?? k.k?.o);
        const close = Number(k.close ?? k.k?.c);
        const volume = Number(k.volume ?? k.k?.v ?? k.volume_);
        if (!start) continue;
        await this.onCandle(symbol, String(interval), Number(start), open, close, volume);
      }
    }
  }

  async handleInstrumentInfo(payload) {
    const list = payload?.data?.list || payload?.data || payload;
    if (!list || !Array.isArray(list)) return;
    for (const inst of list) {
      const symbol = inst.symbol || inst.instId || inst.instrument_name;
      if (!symbol) continue;
      if (!symbol.endsWith('USDT')) continue;
      const base = symbol.replace('USDT', '');
      if (STABLE_COINS.includes(base)) continue;
      if (!this.symbols.has(symbol)) {
        this.symbols.add(symbol);
        this.initSymbol(symbol);
      }
    }
    this.subscribeAll();
  }

  async onCandle(symbol, tf, start, open, close, volume) {
    if (!this.symbolData[symbol] || !this.symbolData[symbol][tf]) return;
    const sdata = this.symbolData[symbol][tf];
    const isNewCandle = sdata.lastCandleStart !== start;
    if (isNewCandle) {
      debug('Candle open', symbol, tf, new Date(start * 1000).toISOString());
      if (sdata.lastClose !== null) sdata.macd.update(sdata.lastClose);
      const macdResult = sdata.macd.update(open);
      sdata.lastOpen = open;
      sdata.lastClose = close;
      sdata.lastCandleStart = start;
      if (ROOT_TFS.includes(tf)) {
        await this.checkRootFlip(symbol, tf, macdResult, volume);
      }
      this.emit('candle_open', { symbol, tf, start, open, close, volume, macdResult });
    } else {
      sdata.lastClose = close;
      sdata.macd.update(close);
    }
  }

  async fetch24hForSymbol(symbol) {
    try {
      const resp = await this.rest.getTickers(symbol);
      const item = resp?.result?.list?.[0] || resp?.result?.[0] || resp?.data?.[0];
      if (!item) return null;
      const price24hChangePct = Number(item.price_24h_pcnt ?? item.change_24h ?? item.px_24h ?? 0) * 100;
      const vol24 = Number(item.turnover_24h ?? item.volume_24h ?? item.quote_volume ?? 0);
      const lastPrice = Number(item.last_price || item.last || item.lastPrice || 0);
      return { price24hChangePct, vol24, lastPrice, raw: item };
    } catch (err) {
      warn('fetch24hForSymbol error', symbol, err.message);
      return null;
    }
  }

  async checkRootFlip(symbol, tf, macdResult, volume) {
    if (!macdResult) return;
    const { hist, prevHist } = macdResult;
    if (prevHist === null) return;
    const threshold = require('./config').MACD_HIST_POSITIVE_THRESHOLD;
    const prevNeg = prevHist < 0;
    const currPos = hist >= threshold;
    if (prevNeg && currPos) {
      const metrics = await this.fetch24hForSymbol(symbol);
      const pct24 = metrics ? metrics.price24hChangePct : 0;
      const vol24 = metrics ? metrics.vol24 : volume;
      if (pct24 < MIN_24H_PRICE_CHANGE_PCT) {
        debug('Root flip skipped by 24h price filter', symbol, pct24);
        return;
      }
      if (vol24 < MIN_24H_VOL_CHANGE_PCT) {
        debug('Root flip skipped by 24h vol filter', symbol, vol24);
        return;
      }
      const key = `${symbol}|${tf}|${this.symbolData[symbol][tf].lastCandleStart}`;
      if (this.activeRootSignals[key]) {
        debug('Duplicate root signal suppressed', key);
        return;
      }
      const id = uuid();
      const sig = {
        id,
        type: 'root',
        symbol,
        tf,
        strength: Math.max(0, hist) + Math.max(0, pct24 / 100),
        pct24,
        vol24,
        start: this.symbolData[symbol][tf].lastCandleStart,
        expires: this.symbolData[symbol][tf].lastCandleStart + this.tfToSeconds(tf),
        status: 'active',
        created: Date.now()
      };
      this.activeRootSignals[key] = sig;
      const s = readSignals();
      s.push(sig);
      writeSignals(s);
      const text = `<b>Bybit perps root signal</b>\n${symbol}\nTF: ${tf}\n24h%: ${pct24.toFixed(2)}\nStrength: ${sig.strength.toFixed(4)}`;
      await sendTelegram(text);
      info('Root signal', symbol, tf, 'sent', id);
      this.emit('root_signal', sig);
      const ttlMs = (sig.expires - Math.floor(Date.now() / 1000)) * 1000;
      setTimeout(() => {
        sig.status = 'expired';
        delete this.activeRootSignals[key];
        const s2 = readSignals();
        s2.push({ id: uuid(), type: 'meta', msg: `root_expired ${symbol} ${tf}`, ts: Date.now() });
        writeSignals(s2);
        info('Root signal expired', key);
      }, Math.max(0, ttlMs));
    }
  }

  tfToSeconds(tf) {
    if (tf === 'D' || tf === 'd') return 24 * 3600;
    return Number(tf) * 60;
  }

  getActiveRootSignals() {
    return Object.values(this.activeRootSignals);
  }

  getSymbolStatus(symbol) {
    return this.symbolData[symbol] || null;
  }
}

module.exports = Scanner;