const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const pool = new Pool({
  connectionString: url,
  max: 10,
  ssl: local ? false : { rejectUnauthorized: false },
});

// A confirmed booking per slot is enforced by the partial unique index, not by
// application code, so concurrent requests cannot both win.
const schema = `
create table if not exists slots (
  id        text primary key,
  provider  text not null,
  start_at  timestamptz not null,
  end_at    timestamptz not null
);

create table if not exists bookings (
  seq        bigserial unique,
  id         text primary key,
  slot_id    text not null references slots(id) on delete cascade,
  name       text not null,
  email      text not null,
  status     text not null check (status in ('confirmed','cancelled')),
  created_at timestamptz not null default clock_timestamp()
);
create unique index if not exists one_confirmed_per_slot
  on bookings (slot_id) where status = 'confirmed';
create index if not exists bookings_email_seq on bookings (email, seq);

create table if not exists idempotency (
  key       text primary key,
  body_hash text not null,
  status    int  not null,
  response  jsonb not null
);

create table if not exists meta (
  key   text primary key,
  value text not null
);

create table if not exists attempts (
  id    bigserial primary key,
  email text not null,
  at    timestamptz not null default clock_timestamp()
);
create index if not exists attempts_email_at on attempts (email, at);
`;

async function init() {
  // The xact lock keeps two instances booting together from racing on DDL.
  await tx(async (c) => {
    await c.query('select pg_advisory_xact_lock(7001)');
    await c.query(schema);
  });
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, init, tx };
