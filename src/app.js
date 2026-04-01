import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import crypto from 'node:crypto';

const CaseStatus = z.enum([
  'OPEN',
  'HOLD_REQUESTED',
  'RESCUE_TAGGED',
  'FOSTER_COMMITTED',
  'TRANSPORT_COMMITTED',
  'PULLED',
  'ADOPTED',
  'EUTH_LISTED',
  'CLOSED',
]);

const RiskLevel = z.enum(['LOW', 'MED', 'HIGH', 'CODE_RED']);

const CommitmentType = z.enum(['FOSTER', 'ADOPT', 'TRANSPORT', 'RESCUE_PULL', 'DONATION']);
const CommitmentStatus = z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'FULFILLED']);

const EventKind = z.enum([
  'CASE_CREATED',
  'CASE_UPDATED',
  'STATUS_CHANGED',
  'COMMITMENT_CREATED',
  'COMMITMENT_UPDATED',
  'CASE_CLAIMED',
  'CASE_RELEASED',
]);

const EVENT_KINDS = EventKind.options;
const ENUMS = {
  caseStatus: CaseStatus.options,
  riskLevel: RiskLevel.options,
  commitmentType: CommitmentType.options,
  commitmentStatus: CommitmentStatus.options,
  eventKind: EVENT_KINDS,
};

const PatchCommitmentBody = z
  .object({
    type: CommitmentType.optional(),
    status: CommitmentStatus.optional(),
    party: z.record(z.string(), z.any()).optional(),
    details: z.record(z.string(), z.any()).optional(),
  })
  .strict();

const CreateCommitmentBody = z
  .object({
    type: CommitmentType.optional(),
    status: CommitmentStatus.optional(),
    party: z
      .object({
        name: z.string().min(1).optional(),
        org: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
      })
      .partial()
      .optional(),
    details: z.record(z.string(), z.any()).optional(),
  })
  .strict();

const ClaimCaseBody = z
  .object({
    claimant: z.string().min(1),
    ttlMs: z.number().int().min(1000).max(1000 * 60 * 60).optional(),
  })
  .strict();

const ReleaseClaimBody = z
  .object({
    claimant: z.string().min(1),
  })
  .strict();

const PatchCaseStatusBody = z
  .object({
    status: CaseStatus,
    claimant: z.string().min(1).optional(),
  })
  .strict();

const CreateCaseBody = z
  .object({
    externalIds: z.array(z.string()).optional(),
    name: z.string().min(1).optional(),
    species: z.string().optional(),
    sex: z.string().optional(),
    ageApprox: z.string().optional(),
    breedGuess: z.string().optional(),
    shelter: z.record(z.string(), z.any()).optional(),
    deadlineAt: z
      .string()
      .optional()
      .refine((v) => v == null || !Number.isNaN(new Date(v).getTime()), { message: 'must be ISO date string' }),
    riskLevel: RiskLevel.optional(),
    status: CaseStatus.optional(),
    location: z
      .object({
        city: z.string().optional(),
        state: z.string().min(2).max(2).optional(),
        lat: z.number().optional(),
        lon: z.number().optional(),
      })
      .partial()
      .optional(),
    notes: z.string().optional(),
    media: z.array(z.string()).optional(),
  })
  .strict();

const PatchCaseBody = z
  .object({
    externalIds: z.array(z.string()).optional(),
    name: z.string().min(1).optional(),
    species: z.string().optional(),
    sex: z.string().optional(),
    ageApprox: z.string().optional(),
    breedGuess: z.string().optional(),
    shelter: z.record(z.string(), z.any()).optional(),
    deadlineAt: z
      .string()
      .optional()
      .refine((v) => v == null || !Number.isNaN(new Date(v).getTime()), { message: 'must be ISO date string' }),
    riskLevel: RiskLevel.optional(),
    status: CaseStatus.optional(),
    location: z
      .object({
        city: z.string().optional(),
        state: z.string().min(2).max(2).optional(),
        lat: z.number().optional(),
        lon: z.number().optional(),
      })
      .partial()
      .optional(),
    notes: z.string().optional(),
    media: z.array(z.string()).optional(),

    // Used only for claim-enforced status changes.
    claimant: z.string().min(1).optional(),
  })
  .strict();

