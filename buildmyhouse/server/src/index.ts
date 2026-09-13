import { createApp } from './app.js';
import { getJwtSecret } from './config.js';
import { openAdapter } from './db.js';

getJwtSecret(); // fail startup loudly if JWT_SECRET is unset

const port = Number(process.env.PORT ?? 3000);
const assetRoot = process.env.ASSET_DIR ?? 'data/assets';
const staticDir = process.env.STATIC_DIR;

const adapter = openAdapter();
const app = await createApp(adapter, assetRoot, staticDir);

app.listen(port, () => {
  console.log(`Homely server listening on http://localhost:${port}`);
});
