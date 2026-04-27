// scanner.js - focused 5m-driven scanner optimized for fast root+MTF scans
// - Seed 5m history per symbol and feed into every TF's MACD
// - On each new 5m candle open: feed the 5m close into every TF's MACD,
//   run root TF flip checks for configured ROOT_TFS, then emit one candle_open
// - Short-lived ticker cache to avoid per-symbol REST calls during a scan
const EventEmitter = require('events');
const BybitWS = require('./bybit-ws');
const BybitREST = require('./bybit-rest');
const { MACD } = require('./indicators');
const { readSignals, writeSignals } = require('./storage');
const { info, debug, warn } = require('./logger');
const {
  STABLE_COINS,
  ROOT_TFS = ['60','240','D'],
  MTF_TFS = ['5','15','60','240','D'],
  PUSH_SIGNALS_ON_START,
  MIN_24H_VOL_CHANGE_PCT = 0,
  MIN_24H_PRICE_CHANGE_PCT = 0,
  SEED_HISTORICAL = true,
  HIST_LOOKBACK = 288,           // number of 5m candles (default ~1 day)
  SEED_SYMBOLS_LIMIT = 0,
  SEED_BATCH_SIZE = 25,
  SEED_BATCH_DELAY_MS = 200
} = require('./config') || {};
const uuid = require('uuid').v4;

