import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { nanoid } from 'nanoid';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket);

/**
 * MVP storage: in-memory.
 * Replace with Postgres + event store in Phase 2.
 */
const cases = new Map();
const commitments = new Map();
const subscribers = new Set();

function emitEvent(event) {
  const msg = JSON.stringify({ type: 'event', event });
  for (const ws of subscribers) {
    try {
      ws.send(msg);
    } catch {
      // ignore
    }
  }
}

app.get('/healthz', async () => ({ ok: true }));

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

app.get('/cases', async () => ({ items: Array.from(cases.values()) }));

app.get('/cases/:id', async (req, reply) => {
  const c = cases.get(req.params.id);
  if (!c) return reply.code(404).send({ error: 'not_found' });
  return c;
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

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });

