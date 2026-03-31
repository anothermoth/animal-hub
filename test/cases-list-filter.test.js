import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

test('GET /cases supports status/risk/state filters', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c1 = await app.inject({
    method: 'POST',
    url: '/cases',
    payload: { riskLevel: 'CODE_RED', location: { city: 'Austin', state: 'TX' } },
  });
  const c2 = await app.inject({
    method: 'POST',
    url: '/cases',
    payload: { riskLevel: 'HIGH', location: { city: 'Miami', state: 'FL' } },
  });

  assert.equal(c1.statusCode, 201);
  assert.equal(c2.statusCode, 201);

  const res1 = await app.inject({ method: 'GET', url: '/cases?risk=CODE_RED&state=TX&status=OPEN' });
  assert.equal(res1.statusCode, 200);
  const body1 = res1.json();
  assert.equal(body1.items.length, 1);
  assert.equal(body1.items[0].riskLevel, 'CODE_RED');

  const res2 = await app.inject({ method: 'GET', url: '/cases?state=fl' });
  assert.equal(res2.statusCode, 200);
  const body2 = res2.json();
  assert.equal(body2.items.length, 1);
  assert.equal(body2.items[0].location.state, 'FL');

  await app.close();
});

test('GET /cases rejects unknown risk/status values', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const badRisk = await app.inject({ method: 'GET', url: '/cases?risk=NOPE' });
  assert.equal(badRisk.statusCode, 400);

  const badStatus = await app.inject({ method: 'GET', url: '/cases?status=NOPE' });
  assert.equal(badStatus.statusCode, 400);

  await app.close();
});

test('PATCH /commitments/:id updates a commitment and validates enums', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const created = await app.inject({ method: 'POST', url: '/cases', payload: {} });
  const c = created.json();

  const commitment = await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/commitments`,
    payload: { type: 'FOSTER', status: 'PENDING', party: { name: 'Alex' } },
  });
  assert.equal(commitment.statusCode, 201);
  const com = commitment.json();

  const patched = await app.inject({
    method: 'PATCH',
    url: `/commitments/${com.commitId}`,
    payload: { status: 'CONFIRMED' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().status, 'CONFIRMED');

  const bad = await app.inject({
    method: 'PATCH',
    url: `/commitments/${com.commitId}`,
    payload: { status: 'NOPE' },
  });
  assert.equal(bad.statusCode, 400);

  await app.close();
});

test('GET /cases/:id/commitments lists commitments for a case', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const created = await app.inject({ method: 'POST', url: '/cases', payload: {} });
  const c = created.json();

  await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/commitments`,
    payload: { type: 'FOSTER', party: { name: 'A' } },
  });
  await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/commitments`,
    payload: { type: 'TRANSPORT', party: { name: 'B' } },
  });

  const listed = await app.inject({ method: 'GET', url: `/cases/${c.caseId}/commitments` });
  assert.equal(listed.statusCode, 200);
  const body = listed.json();
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].caseId, c.caseId);

  const missing = await app.inject({ method: 'GET', url: '/cases/does-not-exist/commitments' });
  assert.equal(missing.statusCode, 404);

  await app.close();
});

test('GET /cases/:id/events returns an append-only event list for a case', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const created = await app.inject({ method: 'POST', url: '/cases', payload: {} });
  const c = created.json();

  await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/commitments`,
    payload: { type: 'FOSTER', party: { name: 'A' } },
  });

  const updatedCase = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}`,
    payload: { notes: 'updated' },
  });
  assert.equal(updatedCase.statusCode, 200);

  const ev = await app.inject({ method: 'GET', url: `/cases/${c.caseId}/events` });
  assert.equal(ev.statusCode, 200);
  const body = ev.json();

  // CASE_CREATED + COMMITMENT_CREATED + CASE_UPDATED
  assert.ok(body.items.length >= 3);
  assert.ok(body.items.every((e) => e.caseId === c.caseId));

  const missing = await app.inject({ method: 'GET', url: '/cases/nope/events' });
  assert.equal(missing.statusCode, 404);

  await app.close();
});
