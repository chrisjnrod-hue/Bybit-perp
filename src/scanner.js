// scanner.js (updated)
// Orchestrates subscriptions, maintains per-symbol/TF MACD state, detects root flips and manages alerts.
// Now: no direct Telegram sends on root creation; instead emits events and supports MTF updates.
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
  SEED_HISTORICAL,
  HIST_LOOKBACK,
  SEED_SYMBOLS_LIMIT,
  SEED_BATCH_SIZE,
  SEED_BATCH_DELAY_MS
} = require('./config');
const BybitREST = require('./bybit-rest');
const { readSignals, writeSignals } = require('./storage');
const uuid = require('uuid').v4;

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

class Scanner extends EventEmitter {
  constructor(trader = null) {
    super();
    this.ws = new BybitWS();
    this.rest = new BybitREST();
    this.trader = trader;
    this.symbols = new Set();
    this.symbolData = {}; // symbol -> tf -> {macd,...}
    this.activeRootSignals = {}; // key -> signal
    this.rootIndex = {}; // id -> key
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
      if (r.id) this.rootIndex[r.id] = key;
    }
    info('Loaded persisted root signals', Object.keys(this.activeRootSignals).length);
  }

  async start() {
    this.ws.connect();
    await this.fetchSymbolsByREST();

    if (SEED_HISTORICAL) {
      await this.seedHistorical();
    }

    this.subscribeAll();

    if (PUSH_SIGNALS_ON_START) {
      // push a small startup summary via event for alerter
      this.emit('startup');
    }

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
    if (msg.topic && msg.topic.startsWith('kline')) {
      const parts = msg.topic.split('.');
      const interval = parts[1];
      let symbol = parts[2];
      if (parts[2] === 'linear' && parts[3]) symbol = parts[3];
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
    if (msg.topic && msg.topic.startsWith('instrument')) {
      debug('Instrument info message received (ignored unless used for discovery)');
    }
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
      const item = resp?.result?.list || resp?.result || resp?.data || [];
      const first = item?.[0] || item;
      if (!first) return null;
      const price24hChangePct = Number(first.price_24h_pcnt ?? first.change_24h ?? first.px_24h ?? 0) * 100;
      const vol24 = Number(first.turnover_24h ?? first.volume_24h ?? first.quote_volume ?? 0);
      const lastPrice = Number(first.last_price || first.last || first.lastPrice || 0);
      return { price24hChangePct, vol24, lastPrice, raw: first };
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
        mtf: null,
        created: Date.now()
      };
      this.activeRootSignals[key] = sig;
      this.rootIndex[id] = key;
      // persist root signal
      const s = readSignals();
      s.push(sig);
      writeSignals(s);
      // emit root_signal for alerter to aggregate and send
      this.emit('root_signal', sig);

      // schedule expiry
      const ttlMs = (sig.expires - Math.floor(Date.now() / 1000)) * 1000;
      setTimeout(() => {
        sig.status = 'expired';
        delete this.activeRootSignals[key];
        delete this.rootIndex[id];
        const s2 = readSignals();
        s2.push({ id: uuid(), type: 'meta', msg: `root_expired ${symbol} ${tf}`, ts: Date.now() });
        writeSignals(s2);
        this.emit('root_expired', sig);
        info('Root signal expired', key);
      }, Math.max(0, ttlMs));
    }
  }

  // update MTF status for a root by id
  updateRootMTF(rootId, mtfInfo) {
    const key = this.rootIndex[rootId];
    if (!key) return null;
    const sig = this.activeRootSignals[key];
    if (!sig) return null;
    sig.mtf = mtfInfo; // save MTF details (status, positives, negatives, etc)
    // persist a mtf record
    const s = readSignals();
    s.push({ id: uuid(), type: 'mtf', rootId, symbol: sig.symbol, tf: sig.tf, detail: mtfInfo, created: Date.now() });
    writeSignals(s);
    // emit update for alerter
    this.emit('root_updated', { rootId, sig });
    return sig;
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

  // Historical seeding: fetches klines and feeds closes into MACD to initialize state
  async seedHistorical() {
    const allSymbols = Array.from(this.symbols);
    const limit = SEED_SYMBOLS_LIMIT > 0 ? Math.min(SEED_SYMBOLS_LIMIT, allSymbols.length) : allSymbols.length;
    const targetSymbols = allSymbols.slice(0, limit);
    info('Seeding historical candles for', targetSymbols.length, 'symbols (lookback', HIST_LOOKBACK, ')');

    const tfs = Array.from(new Set([...ROOT_TFS, ...MTF_TFS]));

    for (let i = 0; i < targetSymbols.length; i += SEED_BATCH_SIZE) {
      const batch = targetSymbols.slice(i, i + SEED_BATCH_SIZE);
      await Promise.all(batch.map(async (symbol) => {
        try {
          for (const tf of tfs) {
            try {
              const resp = await this.rest.getKlines(symbol, tf, HIST_LOOKBACK);
              const list = resp?.result?.list || resp?.result || resp?.data || [];
              const candles = Array.isArray(list) ? list.slice().reverse() : [];
              for (const c of candles) {
                const close = Number(c.close ?? c.k?.c ?? c.close_price ?? c[4]);
                if (Number.isFinite(close)) {
                  const sdata = this.symbolData[symbol] && this.symbolData[symbol][tf];
                  if (sdata && sdata.macd) sdata.macd.update(close);
                }
              }
            } catch (err) {
              debug('seedHistorical fetch klines error', symbol, tf, err.message || err);
            }
          }
        } catch (err) {
          debug('seedHistorical symbol error', symbol, err.message || err);
        }
      }));
      debug('Seed batch completed', i / SEED_BATCH_SIZE + 1);
      await sleep(SEED_BATCH_DELAY_MS);
    }
    info('Seeding complete');
  }
}

module.exports = Scanner;
