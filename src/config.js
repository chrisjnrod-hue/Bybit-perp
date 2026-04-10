const dotenv = require('dotenv');
dotenv.config();

function csv(s) {
  if (!s) return [];
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

const ROOT_TFS = csv(process.env.ROOT_TFS || '60,240,D');
const MTF_TFS = csv(process.env.MTF_TFS || '5,15,60,240,D');

module.exports = {
  BYBIT_API_KEY: process.env.BYBIT_API_KEY,
  BYBIT_API_SECRET: process.env.BYBIT_API_SECRET,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  BYBIT_ENV: process.env.BYBIT_ENV || 'mainnet',
  ROOT_TFS,
  MTF_TFS,
  MTF_CHECK_ON_5M: (process.env.MTF_CHECK_ON_5M || 'true') === 'true',
  WS_INSTRUMENT_TOPIC: process.env.WS_INSTRUMENT_TOPIC || 'instrument_info.100ms',
  REST_FALLBACK_IF_WS_FAIL: (process.env.REST_FALLBACK_IF_WS_FAIL || 'true') === 'true',
  STABLE_COINS: csv(process.env.STABLE_COINS || 'USDT,USDC,DAI,BUSD'),
  CONCURRENCY: Number(process.env.CONCURRENCY || 4),
  API_MAX_RETRY: Number(process.env.API_MAX_RETRY || 3),
  WS_RECONNECT_MS: Number(process.env.WS_RECONNECT_MS || 5000),
  REST_BATCH_SIZE: Number(process.env.REST_BATCH_SIZE || 6),
  REST_BATCH_INTERVAL_MS: Number(process.env.REST_BATCH_INTERVAL_MS || 200),

  // Seeding historical candles to initialize indicators
  SEED_HISTORICAL: (process.env.SEED_HISTORICAL || 'true') === 'true',
  HIST_LOOKBACK: Number(process.env.HIST_LOOKBACK || 50), // number of candles to fetch for seeding
  SEED_SYMBOLS_LIMIT: Number(process.env.SEED_SYMBOLS_LIMIT || 0), // 0 = all symbols
  SEED_BATCH_SIZE: Number(process.env.SEED_BATCH_SIZE || 10),
  SEED_BATCH_DELAY_MS: Number(process.env.SEED_BATCH_DELAY_MS || 500),

  OPEN_TRADES: (process.env.OPEN_TRADES || 'false') === 'true',
  MAX_OPEN_TRADES: Number(process.env.MAX_OPEN_TRADES || 3),
  TAKE_PROFIT_PCT: Number(process.env.TAKE_PROFIT_PCT || 3),
  STOP_LOSS_PCT: Number(process.env.STOP_LOSS_PCT || 2),
  TRADE_LEVERAGE: Number(process.env.TRADE_LEVERAGE || 10),
  BREAKEVEN_PCT: Number(process.env.BREAKEVEN_PCT || 1),
  BREAKEVEN_TRIGGER_PCT: Number(process.env.BREAKEVEN_TRIGGER_PCT || 0.5),
  BREAKEVEN_HIGHER_LOWS: (process.env.BREAKEVEN_HIGHER_LOWS || 'false') === 'true',
  DRY_RUN: (process.env.DRY_RUN || 'true') === 'true',

  MACD_HIST_POSITIVE_THRESHOLD: Number(process.env.MACD_HIST_POSITIVE_THRESHOLD || 0.0),
  MIN_24H_VOL_CHANGE_PCT: Number(process.env.MIN_24H_VOL_CHANGE_PCT || 0.0),
  MIN_24H_PRICE_CHANGE_PCT: Number(process.env.MIN_24H_PRICE_CHANGE_PCT || -100),

  VERBOSE_LOG: (process.env.VERBOSE_LOG || 'false') === 'true',
  HTTP_PORT: Number(process.env.PORT || process.env.HTTP_PORT || 3000),
  PUSH_SIGNALS_ON_START: (process.env.PUSH_SIGNALS_ON_START || 'true') === 'true',

  SIGNALS_FILE: process.env.SIGNALS_FILE || 'data/signals.json'
};