const ListCasesQuery = z
  .object({
    status: z.string().optional(), // comma-separated
    risk: z.string().optional(), // comma-separated
    state: z.string().optional(),
    q: z.string().optional(),
    sort: z.string().optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
  })
  .strict();

const ListEventsQuery = z
  .object({
    limit: z.string().optional(),
    sinceTs: z.string().optional(),
    afterSeq: z.string().optional(),
    caseId: z.string().optional(),
    kind: z.string().optional(), // comma-separated
  })
  .strict();

const ListCommitmentsQuery = z
  .object({
    caseId: z.string().optional(),
    q: z.string().optional(),
    type: z.string().optional(), // comma-separated
    status: z.string().optional(), // comma-separated
    limit: z.string().optional(),
    offset: z.string().optional(),
  })
  .strict();

const ListCaseCommitmentsQuery = z
  .object({
    q: z.string().optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
  })
  .strict();

const GetCaseQuery = z
  .object({
    include: z.string().optional(),
  })
  .strict();

function parseCsvSet(input) {
  if (!input) return null;
  const items = String(input)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) return null;
  return new Set(items);
}

function parseCsvEnumSet(raw, enumSchema) {
  const setRaw = parseCsvSet(raw);
  if (!setRaw) return null;
  const items = Array.from(setRaw);
  const res = z.array(enumSchema).safeParse(items);
  if (!res.success) return { error: true };
  return new Set(res.data);
}

function parseLimitOffset(q, { defaultLimit = 200, maxLimit = 1000 } = {}) {
  let limit = defaultLimit;
  if (q?.limit != null) {
    const n = Number(q.limit);
    if (!Number.isFinite(n) || n < 1) return { error: 'bad_query_limit' };
    limit = Math.min(maxLimit, Math.floor(n));
  }

  let offset = 0;
  if (q?.offset != null) {
    const n = Number(q.offset);
    if (!Number.isFinite(n) || n < 0) return { error: 'bad_query_offset' };
    offset = Math.floor(n);
  }

  return { limit, offset };
}

function parseAfterSeqSinceTsLimit(q, { defaultLimit = 200, maxLimit = 1000 } = {}) {
  let since = null;
  if (q?.sinceTs) {
    const d = new Date(String(q.sinceTs));
    if (Number.isNaN(d.getTime())) return { error: 'bad_query_sinceTs' };
    since = d.toISOString();
  }

  let afterSeq = null;
  if (q?.afterSeq != null) {
    const n = Number(q.afterSeq);
    if (!Number.isFinite(n) || n < 0) return { error: 'bad_query_afterSeq' };
    afterSeq = Math.floor(n);
  }

  let limit = defaultLimit;
  if (q?.limit != null) {
    const n = Number(q.limit);
    if (!Number.isFinite(n) || n < 1) return { error: 'bad_query_limit' };
    limit = Math.min(maxLimit, Math.floor(n));
  }

  return { since, afterSeq, limit };
}

