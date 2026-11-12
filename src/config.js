const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const root = path.join(__dirname, '..');

module.exports = {
  port: Number(process.env.PORT) || 3000,
  mongoUrl: process.env.MONGO_URL || '',
  mongoDb: process.env.MONGO_DB || 'draftwell',
  uploadDir: path.resolve(root, process.env.UPLOAD_DIR || './storage/uploads'),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  maxUploadBytes: 10 * 1024 * 1024,
  llm: {
    provider: process.env.LLM_PROVIDER || '',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || '',
  },
};
