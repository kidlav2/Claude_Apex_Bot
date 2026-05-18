/**
 * L1 BookTicker WebSocket watcher with auto-reconnect, stale detection,
 * bounded exponential backoff, and explicit crash-on-overflow semantics.
 *
 * Why L1 only: bookTicker stream is ~10x lighter than diffDepth (best
 * bid/ask only). Single-vCPU can handle 30-50 symbols comfortably.
 *
 * Resilience contract:
 *   - Every WS error/close logged with reason
 *   - Reconnect backoff: base * 2^attempt with jitter, capped at wsReconnectMaxMs
 *   - After wsMaxReconnects consecutive failures, write [CRITICAL] line
 *     SYNCHRONOUSLY to bot.log and exit(1) — never a silent death
 *   - stop() is idempotent and safe in any readyState
 */

import WebSocket from "ws";
import fs from "fs";

export class BookWatcher {
  constructor(symbols, config, log) {
    this.config = config;
    this.log = log;
    this.book = new Map(); // SYMBOL -> { bid, ask, bidQty, askQty, t }
    this.symbols = new Set(symbols.map((s) => s.toUpperCase()));
    this.ws = null;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.consecutiveFailures = 0;
    this.lastMsgT = Date.now();
    this.staleTimer = null;
    this.msgCounter = 0;
    this.msgRateMonitor = null;
    this.pendingReconnect = null;
  }

  start() {
    this.stopped = false;
    this._connect();
    this.staleTimer = setInterval(() => this._checkStale(), 30000);
    this.msgRateMonitor = setInterval(() => {
      const rate = (this.msgCounter / 300).toFixed(1);
      this.log(`BookWatcher throughput: ${rate} msg/sec over last 5min`);
      this.msgCounter = 0;
    }, 5 * 60 * 1000);
  }

  stop() {
    this.stopped = true;
    if (this.staleTimer) { clearInterval(this.staleTimer); this.staleTimer = null; }
    if (this.msgRateMonitor) { clearInterval(this.msgRateMonitor); this.msgRateMonitor = null; }
    if (this.pendingReconnect) { clearTimeout(this.pendingReconnect); this.pendingReconnect = null; }
    this._teardownSocket();
  }

  /** Tear down current socket safely from ANY readyState (incl. CONNECTING). */
  _teardownSocket() {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    try { ws.removeAllListeners(); } catch (_) {}
    // Attach a noop error handler so any in-flight error after close()
    // never escapes as unhandled.
    try { ws.on("error", () => {}); } catch (_) {}
    try {
      // terminate() forcibly closes from any state including CONNECTING.
      // close() throws "WebSocket was closed before the connection was
      // established" if called pre-OPEN — that was the original crash.
      ws.terminate();
    } catch (_) { /* swallow */ }
  }

  /** Update the watched symbols set; reconnects with new streams. */
  updateSymbols(symbols) {
    const newSet = new Set(symbols.map((s) => s.toUpperCase()));
    const added = [...newSet].filter((s) => !this.symbols.has(s));
    const removed = [...this.symbols].filter((s) => !newSet.has(s));
    if (added.length === 0 && removed.length === 0) return;
    this.log(`BookWatcher: symbol set changed (+${added.length} -${removed.length}), reconnecting`);
    this.symbols = newSet;
    // Reset backoff because this is an intentional cycle, not a failure
    this.reconnectAttempt = 0;
    this.consecutiveFailures = 0;
    this._teardownSocket();
    this._scheduleReconnect(100);
  }

  _connect() {
    if (this.stopped) return;
    if (this.symbols.size === 0) {
      this.log("BookWatcher: no symbols, skipping connect");
      return;
    }

    let ws;
    try {
      const streams = [...this.symbols].map((s) => `${s.toLowerCase()}@bookTicker`).join("/");
      const url = `${this.config.wsBase}/stream?streams=${streams}`;
      ws = new WebSocket(url);
    } catch (e) {
      this.log(`BookWatcher: WS constructor threw: ${e.message}`);
      this._onFailure(`constructor: ${e.message}`);
      return;
    }

    this.ws = ws;

    ws.on("open", () => {
      this.log(`BookWatcher: WS connected (${this.symbols.size} symbols)`);
      this.reconnectAttempt = 0;
      this.consecutiveFailures = 0;
      this.lastMsgT = Date.now();
    });

    ws.on("message", (raw) => {
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
      } catch (_) { /* ignore parse failures */ }
    });

    ws.on("error", (err) => {
      const msg = (err && err.message) || String(err);
      this.log(`BookWatcher: WS error: ${msg}`);
      // Do NOT teardown here — 'close' always fires after 'error' on ws.
    });

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : "";
      if (this.stopped) {
        this.log(`BookWatcher: WS closed during shutdown (code=${code})`);
        return;
      }
      this._onFailure(`close code=${code}${reason ? ` reason=${reason}` : ""}`);
    });
  }

  _onFailure(reason) {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.wsMaxReconnects) {
      // CRITICAL: write synchronously so the line lands on disk before exit
      const line = `[${new Date().toISOString()}] [CRITICAL] BookWatcher: max WS reconnection attempts ` +
                   `(${this.config.wsMaxReconnects}) reached. Last reason: ${reason}. Exiting process.\n`;
      try { fs.appendFileSync(this.config.logFile, line); } catch (_) {}
      try { console.error(line.trim()); } catch (_) {}
      this._teardownSocket();
      // Hard exit — bypass async shutdown so we never get stuck on an
      // unresolved promise while the operator stares at a vanished PID.
      process.exit(1);
    }

    const delay = this._backoffDelay();
    this.log(`BookWatcher: WS down (${reason}); reconnect attempt ` +
             `${this.consecutiveFailures}/${this.config.wsMaxReconnects} in ${delay}ms`);
    this._teardownSocket();
    this._scheduleReconnect(delay);
  }

  _backoffDelay() {
    const base = this.config.wsReconnectBaseMs;
    const cap  = this.config.wsReconnectMaxMs;
    const exp  = Math.min(cap, base * Math.pow(2, this.reconnectAttempt));
    this.reconnectAttempt += 1;
    // Decorrelated jitter: pick uniformly in [base, exp * 1.5] capped at cap
    const jittered = base + Math.random() * (Math.min(cap, exp * 1.5) - base);
    return Math.max(base, Math.floor(jittered));
  }

  _scheduleReconnect(delayMs) {
    if (this.stopped) return;
    if (this.pendingReconnect) clearTimeout(this.pendingReconnect);
    this.pendingReconnect = setTimeout(() => {
      this.pendingReconnect = null;
      this._connect();
    }, delayMs);
  }

  _checkStale() {
    if (this.stopped) return;
    const age = Date.now() - this.lastMsgT;
    if (age > 60000 && this.ws) {
      this.log(`BookWatcher: stale (${Math.floor(age / 1000)}s); forcing reconnect`);
      // Treat staleness as failure — counts toward backoff/limit.
      this._onFailure(`stale ${Math.floor(age / 1000)}s`);
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
