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

test('GET /cases supports offset/limit pagination', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  for (let i = 0; i < 5; i++) {
    await app.inject({ method: 'POST', url: '/cases', payload: { name: `c${i}` } });
  }

  const page1 = await app.inject({ method: 'GET', url: '/cases?limit=2&offset=0' });
  assert.equal(page1.statusCode, 200);
  const b1 = page1.json();
  assert.equal(b1.items.length, 2);
  assert.ok(b1.total >= 5);

  const page2 = await app.inject({ method: 'GET', url: '/cases?limit=2&offset=2' });
  assert.equal(page2.statusCode, 200);
  assert.equal(page2.json().items.length, 2);

  const badLimit = await app.inject({ method: 'GET', url: '/cases?limit=0' });
  assert.equal(badLimit.statusCode, 400);

  const badOffset = await app.inject({ method: 'GET', url: '/cases?offset=-1' });
  assert.equal(badOffset.statusCode, 400);

  await app.close();
});

test('GET /cases supports ETag / 304 Not Modified for list responses', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  await app.inject({ method: 'POST', url: '/cases', payload: { name: 'a' } });
  await app.inject({ method: 'POST', url: '/cases', payload: { name: 'b' } });

  const first = await app.inject({ method: 'GET', url: '/cases?limit=10&offset=0&sort=createdAt:asc' });
  assert.equal(first.statusCode, 200);
  assert.ok(first.headers.etag);

  const notModified = await app.inject({
    method: 'GET',
    url: '/cases?limit=10&offset=0&sort=createdAt:asc',
    headers: { 'if-none-match': first.headers.etag },
  });
  assert.equal(notModified.statusCode, 304);

  await app.close();
});

test('GET /cases/:id supports ETag / 304 Not Modified', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const created = await app.inject({ method: 'POST', url: '/cases', payload: { name: 'etaggable' } });
  assert.equal(created.statusCode, 201);
  const c = created.json();

  const first = await app.inject({ method: 'GET', url: `/cases/${c.caseId}` });
  assert.equal(first.statusCode, 200);
  assert.ok(first.headers.etag);

  const etag = first.headers.etag;
  const notModified = await app.inject({
    method: 'GET',
    url: `/cases/${c.caseId}`,
    headers: { 'if-none-match': etag },
  });
  assert.equal(notModified.statusCode, 304);

  await app.close();
});

test('GET /cases/:id supports include=commitments', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c = (await app.inject({ method: 'POST', url: '/cases', payload: { name: 'inc' } })).json();
  await app.inject({ method: 'POST', url: `/cases/${c.caseId}/commitments`, payload: { type: 'FOSTER' } });

  const res = await app.inject({ method: 'GET', url: `/cases/${c.caseId}?include=commitments` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.case);
  assert.ok(Array.isArray(body.commitments));
  assert.equal(body.case.caseId, c.caseId);
  assert.equal(body.commitments.length, 1);

  // unknown include rejected
  const bad = await app.inject({ method: 'GET', url: `/cases/${c.caseId}?include=nope` });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'bad_query_include');

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

test('GET /cases supports sort=deadlineAt:asc (null deadlines last)', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const t1 = new Date(Date.now() + 60_000).toISOString();
  const t2 = new Date(Date.now() + 120_000).toISOString();

  const a = (await app.inject({ method: 'POST', url: '/cases', payload: { name: 'a', deadlineAt: t2 } })).json();
  const b = (await app.inject({ method: 'POST', url: '/cases', payload: { name: 'b', deadlineAt: t1 } })).json();
  const c = (await app.inject({ method: 'POST', url: '/cases', payload: { name: 'c' } })).json();

  const res = await app.inject({ method: 'GET', url: '/cases?sort=deadlineAt:asc' });
  assert.equal(res.statusCode, 200);
  const items = res.json().items;

  const idxA = items.findIndex((x) => x.caseId === a.caseId);
  const idxB = items.findIndex((x) => x.caseId === b.caseId);
  const idxC = items.findIndex((x) => x.caseId === c.caseId);

  assert.ok(idxB !== -1 && idxA !== -1 && idxC !== -1);
  assert.ok(idxB < idxA);
  assert.ok(idxC > idxA);

  await app.close();
});

