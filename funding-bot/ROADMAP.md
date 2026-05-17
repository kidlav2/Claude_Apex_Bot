# Funding Bot — Deployment Roadmap

Production-ready paper-trading framework for **funding-rate cash-and-carry arbitrage** with rolling 60-day universe refresh and L1 spread veto gate.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  index.js (main loop, every 5 min)                          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 1. Universe refresh check (60-day rolling)            │  │
│  │ 2. Funding-rate REST poll                             │  │
│  │ 3. Accrue funding for open positions                  │  │
│  │ 4. Exit check (rolling avg < threshold)               │  │
│  │ 5. Entry check → L1 spread VETO gate → open pair      │  │
│  │ 6. Persist state + summary log                        │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
        │                  │                   │
        ▼                  ▼                   ▼
   ┌─────────┐      ┌──────────────┐    ┌──────────────┐
   │universe │      │funding-engine│    │paper-broker  │
   │  .js    │      │  .js (REST)  │    │  .js         │
   └─────────┘      └──────────────┘    └──────────────┘
                            │
                            ▼ (async)
                    ┌──────────────┐
                    │book-watcher  │  ← WS bookTicker (always-on)
                    │  .js (L1)    │     ~50-200 msg/sec @ 30 syms
                    └──────────────┘
```

| File | Purpose |
|------|---------|
| `config.js` | All tunables, env-overridable |
| `universe.js` | Top-N by funding stdev, 60-day refresh, on-disk cache |
| `book-watcher.js` | WS bookTicker; spread-veto gate |
| `funding-engine.js` | REST funding-rate poller; entry/exit signal logic |
| `paper-broker.js` | Simulated execution; persistent state; JSONL journal |
| `index.js` | Event loop orchestrator |
| `verify.js` | (optional) sanity checks pre-deploy |

## Quick start (local)

```bash
cd funding-bot/
npm install
node index.js
```

Override any default via env:
```bash
START_USD=100 PER_PAIR_USD=20 MAX_CONCURRENT=5 node index.js
```

State files appear in `./funding-bot/`:
- `state.json` — broker state (resumes on restart)
- `universe.json` — basket cache
- `bot.log` — human-readable log
- `journal.jsonl` — every event (one JSON per line, for analysis)

## Deploying on Free Tier

### Oracle Cloud Always Free (recommended)
4 vCPU ARM (Ampere A1), 24 GB RAM, 200 GB storage, $0/month forever.

1. Create instance: Canonical Ubuntu 22.04, Ampere A1, 1 OCPU, 6 GB RAM
2. Open SSH and install Node 20:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs git
   ```
3. Clone repo + install deps:
   ```bash
   git clone <your-repo> ~/funding-bot
   cd ~/funding-bot/funding-bot
   npm install
   ```
4. Create systemd unit `/etc/systemd/system/funding-bot.service`:
   ```ini
   [Unit]
   Description=Funding Bot Paper Trader
   After=network.target

   [Service]
   Type=simple
   User=ubuntu
   WorkingDirectory=/home/ubuntu/funding-bot/funding-bot
   ExecStart=/usr/bin/node index.js
   Restart=always
   RestartSec=10
   Environment=NODE_ENV=production
   Environment=MODE=paper
   Environment=START_USD=100

   [Install]
   WantedBy=multi-user.target
   ```
5. Enable + start:
   ```bash
   sudo systemctl enable funding-bot
   sudo systemctl start funding-bot
   journalctl -u funding-bot -f
   ```

### Railway / Fly.io / Render free tier
Works the same — just point the runtime at `node index.js` and persist `funding-bot/` directory via a volume mount.

## Resource budget (1 vCPU)

| Component | CPU | Memory | Network |
|-----------|-----|--------|---------|
| Node baseline | 1-3% | 50 MB | — |
| WS bookTicker × 30 syms | 5-10% peak / 2-5% avg | ~30 MB | ~50 KB/s |
| REST funding poll (5min) | <1% | — | ~30 KB / cycle |
| State save | <1% (1/min) | — | disk only |
| **Total sustained** | **~5-8%** | **~80-120 MB** | **~50 KB/s** |

Headroom is comfortable on 1 vCPU. The bot is **not CPU-bound**.

## L1 spread veto — what it does

Before opening a pair on `XYZUSDT`:
1. Read latest `bookTicker` quote (best bid, best ask)
2. Compute spread % = `(ask - bid) / mid`
3. If `> maxSpreadPct` (default 0.05%) → VETO, log reason, skip
4. Also veto if quote age > 10s (stale book)

This protects against:
- **Maker fill failure**: wide spread = your maker limit at mid won't fill cleanly
- **Hidden basis blowout**: wide perp spread usually correlates with wide spot spread → basis cost spikes
- **Liquidity vacuum**: during news/halt events, spread blows out before price catches up

Expected effect: ~2-8% of entry candidates vetoed in normal markets, jumping to 30-50% during volatility events. Saves more than it skips.

## Paper → Live transition plan

**Do NOT run live without these steps:**

1. **Paper run ≥ 30 days** under real conditions
2. **Compare actual to expected:**
   - Funding accrued in paper vs sum of universe's actual funding payments during the period
   - Should match within ±5% (paper has perfect timing; live has fill delay)
3. **Verify veto behavior:** spread vetoes should fire 2-10% of attempts
4. **Implement `live-broker.js`** (deliberately omitted from MVP):
   - Real Binance Futures API client (HMAC SHA256 signing)
   - Real spot Binance API client
   - Margin transfer between spot/futures wallets
   - Position reconciliation on startup (read actual positions vs state.json)
   - Hard kill switch (e.g., on equity drop > 5%)
   - 2FA-protected API keys, IP-restricted
5. **Start LIVE with $50 max** for 7-14 days
6. **Scale up only after live matches paper within ±10%**

## What the bot does NOT do (yet)

- Live trading (paper only — by design)
- Per-coin position sizing (uniform `perPairUSD`)
- Funding-rate prediction (reactive to rolling avg, no ML)
- Cross-exchange arb (Binance only)
- Negative-funding inverted strategy (long perp, short spot)
- Dynamic re-sizing based on equity growth (compound)
- Notifications (no Telegram/Discord hooks yet)
- Web dashboard

These are all sound extensions but each is its own project. The MVP is the loop + L1 gate, validated by 30-day paper run.

## Verifying the bot works (smoke test)

After `npm install`, run for 5 min and check:
```bash
node index.js
# Watch for:
# - "Universe: refreshed" (first run) or "Universe: loaded from cache" (subsequent)
# - "Engine: primed N/N" (funding history loaded)
# - "BookWatcher: WS connected" (websocket up)
# - "BookWatcher throughput: X msg/sec" after 5 min
# - "cycle=1 ..." (full event loop completed)
```

If no entries fire on first cycle (likely — current alt funding is mostly low), that's expected. The bot waits for opportunities. Watch `bot.log` to see veto reasons and rolling-avg progressions.

## Known limitations & honesty

- **OOS APY ≈ 2%** based on backtest. On $100 = ~$2/yr. Real value of this bot is at $700+ balance.
- **Paper assumes maker-fill always succeeds** at current mid. Real execution has queue position risk; live fills may be slower or partial. Add a fill simulator if rigor is needed.
- **Funding rate poll is reactive** — we observe the rate AFTER the cycle. There's a small lag between "rolling avg crosses entry" and the bot opening the position (≤ 1 poll interval = 5 min). For 8h funding cycles, this is acceptable.
- **No hedge against exchange risk** (Binance outage / suspension / API change). Single point of failure. Diversification across venues is a future enhancement.
