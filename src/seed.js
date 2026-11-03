const { pool, tx } = require('./db');

const PROVIDERS = ['Dr Ade', 'Dr Bola', 'Dr Chidi'];

// Gives a fresh deployment something to book. Skipped whenever slots exist, so
// it never touches data a /reset or a visitor has created.
async function seedIfEmpty() {
  const { rows: [{ n }] } = await pool.query('select count(*)::int as n from slots');
  if (n > 0) return;

  const rows = [];
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  for (let offset = 1; rows.length < 120; offset++) {
    const d = new Date(day.getTime() + offset * 864e5);
    if ([0, 6].includes(d.getUTCDay())) continue;
    PROVIDERS.forEach((provider, p) => {
      for (let i = 0; i < 6; i++) {
        const start = new Date(d.getTime() + (9 + p) * 36e5 + i * 30 * 6e4);
        const end = new Date(start.getTime() + 30 * 6e4);
        rows.push([`${provider.split(' ')[1].toLowerCase()}-${start.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`, provider, start, end]);
      }
    });
    if (offset > 9) break;
  }
  await tx(async (c) => {
    for (const r of rows) {
      await c.query('insert into slots (id, provider, start_at, end_at) values ($1,$2,$3,$4) on conflict do nothing', r);
    }
  });
}

module.exports = { seedIfEmpty };