test('GET /cases supports sort=risk:desc (CODE_RED first)', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const low = (await app.inject({ method: 'POST', url: '/cases', payload: { riskLevel: 'LOW' } })).json();
  const cr = (await app.inject({ method: 'POST', url: '/cases', payload: { riskLevel: 'CODE_RED' } })).json();

  const res = await app.inject({ method: 'GET', url: '/cases?sort=risk:desc' });
  assert.equal(res.statusCode, 200);
  const items = res.json().items;
  const idxLow = items.findIndex((x) => x.caseId === low.caseId);
  const idxCr = items.findIndex((x) => x.caseId === cr.caseId);
  assert.ok(idxCr !== -1 && idxLow !== -1);
  assert.ok(idxCr < idxLow);

  await app.close();
});

test('GET /cases supports q= free-text filtering (case-insensitive)', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const a = (
    await app.inject({
      method: 'POST',
      url: '/cases',
      payload: { name: 'Buddy', externalIds: ['A#123'], shelter: { name: 'Travis County' }, notes: 'Very sweet' },
    })
  ).json();
  await app.inject({ method: 'POST', url: '/cases', payload: { name: 'Other' } });

  const res1 = await app.inject({ method: 'GET', url: '/cases?q=bud' });
  assert.equal(res1.statusCode, 200);
  assert.ok(res1.json().items.some((x) => x.caseId === a.caseId));

  const res2 = await app.inject({ method: 'GET', url: '/cases?q=travis' });
  assert.equal(res2.statusCode, 200);
  assert.ok(res2.json().items.some((x) => x.caseId === a.caseId));

  const res3 = await app.inject({ method: 'GET', url: '/cases?q=a%23123' });
  assert.equal(res3.statusCode, 200);
  assert.ok(res3.json().items.some((x) => x.caseId === a.caseId));

  const res4 = await app.inject({ method: 'GET', url: '/cases?q=notfound' });
  assert.equal(res4.statusCode, 200);
  assert.equal(res4.json().items.length, 0);

  await app.close();
});

test('GET /cases rejects unknown sort value', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const res = await app.inject({ method: 'GET', url: '/cases?sort=nope' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'bad_query_sort');

  await app.close();
});

test('GET /meta/event-kinds returns supported kinds', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const res = await app.inject({ method: 'GET', url: '/meta/event-kinds' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.includes('STATUS_CHANGED'));
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'version'));
  assert.ok(res.headers.etag);

  const etag = res.headers.etag;
  const notModified = await app.inject({ method: 'GET', url: '/meta/event-kinds', headers: { 'if-none-match': etag } });
  assert.equal(notModified.statusCode, 304);

  await app.close();
});

test('GET /meta/enums returns enum lists for clients', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const res = await app.inject({ method: 'GET', url: '/meta/enums' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.enums);
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'version'));
  assert.ok(res.headers.etag);

  const etag = res.headers.etag;
  const notModified = await app.inject({ method: 'GET', url: '/meta/enums', headers: { 'if-none-match': etag } });
  assert.equal(notModified.statusCode, 304);
  assert.ok(Array.isArray(body.enums.caseStatus));
  assert.ok(body.enums.riskLevel.includes('CODE_RED'));
  assert.ok(body.enums.commitmentType.includes('TRANSPORT'));
  assert.ok(body.enums.eventKind.includes('CASE_CREATED'));

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

test('GET /commitments/:id supports ETag / 304 Not Modified', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();
  const com = (
    await app.inject({
      method: 'POST',
      url: `/cases/${c.caseId}/commitments`,
      payload: { type: 'FOSTER', party: { name: 'Sam' } },
    })
  ).json();

  const first = await app.inject({ method: 'GET', url: `/commitments/${com.commitId}` });
  assert.equal(first.statusCode, 200);
  assert.ok(first.headers.etag);

  const notModified = await app.inject({
    method: 'GET',
    url: `/commitments/${com.commitId}`,
    headers: { 'if-none-match': first.headers.etag },
  });
  assert.equal(notModified.statusCode, 304);

  await app.close();
});

