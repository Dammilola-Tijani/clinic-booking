const { pool } = require('./db');

const PROVIDERS = ['Dr Ade', 'Dr Bola', 'Dr Chidi'];
const DAYS_AHEAD = 14;
const SLOTS_PER_DAY = 6;

// Keeps the public page bookable by making sure the next two weeks of weekday
// slots exist. Ids are derived from provider and time, so running it again
// adds nothing twice. Once anyone calls /reset the slots are theirs and this
// never touches them.
async function topUpDemoSlots() {
  const { rows: [custom] } = await pool.query(`select 1 from meta where key = 'custom_slots'`);
  if (custom) return 0;

  const ids = [];
  const providers = [];
  const starts = [];
  const ends = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let offset = 1; offset <= DAYS_AHEAD; offset++) {
    const day = new Date(today.getTime() + offset * 864e5);
    if ([0, 6].includes(day.getUTCDay())) continue;
    PROVIDERS.forEach((provider, p) => {
      for (let i = 0; i < SLOTS_PER_DAY; i++) {
        const start = new Date(day.getTime() + (9 + p) * 36e5 + i * 30 * 6e4);
        ids.push(`${provider.split(' ')[1].toLowerCase()}-${start.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`);
        providers.push(provider);
        starts.push(start);
        ends.push(new Date(start.getTime() + 30 * 6e4));
      }
    });
  }
  const { rowCount } = await pool.query(
    `insert into slots (id, provider, start_at, end_at)
          select * from unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[])
     on conflict (id) do nothing`,
    [ids, providers, starts, ends],
  );
  return rowCount;
}

function keepDemoSlotsFresh() {
  const run = () => topUpDemoSlots().catch((err) => console.error('demo slot top-up failed', err));
  run();
  setInterval(run, 6 * 3600e3).unref();
}

module.exports = { topUpDemoSlots, keepDemoSlotsFresh };
