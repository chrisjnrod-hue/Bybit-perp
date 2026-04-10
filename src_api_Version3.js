const express = require('express');
const { HTTP_PORT } = require('./config');
const { info } = require('./logger');

function createAPI(scanner, trader) {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
  app.get('/status', (req, res) => {
    return res.json({
      symbols: Array.from(scanner.symbols || []),
      activeRootSignals: scanner.getActiveRootSignals(),
      openTrades: trader ? trader.openTrades : []
    });
  });
  app.get('/signals', (req, res) => res.json(scanner.getActiveRootSignals()));
  app.get('/symbol/:symbol', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    return res.json(scanner.getSymbolStatus(symbol) || { error: 'symbol not found' });
  });

  const server = app.listen(HTTP_PORT, () => {
    info('Debug API listening on', HTTP_PORT);
  });
  return server;
}

module.exports = { createAPI };