test('GET /cases/:id/commitments supports ETag / 304 Not Modified', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();
  await app.inject({ method: 'POST', url: `/cases/${c.caseId}/commitments`, payload: { type: 'FOSTER' } });

  const first = await app.inject({ method: 'GET', url: `/cases/${c.caseId}/commitments` });
  assert.equal(first.statusCode, 200);
  assert.ok(first.headers.etag);

  const notModified = await app.inject({
    method: 'GET',
    url: `/cases/${c.caseId}/commitments`,
    headers: { 'if-none-match': first.headers.etag },
  });
  assert.equal(notModified.statusCode, 304);

  await app.close();
});

test('GET /cases/:id/commitments supports offset/limit pagination', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const created = await app.inject({ method: 'POST', url: '/cases', payload: {} });
  const c = created.json();

  for (let i = 0; i < 5; i++) {
    await app.inject({ method: 'POST', url: `/cases/${c.caseId}/commitments`, payload: { type: 'FOSTER' } });
  }

  const page1 = await app.inject({ method: 'GET', url: `/cases/${c.caseId}/commitments?limit=2&offset=0` });
  assert.equal(page1.statusCode, 200);
  const b1 = page1.json();
  assert.equal(b1.items.length, 2);
  assert.equal(b1.total, 5);

  const page2 = await app.inject({ method: 'GET', url: `/cases/${c.caseId}/commitments?limit=2&offset=2` });
  assert.equal(page2.statusCode, 200);
  assert.equal(page2.json().items.length, 2);

  const badLimit = await app.inject({ method: 'GET', url: `/cases/${c.caseId}/commitments?limit=0` });
  assert.equal(badLimit.statusCode, 400);

  const badOffset = await app.inject({ method: 'GET', url: `/cases/${c.caseId}/commitments?offset=-1` });
  assert.equal(badOffset.statusCode, 400);

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
  assert.equal(ev.headers['cache-control'], 'no-store');
  const body = ev.json();
  assert.ok(body.next);

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
  assert.equal(all.headers['cache-control'], 'no-store');
  const a = all.json();
  assert.ok(a.items.length >= 4);
  assert.ok(a.next);

  const onlyC1 = await app.inject({ method: 'GET', url: `/events?limit=50&afterSeq=0&caseId=${c1.caseId}` });
  assert.equal(onlyC1.statusCode, 200);
  const b = onlyC1.json();
  assert.ok(b.items.length >= 2);
  assert.ok(b.items.every((e) => e.caseId === c1.caseId));

  await app.close();
});

