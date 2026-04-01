// Minimal reference client:
// - Catch up via HTTP /events?afterSeq=
// - Subscribe via websocket /ws
// - Maintain an in-memory case map

import WebSocket from 'ws';
import fs from 'node:fs';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:3999';
const wsKind = process.env.WS_KIND ? String(process.env.WS_KIND).trim() : null;
const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws${wsKind ? `?kind=${encodeURIComponent(wsKind)}` : ''}`;

let lastSeq = Number(process.env.AFTER_SEQ ?? 0);
const cases = new Map();
const commitments = new Map();

const silentEvents = process.env.SILENT_EVENTS === '1' || process.env.SILENT_EVENTS === 'true';
const silentSummaries = process.env.SILENT_SUMMARIES === '1' || process.env.SILENT_SUMMARIES === 'true';

const stateFile = process.env.STATE_FILE ? String(process.env.STATE_FILE) : null;
if (stateFile) {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const st = JSON.parse(raw);
    if (typeof st.lastSeq === 'number') lastSeq = Math.max(lastSeq, st.lastSeq);
  } catch {
    // ignore
  }
}

function persistState() {
  if (!stateFile) return;
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ lastSeq }, null, 2));
  } catch {
    // ignore
  }
}

const stateFlushMs = Math.max(0, Math.floor(Number(process.env.STATE_FLUSH_MS ?? 1000) || 1000));
let pendingFlush = false;
function schedulePersist() {
  if (!stateFile) return;
  if (stateFlushMs === 0) {
    persistState();
    return;
  }
  if (pendingFlush) return;
  pendingFlush = true;
  setTimeout(() => {
    pendingFlush = false;
    persistState();
  }, stateFlushMs).unref();
}

function flushAndExit(code = 0) {
  try {
    persistState();
  } finally {
    process.exit(code);
  }
}

process.on('SIGINT', () => flushAndExit(0));
process.on('SIGTERM', () => flushAndExit(0));

if (stateFile && stateFlushMs === 0) {
  console.warn('warning: STATE_FLUSH_MS=0 will write STATE_FILE on every event (may be heavy under bursty traffic)');
}

if (dashboardEveryMs > 0 && dashboardEveryMs < 5000) {
  console.warn('warning: DASHBOARD_EVERY_SEC is very low; may spam logs under bursty traffic');
}

const requiredTypes = String(process.env.REQUIRED_TYPES ?? 'RESCUE_PULL,TRANSPORT,FOSTER')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const urgencyHours = Number(process.env.URGENCY_HOURS ?? 2);
const urgencyMs = Number.isFinite(urgencyHours) && urgencyHours > 0 ? urgencyHours * 60 * 60 * 1000 : 0;

const dashboardEverySec = Number(process.env.DASHBOARD_EVERY_SEC ?? 30);
const dashboardEveryMs =
  Number.isFinite(dashboardEverySec) && dashboardEverySec > 0 ? Math.floor(dashboardEverySec * 1000) : 0;
const dashboardTopN = Math.max(1, Math.floor(Number(process.env.DASHBOARD_TOP_N ?? 5) || 5));

const dashboardState = process.env.DASHBOARD_STATE ? String(process.env.DASHBOARD_STATE).trim().toUpperCase() : null;
const dashboardRisk = process.env.DASHBOARD_RISK ? String(process.env.DASHBOARD_RISK).trim().toUpperCase() : null;
const dashboardStatusSet = process.env.DASHBOARD_STATUS
  ? new Set(
      String(process.env.DASHBOARD_STATUS)
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    )
  : null;

function getCaseMetrics(caseId) {
  const c = cases.get(caseId);
  if (!c) return null;

  if (dashboardState) {
    const st = c.location?.state ? String(c.location.state).trim().toUpperCase() : null;
    if (st !== dashboardState) return null;
  }
  if (dashboardRisk) {
    const rl = c.riskLevel ? String(c.riskLevel).trim().toUpperCase() : null;
    if (rl !== dashboardRisk) return null;
  }
  if (dashboardStatusSet) {
    const st = c.status ? String(c.status).trim().toUpperCase() : null;
    if (!dashboardStatusSet.has(st)) return null;
  }

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

  const needs = [];
  for (const t of requiredTypes) {
    const totalForType = byType.get(t) ?? 0;
    const confirmedForType = byTypeStatus.get(`${t}:CONFIRMED`) ?? 0;
    if (totalForType === 0) needs.push(`NEEDS_${t}`);
    else if (confirmedForType === 0) needs.push(`NEEDS_${t}_CONFIRMED`);
  }

  let deadlineDeltaMs = null;
  if (c.deadlineAt) {
    const t = new Date(c.deadlineAt).getTime();
    if (!Number.isNaN(t)) deadlineDeltaMs = t - Date.now();
  }

  return { c, count, byType, byTypeStatus, needs, deadlineDeltaMs };
}

function summarizeCase(caseId) {
  const m = getCaseMetrics(caseId);
  if (!m) return null;
  const { c, count, byType, byTypeStatus, needs, deadlineDeltaMs } = m;
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

  const needsPart = needs.length ? ` needs=[${needs.join(',')}]` : '';

  let urgencyPart = '';
  if (urgencyMs > 0 && deadlineDeltaMs != null) {
    if (deadlineDeltaMs <= urgencyMs) urgencyPart = ' urgency=DUE_SOON';
    if (deadlineDeltaMs <= 0) urgencyPart = ' urgency=OVERDUE';
  }

  return `case ${caseId}${status}${risk}${deadline}${urgencyPart} commitments=${count}${breakdown}${breakdown2}${needsPart}`;
}

function applyEvent(e) {
  if (!e || typeof e !== 'object') return;
  if (typeof e.seq === 'number') {
    const prev = lastSeq;
    lastSeq = Math.max(lastSeq, e.seq);
    if (lastSeq !== prev) schedulePersist();
  }

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

  if (dashboardEveryMs > 0) {
    setInterval(() => {
      const rows = [];
      for (const caseId of cases.keys()) {
        const m = getCaseMetrics(caseId);
        if (!m) continue;
        if (!m.needs.length) continue;
        // Sort: overdue/soonest deadlines first; null deadlines last.
        const sortKey = m.deadlineDeltaMs == null ? Number.POSITIVE_INFINITY : m.deadlineDeltaMs;
        rows.push({ caseId, sortKey });
      }
      rows.sort((a, b) => a.sortKey - b.sortKey);
      const top = rows.slice(0, dashboardTopN);
      if (!top.length) return;
      console.log(`\n=== dashboard (top ${dashboardTopN} unmet needs) ===`);
      for (const r of top) {
        const line = summarizeCase(r.caseId);
        if (line) console.log(line);
      }
    }, dashboardEveryMs).unref();
  }

  const ws = new WebSocket(wsUrl);
  ws.on('open', () => console.log(`ws connected: ${wsUrl}`));
  ws.on('message', async (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'event') {
        applyEvent(msg.event);

        if (!silentEvents) {
          console.log(
            `event kind=${msg.event.kind} seq=${msg.event.seq} cases=${cases.size} commitments=${commitments.size}`,
          );
        }

        if (msg.event.kind === 'CASE_CREATED' || msg.event.kind === 'CASE_UPDATED') {
          if (!silentSummaries) {
            const line = summarizeCase(msg.event.caseId);
            if (line) console.log(line);
          }
        }

        if (msg.event.kind === 'COMMITMENT_CREATED' || msg.event.kind === 'COMMITMENT_UPDATED') {
          if (!silentSummaries) {
            const line = summarizeCase(msg.event.caseId);
            if (line) console.log(line);
          }
        }

        if (msg.event.kind === 'STATUS_CHANGED') {
          const { from, to, by } = msg.event.payload ?? {};
          if (!silentEvents) {
            console.log(`status changed caseId=${msg.event.caseId} ${from} -> ${to} by=${by ?? 'n/a'}`);
          }
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
