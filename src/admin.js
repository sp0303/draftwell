// Admin API: list users with their credits and usage, and grant credits.
// Only Google accounts listed in ADMIN_EMAILS get past requireAdmin.
const express = require('express');
const config = require('./config');
const { col, toId } = require('./db');
const { isAdmin } = require('./auth');

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