// Tunables via env
const FLIP_PERSISTENCE = Number(process.env.FLIP_PERSISTENCE || 1); // consecutive 5m confirmations
const TICKER_CACHE_MS = Number(process.env.TICKER_CACHE_MS || 30 * 1000); // cache tickers for 30s

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
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
    this.symbolData = {}; // symbol -> tf -> { macd, lastClose, lastCandleStart, macdReady, flipStreak }
    this.activeRootSignals = {}; // key -> sig
    this.rootIndex = {}; // id -> key
    this.seeding = false;
    this.lastSeedAt = null;
    this.tickerCache = {}; // symbol -> { ts, data }

    this.ws.on('message', (m) => this.handleWSMessage(m));
    this.ws.on('connected', () => debug('WS connected in scanner'));
    this._loadPersisted();
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
    } catch (e) {
      debug('persisted load err', e && e.message ? e.message : e);
    }
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
          macdReady: false,
          flipStreak: 0
        };
      }
      this.emit('symbol_tracked', { symbol, tfs: Object.keys(this.symbolData[symbol]) });
    }
  }

  async start() {
    this.ws.connect();
    await this._fetchSymbols();
    if (SEED_HISTORICAL) await this.seed5mHistory();
    this._subscribe5m();
    if (PUSH_SIGNALS_ON_START) this.emit('startup');
    this.ready = true;
    info('Scanner started and ready');
  }

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
      info('Symbols loaded', this.symbols.size);
    } catch (e) {
      warn('fetchSymbolsByREST error', e && e.message ? e.message : e);
    }
  }

  _subscribe5m() {
    for (const symbol of this.symbols) {
      try { this.ws.subKline(symbol, '5'); } catch (e) { debug('subKline err', e && e.message ? e.message : e); }
    }
    info('Subscribed to 5m klines for', this.symbols.size, 'symbols');
    this.emit('subscribed', { symbolCount: this.symbols.size });
  }

  async handleWSMessage(msg) {
    try {
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
        const symbol = (k.s || msgData.s || msgData.symbol || parts[parts.length - 1]);
        if (!startSec || !symbol) continue;
        await this.onCandle(String(symbol).toUpperCase(), String(tf), startSec, open, close, volume);
      }
    } catch (e) {
      debug('handleWSMessage error', e && e.message ? e.message : e);
    }
  }

  // Fast cached ticker lookup to avoid per-symbol REST calls during a full scan
  async fetch24hForSymbolCached(symbol) {
    const now = Date.now();
    const cached = this.tickerCache[symbol];
    if (cached && (now - cached.ts) < TICKER_CACHE_MS) return cached.data;
    try {
      const resp = await this.rest.getTickers(symbol);
      const item = resp?.result?.list || resp?.result || resp?.data || [];
      const first = item?.[0] || item;
      if (!first) return null;
      const price24hChangePct = Number(first.price_24h_pcnt ?? first.change_24h ?? first.px_24h ?? 0) * 100;
      const vol24 = Number(first.turnover_24h ?? first.volume_24h ?? first.quote_volume ?? 0);
      const data = { price24hChangePct, vol24, raw: first };
      this.tickerCache[symbol] = { ts: now, data };
      return data;
    } catch (e) {
      debug('fetch24hForSymbolCached error', symbol, e && e.message ? e.message : e);
      return null;
    }
  }

  // onCandle: non-5m updates only update MACD state, 5m new candle opens drive full scan per symbol
  async onCandle(symbol, tf, startSec, open, close, volume) {
    if (!this.symbolData[symbol] || !this.symbolData[symbol][tf]) {
      debug('onCandle: not tracked', symbol, tf);
      return;
    }

    // Non-5m updates: update MACD only
    if (String(tf) !== '5') {
      const bucket = this.symbolData[symbol][tf];
      bucket.lastClose = close;
      try {
        const res = bucket.macd.update(close);
        this.emit('macd_update', { symbol, tf, input: close, result: res });
        if (res && res.prevHist != null && !bucket.macdReady) {
          bucket.macdReady = true;
          this.emit('macd_ready', { symbol, tf, source: 'non5_update' });
        }
      } catch (e) {
        debug('macd update error non5', e && e.message ? e.message : e);
      }
      return;
    }

    // 5m handling
    const buckets = this.symbolData[symbol];
    const bucket5 = buckets['5'];
    const isNew = bucket5.lastCandleStart !== startSec;

    // Same 5m candle (intrabar) update: just update 5m MACD
    if (!isNew) {
      bucket5.lastClose = close;
      try {
        const r = bucket5.macd.update(close);
        this.emit('macd_update', { symbol, tf: '5', input: close, result: r });
        if (r && r.prevHist != null && !bucket5.macdReady) {
          bucket5.macdReady = true;
          this.emit('macd_ready', { symbol, tf: '5', source: 'same5_update' });
        }
      } catch (e) {
        debug('macd update error same 5m', e && e.message ? e.message : e);
      }
      return;
    }

    // NEW 5m open -> fast in-memory scan for this symbol
    debug('5m CANDLE OPEN', symbol, new Date(startSec * 1000).toISOString(), 'close', close);
    bucket5.lastClose = close;
    bucket5.lastCandleStart = startSec;

    // Feed 5m close into every TF's MACD for this symbol and collect results
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

    // Evaluate root TF flips using same robust logic; use FLIP_PERSISTENCE to avoid transients
    const cfg = require('./config');
    const threshold = cfg.MACD_HIST_POSITIVE_THRESHOLD ?? 0;
    const eps = Number(process.env.MACD_EPS || 1e-6);

    for (const rootTf of Array.from(new Set(ROOT_TFS || []))) {
      const res = macdResults[rootTf];
      const bucket = buckets[rootTf];
      if (!bucket) {
        this.emit('root_tf_check_skipped', { symbol, tf: rootTf, reason: 'no_bucket' });
        continue;
      }
      if (!res || typeof res.prevHist === 'undefined' || res.prevHist === null) {
        bucket.flipStreak = 0;
        this.emit('root_tf_check_skipped', { symbol, tf: rootTf, macdReady: bucket.macdReady, hasPrevResult: false });
        continue;
      }

      const { prevHist, hist } = res;
      let crossedUp = false;
      if (typeof prevHist === 'number' && typeof hist === 'number') {
        if (prevHist < -eps && hist > eps) crossedUp = true;
        else if (prevHist < threshold && hist >= threshold) crossedUp = true;
        else if (prevHist < 0 && hist >= 0) crossedUp = true;
      }

      if (crossedUp) bucket.flipStreak = (bucket.flipStreak || 0) + 1;
      else bucket.flipStreak = 0;

      this.emit('root_flip_streak', { symbol, tf: rootTf, crossedUp, streak: bucket.flipStreak, threshold, eps });

      if (bucket.flipStreak >= FLIP_PERSISTENCE) {
        // confirmed flip -> create root (use same filters)
        // reset streak to avoid immediate duplicates
        bucket.flipStreak = 0;

        // quick fetch cached 24h metrics
        const metrics = await this.fetch24hForSymbolCached(symbol);
        const pct24 = metrics ? metrics.price24hChangePct : 0;
        const vol24 = metrics ? metrics.vol24 : volume;

        if (pct24 < MIN_24H_PRICE_CHANGE_PCT) {
          this.emit('root_flip_filtered', { symbol, tf: rootTf, reason: 'price', pct24 });
        } else if (vol24 < MIN_24H_VOL_CHANGE_PCT) {
          this.emit('root_flip_filtered', { symbol, tf: rootTf, reason: 'vol', vol24 });
        } else {
          // create root
          const key = `${symbol}|${rootTf}|${this.symbolData[symbol][rootTf].lastCandleStart}`;
          const prevSig = this.activeRootSignals[key];
          if (prevSig && prevSig.id) {
            try { delete this.rootIndex[prevSig.id]; } catch (e) {}
            this.emit('root_duplicate_overwritten', { key, prevId: prevSig.id, symbol, tf: rootTf });
          }
          const id = uuid();
          const startSec = this.symbolData[symbol][rootTf].lastCandleStart;
          const tfSeconds = (rootTf === 'D' ? 24 * 3600 : Number(rootTf) * 60);
          const sig = {
            id,
            type: 'root',
            symbol,
            tf: rootTf,
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
          s.push(sig); writeSignals(s);
          info('✓ ROOT SIGNAL CREATED', id, symbol, rootTf, 'startSec', startSec);
          try { this.emit('root_signal', sig); } catch (e) { debug('emit root_signal err', e && e.message ? e.message : e); }
          this.emit('root_created', { sig, key });
        }
      } else {
        this.emit('root_no_persistence', { symbol, tf: rootTf, streak: bucket.flipStreak, required: FLIP_PERSISTENCE });
      }
    }

    // After scanning all root TFs for this symbol at this 5m open, emit a single candle_open so MTF runs in sync
    try {
      this.emit('candle_open', { symbol, tf: '5', start: startSec, open, close, volume, macdResults });
    } catch (e) {
      debug('emit candle_open error', e && e.message ? e.message : e);
    }
  }

  async fetch24hForSymbolCached(symbol) {
    // implemented above but accessible here as well
    return this.fetch24hForSymbolCachedImpl ? this.fetch24hForSymbolCachedImpl(symbol) : this.fetch24hForSymbolCached(symbol);
  }

  // Note: fetch24hForSymbolCached is defined earlier; for clarity keep a local alias
  async fetch24hForSymbolCachedImpl(symbol) {
    const now = Date.now();
    const cached = this.tickerCache[symbol];
    if (cached && (now - cached.ts) < TICKER_CACHE_MS) return cached.data;
    try {
      const resp = await this.rest.getTickers(symbol);
      const item = resp?.result?.list || resp?.result || resp?.data || [];
      const first = item?.[0] || item;
      if (!first) return null;
      const price24hChangePct = Number(first.price_24h_pcnt ?? first.change_24h ?? first.px_24h ?? 0) * 100;
      const vol24 = Number(first.turnover_24h ?? first.volume_24h ?? first.quote_volume ?? 0);
      const data = { price24hChangePct, vol24, raw: first };
      this.tickerCache[symbol] = { ts: now, data };
      return data;
    } catch (e) {
      debug('fetch24hForSymbolCached error', symbol, e && e.message ? e.message : e);
      return null;
    }
  }

  // seed 5m history only and feed into all TF MACDs for each symbol
  async seed5mHistory() {
    if (this.seeding) return { started: false, reason: 'already' };
    this.seeding = true;
    this.lastSeedAt = null;
    const all = Array.from(this.symbols);
    const limit = SEED_SYMBOLS_LIMIT > 0 ? Math.min(SEED_SYMBOLS_LIMIT, all.length) : all.length;
    const symbols = all.slice(0, limit);
    info('Seeding 5m history for', symbols.length, 'symbols (lookback', HIST_LOOKBACK, ')');

    let totalFetched = 0, totalProcessed = 0, macdReady = 0;
    for (let i = 0; i < symbols.length; i += SEED_BATCH_SIZE) {
      const batch = symbols.slice(i, i + SEED_BATCH_SIZE);
      await Promise.all(batch.map(async (symbol) => {
        try {
          const resp = await this.rest.getKlines(symbol, '5', HIST_LOOKBACK);
          const list = resp?.result?.list || resp?.result || resp?.data || [];
          const candles = Array.isArray(list) ? list.slice().reverse() : [];
          totalFetched += candles.length;
          for (const c of candles) {
            const close = Number(c.close ?? c.k?.c ?? c.c ?? c[4]);
            if (!Number.isFinite(close)) continue;
            const sdata = this.symbolData[symbol];
            if (!sdata) continue;
            for (const tf of Object.keys(sdata)) {
              try {
                const bucket = sdata[tf];
                const result = bucket.macd.update(close);
                bucket.lastClose = close;
                if (result && result.prevHist != null && !bucket.macdReady) {
                  bucket.macdReady = true;
                  macdReady++;
                  this.emit('macd_ready_seed', { symbol, tf });
                }
                this.emit('macd_seed_update', { symbol, tf, input: close, result: result ? { hist: result.hist, prevHist: result.prevHist } : null });
              } catch (e) {
                debug('macd update during seed error', { symbol, tf, err: e && e.message ? e.message : e });
              }
            }
            totalProcessed++;
          }
        } catch (e) {
          debug('seed fetch error', symbol, e && e.message ? e.message : e);
          this.emit('seed_symbol_error', { symbol, err: e && e.message ? e.message : e });
        }
      }));
      await sleep(SEED_BATCH_DELAY_MS);
      this.emit('seed_batch_complete', { batchIndex: Math.floor(i / SEED_BATCH_SIZE) + 1, batchSize: batch.length });
    }

    this.seeding = false;
    this.lastSeedAt = Date.now();
    info('Seeding complete', { totalFetched, totalProcessed, macdReady, completedAt: new Date(this.lastSeedAt).toISOString() });
    this.emit('seed_complete', { totalFetched, totalProcessed, macdReady, completedAt: this.lastSeedAt });
    return { started: true, totalFetched, totalProcessed, macdReady, completedAt: this.lastSeedAt };
  }

  getActiveRootSignals() { return Object.values(this.activeRootSignals); }
  getSymbolStatus(symbol) { return this.symbolData[symbol] || null; }

  updateRootMTF(rootId, mtfInfo) {
    const key = this.rootIndex[rootId]; if (!key) return null;
    const sig = this.activeRootSignals[key]; if (!sig) return null;
    sig.mtf = mtfInfo;
    const s = readSignals(); s.push({ id: uuid(), type: 'mtf', rootId, symbol: sig.symbol, tf: sig.tf, detail: mtfInfo, created: Date.now() }); writeSignals(s);
    this.emit('root_updated', { rootId, sig });
    return sig;
  }
}

module.exports = Scanner;
