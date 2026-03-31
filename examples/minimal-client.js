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
