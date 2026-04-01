# Animal Hub

Real-time coordination hub for **shelters + rescues + transport + fosters** to move high-risk animals to safety.

## What this is (MVP)
- A fast API + realtime event stream where orgs can post **urgent animals** and helpers can claim **foster / adopt / transport**.
- Designed for **speed** (minutes matter), **auditability**, and **safe handoffs**.

## Run locally
```bash
npm run dev
```

## Quick start (curl)

In one terminal:
```bash
PORT=3999 npm start
```

In another terminal:
```bash
# 1) Create a case
CASE_ID=$(curl -sS -X POST localhost:3999/cases \
  -H 'content-type: application/json' \
  -d '{"name":"Buddy","riskLevel":"CODE_RED","location":{"city":"Austin","state":"TX"}}' \
  | node -p 'JSON.parse(fs.readFileSync(0,"utf8")).caseId')

# 2) Claim it (prevents double-claim during coordination)
curl -sS -X POST localhost:3999/cases/$CASE_ID/claim \
  -H 'content-type: application/json' \
  -d '{"claimant":"rescue-demo"}' | cat

# 3) Add a commitment
curl -sS -X POST localhost:3999/cases/$CASE_ID/commitments \
  -H 'content-type: application/json' \
  -d '{"type":"TRANSPORT","party":{"name":"Taylor"},"status":"PENDING"}' | cat

# 4) Update status (requires claimant if actively claimed)
curl -sS -X PATCH localhost:3999/cases/$CASE_ID/status \
  -H 'content-type: application/json' \
  -d '{"status":"RESCUE_TAGGED","claimant":"rescue-demo"}' | cat

# 5) Tail events for the case
curl -sS "localhost:3999/cases/$CASE_ID/events?afterSeq=0&limit=200" | cat
```

## Realtime (WebSocket)

The server exposes a websocket endpoint at `GET /ws` and emits JSON messages:

- On connect: `{ "type": "hello", "ts": "..." }`
- On updates: `{ "type": "event", "event": { ... } }`

### Event shape

All emitted events share a common envelope:

```json
{
  "eventId": "<id>",
  "seq": 123,
  "kind": "CASE_CREATED",
  "caseId": "<caseId>",
  "ts": "2026-03-31T12:34:56.789Z",
  "payload": {}
}
```

- `seq` is monotonically increasing (useful for catch-up cursors)
- `payload` is event-specific (case record, commitment record, status transition, etc.)

### Event kinds (current)

The server currently emits these `kind` values:

- `CASE_CREATED` — `payload` is the full case record
- `CASE_UPDATED` — `payload` is the full updated case record
- `STATUS_CHANGED` — `payload`: `{ from, to, by }`
- `COMMITMENT_CREATED` — `payload` is the full commitment record
- `COMMITMENT_UPDATED` — `payload` is the full updated commitment record
- `CASE_CLAIMED` — `payload`: `{ claimant, claimedAt, expiresAt }`
- `CASE_RELEASED` — `payload`: `{ claimant }`

### Client state model (suggested)

If you’re building a client that maintains local state:

- Treat `CASE_UPDATED` and `COMMITMENT_UPDATED` as **authoritative snapshots** of the object.
  - Apply by upserting the record by id (`caseId` / `commitId`).
- Treat `STATUS_CHANGED` as a **high-signal transition** suitable for notifications/banners.
  - You can also update your local case status from it, but `CASE_UPDATED` should be the source of truth.
- On reconnect, catch up using `afterSeq` (see above), then resume websocket listening.

### Minimal reference client

See `examples/minimal-client.js` for a tiny demo client that:

- fetches backlog with `/events?afterSeq=...`
- connects to `/ws` for live events
- maintains an in-memory case map

Run it:

