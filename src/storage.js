const fs = require('fs');
const path = require('path');
const { SIGNALS_FILE } = require('./config');
const { info, debug, warn } = require('./logger');

function ensureDir(file) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    debug('ensureDir error', e && e.message ? e.message : e);
  }
}

function readSignals() {
  try {
    if (!fs.existsSync(SIGNALS_FILE)) {
      debug('readSignals: no signals file found at', SIGNALS_FILE);
      return [];
    }
    const raw = fs.readFileSync(SIGNALS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    debug('readSignals: loaded', Array.isArray(parsed) ? parsed.length : 'non-array', 'entries from', SIGNALS_FILE);
    return parsed;
  } catch (err) {
    debug('readSignals error reading', SIGNALS_FILE, err && err.message ? err.message : err);
    return [];
  }
}

function writeSignals(signals) {
  try {
    ensureDir(SIGNALS_FILE);
    const tmp = SIGNALS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(signals || [], null, 2), 'utf8');
    fs.renameSync(tmp, SIGNALS_FILE);
    info('Signals saved', SIGNALS_FILE, 'count=', Array.isArray(signals) ? signals.length : 'n/a');
  } catch (err) {
    debug('writeSignals error', SIGNALS_FILE, err && err.message ? err.message : err);
  }
}

module.exports = { readSignals, writeSignals };
