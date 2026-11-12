// A record of every AI attempt: which provider and model, for which task,
// whether it worked, how long it took and the tokens it used. Shown on the
// admin page. Records are kept 30 days.
//
// The signed-in user comes from the request (AsyncLocalStorage), so llm.js
// doesn't need to know about requests.
const { AsyncLocalStorage } = require('async_hooks');
const { col } = require('./db');

const als = new AsyncLocalStorage();
const today = () => new Date().toISOString().slice(0, 10); // UTC, the day OpenRouter's free limit uses

// Express middleware: remember who is asking for the rest of this request.
const context = (req, res, next) => als.run({ userId: req.user ? req.user._id : null }, next);

// Never slows or breaks the AI call: a failed write is only logged.
function record(entry) {
  const store = als.getStore() || {};
  const now = new Date();
  let db;
  try { db = col('ai_calls'); } catch (e) { return; } // not connected (scripts)
  db.insertOne({
    at: now, day: today(), userId: store.userId || null,
    task: entry.task, provider: entry.provider, model: entry.model,
    ok: Boolean(entry.ok), ms: Math.round(entry.ms || 0), tokens: Math.round(entry.tokens || 0),
    error: entry.ok ? null : String(entry.error || '').slice(0, 200),
  }).catch((e) => console.error('AI log write failed:', e.message));
}

module.exports = { context, record, today };
