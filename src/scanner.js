// scanner.js - robusted: interval normalization, MACD prev-result logic, no-silent-duplication
const EventEmitter = require('events');
const BybitWS = require('./bybit-ws');
const { MACD } = require('./indicators');
const { info, debug, warn } = require('./logger');
const {
  STABLE_COINS,
  ROOT_TFS,
  MTF_TFS,
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

function normalizeStartToSeconds(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isNaN(n)) {
    if (n > 1e12) return Math.floor(n / 1000);
    if (n > 1e9) return Math.floor(n);
  }
  const parsed = Date.parse(String(raw));
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  return null;
}

// Normalize various interval labels used by WS / REST to canonical TF keys used by config
function normalizeIntervalToTf(interval) {
  if (!interval) return interval;
  const s = String(interval).toLowerCase().trim();

  // already numeric like "60", "240"
  if (/^\d+$/.test(s)) return s;

  // minute forms: "1m","5m","15m","60m"
  const mMatch = s.match(/^(\d+)m$/);
  if (mMatch) return String(Number(mMatch[1]));

  // hour forms: "1h","2h" -> minutes
  const hMatch = s.match(/^(\d+)h$/);
  if (hMatch) return String(Number(hMatch[1]) * 60);

  // day aliases
  if (s === 'd' || s === '1d' || s === 'day' || s === '1day') return 'D';

  // some use "min"/"minute"
  const minMatch = s.match(/^(\d+)(min|minute|minutes)$/);
  if (minMatch) return String(Number(minMatch[1]));

  // fallback: return original
  return interval;
}

class Scanner extends EventEmitter {
  constructor(trader = null) {
    super();
    this.ws = new BybitWS();
    this.rest = new BybitREST();
    this.trader = trader;
    this.symbols = new Set();
    this.symbolData = {};
    this.activeRootSignals = {};
    this.rootIndex = {};

    this.seeding = false;
    this.lastSeedAt = null;
    this.ready = false;

    this.ws.on('message', (msg) => this.handleWSMessage(msg));
    this.ws.on('connected', () => debug('WS connected in scanner'));

    this.loadPersistedSignals();

    // When a listener subscribes to 'root_signal', replay persisted active roots immediately (async).
    this.on('newListener', (event, listener) => {
      if (event === 'root_signal') {
        const roots = Object.values(this.activeRootSignals);
        if (!roots || roots.length === 0) return;
        setImmediate(() => {
          for (const r of roots) {
            try { this.emit('root_signal', r); } catch (e) { debug('replay root_signal error', e && e.message ? e.message : e); }
          }
        });
      }
    });
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
    this.emit('signals_loaded', { count: Object.keys(this.activeRootSignals).length });
  }

  async start() {
    this.ws.connect();
    await this.fetchSymbolsByREST();

    if (SEED_HISTORICAL) {
      await this.seedHistorical();
    }

    this.subscribeAll();

    if (PUSH_SIGNALS_ON_START) {
      this.emit('startup');
    }

    this.ready = true;
  }

