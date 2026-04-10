// Lightweight Bybit REST client with basic v5-style signing and batching using p-queue.
// NOTE: Bybit v5 auth requires specific signature formation. Confirm with Bybit docs if you see auth errors.
// This client supports GET/POST with JSON body and a queue to throttle requests.
const axios = require('axios');
const PQueue = require('p-queue').default;
const crypto = require('crypto');
const { info, debug, warn } = require('./logger');
const {
  BYBIT_ENV,
  BYBIT_API_KEY,
  BYBIT_API_SECRET,
  REST_BATCH_SIZE,
  REST_BATCH_INTERVAL_MS
} = require('./config');

const BASES = {
  mainnet: 'https://api.bybit.com',
  testnet: 'https://api-testnet.bybit.com'
};

const BASE = BASES[BYBIT_ENV === 'testnet' ? 'testnet' : 'mainnet'];

class BybitREST {
  constructor() {
    this.base = BASE;
    this.apiKey = BYBIT_API_KEY;
    this.apiSecret = BYBIT_API_SECRET;
    this.queue = new PQueue({ concurrency: REST_BATCH_SIZE, interval: REST_BATCH_INTERVAL_MS, intervalCap: REST_BATCH_SIZE });
    info('BybitREST configured', this.base, 'batchSize', REST_BATCH_SIZE, 'intervalMs', REST_BATCH_INTERVAL_MS);
  }

  // Bybit v5 signature: MSG = timestamp + apiKey + recvWindow + body, HMAC_SHA256(secret, MSG)
  makeHeaders(body = '') {
    const ts = Date.now().toString();
    const recvWindow = '5000';
    const payload = ts + (this.apiKey || '') + recvWindow + body;
    const sign = crypto.createHmac('sha256', this.apiSecret || '').update(payload).digest('hex');
    return {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': this.apiKey || '',
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'X-BAPI-SIGN': sign
    };
  }

  async request(method, path, params = {}) {
    const url = `${this.base}${path}`;
    return this.queue.add(async () => {
      try {
        const body = method === 'GET' ? '' : JSON.stringify(params);
        const headers = this.makeHeaders(body);
        const opts = { method, url, headers, timeout: 20000 };
        if (method === 'GET') opts.params = params;
        else opts.data = params;
        debug('REST request', method, url, method === 'GET' ? params : body);
        const resp = await axios(opts);
        return resp.data;
      } catch (err) {
        warn('REST request error', method, url, err.message);
        throw err;
      }
    });
  }

  // Public helpers
  async getTickers(symbol) {
    // uses /v5/market/tickers?category=linear&symbol=<symbol>
    try {
      return await this.request('GET', '/v5/market/tickers', { category: 'linear', symbol });
    } catch (err) {
      throw err;
    }
  }

  async getSymbols() {
    // /v5/market/instruments-info?category=linear
    try {
      return await this.request('GET', '/v5/market/instruments-info', { category: 'linear' });
    } catch (err) {
      throw err;
    }
  }

  async getKlines(symbol, interval, limit = 200) {
    // GET /v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=200
    try {
      return await this.request('GET', '/v5/market/kline', { category: 'linear', symbol, interval: String(interval), limit });
    } catch (err) {
      throw err;
    }
  }

  // Account and trading endpoints (used by trader)
  async getWalletBalance() {
    return await this.request('GET', '/v5/account/wallet-balance', { coin: 'USDT' });
  }

  async placeOrder(params) {
    // POST /v5/private/linear/order/create
    return await this.request('POST', '/v5/private/linear/order/create', params);
  }

  async setTPAndSL(params) {
    // POST /v5/private/linear/position/trading-stop
    return await this.request('POST', '/v5/private/linear/position/trading-stop', params);
  }

  async getPositions() {
    // GET /v5/private/linear/position/list
    return await this.request('GET', '/v5/private/linear/position/list', {category: 'linear'});
  }
}

module.exports = BybitREST;