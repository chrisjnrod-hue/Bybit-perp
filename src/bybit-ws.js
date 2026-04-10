const WebSocket = require('ws');
const EventEmitter = require('events');
const { info, debug, warn, error } = require('./logger');
const { BYBIT_ENV, WS_RECONNECT_MS } = require('./config');

// Bybit v5 public linear websocket endpoints
const URLS = {
  mainnet: 'wss://stream.bybit.com/v5/public/linear',
  testnet: 'wss://stream-testnet.bybit.com/v5/public/linear'
};

class BybitWS extends EventEmitter {
  constructor() {
    super();
    this.url = URLS[BYBIT_ENV === 'testnet' ? 'testnet' : 'mainnet'];
    this.ws = null;
    this.connected = false;
    this.subscribed = new Set();
    this._pendingSubs = new Set();
    this._reconnectTimer = null;
    this._heartbeatInterval = null;
  }

  connect() {
    info('BybitWS connecting to', this.url);
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      error('BybitWS constructor error', err.message);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.connected = true;
      info('BybitWS open');
      // re-subscribe any topics we previously requested
      for (const t of Array.from(this.subscribed)) {
        this._sendSubscribe(t);
      }
      this.emit('connected');
      // heartbeat
      if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = setInterval(() => {
        try {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        } catch (err) {
          debug('heartbeat error', err.message);
        }
      }, 25000);
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this.emit('message', msg);
        debug('BybitWS message', msg.topic || msg);
      } catch (err) {
        debug('BybitWS message parse error', err.message);
      }
    });

    this.ws.on('close', (code, reason) => {
      warn('BybitWS closed', code, reason && reason.toString ? reason.toString() : reason);
      this.connected = false;
      if (this._heartbeatInterval) {
        clearInterval(this._heartbeatInterval);
        this._heartbeatInterval = null;
      }
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      error('BybitWS error', err.message);
      try { this.ws.terminate(); } catch (e) { /* ignore */ }
    });

    if (this.ws && this.ws.on) {
      this.ws.on('pong', () => {
        debug('BybitWS pong received');
      });
    }
  }

  scheduleReconnect() {
    if (this._reconnectTimer) return;
    debug('BybitWS scheduling reconnect in', WS_RECONNECT_MS, 'ms');
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, WS_RECONNECT_MS || 5000);
  }

  _sendSubscribe(topic) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this._pendingSubs.add(topic);
      return;
    }
    try {
      const msg = { op: 'subscribe', args: [topic] };
      this.ws.send(JSON.stringify(msg));
      debug('BybitWS sent subscribe', topic);
    } catch (err) {
      warn('BybitWS subscribe send error', err.message);
    }
  }

  subscribe(topic) {
    if (!topic) return;
    this.subscribed.add(topic);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendSubscribe(topic);
    } else {
      this._pendingSubs.add(topic);
      debug('BybitWS queued subscribe', topic);
    }
  }

  subKline(symbol, interval) {
    // Use correct v5 topic: kline.{interval}.{symbol}
    if (!symbol || !interval) return;
    const topic = `kline.${String(interval)}.${symbol}`;
    this.subscribe(topic);
  }

  unsubscribe(topic) {
    if (!topic) return;
    this.subscribed.delete(topic);
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const msg = { op: 'unsubscribe', args: [topic] };
        this.ws.send(JSON.stringify(msg));
        debug('BybitWS sent unsubscribe', topic);
      }
    } catch (err) {
      warn('BybitWS unsubscribe send error', err.message);
    }
  }

  close() {
    try {
      if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
      if (this.ws) this.ws.close();
    } catch (err) {
      debug('BybitWS close error', err.message);
    }
  }
}

module.exports = BybitWS;