function buildNextEventsUrl(req, nextAfterSeq, nextSinceTs) {
  try {
    const rawUrl = req?.raw?.url ?? req?.url;
    const url = rawUrl ? new URL(rawUrl, 'http://localhost') : new URL('http://localhost/events');
    url.searchParams.set('afterSeq', String(nextAfterSeq ?? 0));
    if (nextSinceTs) url.searchParams.set('sinceTs', String(nextSinceTs));
    // Keep other existing query params (kind, caseId, limit, etc.).
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

function buildNextOffsetUrl(req, nextOffset) {
  try {
    const rawUrl = req?.raw?.url ?? req?.url;
    const url = rawUrl ? new URL(rawUrl, 'http://localhost') : new URL('http://localhost/');
    url.searchParams.set('offset', String(nextOffset ?? 0));
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

function commitmentMatchesQuery(rec, query) {
  if (!query) return true;
  const q = String(query).trim().toLowerCase();
  if (!q) return true;
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const fields = [
    rec?.commitId,
    rec?.caseId,
    rec?.type,
    rec?.status,
    rec?.party?.name,
    rec?.party?.org,
    rec?.party?.email,
    rec?.party?.phone,
  ]
    .filter((v) => typeof v === 'string' && v.trim().length)
    .map((v) => v.trim().toLowerCase());

  const haystack = fields.join(' | ');
  return terms.every((t) => haystack.includes(t));
}

function caseMatchesQuery(rec, query) {
  if (!query) return true;
  const q = String(query).trim().toLowerCase();
  if (!q) return true;
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const fields = [
    rec?.name,
    rec?.species,
    rec?.breedGuess,
    rec?.notes,
    rec?.shelter?.name,
    ...(Array.isArray(rec?.externalIds) ? rec.externalIds : []),
  ]
    .filter((v) => typeof v === 'string' && v.trim().length)
    .map((v) => v.trim().toLowerCase());

  const haystack = fields.join(' | ');
  return terms.every((t) => haystack.includes(t));
}

export function buildApp(opts = {}) {
  const app = Fastify({ logger: true, ...opts.fastify });

  const metaVersion =
    opts.metaVersion ??
    process.env.APP_VERSION ??
    process.env.GIT_SHA ??
    null;

  function setMetaCacheHeaders(reply, payloadObj) {
    reply.header('cache-control', 'public, max-age=60');
    const etag = crypto.createHash('sha256').update(JSON.stringify(payloadObj)).digest('hex');
    const etagQuoted = `\"${etag}\"`;
    reply.header('etag', etagQuoted);
    return etagQuoted;
  }

  /**
   * MVP storage: in-memory.
   * Replace with Postgres + event store in Phase 2.
   */
  const cases = opts.cases ?? new Map();
  const commitments = opts.commitments ?? new Map();
  const subscribers = new Set();
  const events = opts.events ?? [];
  let eventSeq = opts.eventSeq ?? 0;

  // Basic idempotency support (in-memory): allows clients to safely retry POSTs.
  // Keys are intentionally bounded to avoid unbounded memory growth.
  const idempotency = opts.idempotency ?? {
    cases: new Map(), // key -> caseId
    commitments: new Map(), // `${caseId}:${key}` -> commitId
    order: [],
    max: 1000,
  };

  function getIdempotencyKey(req) {
    const raw = req?.headers?.['idempotency-key'];
    if (!raw) return null;
    const key = String(raw).trim();
    if (!key) return null;
    // Avoid pathological keys. (Not a security boundary, just sanity.)
    if (key.length > 200) return key.slice(0, 200);
    return key;
  }

  function rememberIdempotency(type, key, id) {
    if (!key) return;
    if (type === 'case') idempotency.cases.set(key, id);
    if (type === 'commitment') idempotency.commitments.set(key, id);
    idempotency.order.push({ type, key });
    while (idempotency.order.length > (idempotency.max ?? 1000)) {
      const oldest = idempotency.order.shift();
      if (!oldest) break;
      if (oldest.type === 'case') idempotency.cases.delete(oldest.key);
      if (oldest.type === 'commitment') idempotency.commitments.delete(oldest.key);
    }
  }

  function listCommitmentsForCase(caseId) {
    const items = [];
    for (const rec of commitments.values()) {
      if (rec.caseId === caseId) items.push(rec);
    }
    // stable ordering for clients/tests
    items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return items;
  }

  function emitEvent(event) {
    const enriched = {
      eventId: nanoid(),
      seq: ++eventSeq,
      ...event,
    };
    events.push(enriched);
    const msg = JSON.stringify({ type: 'event', event: enriched });
    for (const sub of subscribers) {
      const ws = sub?.ws ?? sub;
      const kindSet = sub?.kindSet ?? null;
      if (kindSet && !kindSet.has(enriched.kind)) continue;
      try {
        ws.send(msg);
      } catch {
        // ignore
      }
    }
  }

  app.decorate('store', { cases, commitments, events });

  app.register(cors, { origin: true });
  app.register(websocket);

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/meta/enums', async (req, reply) => {
    const payload = { enums: ENUMS, version: metaVersion };
    const etag = setMetaCacheHeaders(reply, payload);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return payload;
  });

  app.get('/meta/event-kinds', async (req, reply) => {
    const payload = { items: EVENT_KINDS, version: metaVersion };
    const etag = setMetaCacheHeaders(reply, payload);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return payload;
  });

  // Global event stream (useful for dashboards / "what changed" views).
  // Supports the same cursors as /cases/:id/events.
  app.get('/events', async (req, reply) => {
    // Event feeds should not be cached by intermediaries (they're inherently time-sensitive).
    // Clients can still use their own cursors (afterSeq/sinceTs) for efficient polling.
    reply.header('cache-control', 'no-store');

    const parsed = ListEventsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query', details: parsed.error.flatten() });
    const q = parsed.data;

    const curs = parseAfterSeqSinceTsLimit(q);
    if (curs.error) return reply.code(400).send({ error: curs.error });
    const { since, afterSeq, limit } = curs;

    const caseId = q.caseId ? String(q.caseId) : null;
    const kindSetParsed = parseCsvEnumSet(q.kind, EventKind);
    if (kindSetParsed?.error) return reply.code(400).send({ error: 'bad_query_kind' });
    const kindSet = kindSetParsed;

    const items = [];
    if (afterSeq != null || since) {
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (caseId && e.caseId !== caseId) continue;
        if (kindSet && !kindSet.has(e.kind)) continue;
        if (afterSeq != null && Number(e.seq ?? 0) <= afterSeq) continue;
        if (since && String(e.ts) <= since) continue;
        items.push(e);
        if (items.length >= limit) break;
      }
    } else {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (caseId && e.caseId !== caseId) continue;
        if (kindSet && !kindSet.has(e.kind)) continue;
        items.push(e);
        if (items.length >= limit) break;
      }
      items.reverse();
    }

    const nextSinceTs = items.length ? items[items.length - 1].ts : since;
    const nextAfterSeq = items.length ? items[items.length - 1].seq : afterSeq;
    return {
      items,
      nextSinceTs,
      nextAfterSeq,
      next: buildNextEventsUrl(req, nextAfterSeq, nextSinceTs),
    };
  });

  app.get('/cases/:id/events', async (req, reply) => {
    const c = cases.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'case_not_found' });

    reply.header('cache-control', 'no-store');

    const parsed = ListEventsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query', details: parsed.error.flatten() });
    const q = parsed.data;

    const curs = parseAfterSeqSinceTsLimit(q);
    if (curs.error) return reply.code(400).send({ error: curs.error });
    const { since, afterSeq, limit } = curs;

    const kindSetParsed = parseCsvEnumSet(q.kind, EventKind);
    if (kindSetParsed?.error) return reply.code(400).send({ error: 'bad_query_kind' });
    const kindSet = kindSetParsed;

    const items = [];
    if (afterSeq != null || since) {
      // Cursor-based forward scan.
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.caseId !== c.caseId) continue;
        if (kindSet && !kindSet.has(e.kind)) continue;
        if (afterSeq != null && Number(e.seq ?? 0) <= afterSeq) continue;
        if (since && String(e.ts) <= since) continue;
        items.push(e);
        if (items.length >= limit) break;
      }
    } else {
      // Default: tail the most recent events (useful for “load latest” views).
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.caseId !== c.caseId) continue;
        if (kindSet && !kindSet.has(e.kind)) continue;
        items.push(e);
        if (items.length >= limit) break;
      }
      items.reverse();
    }
    const nextSinceTs = items.length ? items[items.length - 1].ts : since;
    const nextAfterSeq = items.length ? items[items.length - 1].seq : afterSeq;
    return {
      items,
      nextSinceTs,
      nextAfterSeq,
      next: buildNextEventsUrl(req, nextAfterSeq, nextSinceTs),
    };
  });

  app.get('/ws', { websocket: true }, (socket, req) => {
    // Optional filtering: /ws?kind=STATUS_CHANGED,CASE_CLAIMED
    let kindSet = null;
    let kindInvalid = false;
    try {
      const rawUrl = req?.raw?.url ?? req?.url;
      const url = rawUrl ? new URL(rawUrl, 'http://localhost') : null;
      const kindRaw = url ? parseCsvSet(url.searchParams.get('kind')) : null;
      if (kindRaw) {
        const kinds = Array.from(kindRaw);
        const res = z.array(EventKind).safeParse(kinds);
        if (res.success) kindSet = new Set(res.data);
        else kindInvalid = true;
      }
    } catch {
      // ignore query parse failures
    }

    const ws = socket?.send ? socket : socket?.socket;
    if (!ws || typeof ws.send !== 'function') return;

    if (kindInvalid) {
      // Close with policy violation to signal bad client params.
      // (HTTP event feeds return 400 for the same condition.)
      try {
        ws.close?.(1008, 'bad kind');
      } catch {
        // ignore
      }
      return;
    }

    const sub = { ws, kindSet };
    subscribers.add(sub);
    ws.send?.(JSON.stringify({ type: 'hello', ts: new Date().toISOString() }));
    ws.on?.('close', () => subscribers.delete(sub));
  });

  app.post('/cases', async (req, reply) => {
    const idemKey = getIdempotencyKey(req);
    if (idemKey && idempotency.cases.has(idemKey)) {
      const existingId = idempotency.cases.get(idemKey);
      const existing = existingId ? cases.get(existingId) : null;
      if (existing) return reply.code(201).send(existing);
      // If the referenced record is missing, fall through and create anew.
    }

    const parsed = CreateCaseBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_body', details: parsed.error.flatten() });
    }

    const body = parsed.data;
    const caseId = nanoid();
    const now = new Date().toISOString();
    const record = {
      caseId,
      externalIds: body.externalIds ?? [],
      name: body.name ?? null,
      species: body.species ?? 'DOG',
      sex: body.sex ?? null,
      ageApprox: body.ageApprox ?? null,
      breedGuess: body.breedGuess ?? null,
      shelter: body.shelter ?? null,
      deadlineAt: body.deadlineAt ?? null,
      riskLevel: body.riskLevel ?? 'HIGH',
      status: body.status ?? 'OPEN',
      location: body.location ?? null,
      notes: body.notes ?? '',
      media: body.media ?? [],
      createdAt: now,
      updatedAt: now,
    };
    cases.set(caseId, record);
    rememberIdempotency('case', idemKey, caseId);
    emitEvent({ kind: 'CASE_CREATED', caseId, ts: now, payload: record });
    return reply.code(201).send(record);
  });

  // Supports the design-doc sketch: /cases?status=OPEN&state=TX&risk=CODE_RED
  app.get('/cases', async (req, reply) => {
    const parsed = ListCasesQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query', details: parsed.error.flatten() });

    const q = parsed.data;
    const statusSetParsed = parseCsvEnumSet(q.status, CaseStatus);
    if (statusSetParsed?.error) return reply.code(400).send({ error: 'bad_query_status' });
    const statusSet = statusSetParsed;

    const riskSetParsed = parseCsvEnumSet(q.risk, RiskLevel);
    if (riskSetParsed?.error) return reply.code(400).send({ error: 'bad_query_risk' });
    const riskSet = riskSetParsed;

    const state = q.state ? String(q.state).trim().toUpperCase() : null;
    const query = q.q ? String(q.q).trim() : null;

    // Sort options kept intentionally small for MVP clients.
    // - createdAt:asc|desc (default asc for stable pagination)
    // - updatedAt:asc|desc
    // - deadlineAt:asc|desc (null deadlines sort last)
    // - risk:desc (CODE_RED first)
    const sortRaw = q.sort ? String(q.sort).trim() : '';
    const sort = sortRaw || 'createdAt:asc';
    const riskRank = { LOW: 0, MED: 1, HIGH: 2, CODE_RED: 3 };
    const cmpStr = (a, b) => String(a).localeCompare(String(b));
    const cmpDeadline = (a, b) => {
      const ax = a ? String(a) : null;
      const bx = b ? String(b) : null;
      if (ax == null && bx == null) return 0;
      if (ax == null) return 1;
      if (bx == null) return -1;
      return cmpStr(ax, bx);
    };
    const cmpRiskDesc = (a, b) => (riskRank[b] ?? -1) - (riskRank[a] ?? -1);

    const lo = parseLimitOffset(q);
    if (lo.error) return reply.code(400).send({ error: lo.error });
    const { limit, offset } = lo;

    const items = [];
    for (const rec of cases.values()) {
      if (statusSet && !statusSet.has(rec.status)) continue;
      if (riskSet && !riskSet.has(rec.riskLevel)) continue;
      if (state) {
        const recState = rec.location?.state ? String(rec.location.state).trim().toUpperCase() : null;
        if (recState !== state) continue;
      }

      if (!caseMatchesQuery(rec, query)) continue;
      items.push(rec);
    }

    // stable ordering for pagination
    if (sort === 'createdAt:asc') {
      items.sort((a, b) => cmpStr(a.createdAt, b.createdAt));
    } else if (sort === 'createdAt:desc') {
      items.sort((a, b) => cmpStr(b.createdAt, a.createdAt));
    } else if (sort === 'updatedAt:asc') {
      items.sort((a, b) => {
        const u = cmpStr(a.updatedAt, b.updatedAt);
        return u !== 0 ? u : cmpStr(a.createdAt, b.createdAt);
      });
    } else if (sort === 'updatedAt:desc') {
      items.sort((a, b) => {
        const u = cmpStr(b.updatedAt, a.updatedAt);
        return u !== 0 ? u : cmpStr(a.createdAt, b.createdAt);
      });
    } else if (sort === 'deadlineAt:asc') {
      items.sort((a, b) => {
        const d = cmpDeadline(a.deadlineAt, b.deadlineAt);
        return d !== 0 ? d : cmpStr(a.createdAt, b.createdAt);
      });
    } else if (sort === 'deadlineAt:desc') {
      items.sort((a, b) => {
        const d = cmpDeadline(b.deadlineAt, a.deadlineAt);
        return d !== 0 ? d : cmpStr(a.createdAt, b.createdAt);
      });
    } else if (sort === 'risk:desc') {
      items.sort((a, b) => {
        const r = cmpRiskDesc(a.riskLevel, b.riskLevel);
        return r !== 0 ? r : cmpStr(a.createdAt, b.createdAt);
      });
    } else {
      return reply.code(400).send({ error: 'bad_query_sort' });
    }
    const total = items.length;
    const paged = items.slice(offset, offset + limit);

    const nextOffset = offset + paged.length;
    const payload = {
      items: paged,
      total,
      offset,
      limit,
      nextOffset: nextOffset < total ? nextOffset : null,
      next: nextOffset < total ? buildNextOffsetUrl(req, nextOffset) : null,
    };
    const etag = setMetaCacheHeaders(reply, payload);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return payload;
  });

  app.get('/cases/:id', async (req, reply) => {
    const c = cases.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });

    const parsed = GetCaseQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query', details: parsed.error.flatten() });

    const include = parsed.data.include ? String(parsed.data.include).trim().toLowerCase() : '';
    const includeSet = parseCsvSet(include);

    if (includeSet && includeSet.size) {
      // Only allow known includes for now.
      for (const x of includeSet) {
        if (x !== 'commitments') return reply.code(400).send({ error: 'bad_query_include' });
      }
    }

    const payload =
      includeSet && includeSet.has('commitments')
        ? { case: c, commitments: listCommitmentsForCase(c.caseId) }
        : c;

    const etag = setMetaCacheHeaders(reply, payload);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return payload;
  });

  // Convenience endpoint for case detail views.
  app.get('/cases/:id/commitments', async (req, reply) => {
    const c = cases.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'case_not_found' });

    const parsed = ListCaseCommitmentsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query', details: parsed.error.flatten() });

    const lo = parseLimitOffset(parsed.data);
    if (lo.error) return reply.code(400).send({ error: lo.error });
    const { limit, offset } = lo;

    const query = parsed.data.q ? String(parsed.data.q).trim() : null;

    let all = listCommitmentsForCase(c.caseId);
    if (query) {
      all = all.filter((rec) => commitmentMatchesQuery(rec, query));
    }

    const total = all.length;
    const items = all.slice(offset, offset + limit);

    const nextOffset = offset + items.length;
    const payload = {
      items,
      total,
      offset,
      limit,
      nextOffset: nextOffset < total ? nextOffset : null,
      next: nextOffset < total ? buildNextOffsetUrl(req, nextOffset) : null,
    };
    const etag = setMetaCacheHeaders(reply, payload);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return payload;
  });

  app.patch('/cases/:id', async (req, reply) => {
    const existing = cases.get(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const parsed = PatchCaseBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_body', details: parsed.error.flatten() });
    }

    const body = parsed.data;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    // Optional claim enforcement for status transitions.
    // If a request includes `status`, require either:
    // - no active claim, OR
    // - active claim held by body.claimant
    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      const parsed = CaseStatus.safeParse(body.status);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_body_status' });

      const claim = existing.claim ?? null;
      const claimActive =
        claim && typeof claim.expiresAt === 'string' && new Date(claim.expiresAt).getTime() > nowMs;

      if (claimActive) {
        const claimant = body.claimant;
        if (!claimant || claim.claimant !== claimant) {
          return reply.code(409).send({ error: 'claim_required', claim });
        }
      }
    }

    // Never allow primary identity / timestamps to be overwritten.
    const {
      caseId: _caseId,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      claim: _claim,
      ...rest
    } = body;

    const updated = { ...existing, ...rest, updatedAt: now };
    cases.set(existing.caseId, updated);
    emitEvent({ kind: 'CASE_UPDATED', caseId: existing.caseId, ts: now, payload: updated });

    if (Object.prototype.hasOwnProperty.call(body, 'status') && body.status !== existing.status) {
      emitEvent({
        kind: 'STATUS_CHANGED',
        caseId: existing.caseId,
        ts: now,
        payload: { from: existing.status, to: body.status, by: body.claimant ?? null },
      });
    }
    return updated;
  });

  // Focused endpoint for status transitions with strict validation.
  app.patch('/cases/:id/status', async (req, reply) => {
    const existing = cases.get(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const parsed = PatchCaseStatusBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_body', details: parsed.error.flatten() });

    const { status, claimant } = parsed.data;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    const claim = existing.claim ?? null;
    const claimActive =
      claim && typeof claim.expiresAt === 'string' && new Date(claim.expiresAt).getTime() > nowMs;
    if (claimActive && claim.claimant !== claimant) {
      return reply.code(409).send({ error: 'claim_required', claim });
    }

    const updated = { ...existing, status, updatedAt: now };
    cases.set(existing.caseId, updated);
    emitEvent({ kind: 'CASE_UPDATED', caseId: existing.caseId, ts: now, payload: updated });

    if (status !== existing.status) {
      emitEvent({
        kind: 'STATUS_CHANGED',
        caseId: existing.caseId,
        ts: now,
        payload: { from: existing.status, to: status, by: claimant ?? null },
      });
    }

    return updated;
  });

  // Minimal claim/lock semantics (roadmap item #2) to prevent double-claims.
  // - Claim is stored on the case record as { claim: { claimant, claimedAt, expiresAt } }
  // - Re-claim by same claimant refreshes TTL (idempotent-ish)
  app.post('/cases/:id/claim', async (req, reply) => {
    const existing = cases.get(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    // Best-effort idempotency: allow clients to retry a claim request without creating
    // duplicate CASE_CLAIMED events.
    const idemKey = getIdempotencyKey(req);
    const claimIdemKey = idemKey ? `${existing.caseId}:claim:${idemKey}` : null;
    if (claimIdemKey && idempotency.commitments.has(claimIdemKey)) {
      const existingId = idempotency.commitments.get(claimIdemKey);
      const rec = existingId ? cases.get(existingId) : null;
      // We store caseId here; if present, return current case snapshot.
      if (rec) return reply.code(200).send(rec);
    }

    const parsed = ClaimCaseBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_body', details: parsed.error.flatten() });

    const { claimant, ttlMs } = parsed.data;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const ttl = ttlMs ?? 15 * 60 * 1000;

    const claim = existing.claim ?? null;
    const claimActive =
      claim && typeof claim.expiresAt === 'string' && new Date(claim.expiresAt).getTime() > nowMs;

    if (claimActive && claim.claimant !== claimant) {
      return reply.code(409).send({
        error: 'already_claimed',
        claim,
      });
    }

    const updated = {
      ...existing,
      claim: {
        claimant,
        claimedAt: claim?.claimedAt ?? now,
        expiresAt: new Date(nowMs + ttl).toISOString(),
      },
      updatedAt: now,
    };
    cases.set(existing.caseId, updated);
    // reuse the bounded idempotency store (commitments map) to avoid new structure
    if (claimIdemKey) rememberIdempotency('commitment', claimIdemKey, existing.caseId);
    emitEvent({ kind: 'CASE_CLAIMED', caseId: existing.caseId, ts: now, payload: updated.claim });
    return reply.code(200).send(updated);
  });

  app.post('/cases/:id/release', async (req, reply) => {
    const existing = cases.get(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const idemKey = getIdempotencyKey(req);
    const releaseIdemKey = idemKey ? `${existing.caseId}:release:${idemKey}` : null;
    if (releaseIdemKey && idempotency.commitments.has(releaseIdemKey)) {
      const existingId = idempotency.commitments.get(releaseIdemKey);
      const rec = existingId ? cases.get(existingId) : null;
      if (rec) return reply.code(200).send(rec);
    }

    const parsed = ReleaseClaimBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_body', details: parsed.error.flatten() });

    const { claimant } = parsed.data;
    const now = new Date().toISOString();

    const claim = existing.claim ?? null;
    if (!claim) {
      // idempotent release
      return reply.code(200).send(existing);
    }

    if (claim.claimant !== claimant) {
      return reply.code(409).send({ error: 'claimant_mismatch', claim });
    }

    const updated = { ...existing, claim: null, updatedAt: now };
    cases.set(existing.caseId, updated);
    if (releaseIdemKey) rememberIdempotency('commitment', releaseIdemKey, existing.caseId);
    emitEvent({ kind: 'CASE_RELEASED', caseId: existing.caseId, ts: now, payload: { claimant } });
    return reply.code(200).send(updated);
  });

  app.post('/cases/:id/commitments', async (req, reply) => {
    const c = cases.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'case_not_found' });

    const idemKey = getIdempotencyKey(req);
    const commitIdemKey = idemKey ? `${c.caseId}:${idemKey}` : null;
    if (commitIdemKey && idempotency.commitments.has(commitIdemKey)) {
      const existingId = idempotency.commitments.get(commitIdemKey);
      const existing = existingId ? commitments.get(existingId) : null;
      if (existing) return reply.code(201).send(existing);
      // If referenced record is missing, fall through and create anew.
    }

    const parsed = CreateCommitmentBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_body', details: parsed.error.flatten() });
    }

    const body = parsed.data;
    const commitId = nanoid();
    const now = new Date().toISOString();
    const rec = {
      commitId,
      caseId: c.caseId,
      type: body.type ?? 'FOSTER',
      party: body.party ?? {},
      status: body.status ?? 'PENDING',
      details: body.details ?? {},
      createdAt: now,
      updatedAt: now,
    };
    commitments.set(commitId, rec);
    rememberIdempotency('commitment', commitIdemKey, commitId);
    emitEvent({ kind: 'COMMITMENT_CREATED', caseId: c.caseId, ts: now, payload: rec });
    return reply.code(201).send(rec);
  });

  // Matches design-doc sketch: PATCH /commitments/:id
  app.patch('/commitments/:id', async (req, reply) => {
    const existing = commitments.get(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const parsed = PatchCommitmentBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_body', details: parsed.error.flatten() });
    }

    const now = new Date().toISOString();
    const updated = { ...existing, ...parsed.data, updatedAt: now };
    commitments.set(existing.commitId, updated);
    emitEvent({ kind: 'COMMITMENT_UPDATED', caseId: updated.caseId, ts: now, payload: updated });
    return updated;
  });

  app.get('/commitments/:id', async (req, reply) => {
    const existing = commitments.get(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const etag = setMetaCacheHeaders(reply, existing);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return existing;
  });

  app.get('/commitments', async (req, reply) => {
    const parsed = ListCommitmentsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query', details: parsed.error.flatten() });

    const caseId = parsed.data.caseId ? String(parsed.data.caseId) : null;
    const query = parsed.data.q ? String(parsed.data.q).trim() : null;
    const typeSetParsed = parseCsvEnumSet(parsed.data.type, CommitmentType);
    if (typeSetParsed?.error) return reply.code(400).send({ error: 'bad_query_type' });
    const typeSet = typeSetParsed;

    const statusSetParsed = parseCsvEnumSet(parsed.data.status, CommitmentStatus);
    if (statusSetParsed?.error) return reply.code(400).send({ error: 'bad_query_status' });
    const statusSet = statusSetParsed;

    const lo = parseLimitOffset(parsed.data);
    if (lo.error) return reply.code(400).send({ error: lo.error });
    const { limit, offset } = lo;

    const items = [];
    for (const rec of commitments.values()) {
      if (caseId && rec.caseId !== caseId) continue;
      if (typeSet && !typeSet.has(rec.type)) continue;
      if (statusSet && !statusSet.has(rec.status)) continue;

      if (!commitmentMatchesQuery(rec, query)) continue;
      items.push(rec);
    }
    items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    const total = items.length;
    const paged = items.slice(offset, offset + limit);

    const nextOffset = offset + paged.length;
    const payload = {
      items: paged,
      total,
      offset,
      limit,
      nextOffset: nextOffset < total ? nextOffset : null,
      next: nextOffset < total ? buildNextOffsetUrl(req, nextOffset) : null,
    };
    const etag = setMetaCacheHeaders(reply, payload);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return payload;
  });

  return app;
}
