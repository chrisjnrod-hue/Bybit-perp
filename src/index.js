// index.js - wire up scanner, MTF, Alerter and API (MTF/Alerter created BEFORE scanner.start)
const Scanner = require('./scanner');
const MTF = require('./mtf');
const { createAPI } = require('./api');
const Trader = require('./trader');
const { info, debug } = require('./logger');

// Defensive require for alerter to handle different export shapes
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

  // create MTF BEFORE starting scanner so it receives events (and can evaluate roots)
  const mtf = new MTF(scanner, trader);

  // load Alerter constructor robustly and instantiate it BEFORE starting scanner
  const AlerterCtor = requireAlerter('./alerter');
  const alerter = new AlerterCtor(scanner, { debounceMs: 1500 });

  // Start scanner after listeners are attached
  await scanner.start();

  // create API after scanner started
  createAPI(scanner, trader);

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