```bash
BASE_URL=http://localhost:3999 node examples/minimal-client.js

# Optionally configure which commitment types are considered required
REQUIRED_TYPES=RESCUE_PULL,TRANSPORT,FOSTER BASE_URL=http://localhost:3999 node examples/minimal-client.js

# Optionally configure deadline urgency window (hours)
URGENCY_HOURS=2 BASE_URL=http://localhost:3999 node examples/minimal-client.js

# Optionally print a periodic dashboard of top unmet-need cases
DASHBOARD_EVERY_SEC=30 DASHBOARD_TOP_N=5 BASE_URL=http://localhost:3999 node examples/minimal-client.js

# Optionally scope dashboard to a state and/or risk level
DASHBOARD_STATE=TX DASHBOARD_RISK=CODE_RED DASHBOARD_EVERY_SEC=30 BASE_URL=http://localhost:3999 node examples/minimal-client.js

# Optionally scope dashboard to case status values (comma-separated)
DASHBOARD_STATUS=OPEN,HOLD_REQUESTED DASHBOARD_EVERY_SEC=30 BASE_URL=http://localhost:3999 node examples/minimal-client.js

# Run in “signal-only” mode (subscribe to selected event kinds)
WS_KIND=STATUS_CHANGED,CASE_CLAIMED AFTER_SEQ=0 BASE_URL=http://localhost:3999 node examples/minimal-client.js

Notes:
- `AFTER_SEQ` controls the initial HTTP catch-up cursor.
- `WS_KIND` controls which live websocket event kinds you receive.
- In a real deployment, persist the last seen `seq` and restart with `AFTER_SEQ=<lastSeenSeq>`.

Tip: you can persist `lastSeq` automatically with `STATE_FILE`:

```bash
STATE_FILE=.client-state.json BASE_URL=http://localhost:3999 node examples/minimal-client.js
```

By default, the client flushes `STATE_FILE` at most once per second; you can override with `STATE_FLUSH_MS`.

- Set `STATE_FLUSH_MS=0` to flush on every event (more durable, more disk writes).

The client also flushes state on `SIGINT` / `SIGTERM` (Ctrl+C / shutdown) to reduce cursor loss.

For a cleaner ops-style view (only periodic dashboard output, no per-event logging), run with:

```bash
SILENT_EVENTS=1 DASHBOARD_EVERY_SEC=30 BASE_URL=http://localhost:3999 node examples/minimal-client.js

# For an even quieter mode (no per-case summaries either; dashboard only)
SILENT_EVENTS=1 SILENT_SUMMARIES=1 DASHBOARD_EVERY_SEC=30 BASE_URL=http://localhost:3999 node examples/minimal-client.js
```

You can also print the dashboard immediately when the top-N set changes:

```bash
DASHBOARD_ON_CHANGE=1 SILENT_EVENTS=1 SILENT_SUMMARIES=1 BASE_URL=http://localhost:3999 node examples/minimal-client.js
```
```

To watch events without adding any deps, you can use a tiny Node one-liner:

```bash
node -e "import WebSocket from 'ws'; const ws=new WebSocket('ws://localhost:3999/ws'); ws.on('message',m=>console.log(m.toString()));"
```

You can also filter websocket events by kind (comma-separated), e.g.:

```text
/ws?kind=STATUS_CHANGED,CASE_CLAIMED
```

If `kind` contains unknown values, the server will close the connection with code `1008` (policy violation).

Valid kinds currently include:

```text
CASE_CREATED, CASE_UPDATED, STATUS_CHANGED,
COMMITMENT_CREATED, COMMITMENT_UPDATED,
CASE_CLAIMED, CASE_RELEASED
```

You can also fetch the supported list via HTTP:

- `GET /meta/event-kinds`

And fetch all client-facing enums (statuses, types, etc.):

- `GET /meta/enums`

Both endpoints also return a `version` field (best-effort; may be `null`) to help clients invalidate caches.

They also support conditional GET via `ETag` / `If-None-Match` (returns `304 Not Modified` on a match).

Example:

