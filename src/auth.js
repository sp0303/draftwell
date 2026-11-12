// Accounts and sessions. Sign-in with Google is required to use the app.
// A signed-in browser holds a session cookie (rl_sid) that points at a user.
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const config = require('./config');
const { col } = require('./db');

const COOKIE = 'rl_sid';
const SESSION_DAYS = 180;
const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: SESSION_DAYS * 24 * 3600 * 1000, path: '/' });
const httpError = (status, message) => Object.assign(new Error(message), { status });

// Middleware: attach the signed-in user (or null) to the request.
async function loadUser(req, res, next) {
  req.user = null;
  const sid = req.cookies[COOKIE];
  if (sid && /^[a-f0-9]{64}$/.test(sid)) {
    const session = await col('sessions').findOneAndUpdate({ sid }, { $set: { lastSeenAt: new Date() } }, { returnDocument: 'after' });
    const user = session && await col('users').findOne({ _id: session.userId });
    if (user && user.google) { req.user = user; req.sid = sid; }
    else if (session) await col('sessions').deleteOne({ _id: session._id });
  }
  next();
}

// Middleware: stop here unless signed in.
function requireUser(req, res, next) {
  if (!req.user) return next(httpError(401, 'Sign in with Google to continue.'));
  next();
}

const isAdmin = (u) => Boolean(u && u.google && u.google.email && config.adminEmails.includes(u.google.email.toLowerCase()));

const publicUser = (u) => (u && u.google
  ? { signedIn: true, name: u.google.name || '', email: u.google.email || '', picture: u.google.picture || '', isAdmin: isAdmin(u) }
  : { signedIn: false });

let client;
async function verifyGoogleCredential(credential) {
  if (!config.googleClientId) throw httpError(503, 'Google sign-in is not set up on this server.');
  client = client || new OAuth2Client(config.googleClientId);
  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: config.googleClientId });
    return ticket.getPayload();
  } catch (e) {
    throw httpError(401, 'Google sign-in could not be verified. Try again.');
  }
}

// Sign in with a verified Google profile: find or create the account and start a session.
async function signIn(req, res, profile) {
  if (!profile || !profile.sub) throw httpError(401, 'Google sign-in could not be verified. Try again.');
  if (profile.email_verified === false) throw httpError(401, 'Verify your Google email address first.');
  const google = { sub: String(profile.sub), email: profile.email || '', name: profile.name || '', picture: profile.picture || '' };
  const now = new Date();
  const user = await col('users').findOneAndUpdate(
    { 'google.sub': google.sub },
    { $set: { google, lastSeenAt: now }, $setOnInsert: { createdAt: now, credits: config.startingCredits } },
    { upsert: true, returnDocument: 'after' },
  );

  // A fresh session id on every sign-in; drop the one this browser had before.
  if (req.sid) await col('sessions').deleteOne({ sid: req.sid });
  const sid = crypto.randomBytes(32).toString('hex');
  await col('sessions').insertOne({ sid, userId: user._id, createdAt: now, lastSeenAt: now });
  res.cookie(COOKIE, sid, cookieOpts());
  return user;
}

async function signOut(req, res) {
  if (req.sid) await col('sessions').deleteOne({ sid: req.sid });
  res.clearCookie(COOKIE, { path: '/' });
}

module.exports = { loadUser, requireUser, signIn, signOut, publicUser, isAdmin, verifyGoogleCredential };
