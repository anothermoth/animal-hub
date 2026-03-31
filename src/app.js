import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { nanoid } from 'nanoid';
import { z } from 'zod';

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

const PatchCommitmentBody = z
  .object({
    type: CommitmentType.optional(),
    status: CommitmentStatus.optional(),
    party: z.record(z.any()).optional(),
    details: z.record(z.any()).optional(),
  })
  .strict();

const ListCasesQuery = z
  .object({
    status: z.string().optional(), // comma-separated
    risk: z.string().optional(), // comma-separated
    state: z.string().optional(),
  })
  .strict();

const ListEventsQuery = z
  .object({
    limit: z.string().optional(),
    sinceTs: z.string().optional(),
    afterSeq: z.string().optional(),
    caseId: z.string().optional(),
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

export function buildApp(opts = {}) {
  const app = Fastify({ logger: true, ...opts.fastify });

  /**
   * MVP storage: in-memory.
   * Replace with Postgres + event store in Phase 2.
   */
  const cases = opts.cases ?? new Map();
  const commitments = opts.commitments ?? new Map();
  const subscribers = new Set();
  const events = opts.events ?? [];
  let eventSeq = opts.eventSeq ?? 0;

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
    for (const ws of subscribers) {
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

  // Global event stream (useful for dashboards / "what changed" views).
  // Supports the same cursors as /cases/:id/events.
  app.get('/events', async (req, reply) => {
    const parsed = ListEventsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query', details: parsed.error.flatten() });
    const q = parsed.data;

    let since = null;
    if (q.sinceTs) {
      const d = new Date(String(q.sinceTs));
      if (Number.isNaN(d.getTime())) return reply.code(400).send({ error: 'bad_query_sinceTs' });
      since = d.toISOString();
    }

    let afterSeq = null;
    if (q.afterSeq != null) {
      const n = Number(q.afterSeq);
      if (!Number.isFinite(n) || n < 0) return reply.code(400).send({ error: 'bad_query_afterSeq' });
      afterSeq = Math.floor(n);
    }

    let limit = 200;
    if (q.limit != null) {
      const n = Number(q.limit);
      if (!Number.isFinite(n) || n < 1) return reply.code(400).send({ error: 'bad_query_limit' });
      limit = Math.min(1000, Math.floor(n));
    }

    const caseId = q.caseId ? String(q.caseId) : null;

    const items = [];
    if (afterSeq != null || since) {
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (caseId && e.caseId !== caseId) continue;
        if (afterSeq != null && Number(e.seq ?? 0) <= afterSeq) continue;
        if (since && String(e.ts) <= since) continue;
        items.push(e);
        if (items.length >= limit) break;
      }
    } else {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (caseId && e.caseId !== caseId) continue;
        items.push(e);
        if (items.length >= limit) break;
      }
      items.reverse();
    }

    return {
      items,
      nextSinceTs: items.length ? items[items.length - 1].ts : since,
      nextAfterSeq: items.length ? items[items.length - 1].seq : afterSeq,
    };
  });

  app.get('/cases/:id/events', async (req, reply) => {
    const c = cases.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'case_not_found' });

    const parsed = ListEventsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query', details: parsed.error.flatten() });
    const q = parsed.data;

    let since = null;
    if (q.sinceTs) {
      const d = new Date(String(q.sinceTs));
      if (Number.isNaN(d.getTime())) return reply.code(400).send({ error: 'bad_query_sinceTs' });
      since = d.toISOString();
    }

    let afterSeq = null;
    if (q.afterSeq != null) {
      const n = Number(q.afterSeq);
      if (!Number.isFinite(n) || n < 0) return reply.code(400).send({ error: 'bad_query_afterSeq' });
      afterSeq = Math.floor(n);
    }

    let limit = 200;
    if (q.limit != null) {
      const n = Number(q.limit);
      if (!Number.isFinite(n) || n < 1) return reply.code(400).send({ error: 'bad_query_limit' });
      limit = Math.min(1000, Math.floor(n));
    }

    const items = [];
    if (afterSeq != null || since) {
      // Cursor-based forward scan.
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.caseId !== c.caseId) continue;
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
        items.push(e);
        if (items.length >= limit) break;
      }
      items.reverse();
    }
    return {
      items,
      nextSinceTs: items.length ? items[items.length - 1].ts : since,
      nextAfterSeq: items.length ? items[items.length - 1].seq : afterSeq,
    };
  });

  app.get('/ws', { websocket: true }, (connection) => {
    subscribers.add(connection.socket);
    connection.socket.send(JSON.stringify({ type: 'hello', ts: new Date().toISOString() }));
    connection.socket.on('close', () => subscribers.delete(connection.socket));
  });

  app.post('/cases', async (req, reply) => {
    const body = req.body ?? {};
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
      status: 'OPEN',
      location: body.location ?? null,
      notes: body.notes ?? '',
      media: body.media ?? [],
      createdAt: now,
      updatedAt: now,
    };
    cases.set(caseId, record);
    emitEvent({ kind: 'CASE_CREATED', caseId, ts: now, payload: record });
    return reply.code(201).send(record);
  });

  // Supports the design-doc sketch: /cases?status=OPEN&state=TX&risk=CODE_RED
  app.get('/cases', async (req, reply) => {
    const parsed = ListCasesQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_query', details: parsed.error.flatten() });

    const q = parsed.data;
    const statusSetRaw = parseCsvSet(q.status);
    const riskSetRaw = parseCsvSet(q.risk);

    // Validate enums (but keep it permissive: ignore unknown values by failing fast).
    let statusSet = null;
    if (statusSetRaw) {
      const statuses = Array.from(statusSetRaw);
      const res = z.array(CaseStatus).safeParse(statuses);
      if (!res.success) return reply.code(400).send({ error: 'bad_query_status' });
      statusSet = new Set(res.data);
    }

    let riskSet = null;
    if (riskSetRaw) {
      const risks = Array.from(riskSetRaw);
      const res = z.array(RiskLevel).safeParse(risks);
      if (!res.success) return reply.code(400).send({ error: 'bad_query_risk' });
      riskSet = new Set(res.data);
    }

    const state = q.state ? String(q.state).trim().toUpperCase() : null;
    const items = [];
    for (const rec of cases.values()) {
      if (statusSet && !statusSet.has(rec.status)) continue;
      if (riskSet && !riskSet.has(rec.riskLevel)) continue;
      if (state) {
        const recState = rec.location?.state ? String(rec.location.state).trim().toUpperCase() : null;
        if (recState !== state) continue;
      }
      items.push(rec);
    }
    return { items };
  });

  app.get('/cases/:id', async (req, reply) => {
    const c = cases.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    return c;
  });

  // Convenience endpoint for case detail views.
  app.get('/cases/:id/commitments', async (req, reply) => {
    const c = cases.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'case_not_found' });
    return { items: listCommitmentsForCase(c.caseId) };
  });

  app.patch('/cases/:id', async (req, reply) => {
    const existing = cases.get(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const now = new Date().toISOString();
    const updated = { ...existing, ...(req.body ?? {}), updatedAt: now };
    cases.set(existing.caseId, updated);
    emitEvent({ kind: 'CASE_UPDATED', caseId: existing.caseId, ts: now, payload: updated });
    return updated;
  });

  app.post('/cases/:id/commitments', async (req, reply) => {
    const c = cases.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'case_not_found' });
    const body = req.body ?? {};
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

  return app;
}
