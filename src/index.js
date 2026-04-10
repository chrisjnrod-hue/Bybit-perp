const Scanner = require('./scanner');
const MTF = require('./mtf');
const { createAPI } = require('./api');
const Trader = require('./trader');
const { info } = require('./logger');

async function main() {
  const trader = new Trader();
  const scanner = new Scanner(trader);
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
