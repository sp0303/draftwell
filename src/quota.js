// Free-tier limits per provider, key and model, and how much of each is used.
//
// Limits apply per key (one key = one account or project) and per "quota family":
// some providers count several model names against one limit (on Gemini, 3.5 Flash
// counts as 3.6 Flash and 3.7 Flash as 3.8 Flash; on OpenRouter every ":free" model
// shares one daily limit per account). Usage comes from the AI request log in the
// database (today's requests, with each provider's own day boundary) plus a live
// count of the last minute, so a model at its limit is skipped without a wasted call.
//
// Override or add limits with LLM_LIMITS (JSON array, same shape as DEFAULTS below).
const config = require('./config');

// rpm = requests per minute, tpm = tokens per minute, rpd = requests per day.
const DEFAULTS = [
  // OpenRouter: every free model shares 20 a minute and 50 a day per account (1,000 a day after a $10 credit).
  { provider: 'openrouter', family: 'free models', match: ':free$', rpm: 20, rpd: () => config.openrouterDailyLimit },
  // NVIDIA API catalog: about 40 a minute per account, no published daily limit.
  { provider: 'nvidia', family: 'all models', match: '.', rpm: 40 },
  // Gemini API free tier (per project, from AI Studio's rate-limit page). Days reset at midnight Pacific.
  { provider: 'gemini', family: '3.8 Flash', models: ['gemini-3.8-flash', 'gemini-3.7-flash'], rpm: 5, tpm: 250000, rpd: 20 },
  { provider: 'gemini', family: '3.6 Flash', models: ['gemini-3.6-flash', 'gemini-3.5-flash'], rpm: 5, tpm: 250000, rpd: 20 },
  { provider: 'gemini', family: '3 Flash', models: ['gemini-3-flash-preview', 'gemini-3-flash'], rpm: 5, tpm: 250000, rpd: 20 },
  { provider: 'gemini', family: '4 Hydrogen', models: ['gemini-4-hydrogen'], rpm: 5, tpm: 250000, rpd: 20 },
  { provider: 'gemini', family: '3.5 Flash Lite', models: ['gemini-3.5-flash-lite'], rpm: 15, tpm: 250000, rpd: 500 },
  { provider: 'gemini', family: '3.1 Flash Lite', models: ['gemini-3.1-flash-lite'], rpm: 15, tpm: 250000, rpd: 500 },
  { provider: 'gemini', family: 'Gemma 4 31B', models: ['gemma-4-31b-it'], rpm: 30, tpm: 16000, rpd: 14400 },
  { provider: 'gemini', family: 'Gemma 4 26B', models: ['gemma-4-26b-a4b-it'], rpm: 30, tpm: 16000, rpd: 14400 },
];
// When each provider's day starts over (its daily limits reset).
const DAY_TZ = { openrouter: 'UTC', nvidia: 'UTC', gemini: 'America/Los_Angeles' };

function limits() {
  let extra = [];
  try { extra = JSON.parse(process.env.LLM_LIMITS || '[]'); } catch (e) { console.error('LLM_LIMITS is not valid JSON; ignoring it'); }
  // Paid Gemini (billing on): Tier 1 allows hundreds of requests a minute, so only a daily
  // spending guard applies to Gemini models. Gemma stays on its own (free) limits.
  const all = DEFAULTS.map((d) => (d.provider === 'gemini' && config.gemini.paid && !/^Gemma/.test(d.family)
    ? { ...d, rpm: 300, tpm: 2000000, rpd: config.gemini.dailyLimit } : d));
  extra.forEach((x) => {
    const i = all.findIndex((d) => d.provider === x.provider && d.family === x.family);
    if (i >= 0) all[i] = { ...all[i], ...x }; else all.push(x);
  });
  return all.map((d) => ({ ...d, rpd: typeof d.rpd === 'function' ? d.rpd() : d.rpd }));
}

// The limit (quota family) a model belongs to, or null if it has none.
function limitFor(provider, model) {
  return limits().find((d) => d.provider === provider
    && (d.models ? d.models.includes(model) : new RegExp(d.match).test(model))) || null;
}

