/**
 * Paper broker — simulates cash-and-carry execution with persistent state.
 *
 * State model:
 *   cashBalance     — free cash, accrues funding, pays fees
 *   deployedCapital — locked in open pairs (returns to cash on close)
 *   equity          — cash + deployed (used for DD tracking)
 *
 * Per pair: $perPairUSD splits 50/50 (long spot + short perp).
 * Funding accrues to short perp leg only.
 *
 * State persisted to JSON. Trades journaled to JSONL for analysis.
 */

import fs from "fs/promises";
import fsSync from "fs";

const MS_PER_DAY = 86400 * 1000;

export class PaperBroker {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.state = this._freshState();
  }

  _freshState() {
    const now = Date.now();
    return {
      startingBalance: this.config.startingBalance,
      cashBalance: this.config.startingBalance,
      deployedCapital: 0,
      peakEquity: this.config.startingBalance,
      maxDD: 0,
      openPositions: {},      // symbol -> {entryTime, entryFees, entryMid, totalFunding, cycles, lastAccruedT}
      closedTrades: [],
      totalEntryFees: 0,
      totalExitFees: 0,
      totalBasisCost: 0,
      totalFundingGross: 0,
      negativeFundingEvents: 0,
      startedAt: now,
      lastSavedAt: now,
    };
  }

  async loadState() {
    try {
      const raw = await fs.readFile(this.config.stateFile, "utf-8");
      const loaded = JSON.parse(raw);
      // Validate basic shape; otherwise start fresh
      if (loaded && typeof loaded.cashBalance === "number" && loaded.openPositions) {
        this.state = loaded;
        this.log(`Broker: restored state — equity $${this.equity().toFixed(2)}, ` +
                 `${Object.keys(this.state.openPositions).length} open, ` +
                 `${this.state.closedTrades.length} closed`);
        return;
      }
    } catch (e) {
      // No prior state — fall through
    }
    this.log(`Broker: starting fresh — $${this.config.startingBalance} balance`);
    this.state = this._freshState();
  }

  async saveState() {
    this.state.lastSavedAt = Date.now();
    try {
      await fs.writeFile(this.config.stateFile, JSON.stringify(this.state, null, 2));
    } catch (e) {
      this.log(`Broker: saveState failed: ${e.message}`);
    }
  }

  _journal(event) {
    try {
      fsSync.appendFileSync(
        this.config.journalFile,
        JSON.stringify({ t: Date.now(), ...event }) + "\n"
      );
    } catch (e) { /* non-fatal */ }
  }

  equity() {
    return this.state.cashBalance + this.state.deployedCapital;
  }

  hasPosition(symbol) {
    return Object.prototype.hasOwnProperty.call(this.state.openPositions, symbol);
  }

  openCount() {
    return Object.keys(this.state.openPositions).length;
  }

  canOpenNew() {
    if (this.openCount() >= this.config.maxConcurrent) return false;
    const perLeg = this.config.perPairUSD / 2;
    const need = this.config.perPairUSD + 2 * perLeg * this.config.makerFee;
    return this.state.cashBalance >= need;
  }

  openPair(symbol, midPrice, rollingAvg, time = Date.now()) {
    const cfg = this.config;
    const perLeg = cfg.perPairUSD / 2;
    const entryFees = 2 * perLeg * cfg.makerFee;
    this.state.cashBalance -= cfg.perPairUSD + entryFees;
    this.state.deployedCapital += cfg.perPairUSD;
    this.state.totalEntryFees += entryFees;
    this.state.openPositions[symbol] = {
      entryTime: time,
      entryFees,
      entryMid: midPrice,
      entryRollingAvg: rollingAvg,
      totalFunding: 0,
      cycles: 0,
      lastAccruedT: time,
    };
    this._updateDD();
    this._journal({ kind: "OPEN", symbol, mid: midPrice, rollingAvg, equity: this.equity() });
    this.log(`[OPEN]  ${symbol.padEnd(14)} mid=$${midPrice}  rollAvg=${(rollingAvg*100).toFixed(4)}%/8h  ` +
             `cash=$${this.state.cashBalance.toFixed(2)}`);
  }

  closePair(symbol, reason, time = Date.now()) {
    const cfg = this.config;
    const pos = this.state.openPositions[symbol];
    if (!pos) return null;
    const perLeg = cfg.perPairUSD / 2;
    const exitFees = 2 * perLeg * cfg.makerFee;
    const basisCost = cfg.perPairUSD * cfg.basisPenalty;
    this.state.cashBalance += cfg.perPairUSD - exitFees - basisCost;
    this.state.deployedCapital -= cfg.perPairUSD;
    this.state.totalExitFees += exitFees;
    this.state.totalBasisCost += basisCost;
    const netPnL = pos.totalFunding - pos.entryFees - exitFees - basisCost;
    const trade = {
      symbol,
      entryTime: pos.entryTime,
      exitTime: time,
      durationDays: (time - pos.entryTime) / MS_PER_DAY,
      cycles: pos.cycles,
      totalFunding: pos.totalFunding,
      entryFees: pos.entryFees,
      exitFees, basisCost, netPnL, reason,
    };
    this.state.closedTrades.push(trade);
    delete this.state.openPositions[symbol];
    this._updateDD();
    this._journal({ kind: "CLOSE", symbol, reason, ...trade });
    this.log(`[CLOSE] ${symbol.padEnd(14)} reason=${reason} cycles=${pos.cycles} ` +
             `gross=$${pos.totalFunding.toFixed(4)} net=$${netPnL.toFixed(4)}`);
    return trade;
  }

  /** Accrue ALL unaccounted funding events for a position since its lastAccruedT. */
  accrueFunding(symbol, newEvents) {
    const pos = this.state.openPositions[symbol];
    if (!pos) return 0;
    const cfg = this.config;
    const perLeg = cfg.perPairUSD / 2;
    let totalAccrued = 0;
    for (const e of newEvents) {
      if (e.time <= pos.lastAccruedT) continue;
      const pnl = perLeg * e.rate;
      this.state.cashBalance += pnl;
      pos.totalFunding += pnl;
      pos.cycles += 1;
      pos.lastAccruedT = e.time;
      this.state.totalFundingGross += pnl;
      if (e.rate < 0) this.state.negativeFundingEvents += 1;
      totalAccrued += pnl;
      this._journal({ kind: "FUNDING", symbol, rate: e.rate, pnl, ts: e.time });
    }
    if (totalAccrued !== 0) this._updateDD();
    return totalAccrued;
  }

  _updateDD() {
    const eq = this.equity();
    if (eq > this.state.peakEquity) this.state.peakEquity = eq;
    const dd = this.state.peakEquity > 0 ? (this.state.peakEquity - eq) / this.state.peakEquity : 0;
    if (dd > this.state.maxDD) this.state.maxDD = dd;
  }

  summary() {
    const eq = this.equity();
    const net = eq - this.state.startingBalance;
    const days = Math.max(0.001, (Date.now() - this.state.startedAt) / MS_PER_DAY);
    const apy = days > 0
      ? (Math.pow(eq / this.state.startingBalance, 365 / days) - 1) * 100
      : 0;
    return {
      equity: eq, net, apy, days,
      maxDD: this.state.maxDD,
      openPositions: this.openCount(),
      closedTrades: this.state.closedTrades.length,
      totalFundingGross: this.state.totalFundingGross,
      totalFees: this.state.totalEntryFees + this.state.totalExitFees,
      totalBasisCost: this.state.totalBasisCost,
      negativeFundingEvents: this.state.negativeFundingEvents,
    };
  }
}
