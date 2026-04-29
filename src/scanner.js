// scanner.js - centralized 5m scan driver with bounded concurrency, background seeding,
// batched persistence and WS health checks to ensure timely root scans for many symbols.
//
// Key behaviors:
// - Centralized 5-minute scheduler aligned to wall clock runs a full-pass root check.
// - PrevHist is populated from lastClose for all TF buckets before checks.
// - If prevHist cannot be populated (no lastClose), a background rate-limited REST seed
//   fetches a tiny lookback (non-blocking).
// - Root checks are executed in parallel with bounded concurrency (p-queue).
// - Root candidate persistence is batched and flushed asynchronously.
// - WS health per-symbol tracked; missing klines trigger REST fallback + resubscribe attempts.
//
// Notes:
// - Tune concurrency / delays via env vars documented below.
// - This is designed to work on a single API key and low-resource environments.
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
const PQueue = require('p-queue').default;

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

// Tunable runtime knobs via env (safe defaults tuned for single API key / low-resource)
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 8); // parallel checks during 5m scan
const PERSIST_WRITE_DEBOUNCE_MS = Number(process.env.PERSIST_WRITE_DEBOUNCE_MS || 1000); // flush signals
const REST_SEED_INTERVAL_MS = Number(process.env.REST_SEED_INTERVAL_MS || 1200); // 1.2s per REST seed (rate-limited)
const REST_SEED_LOOKBACK = Number(process.env.REST_SEED_LOOKBACK || 3); // small lookback to warm lastClose
const WS_MISSING_THRESHOLD_MS = Number(process.env.WS_MISSING_THRESHOLD_MS || 6 * 60 * 1000); // consider WS missing if no kline >6m
const MAX_RESUBSCRIBE_ATTEMPTS = Number(process.env.MAX_RESUBSCRIBE_ATTEMPTS || 3);

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

    // concurrency & background queues
    this.scanQueue = new PQueue({ concurrency: SCAN_CONCURRENCY });
    // rate-limited single-worker REST seeder for missing prevHist / WS fallbacks
    this.restSeedQueue = new PQueue({ concurrency: 1, intervalCap: 1, interval: REST_SEED_INTERVAL_MS });

    // batched persistence
    this.pendingSignals = [];
    this.persistTimer = null;

    // WS health tracking
    this.symbolLastKlineAt = {}; // symbol -> timestamp (ms)
    this.symbolResubscribeAttempts = {}; // symbol -> attempts

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
    // start centralized 5m scheduler after subscriptions
    this._startFiveMinScheduler();
    // start persistence flush timer if needed
    this._ensurePersistTimer();
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
    const batchSize = Number(process.env.WS_SUBSCRIBE_BATCH_SIZE || 50);
    const batchDelay = Number(process.env.WS_SUBSCRIBE_BATCH_DELAY_MS || 500);
    const symbols = Array.from(this.symbols);
    for (let i = 0; i < symbols.length; i += batchSize) {
      const chunk = symbols.slice(i, i + batchSize);
      for (const symbol of chunk) {
        for (const tf of Object.keys(this.symbolData[symbol] || {})) {
          try {
            this.ws.subKline(symbol, tf);
          } catch (e) {
            debug('ws subKline error', e && e.message ? e.message : e);
          }
        }
      }
      // stagger subscribe batches to avoid bursts
      if (i + batchSize < symbols.length) {
        // eslint-disable-next-line no-await-in-loop
        sleep(batchDelay);
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
        // update last kline seen timestamp for WS health
        this.symbolLastKlineAt[String(symbol).toUpperCase()] = Date.now();
        await this.onCandle(String(symbol).toUpperCase(), String(tf), startSec, open, close, volume);
      }
    } catch (e) {
      debug('handleWSMessage error', e && e.message ? e.message : e);
    }
  }

  // Modified onCandle: update MACD state for incoming TF exactly as before.
  // ONLY run root-TF checks centrally at 5m scheduler; local TF candle_open still emitted.
  async onCandle(symbol, tf, startSec, open, close, volume) {
    if (!this.symbolData[symbol] || !this.symbolData[symbol][tf]) {
      debug('onCandle: symbol/tf not tracked', symbol, tf);
      return;
    }
    const sdata = this.symbolData[symbol][tf];
    const isNew = sdata.lastCandleStart !== startSec;

    if (isNew) {
      debug('CANDLE OPEN', symbol, tf, new Date(startSec * 1000).toISOString(), 'close', close);

      let macdPrevResult = null;
      try {
        if (sdata.macd && sdata.macd.prevHist != null) {
          macdPrevResult = { hist: sdata.macd.hist, prevHist: sdata.macd.prevHist, macd: sdata.macd.macd, signal: sdata.macd.get('signal') };
          sdata.macdReady = true;
        } else if (sdata.lastClose != null) {
          macdPrevResult = sdata.macd.update(sdata.lastClose);
          if (macdPrevResult && macdPrevResult.prevHist != null) sdata.macdReady = true;
          this.emit('macd_prev_result', { symbol, tf, macdPrevResult });
        }
      } catch (e) {
        debug('macd prev compute err', e && e.message ? e.message : e);
      }

      // update lasts for this new candle
      sdata.lastOpen = open;
      sdata.lastClose = close;
      sdata.lastCandleStart = startSec;

      // feed live open to MACD to keep state consistent for this TF only
      try {
        const r = sdata.macd.update(open);
        this.emit('macd_live_update', { symbol, tf, input: open, result: r });
      } catch (e) {
        debug('macd update open error', e && e.message ? e.message : e);
      }

      // emit candle_open for this TF (preserve existing behavior)
      this.emit('candle_open', { symbol, tf, start: startSec, open, close, volume, macdResult: macdPrevResult });

    } else {
      // same candle update: keep previous behavior — update lastClose and MACD
      sdata.lastClose = close;
      try {
        const res = sdata.macd.update(close);
        this.emit('macd_update', { symbol, tf, input: close, result: res });
      } catch (e) {
        debug('macd update close error', e && e.message ? e.message : e);
      }
    }
  }

  // A fast, non-blocking entry that is used by the centralized scan driver.
  // It checks macd hist/prevHist and if crossing is detected it creates a root candidate quickly
  // and schedules any expensive REST metric gathering asynchronously.
  async _checkRootFlipFast(symbol, tf, macdResult, volume) {
    if (!macdResult) return;
    const { hist, prevHist } = macdResult;
    if (prevHist == null || hist == null) {
      this.emit('checkRootFlip_prevHist_null', { symbol, tf, macdResult });
      return;
    }

    const cfg = require('./config');
    const threshold = cfg.MACD_HIST_POSITIVE_THRESHOLD ?? 0;
    const eps = Number(process.env.MACD_EPS || 1e-6);

    let crossedUp = false;
    if (typeof prevHist === 'number' && typeof hist === 'number') {
      if (prevHist < -eps && hist > eps) crossedUp = true;
      else if (prevHist < threshold && hist >= threshold) crossedUp = true;
      else if (prevHist < 0 && hist >= 0) crossedUp = true;
    }

    if (!crossedUp) {
      this.emit('root_no_cross', { symbol, tf, prevHist, hist });
      return;
    }

    // Build MTF snapshot (hist/prevHist/macdReady) to help downstream MTF higher-highs checks.
    const mtfSnapshot = {};
    for (const mtfTf of Array.from(new Set(MTF_TFS || []))) {
      try {
        const b = this.symbolData[symbol] && this.symbolData[symbol][mtfTf];
        if (!b || !b.macd) {
          mtfSnapshot[mtfTf] = { hist: null, prevHist: null, macdReady: false };
          continue;
        }
        const m = b.macd;
        const mh = typeof m.hist !== 'undefined' ? m.hist : (m.get ? m.get('hist') : undefined);
        const mph = typeof m.prevHist !== 'undefined' ? m.prevHist : (m.get ? m.get('prevHist') : undefined);
        mtfSnapshot[mtfTf] = { hist: mh, prevHist: mph, macdReady: !!b.macdReady };
      } catch (e) {
        mtfSnapshot[mtfTf] = { hist: null, prevHist: null, macdReady: false };
      }
    }

    // Create a root candidate quickly with minimal blocking operations.
    const key = `${symbol}|${tf}|${this.symbolData[symbol][tf].lastCandleStart}`;
    const prev = this.activeRootSignals[key];
    if (prev && prev.id) {
      try { delete this.rootIndex[prev.id]; } catch (e) {}
      this.emit('root_duplicate_overwritten', { key, prevId: prev.id, symbol, tf });
    }

    const id = uuid();
    const startSec = this.symbolData[symbol][tf].lastCandleStart;
    const tfSeconds = (tf === 'D' ? 24 * 3600 : Number(tf) * 60);

    // Create signal with basic macd values and mtf snapshot. Defer REST metrics.
    const sig = {
      id,
      type: 'root',
      symbol,
      tf,
      hist,
      prevHist,
      macd: macdResult.macd,
      signal: macdResult.signal,
      strength: Math.max(0, hist),
      pct24: null,
      vol24: null,
      filter: {
        pricePass: null,
        volPass: null,
        macdHistThresholdPass: (typeof hist === 'number') ? (hist >= (require('./config').MACD_HIST_POSITIVE_THRESHOLD ?? 0)) : null
      },
      mtfSnapshot,
      start: startSec,
      expires: startSec + tfSeconds,
      status: 'active',
      mtf: null,
      created: Date.now()
    };

    // Register in-memory and schedule persistence batch
    this.activeRootSignals[key] = sig;
    this.rootIndex[id] = key;
    this.pendingSignals.push(sig);
    // emit immediate candidate event
    try { this.emit('root_signal', sig); } catch (e) { debug('emit root_signal error', e && e.message ? e.message : e); }
    this.emit('root_created', { sig, key });

    // Schedule REST metric fetch asynchronously (rate-limited)
    this.restSeedQueue.add(async () => {
      try {
        const metrics = await this.fetch24hForSymbol(symbol);
        if (metrics) {
          sig.pct24 = metrics.price24hChangePct;
          sig.vol24 = metrics.vol24;
          sig.filter.pricePass = typeof sig.pct24 === 'number' ? (sig.pct24 >= MIN_24H_PRICE_CHANGE_PCT) : false;
          sig.filter.volPass = typeof sig.vol24 === 'number' ? (sig.vol24 >= MIN_24H_VOL_CHANGE_PCT) : false;
          // update persisted signals on next flush
        }
        // else metrics may remain null; that's ok - trade-selection will re-evaluate
      } catch (e) {
        debug('async fetch24hForSymbol error', e && e.message ? e.message : e);
      }
    });

    // Ensure persistence flush timer is active
    this._ensurePersistTimer();
  }

  // Centralized 5-minute run that attempts to populate prevHist for all TF buckets
  // and then parallelizes checks across symbols/root TFs with bounded concurrency.
  async _runFiveMinPass(startMs) {
    const startTime = Date.now();
    const symbols = Array.from(this.symbols);
    info('5m scan starting', { symbolCount: symbols.length, startedAt: new Date(startMs).toISOString() });

    // 1) Populate prevHist from lastClose for all buckets where possible
    for (const symbol of symbols) {
      for (const t of Object.keys(this.symbolData[symbol] || {})) {
        try {
          const bucket = this.symbolData[symbol][t];
          if (!bucket || !bucket.macd) continue;
          if ((typeof bucket.macd.prevHist === 'undefined' || bucket.macd.prevHist === null) && bucket.lastClose != null) {
            try {
              const prev = bucket.macd.update(bucket.lastClose);
              this.emit('macd_prev_result', { symbol, tf: t, macdPrevResult: prev });
              if (prev && prev.prevHist != null) bucket.macdReady = true;
            } catch (e) {
              debug('5m-driven macd_prev feed error', { symbol, tf: t, err: e && e.message ? e.message : e });
            }
          }
        } catch (e) {
          debug('5m-driven per-TF prev-populate error', { symbol, tf: t, err: e && e.message ? e.message : e });
        }
      }
    }

    // 2) For any bucket still missing prevHist and lastClose, schedule a tiny REST seed in background (non-blocking)
    for (const symbol of symbols) {
      for (const t of Object.keys(this.symbolData[symbol] || {})) {
        const bucket = this.symbolData[symbol][t];
        if (!bucket || !bucket.macd) continue;
        if ((typeof bucket.macd.prevHist === 'undefined' || bucket.macd.prevHist === null) && bucket.lastClose == null) {
          // schedule background REST to fetch small lookback and feed closes
          this.restSeedQueue.add(async () => {
            try {
              const resp = await this.rest.getKlines(symbol, t, REST_SEED_LOOKBACK);
              const list = resp?.result?.list || resp?.result || resp?.data || [];
              const candles = Array.isArray(list) ? list.slice().reverse() : [];
              for (const c of candles) {
                const close = Number(c.close ?? c.k?.c ?? c.c ?? c[4]);
                if (!Number.isFinite(close)) continue;
                bucket.macd.update(close);
                bucket.lastClose = close;
                if (bucket.macd.prevHist != null) bucket.macdReady = true;
              }
              debug('background rest seed finished', { symbol, t, macdReady: bucket.macdReady });
            } catch (e) {
              debug('background rest seed error', { symbol, t, err: e && e.message ? e.message : e });
            }
          }).catch(e => debug('restSeedQueue add error', e && e.message ? e.message : e));
        }
      }
    }

    // 3) For WS-missing symbols schedule a REST fallback (rate-limited) to fetch the latest kline
    const now = Date.now();
    for (const symbol of symbols) {
      const last = this.symbolLastKlineAt[symbol] || 0;
      if (now - last > WS_MISSING_THRESHOLD_MS) {
        // only attempt a few resubscribe attempts to avoid loops
        const attempts = this.symbolResubscribeAttempts[symbol] || 0;
        if (attempts < MAX_RESUBSCRIBE_ATTEMPTS) {
          this.symbolResubscribeAttempts[symbol] = attempts + 1;
          try {
            // re-subscribe via WS (non-blocking)
            for (const tf of Object.keys(this.symbolData[symbol] || {})) {
              try { this.ws.subKline(symbol, tf); } catch (e) { debug('ws resubscribe error', e && e.message ? e.message : e); }
            }
          } catch (e) {
            debug('resubscribe wrapper error', e && e.message ? e.message : e);
          }
        }
        // schedule REST fallback to fetch latest candle and feed bucket
        this.restSeedQueue.add(async () => {
          try {
            for (const tf of Object.keys(this.symbolData[symbol] || {})) {
              const bucket = this.symbolData[symbol][tf];
              if (!bucket) continue;
              try {
                const resp = await this.rest.getKlines(symbol, tf, 1);
                const list = resp?.result?.list || resp?.result || resp?.data || [];
                const latest = Array.isArray(list) && list.length ? list[list.length - 1] : list;
                if (latest) {
                  const close = Number(latest.close ?? latest.k?.c ?? latest.c ?? latest[4]);
                  if (Number.isFinite(close)) {
                    bucket.macd.update(close);
                    bucket.lastClose = close;
                    if (bucket.macd.prevHist != null) bucket.macdReady = true;
                    this.emit('macd_prev_result', { symbol, tf, macdPrevResult: { prevHist: bucket.macd.prevHist, hist: bucket.macd.hist } });
                  }
                }
              } catch (e) {
                debug('rest fallback kline error', { symbol, tf, e: e && e.message ? e.message : e });
              }
            }
            // after successful fallback, mark last kline timestamp for symbol to avoid repeated fallbacks
            this.symbolLastKlineAt[symbol] = Date.now();
            this.symbolResubscribeAttempts[symbol] = 0;
          } catch (e) {
            debug('rest fallback error', e && e.message ? e.message : e);
          }
        }).catch(e => debug('restSeedQueue add error', e && e.message ? e.message : e));
      }
    }

    // 4) Now schedule root checks for every symbol x rootTf in parallel (bounded)
    for (const symbol of symbols) {
      for (const rootTf of Array.from(new Set(ROOT_TFS || []))) {
        // push into scanQueue
        this.scanQueue.add(async () => {
          try {
            const bucket = this.symbolData[symbol][rootTf];
            if (!bucket || !bucket.macd) {
              this.emit('root_tf_check_skipped', { symbol, tf: rootTf, reason: 'no_bucket' });
              return;
            }
            const macdObj = bucket.macd;
            const hist = typeof macdObj.hist !== 'undefined' ? macdObj.hist : (macdObj.get ? macdObj.get('hist') : undefined);
            const prevHist = typeof macdObj.prevHist !== 'undefined' ? macdObj.prevHist : (macdObj.get ? macdObj.get('prevHist') : undefined);

            if (typeof prevHist === 'undefined' || prevHist === null) {
              this.emit('root_tf_check_skipped', { symbol, tf: rootTf, macdReady: bucket.macdReady, hasPrevResult: false });
              return;
            }

            const macdResult = { hist, prevHist, macd: macdObj.macd, signal: macdObj.get ? macdObj.get('signal') : undefined };
            await this._checkRootFlipFast(symbol, rootTf, macdResult, 0);
          } catch (e) {
            debug('5m-driven root check error', { symbol, error: e && e.message ? e.message : e });
          }
        }).catch(e => debug('scanQueue add error', e && e.message ? e.message : e));
      }
    }

    // Wait for scanQueue to settle so we can report a duration (but don't wait for restSeedQueue)
    try {
      await this.scanQueue.onIdle();
    } catch (e) {
      debug('scanQueue onIdle error', e && e.message ? e.message : e);
    }

    const duration = Date.now() - startTime;
    info('5m scan pass completed', { durationMs: duration, symbolCount: symbols.length, pendingSignals: this.pendingSignals.length });
    this.emit('5m_scan_complete', { durationMs: duration, pendingSignalsCount: this.pendingSignals.length });
    // persist pending signals will be handled by periodic flush (persistTimer)
  }

  // Starts an aligned 5-minute scheduler
  _startFiveMinScheduler() {
    const alignAndSchedule = () => {
      const now = Date.now();
      const msSinceEpoch = now;
      // compute next 5-minute boundary (floor to current 5m boundary)
      const boundary = Math.floor(msSinceEpoch / 300000) * 300000;
      const nextBoundary = boundary + 300000;
      const wait = Math.max(0, nextBoundary - now) + 50; // small safety offset
      setTimeout(() => {
        // run first pass at the boundary, then schedule setInterval every 5m
        this._runFiveMinPass(nextBoundary).catch(e => debug('initial 5m pass error', e && e.message ? e.message : e));
        // schedule repeating
        this._fiveMinInterval = setInterval(() => {
          const runAt = Math.floor(Date.now() / 300000) * 300000;
          this._runFiveMinPass(runAt).catch(e => debug('scheduled 5m pass error', e && e.message ? e.message : e));
        }, 300000);
      }, wait);
      info('5m scheduler aligned', { nextBoundary: new Date(nextBoundary).toISOString(), waitMs: wait });
    };
    try { alignAndSchedule(); } catch (e) { debug('startFiveMinScheduler error', e && e.message ? e.message : e); }
  }

  // Persistence flush ensure
  _ensurePersistTimer() {
    if (this.persistTimer) return;
    this.persistTimer = setInterval(() => {
      this._flushPendingSignals().catch(e => debug('flushPendingSignals error', e && e.message ? e.message : e));
    }, Math.max(200, PERSIST_WRITE_DEBOUNCE_MS));
  }

  // Flush pending signals to disk in a single write
  async _flushPendingSignals() {
    if (!this.pendingSignals.length) return;
    const toWrite = this.pendingSignals.splice(0, this.pendingSignals.length);
    try {
      const s = readSignals();
      // Append and write; keep same format as existing storage
      for (const sig of toWrite) s.push(sig);
      writeSignals(s);
      info('Flushed pending signals', toWrite.length);
    } catch (e) {
      debug('writeSignals error', e && e.message ? e.message : e);
      // On failure, re-queue signals to pendingSignals head to try again later
      this.pendingSignals.unshift(...toWrite);
    }
  }

  async _checkRootFlip(symbol, tf, macdResult, volume) {
    // keep original method intact for compatibility if other code calls it
    // but primary fast path used by scheduler is _checkRootFlipFast
    return this._checkRootFlipFast(symbol, tf, macdResult, volume);
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
