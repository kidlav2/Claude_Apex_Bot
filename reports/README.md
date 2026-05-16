# Apex Bot — Audit Report Index

Каждый отчёт — один файл формата `YYYY-MM-DD_audit.md`.  
Открывай любой файл напрямую или используй таблицу ниже как навигатор.

---

## История отчётов

| Дата | Период | Коммит | Сделки | Ключевая находка |
|------|--------|--------|--------|-----------------|
| [2026-05-15](./2026-05-15_audit.md) | May 11–15, 2026 | `2ddaba8` → `3b082e4` | 2 LIVE / 1 LIVE_CLOSE | ENAUSDT orphan risk; sweep gate 98.5% blocker; fvgActive confirmed |
| [2026-05-15 patch](./2026-05-15_patch.md) | Follow-up fixes | `3b082e4` → patch | — | minPrice $1.00; degenerate bracket guard; maxSweepAgeBars→20; SIGTERM Telegram |
| [2026-05-15 backtest](./2026-05-15_session_sweep_backtest.md) | Session H/L Sweep vs PDH/PDL | `backtest_session_sweep.js` | 21 B / 17 A (180d, 6 symbols) | B: +0.74R vs A; BTC +1.34R; sweep блок −13.5%; FVG — главный блокировщик |

---

## Конвенция файлов

```
reports/
├── README.md                  ← этот индекс
├── 2026-05-15_audit.md        ← первый аудит
├── 2026-05-22_audit.md        ← следующий аудит (пример)
└── ...
```

**Имя файла** = дата составления отчёта (не дата начала периода).  
**Период** всегда указан внутри файла в заголовке.

---

## Как добавить новый отчёт

1. Скопируй данные с GCP-сервера (`trades.csv`, `trading_journal.md`) в папку `SSH/`.
2. Попроси Claude: `"проведи аудит за период X–Y и создай отчёт в reports/"`.
3. Claude создаст `reports/YYYY-MM-DD_audit.md` и обновит эту таблицу.
