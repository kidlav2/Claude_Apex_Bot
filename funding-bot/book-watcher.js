/**
 * L1 BookTicker WebSocket watcher with auto-reconnect, stale detection,
 * and dynamic symbol subscription.
 *
 * Why L1 only: bookTicker stream is ~10x lighter than diffDepth (best
 * bid/ask only). Single-vCPU can handle 30-50 symbols comfortably.
 *
 * Memory footprint: 1 Map entry per symbol, ~80 bytes. 30 syms ≈ 3 KB.
 *
 * Acts as a VETO gate before entry: if spread > maxSpreadPct of mid, or
 * if last quote is older than maxBookAgeMs, the entry is blocked.
 */

import WebSocket from "ws";

export class BookWatcher {
  constructor(symbols, config, log) {
    this.config = config;
    this.log = log;
    this.book = new Map(); // SYMBOL -> { bid, ask, bidQty, askQty, t }
    this.symbols = new Set(symbols.map((s) => s.toUpperCase()));
    this.ws = null;
    this.reconnectMs = 1000;
    this.maxReconnectMs = 30000;
    this.lastMsgT = Date.now();
    this.staleTimer = null;
    this.msgCounter = 0; // for throughput stats
    this.msgRateMonitor = null;
  }

  start() {
    this._connect();
    // Watchdog: force reconnect if no messages for 60s
    this.staleTimer = setInterval(() => this._checkStale(), 30000);
    // Throughput log: every 5 min print msgs/sec
    this.msgRateMonitor = setInterval(() => {
      const rate = (this.msgCounter / 300).toFixed(1);
      this.log(`BookWatcher throughput: ${rate} msg/sec over last 5min`);
      this.msgCounter = 0;
    }, 5 * 60 * 1000);
  }

  stop() {
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.msgRateMonitor) clearInterval(this.msgRateMonitor);
    if (this.ws) {
      this.ws.removeAllListeners();
      // ws.close() throws if WebSocket is in CONNECTING state (readyState 0).
      // Use terminate() which is safe in any state.
      try {
        if (this.ws.readyState === 1 /* OPEN */) {
          this.ws.close();
        } else {
          this.ws.terminate();
        }
      } catch (e) { /* swallow */ }
      this.ws = null;
    }
  }

  /** Update the watched symbols set; reconnects with new streams. */
  updateSymbols(symbols) {
    const newSet = new Set(symbols.map((s) => s.toUpperCase()));
    const added = [...newSet].filter((s) => !this.symbols.has(s));
    const removed = [...this.symbols].filter((s) => !newSet.has(s));
    if (added.length === 0 && removed.length === 0) return;
    this.log(`BookWatcher: symbol set changed (+${added.length} -${removed.length}), reconnecting`);
    this.symbols = newSet;
    if (this.ws) this.ws.close(); // close handler will reconnect with new streams
  }

  _connect() {
    if (this.symbols.size === 0) {
      this.log("BookWatcher: no symbols, skipping connect");
      return;
    }
    const streams = [...this.symbols].map((s) => `${s.toLowerCase()}@bookTicker`).join("/");
    const url = `${this.config.wsBase}/stream?streams=${streams}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.log(`BookWatcher: WS connected (${this.symbols.size} symbols)`);
      this.reconnectMs = 1000;
      this.lastMsgT = Date.now();
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        const d = msg.data || msg;
        if (!d || !d.s) return;
        const bid = parseFloat(d.b);
        const ask = parseFloat(d.a);
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;
        this.book.set(d.s, {
          bid, ask,
          bidQty: parseFloat(d.B),
          askQty: parseFloat(d.A),
          t: Date.now(),
        });
        this.lastMsgT = Date.now();
        this.msgCounter += 1;
      } catch (e) {
        // ignore parse failures
      }
    });

    this.ws.on("close", () => {
      this.log(`BookWatcher: WS closed; reconnect in ${this.reconnectMs}ms`);
      setTimeout(() => this._connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, this.maxReconnectMs);
    });

    this.ws.on("error", (err) => {
      this.log(`BookWatcher: WS error: ${err.message || err}`);
      // close handler will fire and reconnect
    });
  }

  _checkStale() {
    const age = Date.now() - this.lastMsgT;
    if (age > 60000 && this.ws) {
      this.log(`BookWatcher: stale (${Math.floor(age / 1000)}s); forcing reconnect`);
      this.ws.close();
    }
  }

  /** Returns { bid, ask, mid, age } or null if no quote. */
  snapshot(symbol) {
    const sym = symbol.toUpperCase();
    const b = this.book.get(sym);
    if (!b) return null;
    return { ...b, mid: (b.bid + b.ask) / 2, age: Date.now() - b.t };
  }

  /**
   * Spread veto gate. Returns { pass: bool, reason?, spread? }.
   * Pass criteria:
   *   - Have a book quote
   *   - Quote younger than maxBookAgeMs
   *   - Spread (ask-bid)/mid <= maxSpreadPct
   */
  passesSpreadGate(symbol) {
    const snap = this.snapshot(symbol);
    if (!snap) return { pass: false, reason: "no book data" };
    if (snap.age > this.config.maxBookAgeMs) {
      return { pass: false, reason: `stale (${snap.age}ms)` };
    }
    if (snap.bid <= 0 || snap.ask <= 0 || snap.ask <= snap.bid) {
      return { pass: false, reason: "invalid quote" };
    }
    const spreadPct = (snap.ask - snap.bid) / snap.mid;
    if (spreadPct > this.config.maxSpreadPct) {
      return {
        pass: false,
        reason: `spread ${(spreadPct * 100).toFixed(4)}% > limit ${(this.config.maxSpreadPct * 100).toFixed(4)}%`,
        spread: spreadPct,
      };
    }
    return { pass: true, spread: spreadPct, mid: snap.mid };
  }

  /** How many symbols currently have a book quote? */
  coverage() {
    return this.book.size;
  }
}
