// Minimal reference client:
// - Catch up via HTTP /events?afterSeq=
// - Subscribe via websocket /ws
// - Maintain an in-memory case map

import WebSocket from 'ws';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:3999';
const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';

let lastSeq = Number(process.env.AFTER_SEQ ?? 0);
const cases = new Map();
const commitments = new Map();

function summarizeCase(caseId) {
  const c = cases.get(caseId);
  if (!c) return null;

  const byType = new Map();
  const byTypeStatus = new Map();
  let count = 0;
  for (const com of commitments.values()) {
    if (com.caseId !== caseId) continue;
    count++;
    const t = com.type ?? 'UNKNOWN';
    const s = com.status ?? 'UNKNOWN';
    byType.set(t, (byType.get(t) ?? 0) + 1);
    const key = `${t}:${s}`;
    byTypeStatus.set(key, (byTypeStatus.get(key) ?? 0) + 1);
  }

  const deadline = c.deadlineAt ? ` deadline=${c.deadlineAt}` : '';
  const risk = c.riskLevel ? ` risk=${c.riskLevel}` : '';
  const status = c.status ? ` status=${c.status}` : '';

  const typeParts = Array.from(byType.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, n]) => `${t}=${n}`)
    .join(',');

  const typeStatusParts = Array.from(byTypeStatus.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}=${n}`)
    .join(',');

  const breakdown = typeParts ? ` types=[${typeParts}]` : '';
  const breakdown2 = typeStatusParts ? ` typeStatus=[${typeStatusParts}]` : '';

  // Simple "needs" heuristic for coordination.
  // (Kept intentionally dumb for MVP: missing type, or no CONFIRMED for that type.)
  const needs = [];
  for (const t of ['RESCUE_PULL', 'TRANSPORT', 'FOSTER']) {
    const totalForType = byType.get(t) ?? 0;
    const confirmedForType = byTypeStatus.get(`${t}:CONFIRMED`) ?? 0;
    if (totalForType === 0) needs.push(`NEEDS_${t}`);
    else if (confirmedForType === 0) needs.push(`NEEDS_${t}_CONFIRMED`);
  }
  const needsPart = needs.length ? ` needs=[${needs.join(',')}]` : '';

  return `case ${caseId}${status}${risk}${deadline} commitments=${count}${breakdown}${breakdown2}${needsPart}`;
}

function applyEvent(e) {
  if (!e || typeof e !== 'object') return;
  if (typeof e.seq === 'number') lastSeq = Math.max(lastSeq, e.seq);

  if (e.kind === 'CASE_CREATED' || e.kind === 'CASE_UPDATED') {
    const rec = e.payload;
    if (rec?.caseId) cases.set(rec.caseId, rec);
  }

  if (e.kind === 'COMMITMENT_CREATED' || e.kind === 'COMMITMENT_UPDATED') {
    const rec = e.payload;
    if (rec?.commitId) commitments.set(rec.commitId, rec);
  }
}

async function catchUp() {
  const url = `${baseUrl}/events?afterSeq=${encodeURIComponent(String(lastSeq))}&limit=200`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`catchUp failed: ${res.status}`);
  const body = await res.json();
  for (const e of body.items ?? []) applyEvent(e);
}

async function main() {
  await catchUp();
  console.log(`caught up: lastSeq=${lastSeq} cases=${cases.size} commitments=${commitments.size}`);

  const ws = new WebSocket(wsUrl);
  ws.on('open', () => console.log(`ws connected: ${wsUrl}`));
  ws.on('message', async (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'event') {
        applyEvent(msg.event);
        console.log(
          `event kind=${msg.event.kind} seq=${msg.event.seq} cases=${cases.size} commitments=${commitments.size}`,
        );

        if (msg.event.kind === 'CASE_CREATED' || msg.event.kind === 'CASE_UPDATED') {
          const line = summarizeCase(msg.event.caseId);
          if (line) console.log(line);
        }

        if (msg.event.kind === 'COMMITMENT_CREATED' || msg.event.kind === 'COMMITMENT_UPDATED') {
          const line = summarizeCase(msg.event.caseId);
          if (line) console.log(line);
        }

        if (msg.event.kind === 'STATUS_CHANGED') {
          const { from, to, by } = msg.event.payload ?? {};
          console.log(`status changed caseId=${msg.event.caseId} ${from} -> ${to} by=${by ?? 'n/a'}`);
        }
      }
    } catch {
      // ignore parse errors
    }
  });
  ws.on('close', async () => {
    console.log('ws closed; catching up once');
    try {
      await catchUp();
      console.log(`caught up: lastSeq=${lastSeq} cases=${cases.size} commitments=${commitments.size}`);
    } catch (e) {
      console.error(e);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
