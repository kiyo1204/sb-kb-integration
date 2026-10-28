import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import express from "express";
import { Pool } from "pg";
import { accessControl, tokenHash } from "../access-control.js";
import { insertResearchEvent, registerResearchEventRoutes } from "../research-events.js";

// An isolated temporary schema, never the application's tables or existing rows.
const schema = `event_check_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public` });
const researcher = process.env.RESEARCHER_API_TOKEN!;
const learner = `learner_${randomUUID().replaceAll("-", "")}`;
const session = randomUUID(), other = randomUUID(), stage = randomUUID(), map = randomUUID(), concept = randomUUID();
let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await scoped.query(`CREATE TABLE sessions(id uuid PRIMARY KEY, protocol_key text, participant_code text, study_group text, status text, group_activity_seconds integer, learner_access_token_hash text, research_kit_definition_id uuid);
    CREATE TABLE session_stages(id uuid PRIMARY KEY, session_id uuid REFERENCES sessions(id), stage_type text, status text, started_at timestamptz, order_index integer);
    CREATE TABLE maps(id uuid PRIMARY KEY, session_stage_id uuid REFERENCES session_stages(id), type text, status text);`);
  const migrationPath = pathToFileURL(resolve("migrations/1790890000000_create_research_events.js")).href;
  const migration = await import(migrationPath) as { up: (pgm: { sql: (sql: string) => void }) => void };
  let sql = ""; migration.up({ sql: value => { sql = value; } }); await scoped.query(sql);
  await scoped.query(`INSERT INTO sessions VALUES($1,'STAGE1_6','participant-test','CONTROL','IN_PROGRESS',3600,$2,$3),($4,'STAGE1_4','other-test',NULL,'IN_PROGRESS',NULL,NULL,$3)`, [session, tokenHash(learner), randomUUID(), other]);
  await scoped.query(`INSERT INTO session_stages VALUES($1,$2,'PRIOR_MAP','IN_PROGRESS',now(),0)`, [stage, session]);
  await scoped.query(`INSERT INTO maps VALUES($1,$2,'PRIOR','DRAFT')`, [map, stage]);
  const app = express(); app.use(express.json()); app.use("/api", accessControl(scoped)); registerResearchEventRoutes(app, scoped);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolveReady => server!.once("listening", resolveReady));
  const addr = server.address(); assert.ok(addr && typeof addr !== "string");
  const port = addr.port;
  async function call(path: string, token: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  const base = { schemaVersion: 1, eventType: "MOVE_CONCEPT", targetType: "CONCEPT", mapId: map, targetId: concept, outcome: "SUCCESS", clientTimeQuality: "MISSING", before: { positionX: 1 }, after: { positionX: 2 }, details: { durationMs: 100 } };
  assert.equal((await call(`/sessions/${other}/events`, learner, base)).status, 404);
  assert.equal((await call(`/research/sessions/${session}/events`, learner)).status, 403);
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...base, details: { token: "secret" } })).status, 400);
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...base, before: { label: "secret" } })).status, 400);
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...base, actorType: "SYSTEM" })).status, 400);
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...base, clientTimeQuality: "OBSERVED" })).status, 400);
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...base, stageId: randomUUID() })).status, 404);
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...base, mapId: randomUUID() })).status, 404);
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...base, relatedEventId: randomUUID() })).status, 404);
  await scoped.query("UPDATE sessions SET participant_code=$2 WHERE id=$1", [session, researcher]);
  assert.equal((await call(`/sessions/${session}/events`, learner, base)).status, 404);
  await scoped.query("UPDATE sessions SET participant_code=$2 WHERE id=$1", [session, learner]);
  assert.equal((await call(`/sessions/${session}/events`, learner, base)).status, 404);
  await scoped.query("UPDATE sessions SET participant_code='participant-test' WHERE id=$1", [session]);
  const saved = await Promise.all(Array.from({ length: 20 }, () => call(`/sessions/${session}/events`, learner, base)));
  assert.ok(saved.every(result => result.status === 201 && result.body.logSaved === true));
  assert.deepEqual(saved.map(result => Number(result.body.sequenceNumber)).sort((a,b) => a-b), Array.from({ length: 20 }, (_,i) => i+1));
  const research = await call(`/sessions/${session}/events`, researcher, { schemaVersion: 1, eventType: "RESEARCH_ANALYSIS_VIEW", targetType: "SESSION", outcome: "SUCCESS", clientTimeQuality: "NOT_APPLICABLE" });
  assert.equal(research.status, 201);
  const rejected = await call(`/sessions/${session}/events`, researcher, { ...base, outcome: "REJECTED", reasonCode: "VALIDATION", relatedEventId: saved[0]!.body.eventId });
  assert.equal(rejected.status, 201);
  const tx = await scoped.connect();
  try { await tx.query("BEGIN"); await insertResearchEvent(tx, session, "SYSTEM", { eventType: "STAGE_START", targetType: "STAGE", stageId: stage, outcome: "SUCCESS", clientTimeQuality: "NOT_APPLICABLE" }); await tx.query("COMMIT"); } finally { tx.release(); }
  const result = await call(`/research/sessions/${session}/events`, researcher);
  assert.equal(result.status, 200);
  const events = result.body.events as Array<Record<string, unknown>>;
  assert.equal(events.length, 23); assert.equal(events[0]!.actorType, "LEARNER"); assert.equal(events[20]!.actorType, "RESEARCHER"); assert.equal(events[21]!.outcome, "REJECTED"); assert.equal(events[22]!.actorType, "SYSTEM");
  assert.equal(events[0]!.participantCode, "participant-test"); assert.equal(events[0]!.activity, "PRIOR_MAP"); assert.equal(events[0]!.studyGroup, "CONTROL");
  assert.deepEqual(events[0]!.details, { durationMs: 100 });
  assert.equal(events[0]!.beforeQuality, "OBSERVED"); assert.equal(events[20]!.beforeQuality, "MISSING");
  assert.equal((await call(`/research/sessions/${session}/events?after=20`, researcher)).status, 200);
  console.log("Research event schema, access control, ordering and persistence: OK");
} finally {
  if (server) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()));
  await scoped.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
