// scanner.js - simplified deterministic scanner focused on root TF detection
const EventEmitter = require('events');
const BybitWS = require('./bybit-ws');
const BybitREST = require('./bybit-rest');
const { MACD } = require('./indicators');
const { readSignals, writeSignals } = require('./storage');
const { info, debug, warn } = require('./logger');
const {
  STABLE_COINS,
  ROOT_TFS,
  MTF_TFS,
  PUSH_SIGNALS_ON_START,
  MIN_24H_VOL_CHANGE_PCT,
  MIN_24H_PRICE_CHANGE_PCT,
  SEED_HISTORICAL,
  HIST_LOOKBACK,
  SEED_SYMBOLS_LIMIT,
  SEED_BATCH_SIZE,
  SEED_BATCH_DELAY_MS
} = require('./config');
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

function normalizeIntervalToTf(interval) {
  if (!interval) return interval;
  const s = String(interval).toLowerCase().trim();
  if (/^\d+$/.test(s)) return s;
  const mMatch = s.match(/^(\d+)m$/); if (mMatch) return String(Number(mMatch[1]));
  const hMatch = s.match(/^(\d+)h$/); if (hMatch) return String(Number(hMatch[1]) * 60);
  if (s === 'd' || s === '1d' || s === 'day') return 'D';
  const minMatch = s.match(/^(\d+)(min|minute|minutes)$/); if (minMatch) return String(Number(minMatch[1]));
  return interval;
}

class Scanner extends EventEmitter {
  constructor(trader = null) {
    super();
    this.ws = new BybitWS();
    this.rest = new BybitREST();
    this.trader = trader;
    this.symbols = new Set();
    this.symbolData = {}; // symbol -> tf -> { macd, lastClose, lastCandleStart, macdReady }
    this.activeRootSignals = {}; // key -> sig
    this.rootIndex = {}; // id -> key
    this.seeding = false;
    this.lastSeedAt = null;
    this.ws.on('message', (m) => this.handleWSMessage(m));
    this.ws.on('connected', () => debug('WS connected in scanner'));
    // load persisted signals
    this._loadPersisted();
  }

  _loadPersisted() {
    const arr = readSignals() || [];
    const roots = arr.filter(x => x.type === 'root' && x.status === 'active');
    for (const r of roots) {
      const key = `${r.symbol}|${r.tf}|${r.start}`;
      this.activeRootSignals[key] = r;
      if (r.id) this.rootIndex[r.id] = key;
    }
    info('Loaded persisted root signals', Object.keys(this.activeRootSignals).length);
    this.emit('signals_loaded', { count: Object.keys(this.activeRootSignals).length });
  }

  // initialize data buckets for a symbol
  initSymbol(symbol) {
    if (!this.symbolData[symbol]) {
      this.symbolData[symbol] = {};
      for (const tf of Array.from(new Set([...(ROOT_TFS || []), ...(MTF_TFS || [])]))) {
        this.symbolData[symbol][tf] = {
          macd: new MACD(),
          lastClose: null,
          lastCandleStart: null,
          macdReady: false
        };
      }
      this.emit('symbol_tracked', { symbol, tfs: Object.keys(this.symbolData[symbol]) });
    }
  }

  async start() {
    this.ws.connect();
    await this._fetchSymbols();
    if (SEED_HISTORICAL) await this.seedHistorical();
    this._subscribeAll();
    if (PUSH_SIGNALS_ON_START) this.emit('startup');
    this.ready = true;
  }

  async _fetchSymbols() {
    try {
      const resp = await this.rest.getSymbols();
      let list = resp?.result?.list || resp?.result || resp?.data || [];
      if (!Array.isArray(list) && Array.isArray(resp)) list = resp;
      if (!Array.isArray(list) && typeof list === 'object' && list !== null) {
        if (Array.isArray(list.symbols)) list = list.symbols; else list = Object.values(list);
      }
      for (const inst of list) {
        let symbol = typeof inst === 'string' ? inst : (inst && (inst.symbol || inst.name || inst.instId || inst.symbol_name || inst.instrument_name));
        if (!symbol) continue;
        symbol = String(symbol).trim().toUpperCase();
        if (!symbol.endsWith('USDT')) continue;
        const base = symbol.replace(/USDT$/i, '');
        if (STABLE_COINS && STABLE_COINS.includes(base)) continue;
        if (this.symbols.has(symbol)) continue;
        this.symbols.add(symbol);
        this.initSymbol(symbol);
      }
      info('REST fetched symbols', this.symbols.size);
    } catch (e) {
      warn('fetchSymbolsByREST error', e && e.message ? e.message : e);
    }
  }

