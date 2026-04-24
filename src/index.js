// index.js - wire up scanner, MTF, Alerter and API (MTF/Alerter created BEFORE scanner.start)
const Scanner = require('./scanner');
const MTF = require('./mtf');
const { createAPI } = require('./api');
const Trader = require('./trader');
const { info, debug } = require('./logger');
const debugLogger = require('./debug-logger'); // optional: attach NDJSON debug logs

// Defensive require for Alerter to handle different export shapes
function requireAlerter(path) {
  const mod = require(path);
  debug('alerter module type:', typeof mod, 'keys:', Object.keys(mod || {}));
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.default === 'function') return mod.default;
  if (mod && typeof mod.Alerter === 'function') return mod.Alerter;
  throw new Error('Alerter module did not export a constructor. Check alerter.js exports.');
}

async function main() {
  const trader = new Trader();
  const scanner = new Scanner(trader);

  // Attach debug logger to file+console (toggle console:true for realtime stdout)
  try {
    debugLogger.attachDebugLogger(scanner, { path: 'data/scanner-debug.log', console: true, periodicSummaryMs: 60_000 });
  } catch (e) {
    debug('failed to attach debug logger', e && e.message ? e.message : e);
  }

  // Create MTF and Alerter BEFORE starting the scanner
  const mtf = new MTF(scanner, trader);

  const AlerterCtor = requireAlerter('./alerter');
  const alerter = new AlerterCtor(scanner, { debounceMs: 1500 });

  // Start scanner after listeners are attached
  await scanner.start();

  // create REST/debug API
  createAPI(scanner, trader);

  // Optional: quick debug injection to test pipeline (enable by setting DEBUG_INJECT_ROOT=true in env)
  if (process.env.DEBUG_INJECT_ROOT === 'true') {
    try {
      const now = Math.floor(Date.now() / 1000);
      const sig = {
        id: 'debug-' + now,
        type: 'root',
        symbol: 'BTCUSDT',
        tf: '60',      // root TF; choose '5' if you want MTF to evaluate immediately via 5m handler
        strength: 1.0,
        pct24: 0.5,
        vol24: 1000,
        start: now,
        expires: now + 60 * 60,
        status: 'active',
        mtf: null,
        created: Date.now()
      };
      // write and emit
      const key = `${sig.symbol}|${sig.tf}|${sig.start}`;
      scanner.activeRootSignals[key] = sig;
      scanner.rootIndex[sig.id] = key;
      const s = require('./storage').readSignals();
      s.push(sig);
      require('./storage').writeSignals(s);
      debug('DEBUG: injecting synthetic root', sig.id, sig.symbol, sig.tf);
      scanner.emit('root_signal', sig);
    } catch (e) {
      debug('DEBUG_INJECT_ROOT failed', e && e.message ? e.message : e);
    }
  }

  setInterval(() => {
    try {
      info('Status:', 'Symbols tracked:', scanner.symbols.size, 'ActiveRootSignals:', scanner.getActiveRootSignals().length, 'OpenTrades:', trader.openTrades && trader.openTrades.length);
    } catch (e) {
      debug('status interval error', e && e.message ? e.message : e);
    }
  }, 60 * 1000);
}

main().catch(err => {
  console.error('Fatal', err && err.stack ? err.stack : err);
  process.exit(1);
});
