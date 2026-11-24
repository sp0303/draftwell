const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const root = path.join(__dirname, '..');

module.exports = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || undefined, // undefined = every interface (local development)
  mongoUrl: process.env.MONGO_URL || '',
  mongoDb: process.env.MONGO_DB || 'resumely',
  // Prepended to every collection name so Resumely can share a database with other projects.
  collectionPrefix: process.env.MONGO_COLLECTION_PREFIX ?? 'resumely_',
  uploadDir: path.resolve(root, process.env.UPLOAD_DIR || './storage/uploads'),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  maxUploadBytes: 10 * 1024 * 1024,
  // OpenRouter's daily cap on free models: 50, or 1000 once $10 of credit has ever been bought.
  openrouterDailyLimit: Number(process.env.OPENROUTER_DAILY_LIMIT) || 50,
  // AI credits a new account starts with (1 credit = 1,000 model tokens).
  startingCredits: Number.isFinite(Number(process.env.AI_STARTING_CREDITS)) && process.env.AI_STARTING_CREDITS !== ''
    ? Number(process.env.AI_STARTING_CREDITS) : 100,
  // Google accounts (comma separated emails) that can open the admin page.
  adminEmails: (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  llm: {
    provider: process.env.LLM_PROVIDER || '',
    // One key, or several separated by commas (one per OpenRouter account; each has its own daily free limit).
    apiKeys: (process.env.LLM_API_KEY || '').split(',').map((s) => s.trim()).filter(Boolean),
    model: process.env.LLM_MODEL || '',
    // Tried in order when the main model is busy or fails.
    fallbackModels: (process.env.LLM_FALLBACK_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean),
    // Optional: one order across providers, e.g. "openrouter:baidu/ernie-5.5-flash-preview:free,nvidia:minimaxai/minimax-m3.1-flash".
    // Entries whose provider has no API key are skipped. Empty = OpenRouter models first, then NVIDIA.
    // Tiers separated by commas, models within a tier by "|" (see llm.js).
    order: (process.env.LLM_ORDER || '').split(',').map((s) => s.trim()).filter((s) => /^(openrouter|nvidia|gemini):./.test(s)),
  },
  // Second provider, tried after OpenRouter: NVIDIA API catalog (build.nvidia.com).
  nvidia: {
    // One key, or several separated by commas (requests take turns between them).
    apiKeys: (process.env.NVIDIA_API_KEY || '').split(',').map((s) => s.trim()).filter(Boolean),
    models: (process.env.NVIDIA_MODELS || 'minimaxai/minimax-m3.1-flash,nvidia/nemotron-3.5-lightning-30b-a3b').split(',').map((s) => s.trim()).filter(Boolean),
  },
  // Google's Gemini API (aistudio.google.com). Free-tier limits per model family are in quota.js.
  gemini: {
    // "paid" once billing is on for the key's project: no free-tier limits, only GEMINI_DAILY_LIMIT
    // per model family as a spending guard.
    paid: (process.env.GEMINI_TIER || '').toLowerCase() === 'paid',
    dailyLimit: Number(process.env.GEMINI_DAILY_LIMIT) || 1500,
    apiKeys: (process.env.GEMINI_API_KEY || '').split(',').map((s) => s.trim()).filter(Boolean),
    models: (process.env.GEMINI_MODELS || 'gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-3.5-flash,gemma-4-26b-a4b-it').split(',').map((s) => s.trim()).filter(Boolean),
  },
};
