// alerter.js - aggregates root + mtf signals and sends grouped Telegram messages.
// Prevents duplicates by comparing last sent aggregated text.
const { sendTelegram } = require('./telegram');
const { info, debug } = require('./logger');

class Alerter {
  constructor(scanner, opts = {}) {
    this.scanner = scanner;
    this.debounceMs = opts.debounceMs || 1500;
    this.timer = null;
    this.lastSentText = '';
    this.pending = false;

    this.scanner.on('root_signal', (sig) => this.onUpdate());
    this.scanner.on('root_updated', (data) => this.onUpdate());
    this.scanner.on('root_expired', (sig) => this.onUpdate());
    this.scanner.on('startup', () => this.onUpdate());

    // Ensure the current active signals (persisted or created before alerter construction)
    // are sent once shortly after construction. Debounced so we don't spam.
    // This makes Alerter pick up persisted activeRootSignals even when created after scanner.start().
    setTimeout(() => this.onUpdate(), 50);
  }

  // ... rest of file unchanged ...
}
