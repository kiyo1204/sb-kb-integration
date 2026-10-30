import {verifyMockTestUrl} from "./mock-db.js";
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
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
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
    CREATE TABLE maps(id uuid PRIMARY KEY, session_stage_id uuid REFERENCES session_stages(id), type text, status text);
    CREATE TABLE map_operation_logs(id uuid PRIMARY KEY, map_id uuid REFERENCES maps(id), sequence_number bigint NOT NULL, UNIQUE(map_id, sequence_number));`);
  const migrationPath = pathToFileURL(resolve("migrations/1790890000000_create_research_events.js")).href;
  const migration = await import(migrationPath) as { up: (pgm: { sql: (sql: string) => void }) => void };
  let sql = ""; migration.up({ sql: value => { sql = value; } }); await scoped.query(sql);
  const migrationLegacyReference = await import(pathToFileURL(resolve("migrations/1790920000000_add_event_legacy_reference.js")).href) as { up: (pgm: { sql: (sql: string) => void }) => void };
  let referenceSql = ""; migrationLegacyReference.up({ sql: value => { referenceSql = value; } }); await scoped.query(referenceSql);
  await scoped.query("CREATE VIEW research_session_ids AS SELECT id AS session_id, 'P-'||id::text AS pseudonym FROM sessions");
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
  assert.equal((await call(`/sessions/${other}/events`, researcher, base)).status, 404);
  assert.equal((await call(`/research/sessions/${session}/events`, learner)).status, 403);
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...base, details: { token: "secret" } })).status, 400);
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...base, before: { label: "secret" } })).status, 400);
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...base, actorType: "SYSTEM" })).status, 400);
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...base, clientTimeQuality: "OBSERVED" })).status, 400);
  assert.equal((await call(`/sessions/${session}/events`, learner, base)).status, 403);
  assert.equal((await call(`/sessions/${session}/events`, researcher, { ...base, stageId: randomUUID() })).status, 404);
  assert.equal((await call(`/sessions/${session}/events`, researcher, { ...base, mapId: randomUUID() })).status, 404);
  assert.equal((await call(`/sessions/${session}/events`, researcher, { ...base, relatedEventId: randomUUID() })).status, 404);
  await scoped.query("UPDATE sessions SET participant_code=$2 WHERE id=$1", [session, researcher]);
  assert.equal((await call(`/sessions/${session}/events`, researcher, base)).status, 404);
  await scoped.query("UPDATE sessions SET participant_code=$2 WHERE id=$1", [session, learner]);
  assert.equal((await call(`/sessions/${session}/events`, researcher, base)).status, 404);
  await scoped.query("UPDATE sessions SET participant_code='participant-test' WHERE id=$1", [session]);
  const saved = await Promise.all(Array.from({ length: 20 }, () => call(`/sessions/${session}/events`, researcher, base)));
  assert.ok(saved.every(result => result.status === 201 && result.body.logSaved === true));
  assert.deepEqual(saved.map(result => Number(result.body.sequenceNumber)).sort((a,b) => a-b), Array.from({ length: 20 }, (_,i) => i+1));
  const research = await call(`/sessions/${session}/events`, researcher, { schemaVersion: 1, eventType: "SESSION_START", targetType: "SESSION", outcome: "SUCCESS", clientTimeQuality: "NOT_APPLICABLE" });
  assert.equal(research.status, 201);
  const rejected = await call(`/sessions/${session}/events`, researcher, { ...base, outcome: "REJECTED", reasonCode: "VALIDATION", relatedEventId: saved[0]!.body.eventId });
  assert.equal(rejected.status, 201);
  const tx = await scoped.connect();
  try { await tx.query("BEGIN"); await insertResearchEvent(tx, session, "SYSTEM", { eventType: "STAGE_START", targetType: "STAGE", stageId: stage, outcome: "SUCCESS", clientTimeQuality: "NOT_APPLICABLE" }); await tx.query("COMMIT"); } finally { tx.release(); }
  const result = await call(`/research/sessions/${session}/events`, researcher);
  assert.equal(result.status, 200);
  const events = result.body.events as Array<Record<string, unknown>>;
  assert.equal(events.length, 23); assert.equal(events[0]!.actorType, "RESEARCHER"); assert.equal(events[20]!.actorType, "RESEARCHER"); assert.equal(events[21]!.outcome, "REJECTED"); assert.equal(events[22]!.actorType, "SYSTEM");
  assert.equal(events[0]!.participantCode, "P-"+session); assert.equal(events[0]!.activity, "PRIOR_MAP"); assert.equal(events[0]!.studyGroup, "CONTROL");
  assert.deepEqual(events[0]!.details, { durationMs: 100 });
  assert.equal(events[0]!.beforeQuality, "OBSERVED"); assert.equal(events[20]!.beforeQuality, "MISSING");
  assert.equal((await call(`/research/sessions/${session}/events?after=20`, researcher)).status, 200);
  const migrationV2 = await import(pathToFileURL(resolve("migrations/1790900000000_allow_research_event_schema_v2.js")).href) as { up: (pgm: { sql: (sql: string) => void }) => void };
  let sqlV2 = ""; migrationV2.up({ sql: value => { sqlV2 = value; } }); await scoped.query(sqlV2);
  const emptyState = { snapshotVersion: 1 as const, mapId: map, mapType: "PRIOR", basedOnMapId: null, kitDefinitionId: null, concepts: [], links: [] };
  const state = { ...emptyState, concepts: [{ id: concept, mapId: map, label: "概念", positionX: 10, positionY: 20, mergedIntoConceptId: null, provenance: [] }] };
  const v2 = { schemaVersion: 2, eventType: "ADD_CONCEPT", targetType: "CONCEPT", targetId: concept, mapId: map, outcome: "SUCCESS", clientTimeQuality: "MISSING", before: emptyState, after: state };
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...v2, after: { ...state, unknown: 1 } })).status, 400);
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...v2, after: { ...state, concepts: [{ ...state.concepts[0], label: "https://example.com" }] } })).status, 400);
  assert.equal((await call(`/sessions/${session}/events`, learner, { ...v2, after: { ...state, concepts: [{ ...state.concepts[0], label: researcher }] } })).status, 403);
  const secretClient=await scoped.connect();
  try {
    await secretClient.query("BEGIN");
    await assert.rejects(insertResearchEvent(secretClient,session,"SYSTEM",{schemaVersion:2,eventType:"ADD_CONCEPT",targetType:"CONCEPT",targetId:concept,mapId:map,outcome:"SUCCESS",clientTimeQuality:"MISSING",before:emptyState,after:{...state,concepts:[{...state.concepts[0]!,label:researcher}]}}));
    await secretClient.query("ROLLBACK");
  } finally { secretClient.release(); }
  assert.equal((await call(`/sessions/${session}/events`, learner, v2)).status, 403);
  assert.equal((await call(`/sessions/${session}/events`, researcher, v2)).status, 403);
  const serverClient = await scoped.connect();
  try {
    await serverClient.query("BEGIN");
    const inserted = await insertResearchEvent(serverClient, session, "LEARNER", { ...v2, schemaVersion: 2, eventType: "ADD_CONCEPT", targetType: "CONCEPT", outcome: "SUCCESS", clientTimeQuality: "MISSING", before: emptyState, after: state });
    assert.ok(inserted);
    await serverClient.query("COMMIT");
  } finally { serverClient.release(); }
  const mixed = await call(`/research/sessions/${session}/events`, researcher);
  const mixedEvents = mixed.body.events as Array<Record<string, unknown>>;
  assert.equal(mixedEvents.length, 24); assert.equal(mixedEvents[0]!.schemaVersion, 1); assert.deepEqual(mixedEvents[0]!.before, { positionX: 1 });
  assert.equal(mixedEvents[23]!.schemaVersion, 2); assert.deepEqual(mixedEvents[23]!.after, state);
  await assert.rejects(scoped.query("UPDATE research_events SET schema_version=3 WHERE event_id=$1::uuid", [mixedEvents[23]!.eventId]));
  await assert.rejects(scoped.query("UPDATE research_events SET before_state='{}'::jsonb WHERE event_id=$1::uuid", [mixedEvents[23]!.eventId]));
  const migrationBoundary = await import(pathToFileURL(resolve("migrations/1790910000000_create_map_history_boundaries.js")).href) as { up: (pgm: { sql: (sql: string) => void }) => void };
  let boundarySql = ""; migrationBoundary.up({ sql: value => { boundarySql = value; } }); await scoped.query(boundarySql);
  const oldId = randomUUID();
  await scoped.query("INSERT INTO map_operation_logs(id,map_id,sequence_number) VALUES($1,$2,1)", [oldId, map]);
  await assert.rejects(scoped.query("INSERT INTO map_history_boundaries(map_id,legacy_count,legacy_last_id,boundary_snapshot) VALUES($1,0,NULL,$2::jsonb)", [map, JSON.stringify(state)]));
  await scoped.query("INSERT INTO map_history_boundaries(map_id,legacy_count,legacy_last_id,boundary_snapshot) VALUES($1,1,$2,$3::jsonb)", [map, oldId, JSON.stringify(state)]);
  const legacyReferenceClient = await scoped.connect();
  const undoKey = randomUUID();
  const undoEvent = { schemaVersion: 2 as const, eventType: "UNDO" as const, targetType: "MAP" as const, mapId: map, outcome: "SUCCESS" as const, clientTimeQuality: "NOT_APPLICABLE" as const, before: state, after: emptyState, relatedLegacyOperationLogId: oldId, idempotencyKey: undoKey };
  try {
    await legacyReferenceClient.query("BEGIN");
    assert.ok(await insertResearchEvent(legacyReferenceClient, session, "LEARNER", undoEvent));
    await legacyReferenceClient.query("COMMIT");
    await legacyReferenceClient.query("BEGIN");
    await assert.rejects(insertResearchEvent(legacyReferenceClient, session, "LEARNER", undoEvent));
    await legacyReferenceClient.query("ROLLBACK");
  } finally { legacyReferenceClient.release(); }
  await assert.rejects(scoped.query("INSERT INTO map_operation_logs(id,map_id,sequence_number) VALUES($1,$2,2)", [randomUUID(), map]));
  await assert.rejects(scoped.query("DELETE FROM map_history_boundaries WHERE map_id=$1", [map]));
  assert.equal((await scoped.query("SELECT 1 FROM map_operation_logs WHERE id=$1", [oldId])).rowCount, 1);
  const raceMap = randomUUID();
  await scoped.query("INSERT INTO maps VALUES($1,$2,'PRIOR','DRAFT')", [raceMap, stage]);
  const writer = await scoped.connect(), boundaryWriter = await scoped.connect();
  try {
    await writer.query("BEGIN");
    await writer.query("INSERT INTO map_operation_logs(id,map_id,sequence_number) VALUES($1,$2,1)", [randomUUID(), raceMap]);
    const boundaryAttempt = boundaryWriter.query("INSERT INTO map_history_boundaries(map_id,legacy_count,legacy_last_id,boundary_snapshot) VALUES($1,0,NULL,$2::jsonb)", [raceMap, JSON.stringify({ mapId: raceMap })]).then(() => false, () => true);
    await writer.query("COMMIT");
    assert.equal(await boundaryAttempt, true);
    assert.equal((await scoped.query("SELECT 1 FROM map_history_boundaries WHERE map_id=$1", [raceMap])).rowCount, 0);
  } finally { writer.release(); boundaryWriter.release(); }
  const beforeV3 = (await scoped.query("SELECT * FROM research_events ORDER BY sequence_number")).rows;
  const migrationV3 = await import(pathToFileURL(resolve("migrations/1790950000000_add_assessment_events_v3.js")).href) as { up: (pgm: { sql: (sql: string) => void }) => void };
  let sqlV3 = ""; migrationV3.up({ sql: value => { sqlV3 = value; } }); await scoped.query(sqlV3);
  assert.deepEqual((await scoped.query("SELECT * FROM research_events ORDER BY sequence_number")).rows, beforeV3);
  await assert.rejects(scoped.query("UPDATE research_events SET schema_version=3 WHERE event_id=$1", [mixedEvents[23]!.eventId]));
  const original = (await scoped.query("SELECT * FROM research_events ORDER BY sequence_number")).rows;
  await scoped.query("ALTER TABLE research_events DROP CONSTRAINT research_events_schema_version_check; ALTER TABLE research_events ADD CONSTRAINT research_events_schema_version_check CHECK(schema_version IN(1,2,3))");
  const migrationAudit = await import(pathToFileURL(resolve("migrations/1790960000000_add_server_audit_events.js")).href) as { up: (pgm: { sql: (sql: string) => void }) => void };
  let sqlAudit="";migrationAudit.up({sql:value=>{sqlAudit=value;}});await scoped.query(sqlAudit);
  const retained=(await scoped.query("SELECT * FROM research_events ORDER BY sequence_number")).rows.map(({audit_dedup_key: _key,...row})=>{void _key;return row;});
  assert.deepEqual(retained,original);
  const versionConstraint=await scoped.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='research_events'::regclass AND conname='research_events_schema_version_check'");
  assert.ok(versionConstraint.rows[0].def.includes("3"));

  await assert.rejects(scoped.query("UPDATE research_events SET session_id=NULL WHERE event_id=$1",[original[0]!.event_id]));
  console.log("Research event schema, access control, ordering and persistence: OK");
} finally {
  if (server) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()));
  await scoped.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
