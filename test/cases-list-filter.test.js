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

test('GET /cases/:id/events supports limit + afterSeq cursor', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const created = await app.inject({ method: 'POST', url: '/cases', payload: {} });
  const c = created.json();

  // create a few events
  await app.inject({ method: 'PATCH', url: `/cases/${c.caseId}`, payload: { notes: '1' } });
  await app.inject({ method: 'PATCH', url: `/cases/${c.caseId}`, payload: { notes: '2' } });
  await app.inject({ method: 'PATCH', url: `/cases/${c.caseId}`, payload: { notes: '3' } });

  const first = await app.inject({ method: 'GET', url: `/cases/${c.caseId}/events?limit=2&afterSeq=0` });
  assert.equal(first.statusCode, 200);
  const b1 = first.json();
  assert.equal(b1.items.length, 2);
  assert.ok(b1.nextAfterSeq != null);

  const second = await app.inject({
    method: 'GET',
    url: `/cases/${c.caseId}/events?afterSeq=${encodeURIComponent(String(b1.nextAfterSeq))}&limit=100`,
  });
  assert.equal(second.statusCode, 200);
  const b2 = second.json();
  assert.ok(b2.items.length >= 1);
  assert.ok(b2.items.every((e) => e.seq > b1.nextAfterSeq));

  const badLimit = await app.inject({ method: 'GET', url: `/cases/${c.caseId}/events?limit=0` });
  assert.equal(badLimit.statusCode, 400);

  const badSince = await app.inject({ method: 'GET', url: `/cases/${c.caseId}/events?sinceTs=not-a-date` });
  assert.equal(badSince.statusCode, 400);

  const badAfterSeq = await app.inject({ method: 'GET', url: `/cases/${c.caseId}/events?afterSeq=-1` });
  assert.equal(badAfterSeq.statusCode, 400);

  await app.close();
});

test('GET /events returns a global event feed (optionally filtered by caseId)', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c1 = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();
  const c2 = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();

  await app.inject({ method: 'PATCH', url: `/cases/${c1.caseId}`, payload: { notes: 'a' } });
  await app.inject({ method: 'PATCH', url: `/cases/${c2.caseId}`, payload: { notes: 'b' } });

  const all = await app.inject({ method: 'GET', url: '/events?limit=10&afterSeq=0' });
  assert.equal(all.statusCode, 200);
  const a = all.json();
  assert.ok(a.items.length >= 4);

  const onlyC1 = await app.inject({ method: 'GET', url: `/events?limit=50&afterSeq=0&caseId=${c1.caseId}` });
  assert.equal(onlyC1.statusCode, 200);
  const b = onlyC1.json();
  assert.ok(b.items.length >= 2);
  assert.ok(b.items.every((e) => e.caseId === c1.caseId));

  await app.close();
});

test('POST /cases/:id/claim prevents double-claim and supports release', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const created = await app.inject({ method: 'POST', url: '/cases', payload: {} });
  const c = created.json();

  const claim1 = await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/claim`,
    payload: { claimant: 'rescue-A', ttlMs: 60_000 },
  });
  assert.equal(claim1.statusCode, 200);
  assert.equal(claim1.json().claim.claimant, 'rescue-A');

  const claim2 = await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/claim`,
    payload: { claimant: 'rescue-B', ttlMs: 60_000 },
  });
  assert.equal(claim2.statusCode, 409);
  assert.equal(claim2.json().error, 'already_claimed');

  const releaseBad = await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/release`,
    payload: { claimant: 'rescue-B' },
  });
  assert.equal(releaseBad.statusCode, 409);

  const releaseOk = await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/release`,
    payload: { claimant: 'rescue-A' },
  });
  assert.equal(releaseOk.statusCode, 200);
  assert.equal(releaseOk.json().claim, null);

  const claim3 = await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/claim`,
    payload: { claimant: 'rescue-B', ttlMs: 60_000 },
  });
  assert.equal(claim3.statusCode, 200);
  assert.equal(claim3.json().claim.claimant, 'rescue-B');

  await app.close();
});

test('PATCH /cases/:id enforces claim for status changes and emits STATUS_CHANGED', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const created = await app.inject({ method: 'POST', url: '/cases', payload: {} });
  const c = created.json();

  // Claim by rescue-A
  await app.inject({ method: 'POST', url: `/cases/${c.caseId}/claim`, payload: { claimant: 'rescue-A', ttlMs: 60_000 } });

  // Status change without claimant should be rejected
  const denied = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}`,
    payload: { status: 'RESCUE_TAGGED' },
  });
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.json().error, 'claim_required');

  // Status change with correct claimant succeeds
  const ok = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}`,
    payload: { status: 'RESCUE_TAGGED', claimant: 'rescue-A' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, 'RESCUE_TAGGED');

  // Verify STATUS_CHANGED exists in events
  const ev = await app.inject({ method: 'GET', url: `/cases/${c.caseId}/events` });
  const items = ev.json().items;
  assert.ok(items.some((e) => e.kind === 'STATUS_CHANGED' && e.payload?.to === 'RESCUE_TAGGED'));

  // Bad status enum rejected
  const bad = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}`,
    payload: { status: 'NOT_A_STATUS', claimant: 'rescue-A' },
  });
  assert.equal(bad.statusCode, 400);

  await app.close();
});

test('PATCH /cases/:id/status provides strict status transitions', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const created = await app.inject({ method: 'POST', url: '/cases', payload: {} });
  const c = created.json();

  // No claim: status can change without claimant
  const ok = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}/status`,
    payload: { status: 'HOLD_REQUESTED' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, 'HOLD_REQUESTED');

  // Claim then enforce claimant
  await app.inject({ method: 'POST', url: `/cases/${c.caseId}/claim`, payload: { claimant: 'rescue-A', ttlMs: 60_000 } });

  const denied = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}/status`,
    payload: { status: 'RESCUE_TAGGED' },
  });
  assert.equal(denied.statusCode, 409);

  const ok2 = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}/status`,
    payload: { status: 'RESCUE_TAGGED', claimant: 'rescue-A' },
  });
  assert.equal(ok2.statusCode, 200);
  assert.equal(ok2.json().status, 'RESCUE_TAGGED');

  const bad = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}/status`,
    payload: { status: 'NOPE' },
  });
  assert.equal(bad.statusCode, 400);

  await app.close();
});
