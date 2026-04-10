// Simple atomic JSON file storage for signals (read/write). Uses fs-extra for atomic write.
const fs = require('fs-extra');
const path = require('path');
const { SIGNALS_FILE } = require('./config');
const { info, debug } = require('./logger');

const ensureDir = (file) => {
  const dir = path.dirname(file);
  fs.ensureDirSync(dir);
};

function readSignals() {
  try {
    if (!fs.existsSync(SIGNALS_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(SIGNALS_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    debug('readSignals error', err.message);
    return [];
  }
}

function writeSignals(signals) {
  try {
    ensureDir(SIGNALS_FILE);
    fs.writeFileSync(SIGNALS_FILE, JSON.stringify(signals, null, 2), 'utf8');
    info('Signals saved', SIGNALS_FILE);
  } catch (err) {
    debug('writeSignals error', err.message);
  }
}

module.exports = { readSignals, writeSignals };