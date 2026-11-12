// Language model adapter. Everything that needs an LLM goes through here,
// so connecting a provider means filling in these two functions only.
//
// Until LLM_PROVIDER is set, isConfigured() returns false and the server
// uses the rule-based parser (extract.js) and assistant (assistant.js).

const config = require('./config');

function isConfigured() {
  return Boolean(config.llm.provider && config.llm.apiKey);
}

/**
 * Turn raw resume text into the data shape described in schema.js.
 * @param {string} text  plain text pulled from the uploaded file
 * @returns {Promise<object>} resume data (will be passed through normalize())
 */
async function extractResume(text) {
  throw new Error('LLM provider not connected yet');
}

/**
 * Apply a chat request to the resume.
 * @param {{data: object, theme: string, message: string, history: {role:string,text:string}[]}} input
 * @returns {Promise<{reply: string, data?: object, theme?: string, change?: string}>}
 */
async function chat(input) {
  throw new Error('LLM provider not connected yet');
}

module.exports = { isConfigured, extractResume, chat };
