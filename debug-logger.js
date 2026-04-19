// debug-logger.js
// Attach to scanner to capture diagnostic events and append JSON lines to a logfile.
// Usage: const dbg = require('./debug-logger'); const handle = dbg.attachDebugLogger(scanner, { path: 'data/scanner-debug.log', console: true });
// handle.detach() to remove listeners and close the file.

const fs = require('fs');
const path = require('path');

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function defaultSerializer(obj) {
  try {
    return JSON.stringify(obj, (k, v) => {
      // avoid huge circular or binary data; best-effort compacting
      if (typeof v === 'function') return '[Function]';
      return v;
    });
  } catch (e) {
    return String(obj);
  }
}

function attachDebugLogger(scanner, opts = {}) {
  const optPath = opts.path || path.join(__dirname, '..', 'data', 'scanner-debug.log');
  const logPath = path.resolve(optPath);
  ensureDirForFile(logPath);

  const stream = fs.createWriteStream(logPath, { flags: 'a' });

  function writeLine(evt, payload) {
    const entry = {
      ts: new Date().toISOString(),
      event: evt,
      payload
    };
    stream.write(defaultSerializer(entry) + '\n');
    if (opts.console) {
      // helpful compact console view
      try {
        const short = typeof payload === 'object' ? { ...payload } : payload;
        console.log(entry.ts, evt, short);
      } catch (e) {
        console.log(entry.ts, evt);
      }
    }
  }

  // Handlers
  const onCandle = (data) => {
    try {
      const { symbol, tf, start, open, close, volume, macdResult } = data || {};
      // fetch internal symbol state for extra diagnostics
      let macdReady = null;
      try {
        const s = scanner.getSymbolStatus && scanner.getSymbolStatus(symbol);
        macdReady = s && s[tf] ? !!s[tf].macdReady : null;
      } catch (e) {
        macdReady = null;
      }
      writeLine('candle_open', { symbol, tf, start_iso: start ? new Date(start * 1000).toISOString() : null, open, close, volume, macdResult, macdReady });
      // log potential macd flip candidate details when macdResult contains hist/prevHist
      if (macdResult && typeof macdResult.hist !== 'undefined' && typeof macdResult.prevHist !== 'undefined') {
        writeLine('macd_candidate', { symbol, tf, hist: macdResult.hist, prevHist: macdResult.prevHist });
      }
    } catch (e) {
      writeLine('candle_open_handler_error', { error: String(e) });
    }
  };

  const onRootSignal = (sig) => {
    writeLine('root_signal', sig);
  };

  const onRootUpdated = (data) => {
    writeLine('root_updated', data);
  };

  const onRootExpired = (sig) => {
    writeLine('root_expired', sig);
  };

  const onStartup = () => {
    try {
      writeLine('startup', { symbolsTracked: scanner.symbols ? scanner.symbols.size : null });
    } catch (e) {
      writeLine('startup', { error: String(e) });
    }
  };

  // Attach listeners
  scanner.on('candle_open', onCandle);
  scanner.on('root_signal', onRootSignal);
  scanner.on('root_updated', onRootUpdated);
  scanner.on('root_expired', onRootExpired);
  scanner.on('startup', onStartup);

  // Optional periodic summary if requested
  let intervalId = null;
  if (opts.periodicSummaryMs && typeof opts.periodicSummaryMs === 'number' && opts.periodicSummaryMs > 0) {
    intervalId = setInterval(() => {
      try {
        const symbols = scanner.symbols ? scanner.symbols.size : null;
        const active = scanner.getActiveRootSignals ? scanner.getActiveRootSignals().length : null;
        writeLine('periodic_summary', { symbolsTracked: symbols, activeRootSignals: active, ts: new Date().toISOString() });
      } catch (e) {
        writeLine('periodic_summary_error', { error: String(e) });
      }
    }, opts.periodicSummaryMs);
    if (intervalId.unref) intervalId.unref();
  }

  writeLine('debug_logger_attached', { logPath, console: !!opts.console });

  return {
    detach() {
      try {
        scanner.removeListener('candle_open', onCandle);
        scanner.removeListener('root_signal', onRootSignal);
        scanner.removeListener('root_updated', onRootUpdated);
        scanner.removeListener('root_expired', onRootExpired);
        scanner.removeListener('startup', onStartup);
        if (intervalId) clearInterval(intervalId);
        writeLine('debug_logger_detached', { ts: new Date().toISOString() });
        // give stream a moment and close
        stream.end();
      } catch (e) {
        try { stream.end(); } catch (_) {}
      }
    }
  };
}

module.exports = { attachDebugLogger };