  _subscribeAll() {
    for (const symbol of this.symbols) {
      for (const tf of Object.keys(this.symbolData[symbol] || {})) {
        this.ws.subKline(symbol, tf);
      }
    }
    info('Subscribed to klines for', this.symbols.size, 'symbols');
    this.emit('subscribed', { symbolCount: this.symbols.size });
  }

  async handleWSMessage(msg) {
    try {
      if (!msg || !msg.topic) return;
      if (!msg.topic.startsWith('kline')) return;
      const parts = msg.topic.split('.');
      const rawInterval = parts[1];
      let symbol = parts[2];
      if (parts[2] === 'linear' && parts[3]) symbol = parts[3];
      if (!symbol) symbol = parts[parts.length - 1];
      const tf = normalizeIntervalToTf(rawInterval);
      const msgData = msg.data || msg;
      const klineData = msgData.k || msgData;
      const candles = Array.isArray(klineData) ? klineData : [klineData];
      for (const k of candles) {
        const rawStart = k.start || k.t || k.open_time || k.ts || k[0];
        const startSec = normalizeStartToSeconds(rawStart);
        const open = Number(k.o ?? k.open ?? k[1] ?? 0);
        const close = Number(k.c ?? k.close ?? k[4] ?? 0);
        const volume = Number(k.v ?? k.volume ?? k[7] ?? 0);
        if (!startSec || !symbol) continue;
        await this.onCandle(String(symbol).toUpperCase(), String(tf), startSec, open, close, volume);
      }
    } catch (e) {
      debug('handleWSMessage error', e && e.message ? e.message : e);
    }
  }

  // REPLACED onCandle: only run root checks and MTF alignment on new 5m candle opens.
  // Non-5m updates only update MACD state.
  async onCandle(symbol, tf, startSec, open, close, volume) {
    // ensure symbol/tf tracked
    if (!this.symbolData[symbol] || !this.symbolData[symbol][tf]) {
      debug('onCandle: symbol/tf not tracked', symbol, tf);
      return;
    }

    // If not a 5m message: update MACD state only and emit macd_update; do not scan
    if (String(tf) !== '5') {
      const bucket = this.symbolData[symbol][tf];
      bucket.lastClose = close;
      try {
        const res = bucket.macd.update(close);
        this.emit('macd_update', { symbol, tf, input: close, result: res });
        if (res && res.prevHist != null && !bucket.macdReady) {
          bucket.macdReady = true;
          this.emit('macd_ready', { symbol, tf, source: 'macd_update_non5' });
        }
      } catch (e) {
        debug('macd update error (non-5m)', { symbol, tf, err: e && e.message ? e.message : e });
      }
      return;
    }

    // Handle 5m kline (we synchronize scans to 5m opens)
    const buckets = this.symbolData[symbol];
    const bucket5 = buckets['5'];
    const isNew = bucket5.lastCandleStart !== startSec;

    // same 5m candle updates: update MACD and return
    if (!isNew) {
      bucket5.lastClose = close;
      try {
        const r = bucket5.macd.update(close);
        this.emit('macd_update', { symbol, tf: '5', input: close, result: r });
        if (r && r.prevHist != null && !bucket5.macdReady) {
          bucket5.macdReady = true;
          this.emit('macd_ready', { symbol, tf: '5', source: 'macd_update_same5' });
        }
      } catch (e) {
        debug('macd update error same 5m', e && e.message ? e.message : e);
      }
      return;
    }

    // NEW 5m candle open -> drive scanning for this symbol
    debug('5m CANDLE OPEN', symbol, new Date(startSec * 1000).toISOString(), 'close', close);

    // update 5m bucket state
    bucket5.lastClose = close;
    bucket5.lastCandleStart = startSec;

    // Feed new 5m close into every TF's MACD for this symbol, gather results
    const macdResults = {};
    for (const t of Object.keys(buckets)) {
      const b = buckets[t];
      try {
        const res = b.macd.update(close);
        b.lastClose = close;
        macdResults[t] = res || null;
        this.emit('macd_live_update', { symbol, tf: t, input: close, result: res || null });
        if (res && res.prevHist != null && !b.macdReady) {
          b.macdReady = true;
          this.emit('macd_ready', { symbol, tf: t, source: 'after_5m_feed' });
        }
      } catch (e) {
        debug('macd feed error', { symbol, tf: t, err: e && e.message ? e.message : e });
        macdResults[t] = null;
      }
    }

    // For each root TF, run flip-check using newly-updated macdResults
    for (const rootTf of Array.from(new Set(ROOT_TFS || []))) {
      const r = macdResults[rootTf];
      const bucket = buckets[rootTf];
      if (!bucket) {
        this.emit('root_tf_check_skipped', { symbol, tf: rootTf, reason: 'no_bucket' });
        continue;
      }
      if (!r || typeof r.prevHist === 'undefined' || r.prevHist === null) {
        this.emit('root_tf_check_skipped', { symbol, tf: rootTf, macdReady: bucket.macdReady, hasPrevResult: !!(r && r.prevHist != null) });
        continue;
      }
      try {
        await this._checkRootFlip(symbol, rootTf, { hist: r.hist, prevHist: r.prevHist, macd: r.macd, signal: r.signal }, volume);
      } catch (e) {
        debug('checkRootFlip error (5m-driven)', { symbol, tf: rootTf, err: e && e.message ? e.message : e });
      }
    }

    // After root checks, emit a single candle_open (tf='5') so MTF/alerter evaluate once per 5m open
    try {
      this.emit('candle_open', { symbol, tf: '5', start: startSec, open, close, volume, macdResults });
    } catch (e) {
      debug('emit candle_open error', e && e.message ? e.message : e);
    }
  }

