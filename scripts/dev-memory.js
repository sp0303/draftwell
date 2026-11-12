// Runs the app against a throwaway in-memory MongoDB, for trying things out
// before a real MONGO_URL is set. Everything in the database is lost on exit.
const { MongoMemoryServer } = require('mongodb-memory-server');

(async () => {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGO_URL = mongo.getUri();
  console.log('Using a temporary in-memory MongoDB. Data is lost when this stops.');
  require('../src/server.js');
})();
