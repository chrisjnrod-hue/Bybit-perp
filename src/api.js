// api.js - debug HTTP endpoints (updated with diagnostic routes)
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

  // Existing grouped current roots by TF
  app.get('/debug/current_roots', (req, res) => {
    const roots = scanner.getActiveRootSignals();
    const byTf = {};
    for (const r of roots) {
      byTf[r.tf] = byTf[r.tf] || [];
      byTf[r.tf].push(r);
    }
    res.json({ total: roots.length, grouped: byTf, raw: roots });
  });

  // New: return list of discovered symbols and counts
  app.get('/debug/symbols', (req, res) => {
    const arr = Array.from(scanner.symbols || []);
    res.json({ count: arr.length, symbols: arr.slice(0, 500) }); // limit response length
  });

  // New: return MACD state for a given symbol (per TF)
  app.get('/debug/macd/:symbol', (req, res) => {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const s = scanner.getSymbolStatus(symbol);
    if (!s) return res.status(404).json({ error: 'symbol not found or not tracked' });
    const out = {};
    for (const tf of Object.keys(s)) {
      const st = s[tf];
      out[tf] = {
        lastOpen: st.lastOpen,
        lastClose: st.lastClose,
        lastCandleStart: st.lastCandleStart,
        macd: st.macd ? { hist: st.macd.hist, prevHist: st.macd.prevHist } : null
      };
    }
    res.json({ symbol, data: out });
  });

  // New: trigger seeding manually (POST)
  app.post('/debug/trigger_seed', async (req, res) => {
    try {
      const result = await scanner.seedHistorical();
      res.json({ triggered: true, result });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // New: seeding status
  app.get('/debug/seed_status', (req, res) => {
    res.json({ seeding: !!scanner.seeding, lastSeedAt: scanner.lastSeedAt ? new Date(scanner.lastSeedAt).toISOString() : null });
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
