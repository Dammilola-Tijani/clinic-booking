// Boots a throwaway Postgres, starts the API against it and exercises every
// level, including the concurrent cases. Run with: npm test
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const EmbeddedPostgres = require('embedded-postgres').default;

const KEY = 'test-key';
const PG_PORT = 54329;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-pg-'));

async function main() {
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: PG_PORT, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('clinic');

  process.env.DATABASE_URL = `postgres://postgres:pw@localhost:${PG_PORT}/clinic`;
  process.env.API_KEY = KEY;
  const { init, pool } = require('../src/db');
  const { createApp } = require('../src/app');
  await init();
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, p, { body, headers = {}, key = KEY } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  };

  const future = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const slots = (n = 3) =>
    Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, provider: i % 2 ? 'Dr Bola' : 'Dr Ade', start: future(24 + i), end: future(24.5 + i) }));
  const reset = (s = slots()) => call('POST', '/reset', { body: { slots: s } });
  const book = (o = {}, headers) => call('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com', ...o }, headers });

  let passed = 0;
  const test = async (name, fn) => {
    await reset();
    try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.message); process.exitCode = 1; }
  };

  console.log('level 1');
  await test('lists slots earliest first with availability', async () => {
    await reset([{ id: 'b', provider: 'X', start: future(5), end: future(6) }, { id: 'a', provider: 'X', start: future(2), end: future(3) }]);
    const r = await call('GET', '/slots');
    assert.deepStrictEqual(r.json.slots.map((s) => s.id), ['a', 'b']);
    assert.strictEqual(r.json.slots[0].available, true);
  });
  await test('filters by provider', async () => {
    const r = await call('GET', '/slots?provider=Dr%20Bola');
    assert.deepStrictEqual(r.json.slots.map((s) => s.id), ['s2']);
  });
  await test('books and fetches', async () => {
    const r = await book();
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.status, 'confirmed');
    const g = await call('GET', `/bookings/${r.json.id}`);
    assert.deepStrictEqual(g.json, r.json);
    const s = await call('GET', '/slots');
    assert.strictEqual(s.json.slots[0].available, false);
  });
  await test('unknown booking is 404', async () => assert.strictEqual((await call('GET', '/bookings/nope')).status, 404));
  await test('reset accepts past slots and wipes bookings', async () => {
    await book();
    await reset([{ id: 'old', provider: 'X', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' }]);
    const r = await call('GET', '/slots');
    assert.strictEqual(r.json.slots[0].start, '2020-01-01T09:00:00Z');
    assert.strictEqual((await call('GET', '/bookings?email=ada@example.com')).json.bookings.length, 0);
  });

  console.log('level 2');
  await test('401 without or with wrong key', async () => {
    assert.strictEqual((await call('GET', '/slots', { key: null })).status, 401);
    assert.strictEqual((await call('GET', '/slots', { key: 'nope' })).status, 401);
    assert.strictEqual((await call('POST', '/reset', { key: null, body: { slots: [] } })).status, 401);
  });
  await test('400 on missing, empty or bad fields', async () => {
    for (const bad of [{ slot_id: undefined }, { name: undefined }, { email: undefined }, { name: '   ' }, { email: 'nope' }, { email: 'a@b' }, { slot_id: 5 }]) {
      const r = await book(bad);
      assert.strictEqual(r.status, 400, JSON.stringify(bad));
      assert.ok(r.json.error);
    }
    assert.strictEqual((await call('POST', '/bookings', { body: '{oops' })).status, 400);
  });
  await test('404 unknown slot, 400 started slot', async () => {
    assert.strictEqual((await book({ slot_id: 'zzz' })).status, 404);
    await reset([{ id: 'p', provider: 'X', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' }]);
    assert.strictEqual((await book({ slot_id: 'p' })).status, 400);
  });
  await test('trims and lowercases', async () => {
    const r = await book({ name: '  Ada Obi ', email: '  ADA@Example.COM ' });
    assert.strictEqual(r.json.name, 'Ada Obi');
    assert.strictEqual(r.json.email, 'ada@example.com');
  });

  console.log('level 3');
  await test('second booking of a slot is 409', async () => {
    assert.strictEqual((await book()).status, 201);
    assert.strictEqual((await book({ email: 'bo@example.com' })).status, 409);
  });
  await test('40 simultaneous requests: exactly one wins', async () => {
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => book({ email: `p${i}@example.com` })));
    const codes = rs.map((r) => r.status);
    assert.strictEqual(codes.filter((c) => c === 201).length, 1, codes.join());
    assert.strictEqual(codes.filter((c) => c === 409).length, 39, codes.join());
  });
  await test('cancel frees the slot; double cancel is 409; unknown is 404', async () => {
    const b = (await book()).json;
    const c = await call('DELETE', `/bookings/${b.id}`);
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.json.status, 'cancelled');
    assert.strictEqual((await call('DELETE', `/bookings/${b.id}`)).status, 409);
    assert.strictEqual((await call('DELETE', '/bookings/nope')).status, 404);
    assert.strictEqual((await call('GET', '/slots')).json.slots[0].available, true);
    assert.strictEqual((await book({ email: 'bo@example.com' })).status, 201);
  });

  console.log('level 4');
  await test('same key and body replays the same response', async () => {
    const h = { 'Idempotency-Key': 'k1' };
    const a = await book({}, h);
    const b = await book({}, h);
    assert.strictEqual(a.status, 201);
    assert.strictEqual(b.status, 201);
    assert.strictEqual(a.json.id, b.json.id);
    assert.strictEqual((await call('GET', '/bookings?email=ada@example.com')).json.bookings.length, 1);
  });
  await test('same key, different body is 422', async () => {
    const h = { 'Idempotency-Key': 'k2' };
    await book({}, h);
    assert.strictEqual((await book({ slot_id: 's2' }, h)).status, 422);
  });
  await test('replayed 409 stays 409', async () => {
    await book({ email: 'bo@example.com' });
    const h = { 'Idempotency-Key': 'k3' };
    assert.strictEqual((await book({}, h)).status, 409);
    assert.strictEqual((await book({}, h)).status, 409);
  });
  await test('20 simultaneous retries with one key make one booking', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => book({}, { 'Idempotency-Key': 'k4' })));
    assert.strictEqual(new Set(rs.map((r) => r.json.id)).size, 1);
    assert.ok(rs.every((r) => r.status === 201));
    assert.strictEqual((await call('GET', '/bookings?email=ada@example.com')).json.bookings.length, 1);
  });
  await test('cursor pagination, oldest first, case-insensitive email', async () => {
    await reset(slots(5));
    for (let i = 1; i <= 5; i++) await book({ slot_id: `s${i}`, email: 'Ada@Example.com' });
    const seen = [];
    let cursor = null, pages = 0;
    do {
      const r = await call('GET', `/bookings?email=ADA@example.com&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      assert.strictEqual(r.status, 200);
      seen.push(...r.json.bookings.map((b) => b.slot_id));
      cursor = r.json.next_cursor;
      pages++;
    } while (cursor);
    assert.deepStrictEqual(seen, ['s1', 's2', 's3', 's4', 's5']);
    assert.strictEqual(pages, 3);
  });
  await test('exact-size last page has null cursor; bad limit/cursor are 400', async () => {
    await book();
    assert.strictEqual((await call('GET', '/bookings?email=ada@example.com&limit=1')).json.next_cursor, null);
    for (const q of ['limit=0', 'limit=51', 'limit=abc', 'limit=1.5', 'cursor=junk']) {
      assert.strictEqual((await call('GET', `/bookings?email=ada@example.com&${q}`)).status, 400, q);
    }
    assert.strictEqual((await call('GET', '/bookings')).status, 400);
  });

  console.log('level 5');
  await test('6th attempt in a minute is 429 with Retry-After; others unaffected', async () => {
    for (let i = 0; i < 5; i++) assert.notStrictEqual((await book({ slot_id: 'zzz' })).status, 429); // failures count
    const r = await book({ slot_id: 'zzz' });
    assert.strictEqual(r.status, 429);
    const wait = Number(r.headers.get('retry-after'));
    assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 60, String(wait));
    assert.strictEqual((await book({ email: 'someone@else.com' })).status, 201);
  });
  await test('concurrent burst lets exactly 5 through', async () => {
    const rs = await Promise.all(Array.from({ length: 15 }, () => book({ slot_id: 'zzz', email: 'Spam@x.com' })));
    assert.strictEqual(rs.filter((r) => r.status === 404).length, 5);
    assert.strictEqual(rs.filter((r) => r.status === 429).length, 10);
  });
  await test('window slides: attempts age out', async () => {
    await pool.query(`insert into attempts (email, at) select 'old@x.com', now() - interval '61 seconds' from generate_series(1,5)`);
    assert.strictEqual((await book({ email: 'old@x.com' })).status, 201);
  });

  console.log('web page proxy');
  await test('/web injects the key but cannot reset', async () => {
    const r = await call('GET', '/web/slots', { key: null });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await call('POST', '/web/reset', { key: null, body: { slots: [] } })).status, 404);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  server.close();
  await pool.end();
  await pg.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
