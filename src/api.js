// api.js - debug HTTP endpoints (updated)
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

  // New debug route: grouped current roots by TF
  app.get('/debug/current_roots', (req, res) => {
    const roots = scanner.getActiveRootSignals();
    const byTf = {};
    for (const r of roots) {
      byTf[r.tf] = byTf[r.tf] || [];
      byTf[r.tf].push(r);
    }
    res.json({ total: roots.length, grouped: byTf, raw: roots });
  });

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
