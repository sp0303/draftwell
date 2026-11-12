// Visitors and sessions.
// Every browser gets a session cookie (rl_sid). A session points at a user.
// A user is a guest until they sign in with Google; signing in moves the
// guest's resumes into their Google account.
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const config = require('./config');
const { col } = require('./db');

const COOKIE = 'rl_sid';
const SESSION_DAYS = 180;
const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: SESSION_DAYS * 24 * 3600 * 1000, path: '/' });
const newSid = () => crypto.randomBytes(32).toString('hex');

async function startSession(res, userId) {
  const sid = newSid();
  const now = new Date();
  await col('sessions').insertOne({ sid, userId, createdAt: now, lastSeenAt: now });
  res.cookie(COOKIE, sid, cookieOpts());
  return sid;
}

async function newGuest() {
  const now = new Date();
  const user = { createdAt: now, lastSeenAt: now };
  const { insertedId } = await col('users').insertOne(user);
  return { ...user, _id: insertedId };
}

// Middleware: load the user for this browser, creating a guest if needed.
async function ensureUser(req, res, next) {
  const sid = req.cookies[COOKIE];
  let session = sid && /^[a-f0-9]{64}$/.test(sid)
    ? await col('sessions').findOneAndUpdate({ sid }, { $set: { lastSeenAt: new Date() } }, { returnDocument: 'after' })
    : null;
  let user = session && await col('users').findOne({ _id: session.userId });
  if (!user) {
    if (session) await col('sessions').deleteOne({ _id: session._id });
    user = await newGuest();
    req.sid = await startSession(res, user._id);
  } else {
    req.sid = sid;
  }
  req.user = user;
  next();
}

const publicUser = (u) => (u && u.google
  ? { signedIn: true, name: u.google.name || '', email: u.google.email || '', picture: u.google.picture || '' }
  : { signedIn: false });

let client;
async function verifyGoogleCredential(credential) {
  if (!config.googleClientId) throw Object.assign(new Error('Google sign-in is not set up on this server.'), { status: 503 });
  client = client || new OAuth2Client(config.googleClientId);
  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken: credential, audience: config.googleClientId });
  } catch (e) {
    throw Object.assign(new Error('Google sign-in could not be verified. Try again.'), { status: 401 });
  }
  return ticket.getPayload();
}

// Sign in with a verified Google profile. Returns the account user.
async function signIn(req, res, profile) {
  if (!profile || !profile.sub) throw Object.assign(new Error('Google sign-in could not be verified. Try again.'), { status: 401 });
  if (profile.email && profile.email_verified === false) throw Object.assign(new Error('Verify your Google email address first.'), { status: 401 });
  const google = { sub: String(profile.sub), email: profile.email || '', name: profile.name || '', picture: profile.picture || '' };
  const current = req.user;
  const now = new Date();

  let account = await col('users').findOne({ 'google.sub': google.sub });
  if (account) {
    await col('users').updateOne({ _id: account._id }, { $set: { google, lastSeenAt: now } });
    if (!current.google && String(current._id) !== String(account._id)) {
      // Bring the guest's work along, then remove the empty guest.
      await col('resumes').updateMany({ userId: current._id }, { $set: { userId: account._id } });
      await col('users').deleteOne({ _id: current._id });
    }
  } else if (!current.google) {
    // First sign-in from this browser: the guest becomes the account.
    await col('users').updateOne({ _id: current._id }, { $set: { google, signedUpAt: now, lastSeenAt: now } });
    account = { ...current, google };
  } else {
    const { insertedId } = await col('users').insertOne({ google, createdAt: now, signedUpAt: now, lastSeenAt: now });
    account = { google, _id: insertedId };
  }

  // New session id on every sign-in, so an old cookie can't ride along.
  await col('sessions').deleteOne({ sid: req.sid });
  await startSession(res, account._id);
  return { ...account, google };
}

async function signOut(req, res) {
  if (req.sid) await col('sessions').deleteOne({ sid: req.sid });
  res.clearCookie(COOKIE, { path: '/' });
}

module.exports = { ensureUser, signIn, signOut, publicUser, verifyGoogleCredential };
