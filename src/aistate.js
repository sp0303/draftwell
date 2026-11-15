// What the AI router remembers about every provider, key and model: whether it is
// resting (and until when, and why) and its recent track record. Kept in memory for
// speed and saved to the database (ai_state collection) so a restart remembers it.
//
// Ids:  provider:<name>   key:<provider>:<n>   model:<provider>|<model>
// Doc:  { restUntil, reason, busyCount, busyDay, okStreak, failStreak, lastOkAt, lastFailAt, avgMs, updatedAt }
let col = null;
try { ({ col } = require('./db')); } catch (e) { /* scripts without a database */ }

const cache = new Map();
let loadedAt = 0;
const RELOAD_MS = 60 * 1000; // pick up an admin reset made in another process within a minute

const db = () => { try { return col && col('ai_state'); } catch (e) { return null; } };

// Load (or refresh) every saved state. Safe to call before each request: it only reads
// the database once a minute, and never throws.
async function load(force = false) {
  if (!force && Date.now() - loadedAt < RELOAD_MS) return;
  loadedAt = Date.now();
  const c = db();
  if (!c) return;
  try {
    const docs = await c.find({}).toArray();
    cache.clear();
    docs.forEach((d) => cache.set(d._id, d));
  } catch (e) { /* database not connected yet: keep what is in memory */ }
}

const get = (id) => cache.get(id) || {};

function save(id, patch) {
  const doc = { ...get(id), ...patch, _id: id, updatedAt: new Date() };
  cache.set(id, doc);
  const c = db();
  if (c) {
    const { _id, ...set } = doc;
    c.updateOne({ _id: id }, { $set: set }, { upsert: true }).catch((e) => console.error('AI state save failed:', e.message));
  }
  return doc;
}

const restingUntil = (id, now = Date.now()) => { const u = get(id).restUntil; return u && +new Date(u) > now ? +new Date(u) : 0; };

function rest(id, until, reason) {
  save(id, { restUntil: new Date(until), reason });
}

// A 429 that keeps happening rests longer each time today: 10, 30, then 60 minutes.
function restBusy(id, reason = 'busy (429)') {
  const day = new Date().toISOString().slice(0, 10);
  const d = get(id);
  const n = d.busyDay === day ? (d.busyCount || 0) + 1 : 1;
  const mins = [10, 30, 60][Math.min(n, 3) - 1];
  save(id, { busyDay: day, busyCount: n, restUntil: new Date(Date.now() + mins * 60 * 1000), reason: `${reason}, ${mins} min` });
  return mins;
}

function success(id, ms) {
  const d = get(id);
  const avgMs = d.avgMs ? Math.round(d.avgMs * 0.7 + ms * 0.3) : Math.round(ms);
  save(id, { okStreak: (d.okStreak || 0) + 1, failStreak: 0, lastOkAt: new Date(), avgMs, restUntil: null, reason: null });
}

function failure(id) {
  const d = get(id);
  save(id, { failStreak: (d.failStreak || 0) + 1, okStreak: 0, lastFailAt: new Date() });
}

// Failed twice or more in a row in the last 30 minutes, and no success since.
function failing(id, now = Date.now()) {
  const d = get(id);
  return (d.failStreak || 0) >= 2 && d.lastFailAt && now - +new Date(d.lastFailAt) < 30 * 60 * 1000;
}

const all = () => [...cache.values()];

async function reset() {
  cache.clear();
  loadedAt = Date.now();
  const c = db();
  if (c) { try { await c.deleteMany({}); } catch (e) { /* not connected */ } }
}

module.exports = { load, get, save, rest, restBusy, restingUntil, success, failure, failing, all, reset };
