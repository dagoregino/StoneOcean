// Local API over the same rules engine the dashboard uses.
//
//   node server/index.mjs [port] [database file]
//
// The TypeScript engine is loaded through Vite, so there is one implementation of the
// rules, not two. Alerts, interventions and their verification are also written to the
// SQLite database when it exists (build it with `npm run db:build`); the run-time tables
// start empty on every launch. This is a prototype for local use: no authentication.
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createServer as createViteServer } from 'vite';

const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);
const dbFile = process.argv[3] ?? 'data/crew-health.db';

const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { MissionRuntime, CREW_ID } = await vite.ssrLoadModule('/src/api/runtime.ts');
const { handle } = await vite.ssrLoadModule('/src/api/handlers.ts');
const runtime = new MissionRuntime();

// ---------- persistence ----------
const db = existsSync(dbFile) ? new DatabaseSync(dbFile) : null;
const alertRow = new Map(); // indicator id -> row id of its open alert
const interventionRow = new Map(); // intervention id -> row id
if (db) {
  db.exec('PRAGMA foreign_keys = ON; DELETE FROM verifications; DELETE FROM interventions; DELETE FROM alerts; DELETE FROM measurements;');
}

function persist() {
  if (!db) return;
  const now = runtime.store.missionTime;
  const current = handle(runtime, { method: 'GET', path: '/alerts' }).body.alerts;
  const open = new Set(current.map((a) => a.indicatorId));
  for (const a of current) {
    if (alertRow.has(a.indicatorId)) continue;
    // provenance_class and source_id are NOT NULL in the schema: an alert without them cannot be stored.
    const row = db
      .prepare('INSERT INTO alerts (crew_id, rule_id, indicator_id, status, detect_kind, provenance_class, source_id, value, detail, raised_at_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(CREW_ID, a.ruleId, a.indicatorId, a.status, a.thresholdBasis, a.provenance_class, a.source.id, a.value, a.basisLabel, now);
    alertRow.set(a.indicatorId, Number(row.lastInsertRowid));
  }
  for (const [indicatorId, rowId] of alertRow) {
    if (open.has(indicatorId)) continue;
    db.prepare('UPDATE alerts SET closed_at_min = ? WHERE id = ?').run(now, rowId);
    alertRow.delete(indicatorId);
  }
  for (const i of runtime.store.interventions) {
    if (!interventionRow.has(i.id)) {
      // An intervention is always tied to the alert that prompted it.
      const alertId = alertRow.get(i.indicatorId) ?? db.prepare('SELECT id FROM alerts WHERE indicator_id = ? ORDER BY id DESC LIMIT 1').get(i.indicatorId)?.id;
      if (alertId === undefined) continue;
      const row = db
        .prepare('INSERT INTO interventions (alert_id, rule_id, step_text, authority_level, preauthorized, started_at_min) VALUES (?, ?, ?, ?, ?, ?)')
        .run(alertId, i.ruleId, i.stepText, i.authorityLevel, i.authorityLevel === 3 ? 1 : 0, i.startedAt);
      const rowId = Number(row.lastInsertRowid);
      interventionRow.set(i.id, rowId);
      db.prepare("INSERT INTO verifications (intervention_id, metric, value_before, outcome) VALUES (?, ?, ?, 'pending')").run(rowId, i.indicatorId, i.valueBefore);
    }
    if (i.outcome !== 'pending') {
      db.prepare('UPDATE verifications SET outcome = ?, value_after = ?, checked_at_min = ? WHERE intervention_id = ?').run(i.outcome, i.valueAfter, i.checkedAt, interventionRow.get(i.id));
    }
  }
}

// ---------- http ----------
const readBody = (request) =>
  new Promise((resolve, reject) => {
    let text = '';
    request.on('data', (chunk) => {
      text += chunk;
      if (text.length > 100_000) reject(new Error('body too large'));
    });
    request.on('end', () => {
      if (text.trim() === '') return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('body is not valid JSON'));
      }
    });
    request.on('error', reject);
  });

const server = createHttpServer(async (request, response) => {
  const send = (status, body) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    response.end(JSON.stringify(body, null, 2));
  };
  if (request.method === 'OPTIONS') return send(204, {});
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const body = request.method === 'GET' ? undefined : await readBody(request);
    const result = handle(runtime, { method: request.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    if (request.method !== 'GET' && result.status < 400) {
      if (url.pathname.startsWith('/measurements') && db) {
        const r = result.body.reading;
        db.prepare('INSERT INTO measurements (crew_id, indicator_id, value, t_mission_min, source) VALUES (?, ?, ?, ?, ?)').run(CREW_ID, r.indicatorId, r.value, r.t, r.source);
      }
      persist();
    }
    send(result.status, result.body);
  } catch (error) {
    send(400, { error: String(error?.message ?? error) });
  }
});

persist();
server.listen(port, '127.0.0.1', () => {
  console.log(`Crew health API on http://localhost:${port}  (crew member: ${CREW_ID}; database: ${db ? dbFile : 'none, run npm run db:build'})`);
  console.log('Try: GET /rules   GET /evidence?rule=R-CO2   GET /state/crew-1   GET /radiation/now   GET /alerts   GET /verify');
});

const shutdown = async () => {
  server.close();
  db?.close();
  await vite.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