// Midnight in the provider's time zone, as a Date (the start of its "today").
function dayStart(provider, now = new Date()) {
  const tz = DAY_TZ[provider] || 'UTC';
  if (tz === 'UTC') { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const sinceMidnight = (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - sinceMidnight);
}
// The next midnight in the provider's time zone. 25 hours after today's midnight always
// lands on the next calendar day (days are 23 to 25 hours long around clock changes).
const nextDayStart = (provider, now = new Date()) => dayStart(provider, new Date(dayStart(provider, now).getTime() + 25 * 3600 * 1000));

// ---- usage ----
// Today's requests per "provider|key|family" from the database, refreshed every 30 s,
// plus requests made since the last refresh. The last minute is kept in memory.
const usage = { day: new Map(), readAt: 0, since: [] };
let recent = []; // { t, id, tokens } for the last 60 s
const fid = (provider, keyNo, family) => `${provider}|${keyNo || 1}|${family}`;

async function refresh(force = false) {
  if (!force && Date.now() - usage.readAt < 30 * 1000) return;
  const readAt = Date.now();
  let col;
  try { col = require('./db').col('ai_calls'); } catch (e) { return; }
  try {
    const day = new Map();
    for (const provider of Object.keys(DAY_TZ)) {
      const rows = await col.aggregate([
        { $match: { provider, at: { $gte: dayStart(provider) } } },
        { $group: { _id: { key: { $ifNull: ['$key', 1] }, model: '$model' }, n: { $sum: 1 } } },
      ]).toArray();
      rows.forEach((r) => {
        const lim = limitFor(provider, r._id.model);
        if (!lim) return;
        const id = fid(provider, r._id.key, lim.family);
        day.set(id, (day.get(id) || 0) + r.n);
      });
    }
    // The last minute too, so a restart doesn't forget it.
    const minute = await col.find({ at: { $gte: new Date(Date.now() - 60 * 1000) } }, { projection: { provider: 1, model: 1, key: 1, at: 1, tokens: 1 } }).toArray();
    const fromDb = minute.map((c) => { const lim = limitFor(c.provider, c.model); return lim && { t: +c.at, id: fid(c.provider, c.key, lim.family), tokens: c.tokens || 0, db: true }; }).filter(Boolean);
    recent = recent.filter((r) => !r.db && r.t > readAt).concat(fromDb);
    usage.day = day;
    usage.since = usage.since.filter((x) => x.t > readAt);
    usage.readAt = readAt;
  } catch (e) { /* database not ready: keep counting in memory */ }
}

// Record a request (called before each try, as providers count failed requests too).
function note(provider, keyNo, model, tokens = 0) {
  const lim = limitFor(provider, model);
  if (!lim) return null;
  const id = fid(provider, keyNo, lim.family);
  const entry = { t: Date.now(), id, tokens };
  recent.push(entry);
  usage.since.push({ t: entry.t, id, provider });
  return entry;
}

function used(provider, keyNo, family, now = Date.now()) {
  const id = fid(provider, keyNo, family);
  const start = dayStart(provider, new Date(now)).getTime();
  const sinceRead = usage.since.filter((x) => x.id === id && x.t >= start).length;
  const base = usage.readAt >= start ? (usage.day.get(id) || 0) : 0;
  recent = recent.filter((r) => now - r.t < 60 * 1000);
  const mine = recent.filter((r) => r.id === id);
  return { today: base + sinceRead, minute: mine.length, minuteTokens: mine.reduce((a, r) => a + (r.tokens || 0), 0), oldest: mine.length ? Math.min(...mine.map((r) => r.t)) : now };
}

/**
 * Is there room for one more request on this provider/key/model?
 * @returns {{ok: boolean, reason?: string, until?: number, left: number}} left = share of today's limit still free (0..1)
 */
function room(provider, keyNo, model, estTokens = 0, now = Date.now()) {
  const lim = limitFor(provider, model);
  if (!lim) return { ok: true, left: 1 };
  const u = used(provider, keyNo, lim.family, now);
  const left = lim.rpd ? Math.max(0, 1 - u.today / lim.rpd) : 1;
  if (lim.rpd && u.today >= lim.rpd) return { ok: false, reason: `daily limit (${lim.rpd}) reached`, until: nextDayStart(provider, new Date(now)).getTime(), left: 0 };
  if (lim.rpm && u.minute >= lim.rpm) return { ok: false, reason: `per-minute limit (${lim.rpm}) reached`, until: u.oldest + 60 * 1000, left };
  if (lim.tpm && u.minute > 0 && u.minuteTokens + estTokens > lim.tpm) return { ok: false, reason: `tokens per minute (${lim.tpm}) would be exceeded`, until: u.oldest + 60 * 1000, left };
  return { ok: true, left };
}

// For the admin page: every limit with its use per key.
function report(keysByProvider) {
  const now = Date.now();
  return limits().filter((l) => (keysByProvider[l.provider] || 0) > 0).map((l) => ({
    provider: l.provider, family: l.family, rpm: l.rpm || null, tpm: l.tpm || null, rpd: l.rpd || null,
    resetsAt: nextDayStart(l.provider).toISOString(),
    keys: Array.from({ length: keysByProvider[l.provider] }, (_, i) => ({ key: i + 1, ...used(l.provider, i + 1, l.family, now) })),
  }));
}

function resetMemory() { usage.day = new Map(); usage.since = []; usage.readAt = 0; recent = []; }

module.exports = { limits, limitFor, dayStart, nextDayStart, refresh, note, used, room, report, resetMemory };
