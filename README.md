# Marigold Clinic booking

A booking API (Node, Express, Postgres) and the web page that uses it. The page is served by the same app.

## Run it

```bash
npm install
npm test      # starts a throwaway Postgres and checks all five levels
npm run dev   # same Postgres, server on http://localhost:3000, key "dev-key"
```

Production needs two environment variables: `DATABASE_URL` (any Postgres) and `API_KEY`.

```bash
DATABASE_URL=postgres://... API_KEY=your-key npm start
```

Tables are created on boot. If there are no slots, a week of demo slots is added; `POST /reset` replaces them.

## How each level is met

| Level | How |
| --- | --- |
| 1 | `GET /slots`, `POST /bookings`, `GET /bookings/:id`, `POST /reset` |
| 2 | `X-API-Key` checked in constant time; fields trimmed, email lower-cased and validated; 404 for an unknown slot, 400 for a started one |
| 3 | A partial unique index on `bookings(slot_id) where status = 'confirmed'` and `INSERT ... ON CONFLICT DO NOTHING`. The database decides the winner, so it holds across processes too. Cancel flips the status and frees the slot |
| 4 | `Idempotency-Key` stored with a hash of the body and the response. A per-key advisory lock makes simultaneous retries safe. Cursor pagination on a monotonic sequence |
| 5 | Sliding window of 5 attempts per email per minute in Postgres, serialised per email by an advisory lock. `Retry-After` is the seconds until the oldest attempt leaves the window |

## The web page

`public/` is plain HTML, CSS and JavaScript. It calls `/web/*`, where the server adds the API key itself, so the key is never sent to a browser. `/web/reset` is not exposed. Everything else on `/web` behaves exactly like the real API, including rate limits.
