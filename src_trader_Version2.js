// Trade execution module: position sizing, order placement, TP/SL, breakeven management.
// Uses BybitREST and respects DRY_RUN. Tracks open trades in memory and persists to signals.json
const BybitREST = require('./bybit-rest');
const { readSignals, writeSignals } = require('./storage');
const { info, debug, warn } = require('./logger');
const {
  OPEN_TRADES,
  MAX_OPEN_TRADES,
  TRADE_LEVERAGE,
  TAKE_PROFIT_PCT,
  STOP_LOSS_PCT,
  BREAKEVEN_PCT,
  BREAKEVEN_TRIGGER_PCT,
  BREAKEVEN_HIGHER_LOWS,
  DRY_RUN
} = require('./config');
const uuid = require('uuid').v4;

class Trader {
  constructor() {
    this.rest = new BybitREST();
    this.openTrades = []; // in-memory tracking: {id, symbol, size, entryPrice, side, restOrderRes, created}
    this.loadPersisted();
  }

  loadPersisted() {
    const s = readSignals();
    // filter persisted trade entries that marked as trade-open; we import them lightly
    this.openTrades = (s || []).filter(x => x.type === 'trade' && x.status === 'open').map(x => ({ ...x }));
    debug('Trader loaded persisted open trades', this.openTrades.length);
  }

  persistTradeRecord(record) {
    const s = readSignals();
    s.push(record);
    writeSignals(s);
  }

  positionSizeFromBalance(balanceUSD, maxOpen = MAX_OPEN_TRADES) {
    const portion = Math.max(1, maxOpen);
    return (balanceUSD / portion);
  }

  async openTrade(symbol, direction, amountUsd) {
    // direction 'Buy' or 'Sell' (long vs short)
    if (!OPEN_TRADES) {
      info('OPEN_TRADES is false; skipping openTrade');
      return { dry: true };
    }
    if (this.openTrades.length >= MAX_OPEN_TRADES) {
      warn('Max open trades reached, skipping', this.openTrades.length);
      return { error: 'max_open' };
    }
    const id = uuid();
    // fetch ticker price to decide entry price
    const tickResp = await this.rest.getTickers(symbol);
    const tickData = tickResp?.result?.list?.[0] || tickResp?.result?.[0] || (tickResp?.ret_msg ? null : null);
    const price = tickData ? Number(tickData.last_price || tickData.lastPrice || tickData.last) : null;
    if (!price) {
      warn('Could not fetch price for', symbol);
    }
    const size = amountUsd / (price || 1); // quantity in base currency; adjust if contract-size-based
    const order = {
      symbol,
      side: direction,
      order_type: 'Market',
      qty: Number(size.toFixed(6)),
      time_in_force: 'ImmediateOrCancel',
      reduce_only: false,
      take_profit: '',
      stop_loss: ''
    };

    if (DRY_RUN) {
      info('DRY_RUN - simulated order', { id, symbol, direction, qty: order.qty, price });
      const rec = { id, type: 'trade', symbol, side: direction, size: order.qty, entryPrice: price, status: 'open', created: Date.now() };
      this.openTrades.push(rec);
      this.persistTradeRecord(rec);
      return { simulated: true, rec };
    }

    try {
      const resp = await this.rest.placeOrder(order);
      info('Order placed', resp);
      const rec = { id, type: 'trade', symbol, side: direction, size: order.qty, entryPrice: price, rest: resp, status: 'open', created: Date.now() };
      this.openTrades.push(rec);
      this.persistTradeRecord(rec);

      // immediately set TP and SL using trading-stop
      const tp = Number((price * (1 + (TAKE_PROFIT_PCT / 100))).toFixed(2));
      const sl = Number((price * (1 - (STOP_LOSS_PCT / 100))).toFixed(2));
      const tsParams = {
        symbol,
        take_profit: tp,
        stop_loss: sl,
        position_idx: 0
      };
      await this.rest.setTPAndSL(tsParams);
      info('TP/SL set', { tp, sl });
      return { ok: true, resp, rec };
    } catch (err) {
      warn('openTrade error', err.message);
      return { error: err.message };
    }
  }

  async manageBreakeven() {
    // periodically check open trades and account PnL; move SL to breakeven when profit threshold reached
    if (DRY_RUN) return;
    try {
      const positionsResp = await this.rest.getPositions();
      const list = positionsResp?.result?.list || positionsResp?.result || [];
      for (const p of list) {
        if (!p || Number(p.size || p.qty || p.size) === 0) continue;
        const unrealized = Number(p.unrealised_pnl || p.unrealisedPnl || 0);
        // placeholder: application-specific breakeven logic should compute based on entry and mark price
        // left as a TODO to complete based on bybit position object fields
      }
    } catch (err) {
      warn('manageBreakeven error', err.message);
    }
  }
}

module.exports = Trader;