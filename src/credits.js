// AI credits per user. 1 credit = 1,000 model tokens (prompt + completion, as
// reported by OpenRouter); each AI call costs at least 1 credit. New accounts
// start with config.startingCredits; admins can add more. At 0 the app keeps
// working on the built-in rules.
//
// Usage counters live on the user document too:
//   stats: { aiRequests, tokensUsed, creditsUsed, uploads, pdfDownloads }
const config = require('./config');
const { col } = require('./db');

const TOKENS_PER_CREDIT = 1000;
const balance = (user) => (user && Number.isFinite(user.credits) ? user.credits : config.startingCredits);
const status = (user) => ({ credits: Math.max(0, balance(user)), tokensPerCredit: TOKENS_PER_CREDIT });
const hasCredits = (user) => balance(user) > 0;
const cost = (tokens) => (tokens > 0 ? Math.max(1, Math.ceil(tokens / TOKENS_PER_CREDIT)) : 0);

// Older accounts have no balance stored yet; give them the starting grant first.
async function ensureBalance(user) {
  if (Number.isFinite(user.credits)) return;
  await col('users').updateOne({ _id: user._id, credits: { $exists: false } }, { $set: { credits: config.startingCredits } });
  user.credits = config.startingCredits;
}

// Take the credits for one AI call and keep req.user in step for the reply.
async function charge(user, tokens) {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  const c = cost(n);
  await ensureBalance(user);
  await col('users').updateOne({ _id: user._id }, {
    $inc: { credits: -c, 'stats.aiRequests': 1, 'stats.tokensUsed': n, 'stats.creditsUsed': c },
  });
  // A call can cost more than was left; never show a negative balance.
  await col('users').updateOne({ _id: user._id, credits: { $lt: 0 } }, { $set: { credits: 0 } });
  user.credits = Math.max(0, user.credits - c);
  return status(user);
}

// Count an upload, a PDF download, etc.
const count = (user, stat) => col('users').updateOne({ _id: user._id }, { $inc: { [`stats.${stat}`]: 1 } });

module.exports = { TOKENS_PER_CREDIT, status, hasCredits, charge, count, ensureBalance };
