// Simple Telegram sender using bot token and chat id
const axios = require('axios');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = require('./config');
const { info, warn } = require('./logger');

/**
 * sendTelegram: sends an HTML-formatted message to the configured chat id.
 * If TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID are missing, the function logs a warning and returns.
 */
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    warn('Telegram not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID). Skipping send.');
    return { skipped: true };
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const resp = await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { timeout: 10000 });
    info('Telegram message sent');
    return resp.data;
  } catch (err) {
    warn('Telegram send error:', err && err.message ? err.message : err);
    return { error: err.message || String(err) };
  }
}

module.exports = { sendTelegram };
