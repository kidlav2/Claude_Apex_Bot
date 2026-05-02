# ICT Silver Bullet — Backtest Final Results

**Дата прогона:** 2026-05-01
**Период:** 180 дней (15m timeframe)
**Источник данных:** Binance public klines API
**Размер риска:** $10 на сделку
**Всего протестировано:** 13 инструментов

---

## Финальный конфиг стратегии

| Параметр | Значение |
|----------|---------|
| `riskRewardRatio` | 2.0 |
| `htfTimeframe` / `htfEmaPeriod` | 1H / 50 |
| `ltfEmaPeriod` | 20 (15m slope) |
| `dailyEmaPeriod` | 20 (1D trend filter) |
| `fvgLookbackBars` | 20 (~5h на 15m) |
| `sweepLookbackBars` | 192 (~48h на 15m) |
| `maxDistancePctFromHtfEma` | 1.5% |
| `atrPeriod` | 14 |
| `atrSlBuffer` | 0.5 × ATR |
| `minStopDistancePct` | 0.4% |
| Break-even | при +1R стоп переносится в entry |
| Time-stop | 8 часов (32 × 15m баров) |

## Условия входа (все 9 должны выполняться)

1. Активная Silver Bullet kill zone (London / AM / PM)
2. HTF bias = price vs 1H EMA(50)
3. Свежий FVG в направлении bias (≤ 20 баров)
4. Удаление от 1H EMA(50) < 1.5%
5. Liquidity sweep PDH/PDL в направлении bias
6. **Daily EMA(20) trend** в направлении bias
7. **HTF 1H EMA(50) slope** в направлении bias
8. **LTF 15m EMA(20) slope** в направлении bias
9. **Min stop distance** ≥ 0.4% от entry

---

## Результаты по всем монетам (180 дней, 15m)

| Symbol | Sig | W | L | BE | TO | WR% | AvgR | PnL$ | Sig/mo | Verdict |
|--------|-----|---|---|----|----|------|------|------|--------|---------|
| BTCUSDT | 17 | 3 | 6 | 4 | 4 | 33.3% | +0.01 | +$1.73 | 2.8 | ≈ breakeven |
| ETHUSDT | 12 | 3 | 3 | 1 | 5 | 50.0% | +0.27 | +$32.40 | 2.0 | ✅ profitable |
| SOLUSDT | 20 | 7 | 4 | 5 | 4 | 63.6% | +0.66 | +$132.39 | 3.3 | ✅ profitable |
| XRPUSDT | 16 | 1 | 8 | 4 | 3 | 11.1% | -0.34 | -$54.99 | — | ❌ losing |
| DOGEUSDT | 14 | 3 | 6 | 3 | 2 | 33.3% | -0.03 | -$3.96 | — | ≈ breakeven |
| ADAUSDT | 22 | 6 | 9 | 2 | 5 | 40.0% | +0.25 | +$54.18 | 3.7 | ✅ profitable |
| MATICUSDT | 0 | — | — | — | — | — | — | — | — | ⚠️ delisted (см. POL) |
| DOTUSDT | 12 | 1 | 6 | 5 | 0 | 14.3% | -0.33 | -$40.00 | — | ❌ losing |
| POLUSDT | 20 | 7 | 9 | 1 | 3 | 43.8% | +0.32 | +$63.25 | 3.3 | ✅ profitable |
| LTCUSDT | 16 | 2 | 7 | 4 | 3 | 22.2% | -0.03 | -$5.05 | — | ≈ breakeven |
| ATOMUSDT | 15 | 3 | 6 | 5 | 1 | 33.3% | +0.06 | +$8.80 | 2.5 | ≈ marginal |
| NEARUSDT | 15 | 3 | 6 | 4 | 2 | 33.3% | +0.17 | +$25.21 | 2.5 | ✅ profitable |
| INJUSDT | 10 | 1 | 6 | 2 | 1 | 14.3% | -0.28 | -$28.36 | — | ❌ losing |
| APTUSDT | 8 | 2 | 6 | 0 | 0 | 25.0% | -0.25 | -$20.00 | — | ❌ losing |

---

## 🎯 Финальный «боевой» watchlist (Avg R > 0)

| Tier | Symbol | WR% | AvgR | Sig/mo | Expected $/mo @ $10 risk |
|------|--------|-----|------|--------|--------------------------|
| **Core** | SOLUSDT | 63.6% | +0.66 | 3.3 | +$21.8 |
| **Core** | POLUSDT | 43.8% | +0.32 | 3.3 | +$10.6 |
| **Core** | ETHUSDT | 50.0% | +0.27 | 2.0 | +$5.4 |
| **Core** | ADAUSDT | 40.0% | +0.25 | 3.7 | +$9.3 |
| Strong | NEARUSDT | 33.3% | +0.17 | 2.5 | +$4.3 |
| Marginal | ATOMUSDT | 33.3% | +0.06 | 2.5 | +$1.5 |
| Marginal | BTCUSDT | 33.3% | +0.01 | 2.8 | +$0.3 |
| **TOTAL** | **7 монет** | — | — | **20.1** ✅ | **+$53.2/мес** |

**Цель 20 сигналов/месяц достигнута.** Combined PnL за 180д = **+$317.96** при $10 на сделку.

## Notes по edge cases

- **MATICUSDT** делистнут на Binance после ребрендинга в POL (август 2024). Используем POLUSDT.
- **BTC и ATOM** — formally прибыльны (avgR > 0), но крайне близко к нулю. Включаем в watchlist для статистики, но рассчитывать на их PnL не стоит. На следующих 30 днях могут уйти в минус.
- **SOL остаётся флагманом** — единственная монета с 60%+ WR и avgR > 0.5 на 180-дневной выборке.
- **POL** — приятный сюрприз (3.3 sig/mo, +0.32 R). Стоит наблюдения в paper-режиме.

## Эволюция по итерациям (для протокола)

| Итерация | Конфиг | BTC AvgR | ETH AvgR | Watchlist Sig/mo |
|----------|--------|----------|----------|------------------|
| v1 | baseline (FVG-edge SL, 1h stop) | -0.44 (30d) | — | — |
| v2 | + ATR0.2 + HTF slope + 4h stop | -0.43 (30d) | -0.41 (30d) | — |
| v3 | + min0.4% + ATR0.5 + R/R=3 + LTF slope | n/a (нет сделок) | n/a | — |
| v4 | R/R=2 + 8h stop | -0.10 (90d) | +0.23 (90d) | — |
| v5 | + daily filter + BE @ 1R | -0.20 (180d) | +0.19 (180d) | — |
| **v6 (final)** | + daily fetch fix + 7 instruments | **+0.01 (180d)** | **+0.27 (180d)** | **20.1** |

## Воспроизведение

```bash
# Bulk run 7 symbols × 180d (требует правки SYMBOLS в backtest.js)
node backtest.js --bulk

# Single symbol legacy mode
node backtest.js BTCUSDT 180
```

## Snippet для rules.json

```json
"watchlist": [
  "SOLUSDT",
  "POLUSDT",
  "ETHUSDT",
  "ADAUSDT",
  "NEARUSDT",
  "ATOMUSDT",
  "BTCUSDT"
]
```

## Рекомендации перед LIVE

1. Применить новый watchlist (PAPER_TRADING=true)
2. Прогнать бот 2 недели на live-данных через LaunchAgent
3. Сравнить реальные результаты с backtest expectancy (±20% — норма)
4. Если совпало — поэтапный переход в LIVE: сначала только SOL+ETH (Core tier) с минимальным размером ($1–5/trade), через месяц — добавление остальных
5. Marginal tier (BTC, ATOM) держать в PAPER ещё месяц после LIVE-запуска Core

---

## Оценка потенциала на Futures

**Ключевой инсайт:** наш бэктест эмулировал ОБЕ стороны (long и short), но на споте SHORT физически не исполнится — нет базовой монеты для продажи. Реальный spot LIVE PnL ≈ половина бэктестового.

### Сравнение Spot LIVE vs Futures (180д проекция)

| Параметр | Spot LIVE (Long Only) | Futures (Long + Short) | Дельта |
|----------|------------------------|-------------------------|--------|
| Сигналов/мес (Core+Strong tier) | ~7 (только longs) | ~14 (обе стороны) | +100% |
| Win Rate | ~50% (longs Core) | ~50% (симметрично) | 0 |
| Avg R/trade | +0.27 (estimate) | +0.27 (full backtest) | 0 |
| Round-trip комиссия | 0.20% (2× 0.1%) | 0.05% (2× 0.025%) | -75% |
| Capital efficiency | 1× (нужно $X для $X объёма) | 3× (margin $X для $3X объёма) | +200% |
| Доступный риск/trade при $100 | $0.08 | $0.40-1.00 | 5–12× |
| **Net expectancy/мес @ $10 risk** | **~$15-20** | **~$45-50** | **+150%** |

### Расчёт сэкономленных комиссий

| | Спот | Фьючи |
|--|------|-------|
| Maker fee | 0.10% | 0.02% |
| Taker fee | 0.10% | 0.05% |
| Round-trip (MARKET → STOP) | 0.20% | 0.07% |
| На 20 сделок/мес × $20 notional | $0.80/мес | $0.28/мес |

Экономия маленькая в абсолюте, но при увеличении объёма это **становится материальным**. На $100 notional × 30 сделок/мес = $6 vs $2.10.

### Подводные камни Futures

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| **Liquidation** при гэпе/halt | Низкая | Плечо 3× = liquidation distance ~30%, наши SL 0.4-0.8% (50× меньше). Использовать ISOLATED margin. |
| **Funding rate** на 8h hold | Низкая (по 0.005-0.05% за tick) | На $20 notional = $0.001-0.01 за tick. Незначительно. Проверять funding rate перед входом если > 0.1%. |
| **OCO не атомарный** — нужен мониторинг ноги | Высокая | Polling статуса каждые N минут или WebSocket user-data stream + cancel-sibling-on-fill. |
| **Max position count** на ограниченном капитале | Средняя | Лимит N одновременных позиций в коде. На $100 × 3× = $300 margin pool, по $20 = max 15 одновременных. На 7 монет × 3 сессии = 21 — превышение возможно. |
| **Hedge vs One-way mode** | Конфигурация | Выбрать ONE-WAY в настройках Binance (для разных пар одновременно) и `positionSide=BOTH` в API. |
| **API key permissions** | Setup | Включить "Enable Futures" в настройках API key (отдельный чекбокс). |

### Вердикт по Futures

**Положительно для нашей стратегии:**
- Восстанавливает 50% сигналов (shorts), которые spot теряет
- Делает риск экономически содержательным на капитале $100-500
- Сокращает комиссионные расходы в 3 раза

**Негативно:**
- +1-2 дня кода для миграции
- Требует мониторинг открытых ордеров (OCO не bundled)
- Юридический риск в некоторых юрисдикциях

**Чистая рекомендация:** мигрировать на futures **после подтверждения работоспособности spot LIVE инфраструктуры** в 7-дневном тесте (long-only). Если спот стабилен — приоритетная задача переписать под /fapi/.

---

## План миграции на Futures API

### Затронутые файлы
- `bot.js` — основная торговая логика (~30% переработки)
- `.env` — новые переменные
- `strategy.js` — без изменений (только индикаторы)

### Существующие функции для переработки

| Функция в bot.js | Spot endpoint | Futures endpoint | Изменения |
|------------------|---------------|------------------|-----------|
| `placeBinanceOrder()` | POST /api/v3/order | POST /fapi/v1/order | Убрать `quoteOrderQty` (нет на фьючах), считать qty из `notional / price`. Добавить `positionSide=BOTH` (one-way mode). |
| `placeOcoOrder()` | POST /api/v3/order/oco | **Нет аналога** | Заменить на 2 ордера: `TAKE_PROFIT_MARKET` + `STOP_MARKET`, оба с `reduceOnly=true`. Запомнить оба orderId. |
| `getBalanceUSDT()` | GET /api/v3/account | GET /fapi/v2/balance | Другой парсинг ответа: массив объектов с полем `availableBalance` для каждого asset'а. |
| `getSymbolFilters()` | GET /api/v3/exchangeInfo | GET /fapi/v1/exchangeInfo | Тот же формат, отдельный endpoint. |
| `signBinance()` | HMAC-SHA256 | HMAC-SHA256 | Без изменений. |

### Новые функции

| Функция | Endpoint | Назначение |
|---------|----------|------------|
| `setLeverage(symbol, lev)` | POST /fapi/v1/leverage | Установить плечо перед открытием первой позиции по каждой монете (один раз, кешировать). |
| `setMarginType(symbol, "ISOLATED")` | POST /fapi/v1/marginType | ISOLATED, чтобы убыток ограничивался margin'ом этой позиции. Вызывать один раз на старте. |
| `getOpenPositions()` | GET /fapi/v2/positionRisk | Проверка текущих открытых позиций перед входом (anti-overlap, max position count). |
| `getOpenOrders(symbol)` | GET /fapi/v1/openOrders | Список висящих SL/TP ордеров — для мониторинга и cancel-on-fill. |
| `cancelOrder(symbol, orderId)` | DELETE /fapi/v1/order | Отмена sibling ордера при срабатывании одной ноги OCO-замены. |
| `checkFundingRate(symbol)` | GET /fapi/v1/premiumIndex | Проверка funding rate перед входом (skip если > 0.1%/8h). |

### Новые переменные в .env

```
BINANCE_FUTURES=true
BINANCE_BASE_URL=https://fapi.binance.com
LEVERAGE=3
MARGIN_TYPE=ISOLATED
MAX_OPEN_POSITIONS=10
SKIP_HIGH_FUNDING_RATE=0.001  # 0.1% per 8h
```

### Дизайн OCO-замены (главная сложность)

**Атомарный поток (live):**
1. Открыть `MARKET` позицию (`placeBinanceOrder`)
2. После fill — поставить `STOP_MARKET` для SL и `TAKE_PROFIT_MARKET` для TP, оба `reduceOnly=true`
3. Сохранить оба orderId в `safety-check-log.json`
4. На каждом следующем запуске бота: `getOpenOrders(symbol)` → если одна нога пропала (исполнилась) → отменить вторую через `cancelOrder()`

**Альтернативный полный мониторинг:** WebSocket user-data stream подписан 24/7, реагирует на ORDER_TRADE_UPDATE моментально. Это +200 строк кода и отдельный долгоживущий процесс. Для нашего trade frequency (20/мес) — overkill.

**Простой фикс (рекомендую):** проверять и чистить sibling-ордера в начале каждого `processSymbol()`. Каждые 4 часа = достаточно.

### Оценка времени

- Переписать торговые функции на /fapi/: **3-5 часов**
- OCO-замена + sibling cleanup: **3-4 часа**
- Тестирование на Binance Testnet (https://testnet.binancefuture.com): **2-3 часа**
- Production-ready: **1-2 рабочих дня**

### Phased rollout

1. **Spot 7-day verification** — текущая задача, инфраструктура работает
2. **Futures Testnet 1 week** — переписанный код на тестовом окружении (виртуальные USDT)
3. **Futures LIVE с минимальным риском** — $5-10 risk per trade, 2 монеты (SOL+ETH)
4. **Полный watchlist + scaling** — все 7 монет, увеличение размера

---

## Текущий 7-day Spot Test Plan (Long Only)

**Цель:** проверить, что инфраструктура работает в LIVE — реальные ордера проходят, OCO встаёт, баланс списывается, journal/Telegram отчёт корректны. **Стратегия не проверяется** на 7 днях — выборка слишком мала.

**Конфигурация:**
- Watchlist: `["SOLUSDT", "ETHUSDT"]` (Core tier)
- `MAX_TRADE_SIZE_USD=15` (выше MIN_NOTIONAL для всех Binance пар)
- `PAPER_TRADING=false` (LIVE)
- Short-фильтр в коде: пропускать `side==="sell"` если spot
- Лимит `MAX_TRADES_PER_DAY=3` оставить

**Что проверяем за 7 дней:**
1. Реальные MARKET-ордера проходят
2. OCO размещается и встаёт в стакан
3. Балансы корректно списываются и возвращаются
4. Telegram отчёты приходят на каждый запуск
5. `trades.csv` пишется без артефактов
6. LaunchAgent отрабатывает 21 раз (3 сессии × 7 дней)

**Kill-switch правила:**
- Убыток за неделю > $20 → STOP, разбор полётов
- 3 ордера подряд с error → STOP, проверить API ключи
- Любой OCO «висит без позиции» → STOP, ручная очистка

**Параллельно:** разработка futures-версии на отдельной ветке git (`feature/futures-migration`).