  async fetchSymbolsByREST() {
    const cfg = require('./config');
    try {
      const resp = await this.rest.getSymbols();
      let list = resp?.result?.list || resp?.result || resp?.data || resp?.symbols || [];
      if (!Array.isArray(list) && Array.isArray(resp)) list = resp;
      if (!Array.isArray(list) && typeof list === 'object' && list !== null) {
        if (Array.isArray(list.symbols)) list = list.symbols;
        else list = Object.values(list);
      }
      info('REST fetched raw list length', Array.isArray(list) ? list.length : 0);
      if (!list || (Array.isArray(list) && list.length === 0)) throw new Error('empty symbol list from REST');

      for (const inst of list) {
        let symbol = null;
        if (typeof inst === 'string') symbol = inst;
        else if (inst && typeof inst === 'object') symbol = inst.symbol || inst.name || inst.instId || inst.symbol_name || inst.instrument_name || inst.s || inst[0];
        if (!symbol) continue;
        symbol = String(symbol).trim().toUpperCase();
        if (!symbol.endsWith('USDT')) continue;
        const base = symbol.replace(/USDT$/i, '');
        if (STABLE_COINS.includes(base)) continue;
        if (this.symbols.has(symbol)) continue;
        this.symbols.add(symbol);
        this.initSymbol(symbol);
      }
      info('REST fetched symbols', this.symbols.size);
    } catch (err) {
      warn('fetchSymbolsByREST error', err && err.message ? err.message : err);
      if (REST_FALLBACK_IF_WS_FAIL && this.ws) {
        info('Attempting WS fallback for instrument discovery');
        const topic = cfg.WS_INSTRUMENT_TOPIC;
        const collected = [];
        const handler = (msg) => {
          try {
            if (!msg || !msg.topic) return;
            if (msg.topic === topic || msg.topic.startsWith('instrument')) {
              const data = msg.data || msg;
              const list = data?.list || data?.instruments || data?.data || (Array.isArray(data) ? data : []);
              if (Array.isArray(list) && list.length > 0) collected.push(...list);
            }
          } catch (e) { debug('ws fallback handler error', e && e.message ? e.message : e); }
        };
        this.ws.on('message', handler);
        await sleep(2500);
        this.ws.removeListener('message', handler);
        this.emit('ws_fallback_collected', { collected: collected.length });
        if (collected.length === 0) warn('WS fallback collected no instrument messages');
        else {
          const seen = new Set();
          let added = 0;
          for (const inst of collected) {
            const symbol = inst.symbol || inst.name || inst.instId || inst.symbol_name || inst.instrument_name;
            if (!symbol) continue;
            const sSym = String(symbol).trim().toUpperCase();
            if (!sSym.endsWith('USDT')) continue;
            const base = sSym.replace(/USDT$/i, '');
            if (STABLE_COINS.includes(base)) continue;
            if (seen.has(sSym)) continue;
            seen.add(sSym);
            if (!this.symbols.has(sSym)) {
              this.symbols.add(sSym);
              this.initSymbol(sSym);
              added++;
            }
          }
          info('WS fallback discovered symbols', added, 'total symbols', this.symbols.size);
          this.emit('ws_fallback_discovered', { added, total: this.symbols.size });
        }
      }
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
          alertedRootId: null,
          macdReady: false
        };
      }
      this.emit('symbol_tracked', { symbol, tfs: Array.from(new Set([...ROOT_TFS, ...MTF_TFS])) });
    }
  }

  subscribeAll() {
    for (const symbol of this.symbols) {
      for (const tf of Array.from(new Set([...ROOT_TFS, ...MTF_TFS]))) {
        // subscribe using WS expected format (most Bybit endpoints accept numeric minute string or 'D')
        this.ws.subKline(symbol, tf);
      }
    }
    info('Subscribed to klines for', this.symbols.size, 'symbols');
    this.emit('subscribed', { symbolCount: this.symbols.size });
  }

  async handleWSMessage(msg) {
    if (msg.topic && msg.topic.startsWith('kline')) {
      const parts = msg.topic.split('.');
      const rawInterval = parts[1];
      let symbol = parts[2];
      if (parts[2] === 'linear' && parts[3]) symbol = parts[3];
      if (!symbol) symbol = parts[parts.length - 1];
      const msgData = msg.data || msg;
      if (!symbol && msgData.s) symbol = msgData.s;
      if (!symbol && msgData.symbol) symbol = msgData.symbol;

      const tf = normalizeIntervalToTf(rawInterval);
      if (!tf) {
        debug('handleWSMessage: unable to normalize interval', rawInterval);
      } else if (tf !== rawInterval) {
        debug('Normalized interval', rawInterval, '→', tf);
      }

      const klineData = msgData.k || msgData;
      const candles = Array.isArray(klineData) ? klineData : [klineData];

      for (const k of candles) {
        const rawStart = k.start || k.t || k.open_time || k.ts || k[0];
        const startSec = normalizeStartToSeconds(rawStart);
        const open = Number(k.o ?? k.open ?? k[1] ?? 0);
        const close = Number(k.c ?? k.close ?? k[4] ?? 0);
        const volume = Number(k.v ?? k.volume ?? k[7] ?? 0);
        if (!startSec || !symbol) {
          debug('handleWSMessage: skipped invalid candle', { symbol, startSec, open, close, tf });
          continue;
        }
        await this.onCandle(String(symbol).toUpperCase(), String(tf), startSec, open, close, volume);
      }
    } else if (msg.topic && msg.topic.startsWith('instrument')) {
      debug('Instrument message (ignored for now)', msg.topic);
    }
  }

  async onCandle(symbol, tf, startSec, open, close, volume) {
    if (!this.symbolData[symbol] || !this.symbolData[symbol][tf]) {
      debug('onCandle: symbol/tf not tracked', symbol, tf);
      return;
    }
    const sdata = this.symbolData[symbol][tf];
    const isNewCandle = sdata.lastCandleStart !== startSec;

    if (isNewCandle) {
      debug('Candle open', symbol, tf, new Date(startSec * 1000).toISOString(), 'close:', close);

      // --- Robust MACD previous-result retrieval ---
      let macdPrevResult = null;

      try {
        // Prefer using existing seeded state (avoid double-feeding)
        const macdObj = sdata.macd;
        if (macdObj && typeof macdObj.prevHist !== 'undefined' && macdObj.prevHist !== null) {
          macdPrevResult = { hist: macdObj.hist, prevHist: macdObj.prevHist, macd: macdObj.macd, signal: macdObj.signal };
          if (!sdata.macdReady) {
            sdata.macdReady = true;
            debug('MACD ready (from existing state) for', symbol, tf);
            this.emit('macd_ready', { symbol, tf, source: 'existing' });
          }
        } else if (sdata.lastClose !== null) {
          // Feed previous close to get prev result if not seeded
          macdPrevResult = sdata.macd.update(sdata.lastClose);
          this.emit('macd_prev_result', { symbol, tf, macdPrevResult });
          if (macdPrevResult && macdPrevResult.prevHist !== null && !sdata.macdReady) {
            sdata.macdReady = true;
            debug('MACD ready (after feeding lastClose) for', symbol, tf);
            this.emit('macd_ready', { symbol, tf, source: 'feed_lastClose' });
          }
        }
      } catch (e) {
        debug('macd prev result error', e && e.message ? e.message : e);
      }

      // update lasts for this new candle
      sdata.lastOpen = open;
      sdata.lastClose = close;
      sdata.lastCandleStart = startSec;

      // Only check root flip if TF is a root TF and MACD is ready with a prev result
      if (ROOT_TFS.includes(tf) && sdata.macdReady && macdPrevResult) {
        debug('ROOT TF check triggered', symbol, tf, 'hist:', macdPrevResult.hist, 'prevHist:', macdPrevResult.prevHist);
        await this.checkRootFlip(symbol, tf, macdPrevResult, volume);
      } else if (ROOT_TFS.includes(tf)) {
        debug('ROOT TF check skipped', symbol, tf, 'macdReady:', sdata.macdReady, 'hasPrevResult:', !!macdPrevResult);
        this.emit('root_tf_check_skipped', { symbol, tf, macdReady: sdata.macdReady, hasPrevResult: !!macdPrevResult });
      }

      // maintain live MACD with open for state
      try {
        const r = sdata.macd.update(open);
        this.emit('macd_live_update', { symbol, tf, input: open, result: r });
      } catch (e) {
        debug('macd update open error', e && e.message ? e.message : e);
      }

      this.emit('candle_open', { symbol, tf, start: startSec, open, close, volume, macdResult: macdPrevResult });
    } else {
      // same candle updates
      sdata.lastClose = close;
      try {
        const res = sdata.macd.update(close);
        this.emit('macd_update', { symbol, tf, input: close, result: res });
      } catch (e) {
        debug('macd update close error', e && e.message ? e.message : e);
      }
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
      warn('fetch24hForSymbol error', symbol, err && err.message ? err.message : err);
      this.emit('fetch24h_error', { symbol, err: err && err.message ? err.message : err });
      return null;
    }
  }

  async checkRootFlip(symbol, tf, macdResult, volume) {
    if (!macdResult) {
      debug('checkRootFlip: no macdResult', symbol, tf);
      this.emit('checkRootFlip_no_result', { symbol, tf });
      return;
    }
    const { hist, prevHist } = macdResult;
    if (prevHist === null) {
      debug('checkRootFlip: prevHist is null', symbol, tf);
      this.emit('checkRootFlip_prevHist_null', { symbol, tf, macdResult });
      return;
    }

    const threshold = require('./config').MACD_HIST_POSITIVE_THRESHOLD;
    const crossedUp = prevHist < threshold && hist >= threshold;
    debug('checkRootFlip details', symbol, tf, { prevHist, hist, threshold, crossedUp });

    if (!crossedUp) {
      this.emit('root_no_cross', { symbol, tf, prevHist, hist, threshold });
      return;
    }

    // Passed flip condition; apply masks/filters
    const metrics = await this.fetch24hForSymbol(symbol);
    const pct24 = metrics ? metrics.price24hChangePct : 0;
    const vol24 = metrics ? metrics.vol24 : volume;

    if (pct24 < MIN_24H_PRICE_CHANGE_PCT) {
      debug('Root flip skipped by 24h price filter', symbol, pct24, '<', MIN_24H_PRICE_CHANGE_PCT);
      this.emit('root_flip_filtered', { symbol, tf, reason: 'price', pct24, min: MIN_24H_PRICE_CHANGE_PCT });
      return;
    }
    if (vol24 < MIN_24H_VOL_CHANGE_PCT) {
      debug('Root flip skipped by 24h vol filter', symbol, vol24, '<', MIN_24H_VOL_CHANGE_PCT);
      this.emit('root_flip_filtered', { symbol, tf, reason: 'vol', vol24, min: MIN_24H_VOL_CHANGE_PCT });
      return;
    }

    const key = `${symbol}|${tf}|${this.symbolData[symbol][tf].lastCandleStart}`;

    // Overwrite previous signal at key instead of silently suppressing
    const prev = this.activeRootSignals[key];
    if (prev && prev.id) {
      try { delete this.rootIndex[prev.id]; } catch (e) {}
      this.emit('root_duplicate_overwritten', { key, prevId: prev.id, symbol, tf });
    }

    const id = uuid();
    const startSec = this.symbolData[symbol][tf].lastCandleStart;
    const tfSeconds = this.tfToSeconds(tf);
    const sig = {
      id,
      type: 'root',
      symbol,
      tf,
      strength: Math.max(0, hist) + Math.max(0, pct24 / 100),
      pct24,
      vol24,
      start: startSec,
      expires: startSec + tfSeconds,
      status: 'active',
      mtf: null,
      created: Date.now()
    };

    this.activeRootSignals[key] = sig;
    this.rootIndex[id] = key;
    const s = readSignals();
    s.push(sig);
    writeSignals(s);
    info('✓ ROOT SIGNAL CREATED', id, symbol, tf, 'startSec', startSec, 'expiresSec', sig.expires);

    try { this.emit('root_signal', sig); } catch (e) { debug('emit root_signal error', e && e.message ? e.message : e); }
    this.emit('root_created', { sig, key });

    // schedule expiry
    const expiryMs = sig.expires * 1000;
    let ttlMs = expiryMs - Date.now();
    if (ttlMs < 0) ttlMs = 0;
    const MAX_TTL = 0x7fffffff - 1;
    if (ttlMs > MAX_TTL) ttlMs = MAX_TTL;

    try {
      this.emit('root_expiry_scheduled', { id, key, ttlMs, expiresAt: sig.expires });
      setTimeout(() => {
        sig.status = 'expired';
        delete this.activeRootSignals[key];
        delete this.rootIndex[id];
        const s2 = readSignals();
        s2.push({ id: uuid(), type: 'meta', msg: `root_expired ${symbol} ${tf}`, ts: Date.now() });
        writeSignals(s2);
        this.emit('root_expired', sig);
        info('Root signal expired', key);
      }, ttlMs);
    } catch (err) {
      warn('Failed to schedule expiry timeout', err && err.message ? err.message : err);
      this.emit('root_expiry_schedule_failed', { id, key, err: err && err.message ? err.message : err });
    }
  }

  updateRootMTF(rootId, mtfInfo) {
    const key = this.rootIndex[rootId];
    if (!key) return null;
    const sig = this.activeRootSignals[key];
    if (!sig) return null;
    sig.mtf = mtfInfo;
    const s = readSignals();
    s.push({ id: uuid(), type: 'mtf', rootId, symbol: sig.symbol, tf: sig.tf, detail: mtfInfo, created: Date.now() });
    writeSignals(s);
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

  async seedHistorical() {
    if (this.seeding) {
      info('seedHistorical called but seeding already in progress');
      return { started: false, reason: 'already_seeding' };
    }
    this.seeding = true;
    this.lastSeedAt = null;
    const allSymbols = Array.from(this.symbols);
    const limit = SEED_SYMBOLS_LIMIT > 0 ? Math.min(SEED_SYMBOLS_LIMIT, allSymbols.length) : allSymbols.length;
    const targetSymbols = allSymbols.slice(0, limit);
    info('Seeding historical candles for', targetSymbols.length, 'symbols (lookback', HIST_LOOKBACK, ')');

    const tfs = Array.from(new Set([...ROOT_TFS, ...MTF_TFS]));
    let totalClosesSeeded = 0;
    let totalCandlesProcessed = 0;
    let symbolsWithMacdReady = 0;

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
                const close = Number(c.close ?? c.k?.c ?? c.c ?? c.close_price ?? c[4]);
                const rawStart = c.start || c.t || c[0];
                const startSec = normalizeStartToSeconds(rawStart);
                if (Number.isFinite(close)) {
                  totalCandlesProcessed++;
                  const sdata = this.symbolData[symbol] && this.symbolData[symbol][tf];
                  if (sdata && sdata.macd) {
                    const result = sdata.macd.update(close);
                    sdata.lastClose = close;
                    if (result && result.prevHist !== null && !sdata.macdReady) {
                      sdata.macdReady = true;
                      symbolsWithMacdReady++;
                      this.emit('macd_ready_seed', { symbol, tf });
                    }
                    this.emit('macd_seed_update', { symbol, tf, input: close, result: result ? { hist: result.hist, prevHist: result.prevHist } : null });
                    totalClosesSeeded++;
                    if (startSec) sdata.lastCandleStart = startSec;
                  }
                }
              }
            } catch (err) {
              debug('seedHistorical fetch klines error', symbol, tf, err && err.message ? err.message : err);
              this.emit('seed_symbol_error', { symbol, tf, err: err && err.message ? err.message : err });
            }
          }
        } catch (err) {
          debug('seedHistorical symbol error', symbol, err && err.message ? err.message : err);
          this.emit('seed_symbol_error', { symbol, err: err && err.message ? err.message : err });
        }
      }));
      debug('Seed batch completed', Math.floor(i / SEED_BATCH_SIZE) + 1, 'of', Math.ceil(targetSymbols.length / SEED_BATCH_SIZE));
      this.emit('seed_batch_complete', { batchIndex: Math.floor(i / SEED_BATCH_SIZE) + 1, batchTotal: Math.ceil(targetSymbols.length / SEED_BATCH_SIZE), processedSymbols: batch.length, totalClosesSeeded, totalCandlesProcessed, symbolsWithMacdReady });
      await sleep(SEED_BATCH_DELAY_MS);
    }

    this.seeding = false;
    this.lastSeedAt = Date.now();
    info('Seeding complete at', new Date(this.lastSeedAt).toISOString(), 'candlesProcessed:', totalCandlesProcessed, 'lastClosesSet:', totalClosesSeeded, 'symbol/TFs with macdReady:', symbolsWithMacdReady);

    let macdReadyCount = 0;
    for (const sym of Object.keys(this.symbolData)) {
      for (const tf of Object.keys(this.symbolData[sym])) {
        if (this.symbolData[sym][tf].macdReady) macdReadyCount++;
      }
    }
    const totalBuckets = Object.keys(this.symbolData).length * tfs.length;
    info('Seeding verification: MACD ready buckets:', macdReadyCount, 'of', totalBuckets, '(' + (macdReadyCount > 0 ? ((macdReadyCount / totalBuckets) * 100).toFixed(1) : 0) + '%)');
    this.emit('seed_complete', { completedAt: this.lastSeedAt, symbolsSeeded: targetSymbols.length, candlesProcessed: totalCandlesProcessed, lastClosesSet: totalClosesSeeded, macdReadyBuckets: macdReadyCount, totalBuckets });
    return { started: true, completedAt: this.lastSeedAt, symbolsSeeded: targetSymbols.length, candlesProcessed: totalCandlesProcessed, lastClosesSet: totalClosesSeeded, macdReadyBuckets: macdReadyCount };
  }
}

module.exports = Scanner;
