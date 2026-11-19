import { createApp } from './app.js';
import { connectDb } from './db.js';
import { config } from './config.js';

async function main() {
  await connectDb();
  const app = createApp();
  // Bind to all interfaces so phones/emulators on the LAN can reach the API.
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Buildora API listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
