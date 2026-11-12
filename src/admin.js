// Admin API: list users with their credits and usage, and grant credits.
// Only Google accounts listed in ADMIN_EMAILS get past requireAdmin.
const express = require('express');
const config = require('./config');
const { col, toId } = require('./db');
const { isAdmin } = require('./auth');
const ailog = require('./ailog');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_CREDITS = 1000000;

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return next(httpError(403, 'Admins only.'));
  next();
}

const credit = (u) => (Number.isFinite(u.credits) ? u.credits : config.startingCredits);

function row(u, resumes) {
  const s = u.stats || {};
  return {
    id: String(u._id),
    name: (u.google && u.google.name) || '',
    email: (u.google && u.google.email) || '',
    picture: (u.google && u.google.picture) || '',
    isAdmin: isAdmin(u),
    createdAt: u.createdAt || null,
    lastSeenAt: u.lastSeenAt || null,
    credits: Math.max(0, credit(u)),
    creditsUsed: s.creditsUsed || 0,
    tokensUsed: s.tokensUsed || 0,
    aiRequests: s.aiRequests || 0,
    uploads: s.uploads || 0,
    pdfDownloads: s.pdfDownloads || 0,
    resumes: resumes || 0,
    creditLog: (u.creditLog || []).slice(-10).reverse(),
  };
}

function router() {
  const r = express.Router();
  r.use(requireAdmin);

  r.get('/users', wrap(async (req, res) => {
    const [users, counts] = await Promise.all([
      col('users').find({ google: { $exists: true } }).sort({ lastSeenAt: -1 }).limit(1000).toArray(),
      col('resumes').aggregate([{ $group: { _id: '$userId', n: { $sum: 1 } } }]).toArray(),
    ]);
    const byUser = new Map(counts.map((c) => [String(c._id), c.n]));
    const rows = users.map((u) => row(u, byUser.get(String(u._id))));
    const sum = (k) => rows.reduce((a, x) => a + x[k], 0);
    res.json({
      startingCredits: config.startingCredits,
      totals: { users: rows.length, credits: sum('credits'), creditsUsed: sum('creditsUsed'), aiRequests: sum('aiRequests'), uploads: sum('uploads'), pdfDownloads: sum('pdfDownloads'), resumes: sum('resumes') },
      users: rows,
    });
  }));

  // AI usage: today's attempts by model and task, the last 7 days, and the latest calls.
  r.get('/ai', wrap(async (req, res) => {
    const day = ailog.today();
    const since = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const calls = col('ai_calls');
    const [byModel, byTask, days, recent] = await Promise.all([
      calls.aggregate([{ $match: { day } }, { $group: {
        _id: { provider: '$provider', model: '$model' }, calls: { $sum: 1 }, ok: { $sum: { $cond: ['$ok', 1, 0] } },
        tokens: { $sum: '$tokens' }, ms: { $avg: '$ms' }, last: { $max: '$at' },
      } }, { $sort: { calls: -1 } }]).toArray(),
      calls.aggregate([{ $match: { day } }, { $group: { _id: '$task', calls: { $sum: 1 }, ok: { $sum: { $cond: ['$ok', 1, 0] } } } }, { $sort: { calls: -1 } }]).toArray(),
      calls.aggregate([{ $match: { day: { $gte: since } } }, { $group: { _id: '$day', calls: { $sum: 1 }, ok: { $sum: { $cond: ['$ok', 1, 0] } } } }, { $sort: { _id: 1 } }]).toArray(),
      calls.find({}, { sort: { at: -1 }, limit: 25 }).toArray(),
    ]);
    const userIds = [...new Set(recent.map((c) => c.userId).filter(Boolean).map(String))];
    const users = userIds.length ? await col('users').find({ _id: { $in: userIds.map(toId) } }, { projection: { 'google.email': 1 } }).toArray() : [];
    const emailOf = new Map(users.map((u) => [String(u._id), u.google && u.google.email]));
    const models = byModel.map((m) => ({ provider: m._id.provider, model: m._id.model, calls: m.calls, ok: m.ok, failed: m.calls - m.ok, tokens: m.tokens, avgMs: Math.round(m.ms || 0), last: m.last }));
    const sum = (k) => models.reduce((a, m) => a + m[k], 0);
    const openrouter = models.filter((m) => m.provider === 'openrouter' && /:free$/.test(m.model)).reduce((a, m) => a + m.calls, 0);
    res.json({
      day,
      totals: { calls: sum('calls'), ok: sum('ok'), failed: sum('failed'), tokens: sum('tokens') },
      openrouterFree: { used: openrouter, limit: config.openrouterDailyLimit },
      lastAnswer: recent.find((c) => c.ok) ? { provider: recent.find((c) => c.ok).provider, model: recent.find((c) => c.ok).model, at: recent.find((c) => c.ok).at } : null,
      models,
      tasks: byTask.map((t) => ({ task: t._id, calls: t.calls, ok: t.ok })),
      days: days.map((d) => ({ day: d._id, calls: d.calls, ok: d.ok })),
      recent: recent.map((c) => ({ at: c.at, task: c.task, provider: c.provider, model: c.model, ok: c.ok, ms: c.ms, tokens: c.tokens, error: c.error, email: emailOf.get(String(c.userId)) || '' })),
    });
  }));

  // Body: { add: n } to grant (or take away, if negative), or { set: n } to set the balance.
  r.post('/users/:id/credits', wrap(async (req, res) => {
    const id = toId(req.params.id);
    const user = id && await col('users').findOne({ _id: id, google: { $exists: true } });
    if (!user) throw httpError(404, 'User not found');
    const b = req.body || {};
    const before = Math.max(0, credit(user));
    let after;
    if (b.set !== undefined) {
      if (!Number.isInteger(b.set) || b.set < 0 || b.set > MAX_CREDITS) throw httpError(400, `Set a whole number of credits from 0 to ${MAX_CREDITS.toLocaleString('en-US')}.`);
      after = b.set;
    } else if (b.add !== undefined) {
      if (!Number.isInteger(b.add) || b.add === 0 || Math.abs(b.add) > MAX_CREDITS) throw httpError(400, 'Add a whole number of credits (use a negative number to take some away).');
      after = Math.min(MAX_CREDITS, Math.max(0, before + b.add));
    } else throw httpError(400, 'Send { add: n } or { set: n }.');
    const entry = { at: new Date(), by: req.user.google.email, before, after };
    await col('users').updateOne({ _id: user._id }, { $set: { credits: after }, $push: { creditLog: { $each: [entry], $slice: -50 } } });
    console.log(`Admin ${entry.by} changed credits for ${user.google.email}: ${before} -> ${after}`);
    user.credits = after;
    user.creditLog = (user.creditLog || []).concat(entry);
    res.json(row(user, await col('resumes').countDocuments({ userId: user._id })));
  }));

  return r;
}

module.exports = { router, requireAdmin };