test('GET /events supports kind filtering (csv) and validates kinds', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();
  await app.inject({ method: 'POST', url: `/cases/${c.caseId}/claim`, payload: { claimant: 'rescue-A', ttlMs: 60_000 } });
  await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}/status`,
    payload: { status: 'RESCUE_TAGGED', claimant: 'rescue-A' },
  });

  const onlyStatus = await app.inject({ method: 'GET', url: '/events?afterSeq=0&kind=STATUS_CHANGED' });
  assert.equal(onlyStatus.statusCode, 200);
  const items = onlyStatus.json().items;
  assert.ok(items.length >= 1);
  assert.ok(items.every((e) => e.kind === 'STATUS_CHANGED'));

  const bad = await app.inject({ method: 'GET', url: '/events?kind=NOPE' });
  assert.equal(bad.statusCode, 400);

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

test('POST /cases/:id/claim and /release support Idempotency-Key (no duplicate events)', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();

  const claim1 = await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/claim`,
    headers: { 'idempotency-key': 'claim-1' },
    payload: { claimant: 'rescue-A', ttlMs: 60_000 },
  });
  assert.equal(claim1.statusCode, 200);

  const claim2 = await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/claim`,
    headers: { 'idempotency-key': 'claim-1' },
    payload: { claimant: 'rescue-A', ttlMs: 60_000 },
  });
  assert.equal(claim2.statusCode, 200);

  const ev1 = await app.inject({ method: 'GET', url: `/events?afterSeq=0&kind=CASE_CLAIMED&caseId=${c.caseId}&limit=50` });
  assert.equal(ev1.statusCode, 200);
  const claimed = ev1.json().items.filter((e) => e.kind === 'CASE_CLAIMED' && e.caseId === c.caseId);
  assert.equal(claimed.length, 1);

  const rel1 = await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/release`,
    headers: { 'idempotency-key': 'release-1' },
    payload: { claimant: 'rescue-A' },
  });
  assert.equal(rel1.statusCode, 200);

  const rel2 = await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/release`,
    headers: { 'idempotency-key': 'release-1' },
    payload: { claimant: 'rescue-A' },
  });
  assert.equal(rel2.statusCode, 200);

  const ev2 = await app.inject({ method: 'GET', url: `/events?afterSeq=0&kind=CASE_RELEASED&caseId=${c.caseId}&limit=50` });
  assert.equal(ev2.statusCode, 200);
  const released = ev2.json().items.filter((e) => e.kind === 'CASE_RELEASED' && e.caseId === c.caseId);
  assert.equal(released.length, 1);

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

test('PATCH /cases/:id validates body (strict keys + enums + date + location.state)', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();

  // strict unknown key
  const extra = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}`,
    payload: { nope: true },
  });
  assert.equal(extra.statusCode, 400);

  // bad enums
  const badRisk = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}`,
    payload: { riskLevel: 'NOPE' },
  });
  assert.equal(badRisk.statusCode, 400);

  const badStatus = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}`,
    payload: { status: 'NOPE' },
  });
  assert.equal(badStatus.statusCode, 400);

  // bad date
  const badDeadline = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}`,
    payload: { deadlineAt: 'not-a-date' },
  });
  assert.equal(badDeadline.statusCode, 400);

  // bad state
  const badState = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}`,
    payload: { location: { state: 'TEX' } },
  });
  assert.equal(badState.statusCode, 400);

  // ok patch
  const ok = await app.inject({
    method: 'PATCH',
    url: `/cases/${c.caseId}`,
    payload: { notes: 'hello', riskLevel: 'MED', location: { state: 'TX' } },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().notes, 'hello');

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

test('POST /cases validates riskLevel/status/deadlineAt/location.state', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const ok = await app.inject({
    method: 'POST',
    url: '/cases',
    payload: {
      riskLevel: 'CODE_RED',
      status: 'OPEN',
      deadlineAt: new Date().toISOString(),
      location: { state: 'TX' },
    },
  });
  assert.equal(ok.statusCode, 201);

  const badRisk = await app.inject({ method: 'POST', url: '/cases', payload: { riskLevel: 'NOPE' } });
  assert.equal(badRisk.statusCode, 400);

  const badStatus = await app.inject({ method: 'POST', url: '/cases', payload: { status: 'NOPE' } });
  assert.equal(badStatus.statusCode, 400);

  const badDeadline = await app.inject({ method: 'POST', url: '/cases', payload: { deadlineAt: 'not-a-date' } });
  assert.equal(badDeadline.statusCode, 400);

  const badState = await app.inject({ method: 'POST', url: '/cases', payload: { location: { state: 'TEX' } } });
  assert.equal(badState.statusCode, 400);

  // strict: unknown keys rejected
  const extra = await app.inject({ method: 'POST', url: '/cases', payload: { nope: true } });
  assert.equal(extra.statusCode, 400);

  await app.close();
});

test('POST /cases supports Idempotency-Key to dedupe retries', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const r1 = await app.inject({
    method: 'POST',
    url: '/cases',
    headers: { 'idempotency-key': 'case-123' },
    payload: { name: 'Retry Me' },
  });
  assert.equal(r1.statusCode, 201);
  const c1 = r1.json();

  const r2 = await app.inject({
    method: 'POST',
    url: '/cases',
    headers: { 'idempotency-key': 'case-123' },
    payload: { name: 'Retry Me (different body ignored for now)' },
  });
  assert.equal(r2.statusCode, 201);
  const c2 = r2.json();
  assert.equal(c2.caseId, c1.caseId);

  // Ensure we did not emit a duplicate CASE_CREATED.
  const ev = await app.inject({ method: 'GET', url: '/events?afterSeq=0&kind=CASE_CREATED&limit=50' });
  assert.equal(ev.statusCode, 200);
  const createdEvents = ev.json().items.filter((e) => e.kind === 'CASE_CREATED' && e.caseId === c1.caseId);
  assert.equal(createdEvents.length, 1);

  await app.close();
});

test('POST /cases/:id/commitments supports Idempotency-Key to dedupe retries', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();

  const r1 = await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/commitments`,
    headers: { 'idempotency-key': 'commit-123' },
    payload: { type: 'TRANSPORT' },
  });
  assert.equal(r1.statusCode, 201);
  const com1 = r1.json();

  const r2 = await app.inject({
    method: 'POST',
    url: `/cases/${c.caseId}/commitments`,
    headers: { 'idempotency-key': 'commit-123' },
    payload: { type: 'TRANSPORT' },
  });
  assert.equal(r2.statusCode, 201);
  const com2 = r2.json();
  assert.equal(com2.commitId, com1.commitId);

  const ev = await app.inject({
    method: 'GET',
    url: `/events?afterSeq=0&kind=COMMITMENT_CREATED&caseId=${encodeURIComponent(c.caseId)}&limit=50`,
  });
  assert.equal(ev.statusCode, 200);
  const createdEvents = ev.json().items.filter((e) => e.kind === 'COMMITMENT_CREATED' && e.payload?.commitId === com1.commitId);
  assert.equal(createdEvents.length, 1);

  await app.close();
});

test('POST /cases/:id/commitments validates enums and rejects extra keys', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const created = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();

  const ok = await app.inject({
    method: 'POST',
    url: `/cases/${created.caseId}/commitments`,
    payload: { type: 'TRANSPORT', status: 'CONFIRMED', party: { name: 'Taylor' } },
  });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().type, 'TRANSPORT');

  const badType = await app.inject({
    method: 'POST',
    url: `/cases/${created.caseId}/commitments`,
    payload: { type: 'NOPE' },
  });
  assert.equal(badType.statusCode, 400);

  const badStatus = await app.inject({
    method: 'POST',
    url: `/cases/${created.caseId}/commitments`,
    payload: { status: 'NOPE' },
  });
  assert.equal(badStatus.statusCode, 400);

  const extra = await app.inject({
    method: 'POST',
    url: `/cases/${created.caseId}/commitments`,
    payload: { type: 'FOSTER', nope: true },
  });
  assert.equal(extra.statusCode, 400);

  await app.close();
});

test('GET /commitments/:id fetches a commitment by id', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();
  const com = (
    await app.inject({
      method: 'POST',
      url: `/cases/${c.caseId}/commitments`,
      payload: { type: 'FOSTER', party: { name: 'Sam' } },
    })
  ).json();

  const fetched = await app.inject({ method: 'GET', url: `/commitments/${com.commitId}` });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().commitId, com.commitId);

  const missing = await app.inject({ method: 'GET', url: '/commitments/nope' });
  assert.equal(missing.statusCode, 404);

  await app.close();
});

test('GET /commitments supports filtering by caseId', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c1 = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();
  const c2 = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();

  await app.inject({ method: 'POST', url: `/cases/${c1.caseId}/commitments`, payload: { type: 'FOSTER' } });
  await app.inject({ method: 'POST', url: `/cases/${c2.caseId}/commitments`, payload: { type: 'TRANSPORT' } });

  const all = await app.inject({ method: 'GET', url: '/commitments' });
  assert.equal(all.statusCode, 200);
  assert.ok(all.json().items.length >= 2);

  const only1 = await app.inject({ method: 'GET', url: `/commitments?caseId=${c1.caseId}` });
  assert.equal(only1.statusCode, 200);
  const items = only1.json().items;
  assert.equal(items.length, 1);
  assert.equal(items[0].caseId, c1.caseId);

  await app.close();
});

test('GET /commitments supports type/status filters (csv) and validates enums', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();
  const c2 = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();

  const a = (
    await app.inject({
      method: 'POST',
      url: `/cases/${c.caseId}/commitments`,
      payload: { type: 'TRANSPORT', status: 'PENDING' },
    })
  ).json();
  const b = (
    await app.inject({
      method: 'POST',
      url: `/cases/${c.caseId}/commitments`,
      payload: { type: 'FOSTER', status: 'CONFIRMED' },
    })
  ).json();
  await app.inject({
    method: 'POST',
    url: `/cases/${c2.caseId}/commitments`,
    payload: { type: 'DONATION', status: 'PENDING' },
  });

  const onlyPending = await app.inject({ method: 'GET', url: '/commitments?status=PENDING' });
  assert.equal(onlyPending.statusCode, 200);
  assert.ok(onlyPending.json().items.every((x) => x.status === 'PENDING'));

  const transportOrFoster = await app.inject({
    method: 'GET',
    url: '/commitments?type=TRANSPORT,FOSTER&status=PENDING,CONFIRMED',
  });
  assert.equal(transportOrFoster.statusCode, 200);
  const items = transportOrFoster.json().items;
  assert.ok(items.some((x) => x.commitId === a.commitId));
  assert.ok(items.some((x) => x.commitId === b.commitId));

  const badType = await app.inject({ method: 'GET', url: '/commitments?type=NOPE' });
  assert.equal(badType.statusCode, 400);

  const badStatus = await app.inject({ method: 'GET', url: '/commitments?status=NOPE' });
  assert.equal(badStatus.statusCode, 400);

  await app.close();
});

test('GET /commitments supports offset/limit pagination', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();
  for (let i = 0; i < 5; i++) {
    await app.inject({ method: 'POST', url: `/cases/${c.caseId}/commitments`, payload: { type: 'FOSTER' } });
  }

  const page1 = await app.inject({ method: 'GET', url: '/commitments?limit=2&offset=0' });
  assert.equal(page1.statusCode, 200);
  const b1 = page1.json();
  assert.equal(b1.items.length, 2);
  assert.ok(b1.total >= 5);

  const page2 = await app.inject({ method: 'GET', url: '/commitments?limit=2&offset=2' });
  assert.equal(page2.statusCode, 200);
  const b2 = page2.json();
  assert.equal(b2.items.length, 2);

  const badLimit = await app.inject({ method: 'GET', url: '/commitments?limit=0' });
  assert.equal(badLimit.statusCode, 400);

  const badOffset = await app.inject({ method: 'GET', url: '/commitments?offset=-1' });
  assert.equal(badOffset.statusCode, 400);

  await app.close();
});

test('GET /commitments supports ETag / 304 Not Modified for list responses', async () => {
  const app = buildApp({ fastify: { logger: false } });
  await app.ready();

  const c = (await app.inject({ method: 'POST', url: '/cases', payload: {} })).json();
  await app.inject({ method: 'POST', url: `/cases/${c.caseId}/commitments`, payload: { type: 'FOSTER' } });
  await app.inject({ method: 'POST', url: `/cases/${c.caseId}/commitments`, payload: { type: 'TRANSPORT' } });

  const first = await app.inject({ method: 'GET', url: '/commitments?limit=10&offset=0' });
  assert.equal(first.statusCode, 200);
  assert.ok(first.headers.etag);

  const notModified = await app.inject({
    method: 'GET',
    url: '/commitments?limit=10&offset=0',
    headers: { 'if-none-match': first.headers.etag },
  });
  assert.equal(notModified.statusCode, 304);

  await app.close();
});
