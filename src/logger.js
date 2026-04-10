const { VERBOSE_LOG } = require('./config');

function ts() {
  return new Date().toISOString();
}

function info(...args) {
  console.log(ts(), '[INFO]', ...args);
}

function debug(...args) {
  if (VERBOSE_LOG) console.debug(ts(), '[DEBUG]', ...args);
}

function warn(...args) {
  console.warn(ts(), '[WARN]', ...args);
}

function error(...args) {
  console.error(ts(), '[ERROR]', ...args);
}

module.exports = { info, debug, warn, error };
