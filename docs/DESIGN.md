# Animal Hub — Design Doc (v0)

## 0) Problem
When an animal is at imminent risk (deadline hours/minutes), coordination fails because:
- information is scattered (posts, texts, email threads)
- verification is hard (is the animal still available?)
- matching supply/demand is slow (foster + transport + rescue pull)
- handoffs are brittle (no single source of truth)

**Goal:** a centralized, real-time hub that makes it trivial to:
1) publish a high-risk animal record,
2) broadcast instantly to the right network,
3) coordinate commitments (foster/transport/rescue tag),
4) track status until outcome.

## 1) Core objects (MVP)
### AnimalCase
- `caseId` (nanoid)
- `externalIds` (array): e.g. shelter A#
- `name`, `species`, `sex`, `ageApprox`, `breedGuess`
- `shelter`: `{ name, phone, address, hours, intakeUrl }`
- `deadlineAt` (ISO)
- `riskLevel`: `LOW|MED|HIGH|CODE_RED`
- `status`: `OPEN|HOLD_REQUESTED|RESCUE_TAGGED|FOSTER_COMMITTED|TRANSPORT_COMMITTED|PULLED|ADOPTED|EUTH_LISTED|CLOSED`
- `location`: `{ city, state, lat?, lon? }`
- `notes` (free text)
- `media`: image URLs
- `createdAt`, `updatedAt`

### Commitment
- `commitId`
- `caseId`
- `type`: `FOSTER|ADOPT|TRANSPORT|RESCUE_PULL|DONATION`
- `party`: `{ name, org?, phone?, email? }`
- `status`: `PENDING|CONFIRMED|CANCELLED|FULFILLED`
- `details`: `{ startAt?, endAt?, route?, constraints? }`

### Event (append-only)
- `eventId`, `caseId`, `ts`
- `kind`: `CASE_CREATED|CASE_UPDATED|COMMITMENT_CREATED|COMMITMENT_UPDATED|STATUS_CHANGED|COMMENT`
- `payload`

## 2) System requirements
### Performance
- 99p event fanout < 250ms (regional)
- handle bursty “code red” traffic (social amplification)

### Reliability
- append-only events (audit)
- idempotent writes (dedupe)

### Trust / safety
- verified orgs (shelters/rescues)
- rate limiting + abuse monitoring
- PII minimization (store only necessary contact details)

## 3) Architecture (phased)
### Phase 1 (this repo): single-node real-time MVP
- **Fastify** HTTP API
- **WebSocket** realtime feed (`/ws`) for case + commitment events
- In-memory store (dev) + file persistence (optional) to ship quickly
- Simple CLI/HTTP usage + future UI

### Phase 2: production
- Postgres (cases/commitments) + event store table
- Redis for presence + pub/sub (or NATS)
- Auth (Magic link / GitHub org / API keys)
- Webhooks + integrations (Facebook groups/Slack/Telegram/Email)

### Phase 3: matching + routing
- transport route optimization
- foster matching (constraints + distance)
- automated “rescue tag” workflow tracking

## 4) API sketch
### HTTP
- `POST /cases` create
- `GET /cases?status=OPEN&state=TX&risk=CODE_RED`
- `GET /cases/:id`
- `PATCH /cases/:id`
- `POST /cases/:id/commitments`
- `PATCH /commitments/:id`

### WebSocket
- client connects to `/ws`
- server emits `event` messages:
  ```json
  {"type":"event","event":{"kind":"CASE_CREATED", "caseId":"...", "payload":{...}}}
  ```

## 5) Roadmap (near-term)
1) Implement `Case` + `Commitment` with realtime events.
2) Add “claim/lock” semantics to prevent double-claims.
3) Add notification sinks:
   - SMS/voice (Twilio)
   - Telegram/Slack
   - Email
4) Add org verification + roles.

