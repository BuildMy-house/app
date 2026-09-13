import { createApp } from './app.js';
import { getJwtSecret } from './config.js';
import { openAdapter } from './db.js';
import { jobTelemetry } from './jobs/telemetry.js';
import { renderQueue } from './render-queue.js';
import { reportError } from './errorReporting.js';

// Process-level safety net for errors outside the request cycle's error
// handler (e.g. in the debounced save-queue timer).
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  reportError(reason, { kind: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  reportError(err, { kind: 'uncaughtException' });
  // Node's guidance: the process is in an undefined state after an uncaught
  // exception — do not try to keep running.
  process.exit(1);
});

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
