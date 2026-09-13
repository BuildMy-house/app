import { createApp } from './app.js';
import { getJwtSecret } from './config.js';
import { openAdapter } from './db.js';
import { jobTelemetry } from './jobs/telemetry.js';
import { renderQueue } from './render-queue.js';

async function main() {
  getJwtSecret(); // fail startup loudly if JWT_SECRET is unset

  const port = Number(process.env.PORT ?? 3000);
  const assetRoot = process.env.ASSET_DIR ?? 'data/assets';
  const staticDir = process.env.STATIC_DIR;

  const adapter = openAdapter();
  const app = await createApp(adapter, assetRoot, staticDir);

  // Start job queue depth monitoring (checks every 60s, alerts if >100)
  jobTelemetry.startMonitoring(() => renderQueue.getStatus().pending);

  app.listen(port, () => {
    console.log(`Homely server listening on http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
