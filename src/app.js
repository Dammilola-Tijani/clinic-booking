const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { pool, tx } = require('./db');

const API_KEY = process.env.API_KEY;
if (!API_KEY) throw new Error('API_KEY is required');

const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = (status, error, extra = {}) => ({ status, body: { error }, ...extra });

// Dates leave the API the way the spec writes them: no ".000" when there are
// no milliseconds.
const iso = (d) => d.toISOString().replace('.000Z', 'Z');

const slotOut = (r) => ({
  id: r.id,
  provider: r.provider,
  start: iso(r.start_at),
  end: iso(r.end_at),
});

const bookingOut = (r) => ({
  id: r.id,
  slot_id: r.slot_id,
  name: r.name,
  email: r.email,
  status: r.status,
  created_at: iso(r.created_at),
});

function sameKey(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function auth(req, res, next) {
  const given = req.get('x-api-key');
  if (!given || !sameKey(given, API_KEY)) return res.status(401).json({ error: 'invalid or missing API key' });
  next();
}

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

function validDate(v) {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const api = express.Router();

api.post('/reset', wrap(async (req, res) => {
  const list = req.body && req.body.slots;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'slots must be an array' });

  const rows = [];
  const seen = new Set();
  for (const s of list) {
    const start = validDate(s && s.start);
    const end = validDate(s && s.end);
    const ok = s && typeof s.id === 'string' && s.id.trim() && typeof s.provider === 'string' && start && end;
    if (!ok) return res.status(400).json({ error: 'each slot needs id, provider, start and end' });
    if (seen.has(s.id)) return res.status(400).json({ error: `duplicate slot id ${s.id}` });
    seen.add(s.id);
    rows.push([s.id, s.provider, start, end]);
  }

  await tx(async (c) => {
    await c.query('truncate bookings, slots, idempotency, attempts');
    for (const r of rows) {
      await c.query('insert into slots (id, provider, start_at, end_at) values ($1,$2,$3,$4)', r);
    }
  });
  res.json({ ok: true, slots: rows.length });
}));

api.get('/slots', wrap(async (req, res) => {
  const params = [];
  let where = '';
  if (typeof req.query.provider === 'string') {
    params.push(req.query.provider);
    where = 'where s.provider = $1';
  }
  const { rows } = await pool.query(
    `select s.*, not exists (
        select 1 from bookings b where b.slot_id = s.id and b.status = 'confirmed'
      ) as available
       from slots s ${where}
      order by s.start_at, s.id`,
    params,
  );
  res.json({ slots: rows.map((r) => ({ ...slotOut(r), available: r.available })) });
}));

// Everything a booking attempt can decide, run inside one transaction. Returns
// {status, body, headers?, store?}; `store` marks results worth replaying for
// an Idempotency-Key (a 429 is transient, so it is not).
async function attemptBooking(c, input, idemKey) {
  const { slot_id, name, email } = input;
  const emailOk = typeof email === 'string' && EMAIL_RE.test(email) && email.length <= 254;

  // Per-email sliding window. Attempts count even when they later fail, but
  // only once we know whose attempt it is (a usable email).
  if (emailOk) {
    await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`rl:${email}`]);
    await c.query(`delete from attempts where email = $1 and at < clock_timestamp() - make_interval(secs => $2)`, [
      email,
      RATE_WINDOW_SECONDS,
    ]);
    const { rows: [w] } = await c.query(
      `select count(*)::int as n,
              ceil(extract(epoch from (min(at) + make_interval(secs => $2) - clock_timestamp())))::int as wait
         from attempts where email = $1`,
      [email, RATE_WINDOW_SECONDS],
    );
    if (w.n >= RATE_LIMIT) {
      const wait = Math.max(1, w.wait || 1);
      return fail(429, 'too many booking attempts for this email, try again later', {
        headers: { 'Retry-After': String(wait) },
      });
    }
    await c.query('insert into attempts (email) values ($1)', [email]);
  }

  const done = (r) => ({ ...r, store: true });

  if (typeof slot_id !== 'string' || !slot_id.trim()) return done(fail(400, 'slot_id is required'));
  if (typeof name !== 'string' || !name.trim()) return done(fail(400, 'name is required'));
  if (name.length > 120) return done(fail(400, 'name is too long'));
  if (typeof email !== 'string' || !email) return done(fail(400, 'email is required'));
  if (!emailOk) return done(fail(400, 'email is not valid'));

  const { rows: [slot] } = await c.query('select * from slots where id = $1', [slot_id]);
  if (!slot) return done(fail(404, 'slot not found'));
  if (slot.start_at <= new Date()) return done(fail(400, 'slot has already started'));

  const id = `bk_${crypto.randomUUID().replace(/-/g, '')}`;
  const { rows } = await c.query(
    `insert into bookings (id, slot_id, name, email, status)
          values ($1,$2,$3,$4,'confirmed')
     on conflict (slot_id) where status = 'confirmed' do nothing
       returning *`,
    [id, slot_id, name, email],
  );
  if (!rows.length) return done(fail(409, 'slot is already booked'));
  return done({ status: 201, body: bookingOut(rows[0]) });
}

