// api.js - debug HTTP endpoints (updated with diagnostic routes + browser-friendly signals viewer + force alert)
const express = require('express');
const fs = require('fs');
const { HTTP_PORT } = require('./config');
const { info } = require('./logger');
const uuid = require('uuid').v4;

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
        macdReady: st.macdReady,
        macd: st.macd ? { hist: st.macd.hist, prevHist: st.macd.prevHist, macd: st.macd.macd, signal: st.macd.signal } : null
      };
    }
    res.json({ symbol, data: out });
  });

  // NEW: Comprehensive root TF debug endpoint
  app.get('/debug/root_tf_analysis', (req, res) => {
    const analysis = {
      timestamp: new Date().toISOString(),
      config: {
        ROOT_TFS: require('./config').ROOT_TFS,
        MACD_HIST_POSITIVE_THRESHOLD: require('./config').MACD_HIST_POSITIVE_THRESHOLD,
        MIN_24H_PRICE_CHANGE_PCT: require('./config').MIN_24H_PRICE_CHANGE_PCT,
        MIN_24H_VOL_CHANGE_PCT: require('./config').MIN_24H_VOL_CHANGE_PCT,
        SEED_HISTORICAL: require('./config').SEED_HISTORICAL
      },
      seeding: {
        isSeeding: scanner.seeding,
        lastSeedAt: scanner.lastSeedAt ? new Date(scanner.lastSeedAt).toISOString() : null
      },
      symbolCount: scanner.symbols.size,
      totalSymbolTFBuckets: scanner.symbols.size * require('./config').ROOT_TFS.length,
      rootTFAnalysis: {}
    };

    // Analyze each ROOT TF
    for (const rootTf of require('./config').ROOT_TFS) {
      const tfData = {
        tf: rootTf,
        totalTracked: 0,
        macdReady: 0,
        withPrevHist: 0,
        withValidHist: 0,
        withFlipCondition: 0,
        sampleSymbols: []
      };

      let sampleCount = 0;
      for (const symbol of scanner.symbols) {
        const sdata = scanner.symbolData[symbol] && scanner.symbolData[symbol][rootTf];
        if (!sdata) continue;
        
        tfData.totalTracked++;
        if (sdata.macdReady) tfData.macdReady++;
        
        const macd = sdata.macd;
        if (macd && macd.prevHist !== null) tfData.withPrevHist++;
        if (macd && macd.hist !== null) tfData.withValidHist++;
        
        // Check flip condition (crossedUp: prevHist < threshold AND hist >= threshold)
        const threshold = require('./config').MACD_HIST_POSITIVE_THRESHOLD;
        const crossedUp = macd && macd.prevHist !== null && macd.prevHist < threshold && macd.hist >= threshold;
        if (crossedUp) {
          tfData.withFlipCondition++;
        }
        
        // Collect sample data for first few symbols
        if (sampleCount < 3) {
          tfData.sampleSymbols.push({
            symbol,
            macdReady: sdata.macdReady,
            lastCandleStart: sdata.lastCandleStart ? new Date(sdata.lastCandleStart * 1000).toISOString() : null,
            lastClose: sdata.lastClose,
            macdHist: macd ? macd.hist : null,
            macdPrevHist: macd ? macd.prevHist : null
          });
          sampleCount++;
        }
      }

      analysis.rootTFAnalysis[rootTf] = tfData;
    }

    res.json(analysis);
  });

  // NEW: Inject candle via query params (GET-only, Android browser friendly)
  app.get('/debug/inject_candle', (req, res) => {
    const { symbol, tf, close } = req.query;
    if (!symbol || !tf || close === undefined) {
      return res.status(400).json({ error: 'Missing symbol, tf, or close in query params. Usage: /debug/inject_candle?symbol=BTCUSDT&tf=60&close=45000' });
    }

    const sdata = scanner.symbolData[symbol.toUpperCase()] && scanner.symbolData[symbol.toUpperCase()][tf];
    if (!sdata) {
      return res.status(404).json({ error: 'Symbol/TF not tracked', symbol: symbol.toUpperCase(), tf });
    }

    const closeParsed = Number(close);
    const now = Math.floor(Date.now() / 1000);
    const result = sdata.macd.update(closeParsed);
    sdata.lastClose = closeParsed;
    if (!sdata.lastCandleStart) sdata.lastCandleStart = now;

    res.json({
      symbol: symbol.toUpperCase(),
      tf,
      injected: closeParsed,
      macdResult: result,
      macdReady: sdata.macdReady,
      macdNowHas: {
        hist: sdata.macd.hist,
        prevHist: sdata.macd.prevHist
      }
    });
  });

  // New: trigger seeding manually (GET with query param)
  app.get('/debug/trigger_seed', async (req, res) => {
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

  // NEW: View signals.json file contents (Android-friendly GET)
  app.get('/debug/signals_file', (req, res) => {
    try {
      const { readSignals } = require('./storage');
      const signals = readSignals() || [];
      const limit = Math.max(1, Math.min(2000, Number(req.query.limit || 500)));
      res.json({
        filePath: require('./config').SIGNALS_FILE,
        total: signals.length,
        returned: Math.min(signals.length, limit),
        truncated: signals.length > limit,
        signals: signals.slice(0, limit)
      });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // NEW: Browser-friendly view of signals.json (HTML)
  app.get('/debug/view_signals', (req, res) => {
    try {
      const filePath = require('./config').SIGNALS_FILE;
      if (!fs.existsSync(filePath)) {
        return res.status(404).send(`<html><body><h3>signals.json not found</h3><p>Expected at: ${filePath}</p></body></html>`);
      }
      const raw = fs.readFileSync(filePath, 'utf8');
      let parsed = [];
      try { parsed = JSON.parse(raw || '[]'); } catch (e) { parsed = null; }
      const limit = Math.max(1, Math.min(2000, Number(req.query.limit || 500)));
      const shown = Array.isArray(parsed) ? parsed.slice(0, limit) : raw;
      const truncatedNotice = Array.isArray(parsed) && parsed.length > limit ? `<p>Showing first ${limit} of ${parsed.length} entries</p>` : '';
      const downloadUrl = '/debug/download_signals';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<html>
  <head><title>signals.json viewer</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font-family:monospace;background:#0b0b0b;color:#e6e6e6;padding:10px} pre{white-space:pre-wrap;word-wrap:break-word} a{color:#9cf}</style>
  </head>
  <body>
    <h2>signals.json viewer</h2>
    <p>File: <strong>${filePath}</strong> — <a href="${downloadUrl}">download full file</a></p>
    ${truncatedNotice}
    <pre>${typeof shown === 'string' ? shown : JSON.stringify(shown, null, 2)}</pre>
  </body>
</html>`);
    } catch (err) {
      res.status(500).send(`<html><body><h3>Error reading signals.json</h3><pre>${String(err)}</pre></body></html>`);
    }
  });

  // NEW: Download the full signals.json file as attachment
  app.get('/debug/download_signals', (req, res) => {
    try {
      const filePath = require('./config').SIGNALS_FILE;
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'signals.json not found', filePath });
      }
      res.download(filePath, 'signals.json');
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // QUICK TEST: Force a root_signal emission (for testing/validation)
  // Usage: /debug/force_alert?symbol=BTCUSDT&tf=60
  app.get('/debug/force_alert', (req, res) => {
    try {
      const cfg = require('./config');
      const { readSignals, writeSignals } = require('./storage');
      const { symbol: qSymbol, tf: qTf } = req.query;
      const symbol = qSymbol ? String(qSymbol).toUpperCase() : Array.from(scanner.symbols || [])[0];
      const tf = qTf || (Array.isArray(cfg.ROOT_TFS) && cfg.ROOT_TFS.length > 0 ? cfg.ROOT_TFS[0] : '60');

      if (!symbol) return res.status(400).json({ error: 'No symbol available to force alert' });

      const tfSeconds = (tf === 'D' || tf === 'd') ? 24 * 3600 : Number(tf) * 60;
      const start = Math.floor(Date.now() / 1000);
      const id = uuid();
      const sig = {
        id,
        type: 'root',
        symbol,
        tf,
        strength: 1,
        pct24: 0,
        vol24: 0,
        start,
        expires: start + tfSeconds,
        status: 'active',
        mtf: null,
        created: Date.now()
      };

      const key = `${sig.symbol}|${sig.tf}|${sig.start}`;
      scanner.activeRootSignals[key] = sig;
      scanner.rootIndex[id] = key;

      const current = readSignals() || [];
      current.push(sig);
      writeSignals(current);

      // Emit so alerter and other listeners react immediately
      try { scanner.emit('root_signal', sig); } catch (e) { /* ignore */ }

      res.json({ forced: true, sig });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
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
