import { createApp } from './app.js';
import { getJwtSecret } from './config.js';
import { defaultDbPath, openDatabase } from './db.js';

getJwtSecret(); // fail startup loudly if JWT_SECRET is unset

const dbPath = process.env.DB_PATH ?? defaultDbPath();
const port = Number(process.env.PORT ?? 3000);

const db = openDatabase(dbPath);
const app = createApp(db);

app.listen(port, () => {
  console.log(`Homely server listening on http://localhost:${port} (db: ${dbPath})`);
});