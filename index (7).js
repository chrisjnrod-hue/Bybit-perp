// index.js - wire up alerter and scanner
const Scanner = require('./scanner');
const MTF = require('./mtf');
const { createAPI } = require('./api');
const Trader = require('./trader');
const { info } = require('./logger');
const Alerter = require('./alerter');

async function main() {
  const trader = new Trader();
  const scanner = new Scanner(trader);

  // Instantiate Alerter BEFORE starting the scanner so it registers listeners
  // and will receive the 'startup' event (to push persisted signals on start).
  const alerter = new Alerter(scanner, { debounceMs: 1500 });

  await scanner.start();

  const mtf = new MTF(scanner, trader);

  createAPI(scanner, trader);

  setInterval(() => {
    info('Symbols tracked', scanner.symbols.size, 'ActiveRootSignals', scanner.getActiveRootSignals().length, 'OpenTrades', trader.openTrades.length);
  }, 60 * 1000);
}

main().catch(err => {
  console.error('Fatal', err);
  process.exit(1);
});