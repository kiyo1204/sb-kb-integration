import { verifyMockTestUrl } from "./mock-db.js";
import assert from "node:assert/strict";
import express from "express";
import { Pool } from "pg";
import { createFiveActivitySession, createStage1Session } from "../sessions.js";
import { accessControl, createLearnerToken, storeLearnerToken, tokenHash } from "../access-control.js";
import { registerDataManagement } from "../data-management.js";
import { EventExportService } from "../event-export-service.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const url = process.env.DATABASE_URL!;
await verifyMockTestUrl(url);
const pool = new Pool({ connectionString: url });
const root = await mkdtemp(join(tmpdir(), "empty-session-delete-"));
const exports = new EventExportService(pool, { root });
const app = express();
app.use(express.json());
app.use("/api", accessControl(pool));
registerDataManagement(app, pool, exports);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}/api`;
const researcher = process.env.RESEARCHER_API_TOKEN!;

async function api(path: string, token = researcher, method = "DELETE") {
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, data: await response.json() };
}

async function fixture() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await createFiveActivitySession(client, {
      participantCode: `empty-${crypto.randomUUID()}`,
      lessonVideoUrl: "/dummy.mp4",
      kitDefinitionId: "66666666-6666-4666-8666-666666666662",
      groupActivitySeconds: 60,
    });
    const credential = createLearnerToken();
    await storeLearnerToken(client, session.id, credential.hash);
    const item = (
      await client.query(
        "SELECT id FROM kit_concept_items WHERE kit_definition_id=$1 LIMIT 1",
        ["66666666-6666-4666-8666-666666666662"],
      )
    ).rows[0];
    assert.ok(item);
    await client.query(
      "INSERT INTO session_seed_concepts(session_id,kit_concept_item_id) VALUES($1,$2)",
      [session.id, item.id],
    );
    await client.query(
      "INSERT INTO survey_questions(session_id,kind,prompt,required,display_order,config) VALUES($1,'TEXT','Setup question',true,0,'{}')",
      [session.id],
    );
    const prior = session.stages.find((stage) => stage.stageType === "PRIOR_MAP")!;
    const map = (
      await client.query(
        "INSERT INTO maps(type,session_stage_id) VALUES('PRIOR',$1) RETURNING id",
        [prior.id],
      )
    ).rows[0].id;
    const concept = (
      await client.query(
        "INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1,'Initial seed',320,240) RETURNING id",
        [map],
      )
    ).rows[0].id;
    await client.query(
      "INSERT INTO seeded_map_concepts(concept_id,session_id,kit_concept_item_id) VALUES($1,$2,$3)",
      [concept, session.id, item.id],
    );
    // Session creation/admin audit is deliberately allowed and removed under
    // the ordinary, identity-safe deletion receipt.
    await client.query(
      `INSERT INTO research_events(schema_version,session_id,participant_code,actor_type,event_type,target_type,outcome,sequence_number,client_time_quality,before_quality,after_quality)
       VALUES(4,$1,$2,'RESEARCHER','SESSION_CREATE','SESSION','SUCCESS',1,'NOT_APPLICABLE','NOT_APPLICABLE','NOT_APPLICABLE')`,
      [session.id, `empty-${session.id}`],
    );
    await client.query("COMMIT");
    return { id: session.id, token: credential.token, stage: prior.id, map, concept };
  } finally {
    client.release();
  }
}

async function legacyFixture(protocolKey: "STAGE1_4" | "STAGE1_6") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let sessionId: string;
    if (protocolKey === "STAGE1_6") {
      sessionId = (await createStage1Session(client, {
        participantCode: `legacy-${crypto.randomUUID()}`,
        lessonVideoUrl: "/dummy.mp4",
        kitDefinitionId: "66666666-6666-4666-8666-666666666662",
        studyGroup: "CONTROL",
        groupActivitySeconds: 60,
      })).id;
    } else {
      sessionId = (await client.query<{id:string}>(
        `INSERT INTO sessions(protocol_key,participant_code,lesson_video_url,research_kit_definition_id)
         VALUES('STAGE1_4',$1,'/dummy.mp4',$2) RETURNING id`,
        [`legacy-${crypto.randomUUID()}`, "66666666-6666-4666-8666-666666666662"],
      )).rows[0]!.id;
      for (const [order, type] of ["LESSON", "PRIOR_MAP", "KB_MAP", "INTEGRATION_MAP"].entries())
        await client.query("INSERT INTO session_stages(session_id,stage_type,order_index) VALUES($1,$2,$3)", [sessionId, type, order]);
    }
    const credential = createLearnerToken();
    await storeLearnerToken(client, sessionId, credential.hash);
    await client.query("COMMIT");
    return { id: sessionId, token: credential.token };
  } finally {
    client.release();
  }
}

async function receiptCount() {
  return Number(
    (await pool.query("SELECT count(*) AS n FROM research_deletion_receipts")).rows[0]!.n,
  );
}

try {
  const empty = await fixture();
  const otherSession = await fixture();
  assert.equal((await api(`/research/stage1/sessions/${empty.id}`, "", "DELETE")).status, 401);
  assert.equal((await api(`/research/stage1/sessions/${empty.id}`, empty.token)).status, 403);
  assert.equal((await api(`/research/stage1/sessions/${empty.id}`, otherSession.token)).status, 403);
  assert.equal((await api(`/research/stage1/sessions/${otherSession.id}`)).status, 200);
  const before = await receiptCount();
  const deleted = await api(`/research/stage1/sessions/${empty.id}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal((await pool.query("SELECT 1 FROM sessions WHERE id=$1", [empty.id])).rowCount, 0);
  for (const table of [
    "session_stages", "survey_questions", "session_seed_concepts", "seeded_map_concepts",
    "maps", "concepts", "research_events", "research_event_counters",
  ]) {
    const column = table === "maps" || table === "concepts" ? "id" : "session_id";
    const value = table === "maps" ? empty.map : table === "concepts" ? empty.concept : empty.id;
    const row = await pool.query(`SELECT 1 FROM ${table} WHERE ${column}=$1 LIMIT 1`, [value]);
    assert.equal(row.rowCount, 0, `${table} should be cleaned up`);
  }
  assert.equal(await receiptCount(), before + 1);
  const membership = await pool.query("SELECT 1 FROM research_identity.membership WHERE session_id=$1", [empty.id]);
  assert.equal(membership.rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM research_identity.revocations WHERE token_hash=$1", [tokenHash(empty.token)])).rowCount, 1);
  assert.equal((await pool.query("SELECT 1 FROM research_identity.device_deletions WHERE token_hash=$1 AND client_hash='UNKNOWN'", [tokenHash(empty.token)])).rowCount, 1);
  for (const protocolKey of ["STAGE1_4", "STAGE1_6"] as const) {
    const legacy = await legacyFixture(protocolKey);
    assert.equal((await api(`/research/stage1/sessions/${legacy.id}`)).status, 200, `${protocolKey} compatibility`);
  }

  const started = await fixture();
  await pool.query("UPDATE sessions SET status='IN_PROGRESS',started_at=clock_timestamp() WHERE id=$1", [started.id]);
  const startedResult = await api(`/research/stage1/sessions/${started.id}`);
  assert.equal(startedResult.status, 409);
  assert.equal(startedResult.data.confirmationRequired, true);
  assert.equal(startedResult.data.href, "/research/data-management");

  const event = await fixture();
  await pool.query(
    `INSERT INTO research_events(schema_version,session_id,participant_code,actor_type,event_type,target_type,outcome,sequence_number,client_time_quality,before_quality,after_quality)
     VALUES(1,$1,'test-code','LEARNER','SCREEN_ENTER','SCREEN','SUCCESS',2,'MISSING','MISSING','MISSING')`,
    [event.id],
  );
  assert.equal((await api(`/research/stage1/sessions/${event.id}`)).status, 409);
  const edit = await fixture();
  await pool.query(
    "INSERT INTO map_operation_logs(map_id,operation_type,target_type,target_id,sequence_number) VALUES($1,'MAP_SAVE','MAP',$1,1)",
    [edit.map],
  );
  assert.equal((await api(`/research/stage1/sessions/${edit.id}`)).status, 409);

  const submitted = await fixture();
  await pool.query("UPDATE maps SET status='SUBMITTED',submitted_at=clock_timestamp() WHERE id=$1", [submitted.map]);
  assert.equal((await api(`/research/stage1/sessions/${submitted.id}`)).status, 409);

  const answered = await fixture();
  const question = (
    await pool.query("SELECT id FROM survey_questions WHERE session_id=$1 LIMIT 1", [answered.id])
  ).rows[0]!.id;
  await pool.query(
    "INSERT INTO survey_answers(session_id,stage_id,question_id,answer) VALUES($1,$2,$3,'\"answer\"'::jsonb)",
    [answered.id, answered.stage, question],
  );
  assert.equal((await api(`/research/stage1/sessions/${answered.id}`)).status, 409);
  assert.equal((await api(`/research/stage1/sessions/${started.id}`)).status, 409, "other target IDs cannot bypass eligibility");

  // A concurrent start follows the production route's FOR UPDATE protocol.
  // If it wins, cleanup must re-read status and refuse without deleting data.
  const race = await fixture();
  const starter = await pool.connect();
  await starter.query("BEGIN");
  await starter.query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE", [race.id]);
  await starter.query("UPDATE sessions SET status='IN_PROGRESS',started_at=clock_timestamp() WHERE id=$1", [race.id]);
  const deleting = api(`/research/stage1/sessions/${race.id}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await starter.query("COMMIT");
  starter.release();
  const raceResult = await deleting;
  assert.equal(raceResult.status, 409);
  assert.equal((await pool.query("SELECT status FROM sessions WHERE id=$1", [race.id])).rows[0]!.status, "IN_PROGRESS");

  // Learner answer obtains foreign-key locks before deletion. Once its
  // transaction commits, deletion observes the persisted answer and refuses.
  const answerRace = await fixture();
  const answerClient = await pool.connect();
  const answerQuestion = (await pool.query("SELECT id FROM survey_questions WHERE session_id=$1 LIMIT 1", [answerRace.id])).rows[0]!.id;
  await answerClient.query("BEGIN");
  await answerClient.query(
    "INSERT INTO survey_answers(session_id,stage_id,question_id,answer) VALUES($1,$2,$3,'\"racing answer\"'::jsonb)",
    [answerRace.id, answerRace.stage, answerQuestion],
  );
  const deleteAfterAnswer = api(`/research/stage1/sessions/${answerRace.id}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await answerClient.query("COMMIT");
  answerClient.release();
  assert.equal((await deleteAfterAnswer).status, 409);
  assert.equal((await pool.query("SELECT 1 FROM survey_answers WHERE session_id=$1", [answerRace.id])).rowCount, 1);

  // If deletion locks first, a concurrent FK-backed answer insert waits and
  // then fails against the removed Session; it cannot leave an orphan row.
  const deleteWins = await fixture();
  const deleteWinsQuestion = (await pool.query("SELECT id FROM survey_questions WHERE session_id=$1 LIMIT 1", [deleteWins.id])).rows[0]!.id;
  await pool.query(
    "CREATE FUNCTION empty_delete_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN OLD; END $$; CREATE TRIGGER empty_delete_pause BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION empty_delete_pause()",
  );
  try {
    const deleteFirst = api(`/research/stage1/sessions/${deleteWins.id}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(
      pool.query(
        "INSERT INTO survey_answers(session_id,stage_id,question_id,answer) VALUES($1,$2,$3,'\"late answer\"'::jsonb)",
        [deleteWins.id, deleteWins.stage, deleteWinsQuestion],
      ),
      (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "23503",
    );
    assert.equal((await deleteFirst).status, 200);
    assert.equal((await pool.query("SELECT 1 FROM sessions WHERE id=$1", [deleteWins.id])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM survey_answers WHERE session_id=$1", [deleteWins.id])).rowCount, 0);
  } finally {
    await pool.query("DROP TRIGGER empty_delete_pause ON sessions; DROP FUNCTION empty_delete_pause()");
  }

  // Trigger failure proves the receipt and all prior child deletions roll back.
  const rollback = await fixture();
  const receiptsBeforeFailure = await receiptCount();
  await pool.query(
    "CREATE FUNCTION empty_delete_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'delete fault'; END $$; CREATE TRIGGER empty_delete_fail BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION empty_delete_fail()",
  );
  try {
    assert.equal((await api(`/research/stage1/sessions/${rollback.id}`)).status, 409);
    assert.equal((await pool.query("SELECT 1 FROM sessions WHERE id=$1", [rollback.id])).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM survey_questions WHERE session_id=$1", [rollback.id])).rowCount, 1);
    assert.equal(await receiptCount(), receiptsBeforeFailure);
  } finally {
    await pool.query("DROP TRIGGER empty_delete_fail ON sessions; DROP FUNCTION empty_delete_fail()");
  }
  console.log("empty Session deletion eligibility, setup cleanup, audit receipt, authorization, refusal and locking rollback: PASS");
} finally {
  await exports.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  await rm(root, { recursive: true, force: true });
}
