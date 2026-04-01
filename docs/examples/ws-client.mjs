// Minimal realtime client example for Animal Hub (Node 20+)
//
// Usage:
//   HUB_URL=http://localhost:3999 node docs/examples/ws-client.mjs
//
// Behavior:
// 1) Catch up via HTTP /events?afterSeq=<lastSeq>
// 2) Connect to /ws for live events
// 3) On disconnect, repeat catch-up and reconnect

import { setTimeout as sleep } from 'node:timers/promises';

const HUB_URL = process.env.HUB_URL ?? 'http://localhost:3999';
const POLL_LIMIT = Number(process.env.POLL_LIMIT ?? 200);

function toWsUrl(httpUrl) {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u;
}

async function fetchJson(path) {
  const res = await fetch(new URL(path, HUB_URL));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${path}: ${text}`);
  }
  return res.json();
}

async function catchUp({ lastSeq }) {
  let seq = lastSeq;
  for (;;) {
    const data = await fetchJson(`/events?afterSeq=${encodeURIComponent(seq)}&limit=${encodeURIComponent(POLL_LIMIT)}`);
    for (const ev of data.items) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ type: 'event', ev }));
    }
    const nextSeq = data.nextAfterSeq ?? seq;
    if (nextSeq === seq) break;
    seq = nextSeq;

    // If server provides a next URL, you can follow it instead of rebuilding.
    // (We keep it explicit here for readability.)
  }
  return seq;
}

async function run() {
  let lastSeq = 0;

  for (;;) {
    try {
      lastSeq = await catchUp({ lastSeq });

      const wsUrl = toWsUrl(HUB_URL);
      wsUrl.pathname = '/ws';

      // Node 20+ provides a global WebSocket implementation.
      const ws = new WebSocket(wsUrl.toString());

      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });

      // eslint-disable-next-line no-console
      console.error(`connected ${wsUrl}`);

      await new Promise((resolve) => {
        ws.addEventListener('message', (msg) => {
          try {
            const data = JSON.parse(String(msg.data));
            if (data?.type === 'event' && data?.event?.seq != null) {
              lastSeq = Math.max(lastSeq, Number(data.event.seq));
            }
          } catch {
            // ignore
          }
          // eslint-disable-next-line no-console
          console.log(String(msg.data));
        });

        ws.addEventListener('close', resolve, { once: true });
      });

      // eslint-disable-next-line no-console
      console.error('disconnected; will reconnect');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('client error:', err);
    }

    await sleep(1000);
  }
}

run();
