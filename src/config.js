const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const root = path.join(__dirname, '..');

module.exports = {
  port: Number(process.env.PORT) || 3000,
  mongoUrl: process.env.MONGO_URL || '',
  mongoDb: process.env.MONGO_DB || 'resumely',
  // Prepended to every collection name so Resumely can share a database with other projects.
  collectionPrefix: process.env.MONGO_COLLECTION_PREFIX ?? 'resumely_',
  uploadDir: path.resolve(root, process.env.UPLOAD_DIR || './storage/uploads'),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  maxUploadBytes: 10 * 1024 * 1024,
  llm: {
    provider: process.env.LLM_PROVIDER || '',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || '',
    // Tried in order when the main model is busy or fails.
    fallbackModels: (process.env.LLM_FALLBACK_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean),
  },
};