  async _checkRootFlip(symbol, tf, macdResult, volume) {
    if (!macdResult) return;
    const { hist, prevHist } = macdResult;
    if (prevHist == null || hist == null) {
      this.emit('checkRootFlip_prevHist_null', { symbol, tf, macdResult });
      return;
    }

    const cfg = require('./config');
    const threshold = cfg.MACD_HIST_POSITIVE_THRESHOLD ?? 0;
    const eps = Number(process.env.MACD_EPS || 1e-6);

    debug('checkRootFlip values', { symbol, tf, prevHist, hist, threshold, eps });

    let crossedUp = false;
    if (typeof prevHist === 'number' && typeof hist === 'number') {
      if (prevHist < -eps && hist > eps) crossedUp = true;
      else if (prevHist < threshold && hist >= threshold) crossedUp = true;
      else if (prevHist < 0 && hist >= 0) crossedUp = true;
    }

    debug('checkRootFlip decision', { symbol, tf, crossedUp });

    if (!crossedUp) {
      this.emit('root_no_cross', { symbol, tf, prevHist, hist });
      return;
    }

    // apply filters
    let metrics = null;
    try { metrics = await this.fetch24hForSymbol(symbol); } catch (e) { debug('fetch24hForSymbol error', e && e.message ? e.message : e); }
    const pct24 = metrics ? metrics.price24hChangePct : 0;
    const vol24 = metrics ? metrics.vol24 : volume;

    if (pct24 < MIN_24H_PRICE_CHANGE_PCT) {
      this.emit('root_flip_filtered', { symbol, tf, reason: 'price', pct24 });
      return;
    }
    if (vol24 < MIN_24H_VOL_CHANGE_PCT) {
      this.emit('root_flip_filtered', { symbol, tf, reason: 'vol', vol24 });
      return;
    }

    // create/persist root
    const key = `${symbol}|${tf}|${this.symbolData[symbol][tf].lastCandleStart}`;
    const prev = this.activeRootSignals[key];
    if (prev && prev.id) {
      try { delete this.rootIndex[prev.id]; } catch (e) {}
      this.emit('root_duplicate_overwritten', { key, prevId: prev.id, symbol, tf });
    }

    const id = uuid();
    const startSec = this.symbolData[symbol][tf].lastCandleStart;
    const tfSeconds = (tf === 'D' ? 24 * 3600 : Number(tf) * 60);
    const sig = {
      id,
      type: 'root',
      symbol,
      tf,
      strength: Math.max(0, hist) + Math.max(0, (pct24 || 0) / 100),
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
    info('✓ ROOT SIGNAL CREATED', id, symbol, tf, 'startSec', startSec);
    try { this.emit('root_signal', sig); } catch (e) { debug('emit root_signal error', e && e.message ? e.message : e); }
    this.emit('root_created', { sig, key });

    // schedule expiry
    const ttlMs = Math.max(0, sig.expires * 1000 - Date.now());
    setTimeout(() => {
      try {
        sig.status = 'expired';
        delete this.activeRootSignals[key];
        delete this.rootIndex[id];
        const s2 = readSignals();
        s2.push({ id: uuid(), type: 'meta', msg: `root_expired ${symbol} ${tf}`, ts: Date.now() });
        writeSignals(s2);
        this.emit('root_expired', sig);
        info('Root signal expired', key);
      } catch (e) { debug('expiry handler error', e && e.message ? e.message : e); }
    }, Math.min(ttlMs, 0x7fffffff - 1));
  }

  async fetch24hForSymbol(symbol) {
    try {
      const resp = await this.rest.getTickers(symbol);
      const item = resp?.result?.list || resp?.result || resp?.data || [];
      const first = item?.[0] || item;
      if (!first) return null;
      const price24hChangePct = Number(first.price_24h_pcnt ?? first.change_24h ?? first.px_24h ?? 0) * 100;
      const vol24 = Number(first.turnover_24h ?? first.volume_24h ?? first.quote_volume ?? 0);
      return { price24hChangePct, vol24, raw: first };
    } catch (e) {
      debug('fetch24h error', e && e.message ? e.message : e);
      return null;
    }
  }

  getActiveRootSignals() {
    return Object.values(this.activeRootSignals);
  }

  getSymbolStatus(symbol) {
    return this.symbolData[symbol] || null;
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

  // seedHistorical kept simple but deterministic: feed closes oldest->newest
  async seedHistorical() {
    if (this.seeding) return { started: false, reason: 'already' };
    this.seeding = true;
    this.lastSeedAt = null;
    const all = Array.from(this.symbols);
    const limit = SEED_SYMBOLS_LIMIT > 0 ? Math.min(SEED_SYMBOLS_LIMIT, all.length) : all.length;
    const tfs = Array.from(new Set([...(ROOT_TFS || []), ...(MTF_TFS || [])]));
    let processed = 0, seeded = 0, macdReadyCount = 0;
    for (let i = 0; i < limit; i += SEED_BATCH_SIZE) {
      const batch = all.slice(i, i + SEED_BATCH_SIZE);
      await Promise.all(batch.map(async (symbol) => {
        for (const tf of tfs) {
          try {
            const resp = await this.rest.getKlines(symbol, tf, HIST_LOOKBACK);
            const list = resp?.result?.list || resp?.result || resp?.data || [];
            const candles = Array.isArray(list) ? list.slice().reverse() : [];
            for (const c of candles) {
              const close = Number(c.close ?? c.k?.c ?? c.c ?? c[4]);
              if (!Number.isFinite(close)) continue;
              const sdata = this.symbolData[symbol] && this.symbolData[symbol][tf];
              if (!sdata) continue;
              const result = sdata.macd.update(close);
              sdata.lastClose = close;
              if (result && result.prevHist != null && !sdata.macdReady) {
                sdata.macdReady = true;
                macdReadyCount++;
              }
              seeded++;
            }
          } catch (e) { debug('seed error', symbol, tf, e && e.message ? e.message : e); }
        }
        processed++;
      }));
      await sleep(SEED_BATCH_DELAY_MS);
    }
    this.seeding = false;
    this.lastSeedAt = Date.now();
    info('Seeding complete', { processed, seeded, macdReadyCount });
    this.emit('seed_complete', { processed, seeded, macdReadyCount });
    return { started: true, processed, seeded, macdReadyCount, completedAt: this.lastSeedAt };
  }
}

module.exports = Scanner;