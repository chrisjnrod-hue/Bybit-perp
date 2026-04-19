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
  await scanner.start();

  // create alerter early so it sees startup/root events
  const alerter = new Alerter(scanner, { debounceMs: 1500 });

  const mtf = new MTF(scanner, trader);

  createAPI(scanner, trader);

  // Mirror root events to top-level logs to help debug missed alerts
  scanner.on('root_signal', (sig) => {
    info('Index: root_signal', sig.id, sig.symbol, sig.tf, 'start:', sig.start);
  });
  scanner.on('root_updated', (data) => {
    try {
      const { rootId, sig } = data;
      info('Index: root_updated', rootId, sig.symbol, sig.tf, 'mtfStatus:', sig.mtf && sig.mtf.status);
    } catch (e) { /* ignore malformed event */ }
  });
  scanner.on('root_expired', (sig) => {
    info('Index: root_expired', sig.id, sig.symbol, sig.tf);
  });

  setInterval(() => {
    info('Symbols tracked', scanner.symbols.size, 'ActiveRootSignals', scanner.getActiveRootSignals().length, 'OpenTrades', trader.openTrades.length);
  }, 60 * 1000);
}

main().catch(err => {
  console.error('Fatal', err);
  process.exit(1);
});