```bash
ETAG=$(curl -sSI localhost:3999/meta/enums | awk -F': ' 'tolower($1)=="etag"{gsub(/\r/,"",$2); print $2}')
curl -i localhost:3999/meta/enums -H "If-None-Match: $ETAG"

ETAG2=$(curl -sSI localhost:3999/meta/event-kinds | awk -F': ' 'tolower($1)=="etag"{gsub(/\r/,"",$2); print $2}')
curl -i localhost:3999/meta/event-kinds -H "If-None-Match: $ETAG2"

# To assert status code in scripts:
curl -s -o /dev/null -w "%{http_code}\n" localhost:3999/meta/enums -H "If-None-Match: $ETAG"

Tip: use `curl -I` / `HEAD` requests (as above) to fetch headers (like ETag) without downloading the response body.
```

### Reconnect strategy (recommended)

Each event includes a monotonically increasing `seq`. A common pattern is:

1) On startup, fetch backlog via HTTP:
   - `GET /events?afterSeq=<lastSeenSeq>&limit=200`
2) Connect to websocket `GET /ws` for live events.
3) On disconnect, reconnect and catch up again with `afterSeq`.

This gives you reliable catch-up without requiring the websocket to be perfectly durable.

### Event feed filtering

Both `GET /events` and `GET /cases/:id/events` support an optional `kind` filter (comma-separated):

- `GET /events?afterSeq=0&kind=STATUS_CHANGED,CASE_CLAIMED`
- `GET /cases/:id/events?kind=COMMITMENT_UPDATED`

## API (current)

### Health
- `GET /healthz`

### Cases
- `POST /cases` (validated)
- `GET /cases`
  - filters: `status`, `risk`, `state`
  - pagination: `limit`, `offset`
  - example: `/cases?status=OPEN&risk=CODE_RED&state=TX&limit=50&offset=0`
- `GET /cases/:id`
- `PATCH /cases/:id`
  - if `status` is provided and the case is actively claimed, requires `claimant` to match the claim holder
- `PATCH /cases/:id/status` (strict status transitions)

### Commitments
- `POST /cases/:id/commitments` (validated)
- `GET /cases/:id/commitments` (pagination: `limit`, `offset`)
- `GET /commitments/:id`
- `GET /commitments`
  - filters: `caseId`, `type`, `status` (type/status are comma-separated)
  - pagination: `limit`, `offset`
  - example: `/commitments?type=TRANSPORT&status=PENDING,CONFIRMED&limit=100&offset=0`
- `PATCH /commitments/:id` (validated patch)

### Claim/lock semantics (MVP)
- `POST /cases/:id/claim` body: `{ claimant: "org-or-user-id", ttlMs?: number }`
  - returns `409 already_claimed` if another claimant holds an active claim
- `POST /cases/:id/release` body: `{ claimant: "org-or-user-id" }`

### Events
- WebSocket: `GET /ws`
- HTTP feeds:
  - `GET /events` (global)
    - cursor pagination: `afterSeq`, `sinceTs`, `limit`
    - filters: `caseId`, `kind` (csv)
    - example: `/events?afterSeq=0&limit=200&kind=STATUS_CHANGED,CASE_CLAIMED`
  - `GET /cases/:id/events` (per-case)
    - cursor pagination: `afterSeq`, `sinceTs`, `limit`
    - filter: `kind` (csv)

Example catch-up + subscribe (filtering to high-signal kinds):

```bash
# catch up via HTTP
curl -sS "localhost:3999/events?afterSeq=0&limit=200&kind=STATUS_CHANGED,CASE_CLAIMED" | cat

# subscribe via websocket
node -e "import WebSocket from 'ws'; const ws=new WebSocket('ws://localhost:3999/ws?kind=STATUS_CHANGED,CASE_CLAIMED'); ws.on('message',m=>console.log(m.toString()));"
```

### Meta
- `GET /meta/event-kinds` (supports `HEAD`, `ETag`, `If-None-Match` -> 304)
- `GET /meta/enums` (supports `HEAD`, `ETag`, `If-None-Match` -> 304)

## Docs
- See **docs/DESIGN.md** for the system design + roadmap.