api.post('/bookings', wrap(async (req, res) => {
  const raw = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const input = {
    slot_id: typeof raw.slot_id === 'string' ? raw.slot_id.trim() : raw.slot_id,
    name: typeof raw.name === 'string' ? raw.name.trim() : raw.name,
    email: typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : raw.email,
  };
  const idemKey = (req.get('idempotency-key') || '').trim();
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

  const result = await tx(async (c) => {
    if (idemKey) {
      await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`idem:${idemKey}`]);
      const { rows: [prev] } = await c.query('select * from idempotency where key = $1', [idemKey]);
      if (prev) {
        if (prev.body_hash !== bodyHash) {
          return fail(422, 'Idempotency-Key was already used with a different request body');
        }
        return { status: prev.status, body: prev.response };
      }
    }
    const r = await attemptBooking(c, input, idemKey);
    if (idemKey && r.store) {
      await c.query('insert into idempotency (key, body_hash, status, response) values ($1,$2,$3,$4)', [
        idemKey,
        bodyHash,
        r.status,
        JSON.stringify(r.body),
      ]);
    }
    return r;
  });

  if (result.headers) res.set(result.headers);
  res.status(result.status).json(result.body);
}));

api.get('/bookings', wrap(async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email) return res.status(400).json({ error: 'email is required' });

  let limit = 10;
  if (req.query.limit !== undefined) {
    if (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)) {
      return res.status(400).json({ error: 'limit must be an integer from 1 to 50' });
    }
    limit = Number(req.query.limit);
    if (limit < 1 || limit > 50) return res.status(400).json({ error: 'limit must be an integer from 1 to 50' });
  }

  let after = 0;
  if (req.query.cursor !== undefined) {
    const text = typeof req.query.cursor === 'string' ? Buffer.from(req.query.cursor, 'base64url').toString() : '';
    if (!/^c:\d{1,15}$/.test(text)) return res.status(400).json({ error: 'cursor is not valid' });
    after = Number(text.slice(2));
  }

  const { rows } = await pool.query(
    'select * from bookings where email = $1 and seq > $2 order by seq limit $3',
    [email, after, limit + 1],
  );
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? Buffer.from(`c:${page[page.length - 1].seq}`).toString('base64url') : null;
  res.json({ bookings: page.map(bookingOut), next_cursor: next });
}));

api.get('/bookings/:id', wrap(async (req, res) => {
  const { rows: [b] } = await pool.query('select * from bookings where id = $1', [req.params.id]);
  if (!b) return res.status(404).json({ error: 'booking not found' });
  res.json(bookingOut(b));
}));

api.delete('/bookings/:id', wrap(async (req, res) => {
  const out = await tx(async (c) => {
    const { rows: [b] } = await c.query('select * from bookings where id = $1 for update', [req.params.id]);
    if (!b) return fail(404, 'booking not found');
    if (b.status === 'cancelled') return fail(409, 'booking is already cancelled');
    const { rows: [u] } = await c.query(`update bookings set status = 'cancelled' where id = $1 returning *`, [b.id]);
    return { status: 200, body: bookingOut(u) };
  });
  res.status(out.status).json(out.body);
}));

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.get('/healthz', (req, res) => res.type('text').send('ok'));

  app.use(express.json({ limit: '100kb' }));

  // The web page lives on the same origin and talks to /web/*, where the
  // server adds the key itself, so the key never ships to a browser. /reset is
  // deliberately not reachable this way.
  const web = express.Router();
  web.use((req, res, next) => {
    if (req.path === '/reset') return res.status(404).json({ error: 'not found' });
    req.headers['x-api-key'] = API_KEY;
    next();
  });
  web.use(api);
  app.use('/web', web);

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use(auth, api);

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'request body is not valid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request body too large' });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp };
