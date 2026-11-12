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
  await Promise.all([
    col('users').createIndex({ uid: 1 }, { unique: true }),
    col('resumes').createIndex({ userId: 1, updatedAt: -1 }),
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
