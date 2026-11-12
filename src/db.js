const { MongoClient, ObjectId } = require('mongodb');
const config = require('./config');

let client;
let db;

async function connect(url = config.mongoUrl) {
  if (!url) {
    throw new Error('MONGO_URL is not set. Add it to .env (see .env.example).');
  }
  client = new MongoClient(url);
  await client.connect();
  db = client.db(config.mongoDb);
  // Old anonymous-cookie index from before sessions existed.
  await col('users').dropIndex('uid_1').catch(() => {});
  await Promise.all([
    col('users').createIndex({ 'google.sub': 1 }, { unique: true, partialFilterExpression: { 'google.sub': { $exists: true } } }),
    col('sessions').createIndex({ sid: 1 }, { unique: true }),
    // Sessions nobody has used for 180 days are removed automatically.
    col('sessions').createIndex({ lastSeenAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 }),
    col('resumes').createIndex({ userId: 1, updatedAt: -1 }),
    // AI attempts for the admin page, removed after 30 days.
    col('ai_calls').createIndex({ at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 }),
    col('ai_calls').createIndex({ day: 1, provider: 1, model: 1 }),
  ]);
  return db;
}

function col(name) {
  if (!db) throw new Error('Database not connected');
  return db.collection(config.collectionPrefix + name);
}

async function close() {
  if (client) await client.close();
}

function toId(id) {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id) ? new ObjectId(id) : null;
}

module.exports = { connect, col, close, toId };
