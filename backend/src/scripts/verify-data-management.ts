import {verifyMockTestUrl} from "./mock-db.js";
import assert from "node:assert/strict";
import express from "express";
import { Pool } from "pg";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStage1Session } from "../sessions.js";
import {
  accessControl,
  createLearnerToken,
  storeLearnerToken,
  tokenHash,
} from "../access-control.js";
import { registerDataManagement } from "../data-management.js";
import { EventExportService } from "../event-export-service.js";
import { registerEventExportRoutes } from "../event-export-routes.js";
import { redactResearchOutput } from "../research-output-safety.js";
import { parseFilters } from "../event-export-contract.js";
const url = process.env.DATABASE_URL!;
await verifyMockTestUrl(url);
const pool = new Pool({ connectionString: url }),
  root = await mkdtemp(join(tmpdir(), "issue11-")),
  service = new EventExportService(pool, { root });
const app = express();
app.use(express.json());
app.use("/api", accessControl(pool));
registerDataManagement(app, pool, service);
registerEventExportRoutes(app, pool, service);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = "http://127.0.0.1:" + address.port + "/api",
  researcher = process.env.RESEARCHER_API_TOKEN!;
async function api(
  path: string,
  body?: unknown,
  token = researcher,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}
async function fixture() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const s = await createStage1Session(c, {
      participantCode: "dummy-code-not-exported",
      lessonVideoUrl: "/dummy.mp4",
      kitDefinitionId: "66666666-6666-4666-8666-666666666662",
      studyGroup: "CONTROL",
      groupActivitySeconds: 60,
    });
    const token = createLearnerToken();
    await storeLearnerToken(c, s.id, token.hash);
    const stage = s.stages.find((x) => x.stageType === "PRIOR_MAP")!;
    const map = (
      await c.query(
        "INSERT INTO maps(type,session_stage_id) VALUES('PRIOR',$1) RETURNING id",
        [stage.id],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1,'dummy',0,0)",
      [map],
    );
    await c.query(
      "INSERT INTO research_events(schema_version,session_id,participant_code,activity,actor_type,event_type,target_type,outcome,sequence_number,client_time_quality,before_quality,after_quality) VALUES(1,$1,'dummy-code-not-exported','PRIOR_MAP','LEARNER','SCREEN_ENTER','SCREEN','SUCCESS',1,'MISSING','MISSING','MISSING')",
      [s.id],
    );
    const legacy = (
      await c.query(
        "INSERT INTO map_operation_logs(map_id,operation_type,target_type,target_id,sequence_number) VALUES($1,'MAP_SAVE','MAP',$1,1) RETURNING id",
        [map],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO map_initial_snapshots(map_id,snapshot_version,snapshot) VALUES($1::uuid,1,jsonb_build_object('mapId',$1::text))",
      [map],
    );
    await c.query(
      "INSERT INTO map_history_boundaries(map_id,legacy_count,legacy_last_id,boundary_snapshot) VALUES($1::uuid,1,$2,jsonb_build_object('mapId',$1::text))",
      [map, legacy],
    );
    const question = (
      await c.query(
        "INSERT INTO assessment_questions(session_id,category,prompt,display_order) VALUES($1,'DESCRIPTION','dummy',0) RETURNING id",
        [s.id],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO assessment_answers(session_id,stage_id,question_id,answer) VALUES($1,$2,$3,'dummy answer')",
      [
        s.id,
        s.stages.find((x) => x.stageType === "PRE_ASSESSMENT")!.id,
        question,
      ],
    );
    await c.query(
      "INSERT INTO research_reflection_notes(session_id,map_id,operation_log_id,reported_by_code,note_text) VALUES($1,$2,$3,'researcher','dummy note')",
      [s.id, map, legacy],
    );
    await c.query("COMMIT");
    return { ...s, token: token.token, map };
  } finally {
    c.release();
  }
}
try {
  const a = await fixture(),
    b = await fixture();
  const scopes=["LEARNER:"+a.id,"LEARNER:"+a.id+":REJECTED","LEARNER:"+a.id+":FAILURE","LEARNER:"+a.id+":FUTURE:PHASE","LEARNER:"+b.id+":FAILURE","LEARNER:"+a.id+"extra:FAILURE"];
  for(const scope of scopes)await pool.query("INSERT INTO operation_receipts(principal_scope,operation_key,request_hash,result) VALUES($1,gen_random_uuid(),'mock','true')",[scope]);
  const unrelated=await fixture();
  await pool.query("INSERT INTO operation_receipts(principal_scope,operation_key,request_hash,result) VALUES($1,gen_random_uuid(),'mock','true'),('RESEARCHER',gen_random_uuid(),'mock',to_jsonb($2::text))",["LEARNER:"+unrelated.id+":REJECTED",a.map]);
  const receiptCount=async()=>Number((await pool.query("SELECT count(*) n FROM operation_receipts WHERE request_hash='mock'")).rows[0].n);
  const receiptsBefore=await receiptCount();
  const clientId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await pool.query(
    "INSERT INTO client_delivery_reports(session_id,client_id,report_sequence,pending,retrying,acknowledged,attempts,last_response,capacity_lost,expired_lost,rejected_lost,storage_lost) VALUES($1,$2,1,1,0,0,0,'NONE',0,0,0,0)",
    [a.id, clientId],
  );
  await assert.rejects(pool.query("DELETE FROM map_history_boundaries WHERE map_id=$1",[a.map]), (e: unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code==='23514');
  const listing = await api("/research/data-management");
  assert.equal(listing.status, 200);
  assert.ok(!JSON.stringify(listing.data).includes("participant_id"));
  assert.ok(!JSON.stringify(listing.data).includes("dummy-code"));
  const pa = listing.data.sessions.find(
    (x: { session_id: string }) => x.session_id === a.id,
  ).pseudonym;
  assert.equal(
    (await api("/research/data-management", undefined, a.token)).status,
    403,
  );
  assert.equal(
    (await api("/research/data-management", undefined, "invalid")).status,
    401,
  );
  const study = await api("/research/data-management/studies", {});
  assert.equal(study.status, 200);
  assert.equal(
    (
      await api(
        "/research/data-management/studies/" + study.data.id,
        { retainUntil: "2000-01-01T00:00:00Z" },
        researcher,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (await api("/research/data-management")).data.studies.find(
      (x: { id: string }) => x.id === study.data.id,
    ).retention_state,
    "EXPIRED",
  );
  assert.equal(
    (
      await api("/research/data-management/assign", {
        sessionId: b.id,
        pseudonym: pa,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api("/research/data-management/assign", {
        sessionId: a.id,
        reissue: true,
      })
    ).status,
    200,
  );
  const updated = (await api("/research/data-management")).data.sessions.filter(
    (x: { session_id: string }) => [a.id, b.id].includes(x.session_id),
  );
  assert.equal(updated[0].pseudonym, updated[1].pseudonym);
  assert.notEqual(updated[0].pseudonym, pa);
  const exported = await service.create(
    parseFilters({ learnerIds: [updated[0].pseudonym] })!,
  );
  assert.equal(exported.eventCount, 4);
  const rows = (await service.page(exported.exportId, 0))!.events;
  assert.ok(rows.every((e) => e.learner_id === updated[0].pseudonym));
  assert.ok(!JSON.stringify(rows).includes("dummy-code"));
  const internal = (
    await pool.query(
      "SELECT participant_id FROM research_identity.membership WHERE session_id=$1",
      [a.id],
    )
  ).rows[0].participant_id;
  assert.ok(!JSON.stringify(rows).includes(internal));
  const c = await pool.connect();
  try {
    const safe = await redactResearchOutput(
      {
        token: a.token,
        text: "Bearer credential-secret-12345",
        participant_id: internal,
        ordinary: "パスワードの仕組み",
      },
      c,
    );
    assert.equal(safe.token, "[REDACTED]");
    assert.equal(safe.text, "[REDACTED]");
    assert.equal(safe.participant_id, "[REDACTED]");
    assert.equal(safe.ordinary, "パスワードの仕組み");
  } finally {
    c.release();
  }
  const untouched = await service.create(
    parseFilters({ sessionIds: ["00000000-0000-4000-8000-000000000000"] })!,
  );
  const orphan=await service.create(parseFilters({sessionIds:[a.id]})!);
  const orphanDirectory=service.get(orphan.exportId)!.directory;
  service.jobs.delete(orphan.exportId); // Simulate a previous process's private files.
  let preview = await api("/research/data-management/preview", {
    sessionId: a.id,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.counts.concepts, 1);
  await pool.query("UPDATE concepts SET label='changed' WHERE map_id=$1", [
    a.map,
  ]);
  assert.equal(
    (
      await api("/research/data-management/delete", {
        planId: preview.data.planId,
        confirm: "DELETE",
      })
    ).status,
    409,
  );
  preview = await api("/research/data-management/preview", {
    pseudonym: updated[0].pseudonym,
  });
  assert.equal(preview.data.counts.sessions, 2);
  assert.equal(
    (
      await api("/research/data-management/delete", {
        planId: preview.data.planId,
        confirm: "NO",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api(
        "/research/data-management/delete",
        { planId: preview.data.planId, confirm: "DELETE" },
        a.token,
      )
    ).status,
    403,
  );
  await pool.query(
    "CREATE FUNCTION fail_delete_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'secret-exception-never-echo'; END $$;CREATE TRIGGER fail_delete_test BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION fail_delete_test()",
  );
  const failed = await api("/research/data-management/delete", {
    planId: preview.data.planId,
    confirm: "DELETE",
  });
  assert.equal(failed.status, 409);
  assert.ok(!JSON.stringify(failed).includes("secret-exception"));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM sessions WHERE id=ANY($1::uuid[])",
        [[a.id, b.id]],
      )
    ).rows[0].n,
    2,
  );
  assert.equal(await receiptCount(),receiptsBefore);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM assessment_answers WHERE session_id=ANY($1::uuid[])",[[a.id,b.id]])).rows[0].n),2);
  await pool.query(
    "DROP TRIGGER fail_delete_test ON sessions;DROP FUNCTION fail_delete_test()",
  );
  const deleted = await api("/research/data-management/delete", {
    planId: preview.data.planId,
    confirm: "DELETE",
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted));
  for(const scope of scopes.slice(0,5))assert.equal(Number((await pool.query("SELECT count(*) n FROM operation_receipts WHERE principal_scope=$1",[scope])).rows[0].n),0);
  assert.equal(await receiptCount(),2);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM sessions WHERE id=$1",[unrelated.id])).rows[0].n),1);
  for(const scope of [scopes[5],"LEARNER:"+unrelated.id+":REJECTED"])assert.equal(Number((await pool.query("SELECT count(*) n FROM operation_receipts WHERE principal_scope=$1",[scope])).rows[0].n),1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM research_events WHERE session_id=ANY($1::uuid[])",
        [[a.id, b.id]],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM concepts WHERE map_id=ANY($1::uuid[])",
        [[a.map, b.map]],
      )
    ).rows[0].n,
    0,
  );
  await assert.rejects(stat(orphanDirectory));
  assert.equal(service.get(exported.exportId), null);
  assert.ok(service.get(untouched.exportId));
  assert.equal(
    (
      await api("/research/data-management/delete", {
        planId: preview.data.planId,
        confirm: "DELETE",
      })
    ).status,
    409,
  );
  const gone = await api("/me", undefined, a.token);
  assert.equal(gone.status, 410);
  assert.equal(gone.data.queueKey, tokenHash(a.id));
  assert.ok(!JSON.stringify(gone).includes(a.id));
  assert.equal(
    (await api("/sessions/" + a.id + "/events", { schemaVersion: 1 }, a.token))
      .status,
    410,
  );
  const audit = (await api("/research/data-management")).data.deletions.find(
    (x: { id: string }) => x.id === deleted.data.receiptId,
  );
  assert.ok(audit.pending_devices >= 2);
  assert.equal((await api("/deletion-ack", { clientId }, a.token)).status, 200);
  const afterAck = (await api("/research/data-management")).data.deletions.find(
    (x: { id: string }) => x.id === deleted.data.receiptId,
  );
  assert.equal(afterAck.pending_devices, audit.pending_devices - 1);
  assert.ok(!JSON.stringify(audit).includes(a.id));
  console.log(
    "Issue11 identity/reissue/retention/deletion/rollback/export/auth/replay prevention: PASS",
  );
} finally {
  await service.dispose();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  await rm(root, { recursive: true, force: true });
}
