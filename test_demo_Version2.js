// Small demo runner that starts scanner but limits subscribed symbols to DEMO_SYMBOLS env var.
// Useful for validating MACD flips and MTF alignment without scanning the entire market.
const Scanner = require('../src/scanner');
const MTF = require('../src/mtf');
const Trader = require('../src/trader');
const { info } = require('../src/logger');
const { DEMO_SYMBOLS } = require('../src/config');

async function demo() {
  const demoList = process.env.DEMO_SYMBOLS ? process.env.DEMO_SYMBOLS.split(',').map(s => s.trim().toUpperCase()) : DEMO_SYMBOLS;
  const trader = new Trader();
  const scanner = new Scanner(trader);

  // quick override: only track demoList; we still need to call start for WS connection
  for (const s of demoList) scanner.symbols.add(s), scanner.initSymbol(s);
  scanner.subscribeAll();

  const mtf = new MTF(scanner, trader);

  scanner.on('root_signal', (sig) => {
    info('Demo detected root_signal', sig.symbol, sig.tf, 'strength', sig.strength);
  });

  scanner.on('candle_open', (c) => {
    info('Demo candle_open', c.symbol, c.tf, new Date(c.start * 1000).toISOString());
  });

  // keep process alive
  setInterval(() => {
    info('Demo running. Tracked', scanner.symbols.size, 'signals', scanner.getActiveRootSignals().length);
  }, 30 * 1000);
}

demo().catch(err => { console.error(err); process.exit(1); });