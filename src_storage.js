const fs = require('fs-extra');
const path = require('path');
const { SIGNALS_FILE } = require('./config');
const { info, debug, warn } = require('./logger');

const ensureDir = (file) => {
  const dir = path.dirname(file);
  fs.ensureDirSync(dir);
};

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
    fs.writeFileSync(SIGNALS_FILE, JSON.stringify(signals, null, 2), 'utf8');
    info('Signals saved', SIGNALS_FILE, 'count=', Array.isArray(signals) ? signals.length : 'n/a');
  } catch (err) {
    debug('writeSignals error', SIGNALS_FILE, err && err.message ? err.message : err);
  }
}

module.exports = { readSignals, writeSignals };