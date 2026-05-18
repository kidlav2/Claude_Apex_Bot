/**
 * Telegram notifications for Apex Funding.
 *
 * Shares the same TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env contract as
 * mean-bot.js (Apex Ranger) — single chat, multiple bots, disambiguated
 * by the leading tag emoji + name.
 *
 * Contract:
 *   - sendTelegram(text) is FIRE-AND-FORGET (never throws, never blocks
 *     the caller longer than the network round-trip).
 *   - sendTelegramWithTimeout(text, ms) AWAITS up to `ms` then resolves —
 *     used on the CRITICAL exit path so we get one best-effort attempt
 *     before process.exit(1).
 *   - Both no-op when env not configured, just like Apex Ranger.
 *   - Markdown is the parse mode; escape backticks/underscores by hand
 *     in callers when emitting raw symbol/reason strings.
 */

export const BOT_TAG = "🛡️ *[Apex Funding]*";

function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function postOnce(text, timeoutMs) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const tagged = `${BOT_TAG}\n${text}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: tagged, parse_mode: "Markdown" }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(`⚠️  Telegram error: ${res.status} ${body}`);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      console.log(`⚠️  Telegram send timed out after ${timeoutMs}ms`);
    } else {
      console.log(`⚠️  Telegram send failed: ${err.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget send. Returns a promise that always resolves. */
export function sendTelegram(text) {
  if (!isConfigured()) return Promise.resolve();
  return postOnce(text, 8000);
}

/**
 * Awaitable send capped at `timeoutMs`. Use on the CRITICAL exit path so
 * the process doesn't exit before Telegram has a chance to deliver, but
 * also doesn't hang indefinitely if the API is unreachable.
 */
export function sendTelegramWithTimeout(text, timeoutMs = 3000) {
  if (!isConfigured()) return Promise.resolve();
  return Promise.race([
    postOnce(text, timeoutMs),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

/** Tiny helper to escape Markdown metachars that mangle Telegram rendering. */
export function mdEscape(s) {
  return String(s).replace(/([_*`\[\]])/g, "\\$1");
}
