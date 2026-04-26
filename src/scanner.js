// scanner.js - 5m-driven scanner: seed once on 5m historical candles, update all TF MACDs on every 5m open,
// run root-TF flip checks and MTF evaluation at each 5m candle open for every symbol.
//
// Key idea: fetch 5m history per symbol (one REST call each), feed that series to every TF's MACD instance
// (so MACDs for 1h/4h/D are primed), then use live 5m candle opens to update all MACDs and run checks.
// This minimizes REST calls (N_symbols calls) and makes the live checks fast in-memory loops.
const EventEmitter = require('events');
const BybitWS = require('./bybit-ws');
const BybitREST = require('./bybit-rest');
const { MACD } = require('./indicators');
const { readSignals, writeSignals } = require('./storage');
const { info, debug, warn } = require('./logger');
const {
  STABLE_COINS,
  ROOT_TFS = ['60', '240', 'D'],
  MTF_TFS = ['5','15','60','240','D'],
  PUSH_SIGNALS_ON_START,
  MIN_24H_VOL_CHANGE_PCT,
  MIN_24H_PRICE_CHANGE_PCT,
  SEED_HISTORICAL = true,
  HIST_LOOKBACK = 200,         // number of 5m candles to fetch when seeding
  SEED_SYMBOLS_LIMIT = 0,
  SEED_BATCH_SIZE = 25,
  SEED_BATCH_DELAY_MS = 200,
  VERBOSE_LOG = false
} = require('./config');
const uuid = require('uuid').v4;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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
    this.activeRootSignals = {}; // key->sig
    this.rootIndex = {}; // id->key
    this.seeding = false;
    this.lastSeedAt = null;
    this.ready = false;

    // WS handlers
    this.ws.on('message', (msg) => this.handleWSMessage(msg));
    this.ws.on('connected', () => debug('WS connected in scanner'));

    // load persisted signals
    this._loadPersisted();

    // replay persisted roots to listeners
    this.on('newListener', (ev) => {
      if (ev === 'root_signal') {
        const roots = Object.values(this.activeRootSignals);
        if (!roots || roots.length === 0) return;
        setImmediate(() => {
          for (const r of roots) {
            try { this.emit('root_signal', r); } catch (e) { debug('replay root_signal err', e && e.message ? e.message : e); }
          }
        });
      }
    });
  }

  _loadPersisted() {
    try {
      const arr = readSignals() || [];
      const roots = arr.filter(x => x.type === 'root' && x.status === 'active');
      for (const r of roots) {
        const key = `${r.symbol}|${r.tf}|${r.start}`;
        this.activeRootSignals[key] = r;
        if (r.id) this.rootIndex[r.id] = key;
      }
      info('Loaded persisted root signals', Object.keys(this.activeRootSignals).length);
      this.emit('signals_loaded', { count: Object.keys(this.activeRootSignals).length });
    } catch (e) { debug('persisted load err', e && e.message ? e.message : e); }
  }

  initSymbol(symbol) {
    if (!this.symbolData[symbol]) {
      this.symbolData[symbol] = {};
      const tfs = Array.from(new Set([...(ROOT_TFS || []), ...(MTF_TFS || [])]));
      for (const tf of tfs) {
        this.symbolData[symbol][tf] = {
          macd: new MACD(),
          lastClose: null,
          lastCandleStart: null,
          macdReady: false
        };
      }
      this.emit('symbol_tracked', { symbol, tfs });
    }
  }

  // start: discover symbols, optionally seed using 5m history, subscribe klines, and become ready
  async start() {
    this.ws.connect();
    await this._fetchSymbols();
    if (SEED_HISTORICAL) {
      await this.seedHistorical5mOnly();
    }
    this._subscribeAll5m();
    if (PUSH_SIGNALS_ON_START) this.emit('startup');
    this.ready = true;
    info('Scanner ready');
  }

  // fetch symbol list via REST (same logic as before)
  async _fetchSymbols() {
    try {
      const resp = await this.rest.getSymbols();
      let list = resp?.result?.list || resp?.result || resp?.data || [];
      if (!Array.isArray(list) && Array.isArray(resp)) list = resp;
      if (!Array.isArray(list) && typeof list === 'object' && list !== null) {
        list = Array.isArray(list.symbols) ? list.symbols : Object.values(list);
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
      warn('fetchSymbols error', e && e.message ? e.message : e);
    }
  }

  // Subscribe only to 5m klines for every symbol (live updates come on 5m opens)
  _subscribeAll5m() {
    for (const symbol of this.symbols) {
      try { this.ws.subKline(symbol, '5'); } catch (e) { debug('subKline err', e && e.message ? e.message : e); }
    }
    info('Subscribed to 5m klines for', this.symbols.size, 'symbols');
    this.emit('subscribed', { symbolCount: this.symbols.size });
  }

  // handle WS messages (expect kline topics) — we only care about 5m here
  async handleWSMessage(msg) {
    if (!msg || !msg.topic) return;
    if (!msg.topic.startsWith('kline')) return;
    const parts = msg.topic.split('.');
    const rawInterval = parts[1];
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
      const symbol = (msgData.s || msgData.symbol || parts[parts.length - 1] || k.s || k.symbol);
      if (!startSec || !symbol) continue;
      // We assume server only subscribed to 5m; if tf !== '5' ignore.
      await this.onCandle(String(symbol).toUpperCase(), String(tf), startSec, open, close, volume);
    }
  }

  // Main onCandle: if 5m new candle open, update every TF's MACD for that symbol with the new 5m close,
  // then run root checks for each root TF and evaluate MTF for active roots.
  async onCandle(symbol, tf, startSec, open, close, volume) {
    // only process symbols we know
    if (!this.symbolData[symbol] || !this.symbolData[symbol]['5']) {
      debug('onCandle: symbol/tf not tracked', symbol, tf);
      return;
    }
    const sdataAll = this.symbolData[symbol];
    const sdata5 = sdataAll['5'];
    const isNew = sdata5.lastCandleStart !== startSec;

    if (isNew && tf === '5') {
      // new 5m open for symbol
      debug('5m CANDLE OPEN', symbol, 'start', new Date(startSec * 1000).toISOString(), 'close', close);

      // 1) compute a prev-state if needed for 5m macd
      let prev5 = null;
      try {
        if (sdata5.macd && typeof sdata5.macd.prevHist !== 'undefined' && sdata5.macd.prevHist !== null) {
          prev5 = { hist: sdata5.macd.hist, prevHist: sdata5.macd.prevHist };
        } else if (sdata5.lastClose != null) {
          prev5 = sdata5.macd.update(sdata5.lastClose);
          this.emit('macd_prev_result', { symbol, tf: '5', macdPrevResult: prev5 });
        }
      } catch (e) { debug('prev5 compute err', e && e.message ? e.message : e); }

      // 2) update lastClose/start for 5m
      sdata5.lastClose = close;
      sdata5.lastCandleStart = startSec;

      // 3) Feed this new 5m close into EVERY TF's MACD for this symbol (keeps higher-TF MACDs "live")
      const allTfs = Object.keys(sdataAll);
      for (const t of allTfs) {
        try {
          const bucket = sdataAll[t];
          // compute prev for that tf if not present (attempt using lastClose)
          let prev = null;
          if (bucket.macd && typeof bucket.macd.prevHist !== 'undefined' && bucket.macd.prevHist !== null) {
            prev = { hist: bucket.macd.hist, prevHist: bucket.macd.prevHist };
            if (!bucket.macdReady) { bucket.macdReady = true; this.emit('macd_ready', { symbol, tf: t, source: 'existing' }); }
          } else if (bucket.lastClose != null) {
            prev = bucket.macd.update(bucket.lastClose);
            if (prev && prev.prevHist != null && !bucket.macdReady) { bucket.macdReady = true; this.emit('macd_ready', { symbol, tf: t, source: 'feed_lastClose' }); }
            this.emit('macd_prev_result', { symbol, tf: t, macdPrevResult: prev });
          }
          // Now update with the new 5m close (this approximates continuous updates for higher TFs)
          bucket.lastClose = close;
          const nowR = bucket.macd.update(close);
          // if nowR has prevHist set and not macdReady set it
          if (nowR && nowR.prevHist != null && !bucket.macdReady) { bucket.macdReady = true; this.emit('macd_ready', { symbol, tf: t, source: 'after_update' }); }
          this.emit('macd_live_update', { symbol, tf: t, input: close, result: nowR });
        } catch (e) { debug('feed allTFs err', symbol, t, e && e.message ? e.message : e); }
      }

      // 4) For each ROOT_TF, run checkRootFlip using the updated MACD state
      for (const rootTf of Array.from(new Set(ROOT_TFS || []))) {
        const bucket = sdataAll[rootTf];
        if (!bucket) continue;
        const macdObj = bucket.macd;
        // require macdReady and prevHist available
        if (bucket.macdReady && typeof macdObj.prevHist !== 'undefined' && macdObj.prevHist !== null) {
          const macdResult = { hist: macdObj.hist, prevHist: macdObj.prevHist, macd: macdObj.macd, signal: macdObj.get ? macdObj.get('signal') : null };
          try {
            await this._checkRootFlip(symbol, rootTf, macdResult, volume);
          } catch (e) { debug('checkRootFlip rootTf err', e && e.message ? e.message : e); }
        } else {
          this.emit('root_tf_check_skipped', { symbol, tf: rootTf, macdReady: bucket.macdReady, hasPrevResult: !!(macdObj && macdObj.prevHist != null) });
        }
      }

      // 5) Evaluate MTF for active roots for this symbol (quick)
      const activeRoots = Object.values(this.activeRootSignals).filter(r => r.symbol === symbol);
      for (const r of activeRoots) {
        try { this.emit('evaluate_mtf', { root: r }); } catch(e) { debug('emit evaluate_mtf err', e && e.message ? e.message : e); }
      }

      // 6) done
      this.emit('candle_open', { symbol, tf: '5', start: startSec, open, close, volume });
    } else {
      // not a new 5m candle or not tf '5' - ignore other TFs (we only subscribe to 5m)
      // but we still keep lastClose updated for same-5m updates if any
      const bucket = this.symbolData[symbol] && this.symbolData[symbol]['5'];
      if (bucket) {
        bucket.lastClose = close;
        try { const res = bucket.macd.update(close); this.emit('macd_update', { symbol, tf: '5', input: close, result: res }); } catch(e){ debug('macd_update err', e && e.message ? e.message : e); }
      }
    }
  }

  // checkRootFlip (same robust logic as before)
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
    debug('checkRootFlip hist check', { symbol, tf, prevHist, hist, threshold, eps });

    let crossedUp = false;
    if (typeof prevHist === 'number' && typeof hist === 'number') {
      if (prevHist < -eps && hist > eps) crossedUp = true;
      else if (prevHist < threshold && hist >= threshold) crossedUp = true;
      else if (prevHist < 0 && hist >= 0) crossedUp = true;
    }

    debug('checkRootFlip evaluated crossedUp', { symbol, tf, crossedUp });
    if (!crossedUp) { this.emit('root_no_cross', { symbol, tf, prevHist, hist }); return; }

    // filters
    let metrics = null;
    try { metrics = await this.fetch24hForSymbol(symbol); } catch (e) { debug('fetch24h err', e && e.message ? e.message : e); }
    const pct24 = metrics ? metrics.price24hChangePct : 0;
    const vol24 = metrics ? metrics.vol24 : volume;
    if (pct24 < MIN_24H_PRICE_CHANGE_PCT) { this.emit('root_flip_filtered', { symbol, tf, reason: 'price', pct24 }); return; }
    if (vol24 < MIN_24H_VOL_CHANGE_PCT) { this.emit('root_flip_filtered', { symbol, tf, reason: 'vol', vol24 }); return; }

    // create signal
    const key = `${symbol}|${tf}|${this.symbolData[symbol][tf].lastCandleStart}`;
    const prev = this.activeRootSignals[key];
    if (prev && prev.id) { try { delete this.rootIndex[prev.id]; } catch(e){} this.emit('root_duplicate_overwritten', { key, prevId: prev.id, symbol, tf }); }

    const id = uuid();
    const startSec = this.symbolData[symbol][tf].lastCandleStart;
    const tfSeconds = (tf === 'D' ? 24 * 3600 : Number(tf) * 60);
    const sig = { id, type: 'root', symbol, tf, strength: Math.max(0, hist) + Math.max(0, (pct24 || 0) / 100), pct24, vol24, start: startSec, expires: startSec + tfSeconds, status: 'active', mtf: null, created: Date.now() };

    this.activeRootSignals[key] = sig;
    this.rootIndex[id] = key;
    const s = readSignals(); s.push(sig); writeSignals(s);
    info('✓ ROOT SIGNAL CREATED', id, symbol, tf, 'startSec', startSec);
    try { this.emit('root_signal', sig); } catch (e) { debug('emit root_signal err', e && e.message ? e.message : e); }
    this.emit('root_created', { sig, key });

    // schedule expiry
    const ttlMs = Math.max(0, sig.expires * 1000 - Date.now());
    setTimeout(() => {
      try {
        sig.status = 'expired';
        delete this.activeRootSignals[key];
        delete this.rootIndex[id];
        const s2 = readSignals(); s2.push({ id: uuid(), type: 'meta', msg: `root_expired ${symbol} ${tf}`, ts: Date.now() }); writeSignals(s2);
        this.emit('root_expired', sig);
        info('Root signal expired', key);
      } catch (e) { debug('expiry err', e && e.message ? e.message : e); }
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
    } catch (e) { debug('fetch24h err', e && e.message ? e.message : e); return null;}
  }

  getActiveRootSignals() { return Object.values(this.activeRootSignals); }
  getSymbolStatus(symbol) { return this.symbolData[symbol] || null; }

  updateRootMTF(rootId, mtfInfo) {
    const key = this.rootIndex[rootId]; if (!key) return null;
    const sig = this.activeRootSignals[key]; if (!sig) return null;
    sig.mtf = mtfInfo;
    const s = readSignals(); s.push({ id: uuid(), type: 'mtf', rootId, symbol: sig.symbol, tf: sig.tf, detail: mtfInfo, created: Date.now() });
    writeSignals(s);
    this.emit('root_updated', { rootId, sig });
    return sig;
  }

  // seed: fetch only 5m historical candles for each symbol, then feed those prices into each TF's MACD to prime them.
  async seedHistorical5mOnly() {
    if (this.seeding) return { started: false, reason: 'already' };
    this.seeding = true;
    this.lastSeedAt = null;
    const allSymbols = Array.from(this.symbols);
    const limit = SEED_SYMBOLS_LIMIT > 0 ? Math.min(SEED_SYMBOLS_LIMIT, allSymbols.length) : allSymbols.length;
    const symbols = allSymbols.slice(0, limit);
    info('Seeding 5m history for', symbols.length, 'symbols (5m lookback', HIST_LOOKBACK, ')');

    let totalFetched = 0, totalProcessed = 0, macdReady = 0;
    for (let i = 0; i < symbols.length; i += SEED_BATCH_SIZE) {
      const batch = symbols.slice(i, i + SEED_BATCH_SIZE);
      await Promise.all(batch.map(async (symbol) => {
        try {
          // fetch 5m klines only
          const resp = await this.rest.getKlines(symbol, '5', HIST_LOOKBACK);
          const list = resp?.result?.list || resp?.result || resp?.data || [];
          const candles = Array.isArray(list) ? list.slice().reverse() : [];
          totalFetched += candles.length;
          // feed each close into all TF MACDs for this symbol
          for (const c of candles) {
            const close = Number(c.close ?? c.k?.c ?? c.c ?? c[4]);
            if (!Number.isFinite(close)) continue;
            const sdata = this.symbolData[symbol];
            if (!sdata) continue;
            for (const tf of Object.keys(sdata)) {
              try {
                const bucket = sdata[tf];
                const res = bucket.macd.update(close);
                bucket.lastClose = close;
                // mark macdReady if prevHist present
                if (res && res.prevHist != null && !bucket.macdReady) { bucket.macdReady = true; macdReady++; this.emit('macd_ready_seed', { symbol, tf }); }
              } catch (e) { /* ignore individual MACD update errors per tf */ }
            }
            totalProcessed++;
          }
        } catch (e) {
          debug('seed fetch error', symbol, e && e.message ? e.message : e);
          this.emit('seed_symbol_error', { symbol, err: e && e.message ? e.message : e });
        }
      }));
      // small pause to avoid bursts
      await sleep(SEED_BATCH_DELAY_MS);
      this.emit('seed_batch_complete', { batchIndex: Math.floor(i / SEED_BATCH_SIZE) + 1, batchSize: batch.length });
    }

    this.seeding = false;
    this.lastSeedAt = Date.now();
    info('Seeding complete', { totalFetched, totalProcessed, macdReady, completedAt: new Date(this.lastSeedAt).toISOString() });
    this.emit('seed_complete', { totalFetched, totalProcessed, macdReady, completedAt: this.lastSeedAt });
    return { started: true, totalFetched, totalProcessed, macdReady, completedAt: this.lastSeedAt };
  }
}

module.exports = Scanner;
