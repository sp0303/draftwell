const fs = require('fs');
const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const { closeBrowser } = require('./pdf');

async function main() {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  await db.connect();
  const server = createApp().listen(config.port, () => {
    console.log(`Draftwell running at http://localhost:${config.port}`);
    console.log(`Uploads stored in ${config.uploadDir}`);
  });
  const stop = async () => {
    server.close();
    await closeBrowser().catch(() => {});
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
