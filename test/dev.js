// Local dev: a throwaway Postgres plus the real server on :3000. npm run dev
const os = require('os');
const fs = require('fs');
const path = require('path');
const EmbeddedPostgres = require('embedded-postgres').default;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-dev-'));
(async () => {
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: 54330, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('clinic');
  process.env.DATABASE_URL = 'postgres://postgres:pw@localhost:54330/clinic';
  process.env.API_KEY = process.env.API_KEY || 'dev-key';
  require('../src/server');
  const stop = async () => { await pg.stop(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
