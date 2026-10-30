import {verifyMockTestUrl} from "./mock-db.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Pool } from "pg";
import { createStage1Session } from "../sessions.js";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";
const url = process.env.DATABASE_URL!;
await verifyMockTestUrl(url);
const pool = new Pool({ connectionString: url }),
  base = "http://127.0.0.1:3048/api",
  researcher = process.env.RESEARCHER_API_TOKEN!;
let child: ChildProcess | undefined;
async function start() {
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, PORT: "3048" },
    stdio: "inherit",
    windowsHide: true,
  });
  for (let i = 0; i < 150; i++) {
    if (
      await fetch(base + "/health",{headers:{Connection:"close"}})
        .then((r) => r.ok)
        .catch(() => false)
    )
      return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("test_server_start_failed:" + child?.exitCode);
}
async function stop() {
  if (child && child.exitCode === null) {
    const ended = once(child, "exit");
    child.kill();
    await ended;
  }
  child = undefined;
}
async function call(
  path: string,
  token: string,
  method = "GET",
  body?: unknown,
  key?: string,
  headers: Record<string, string> = {},
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Connection: "close",
      Authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
async function fixture(group: "CONTROL" | "EXPERIMENTAL" = "CONTROL") {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const s = await createStage1Session(c, {
      participantCode: "delivery-" + randomUUID(),
      lessonVideoUrl: "/dummy.mp4",
      kitDefinitionId: "66666666-6666-4666-8666-666666666662",
      studyGroup: group,
      groupActivitySeconds: 60,
    });
    const credential = createLearnerToken();
    await storeLearnerToken(c, s.id, credential.hash);
    await c.query(
      "INSERT INTO assessment_questions(session_id,category,prompt,display_order) VALUES($1,'DESCRIPTION','Dummy',0),($1,'DESCRIPTION','Dummy2',1)",
      [s.id],
    );
    await c.query(
      "UPDATE sessions SET status='IN_PROGRESS',started_at=now() WHERE id=$1",
      [s.id],
    );
    await c.query("COMMIT");
    return { ...s, token: credential.token };
  } finally {
    c.release();
  }
}
try {
  await start();
  const s = await fixture(),
    other = await fixture();
  const lesson = s.stages.find((x) => x.stageType === "LESSON")!,
    prior = s.stages.find((x) => x.stageType === "PRIOR_MAP")!,
    pre = s.stages.find((x) => x.stageType === "PRE_ASSESSMENT")!;
  assert.equal(
    (await call("/session-stages/" + lesson.id + "/start", s.token, "POST", {}))
      .status,
    200,
  );
  const observation = {
    schemaVersion: 1,
    eventType: "VIDEO_PLAY",
    targetType: "VIDEO",
    stageId: lesson.id,
    outcome: "SUCCESS",
    clientTimeQuality: "OBSERVED",
    clientTimestamp: new Date().toISOString(),
  };
  const stream = randomUUID(),
    key = randomUUID(),
    headers = { "X-Client-Stream-Id": stream, "X-Client-Sequence": "1" };
  const path = "/sessions/" + s.id + "/events";
  const first = await call(path, s.token, "POST", observation, key, headers);
  assert.equal(first.status, 201);
  const duplicates = await Promise.all(
    Array.from({ length: 8 }, () =>
      call(path, s.token, "POST", observation, key, headers),
    ),
  );
  assert.ok(
    duplicates.every(
      (x) =>
        x.body.eventId === first.body.eventId &&
        x.body.sequenceNumber === first.body.sequenceNumber,
    ),
  );
  await stop();
  await start();
  assert.deepEqual(
    (await call(path, s.token, "POST", observation, key, headers)).body,
    first.body,
  );
  assert.equal(
    (
      await call(
        path,
        s.token,
        "POST",
        { ...observation, eventType: "VIDEO_PAUSE" },
        key,
        headers,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(path, s.token, "POST", observation, key, {
        ...headers,
        "X-Client-Sequence": "2",
      })
    ).status,
    409,
  );
  assert.equal(
    (await call(path, other.token, "POST", observation, randomUUID(), headers))
      .status,
    404,
  );
  assert.equal(
    (await call(path, "invalid", "POST", observation, randomUUID(), headers))
      .status,
    401,
  );
  const second = await call(
    path,
    s.token,
    "POST",
    { ...observation, eventType: "VIDEO_PAUSE" },
    randomUUID(),
    { ...headers, "X-Client-Sequence": "3" },
  );
  assert.equal(second.status, 201);
  assert.equal(
    (
      await call(path, s.token, "POST", observation, randomUUID(), {
        ...headers,
        "X-Client-Sequence": "2",
      })
    ).status,
    409,
  );
  await call("/session-stages/" + lesson.id + "/complete", s.token, "POST", {});
  assert.equal(
    (
      await call(
        path,
        s.token,
        "POST",
        { ...observation, eventType: "VIDEO_COMPLETE" },
        randomUUID(),
        { ...headers, "X-Client-Sequence": "4" },
      )
    ).status,
    201,
    "delayed observations must not change completed Stage",
  );
  assert.equal(
    (
      await pool.query("SELECT status FROM session_stages WHERE id=$1", [
        lesson.id,
      ])
    ).rows[0].status,
    "COMPLETED",
  );
  const report = {
    clientId: stream,
    reportSequence: 2,
    pending: 4,
    retrying: 2,
    attempts: 12,
    lastResponse: "NETWORK",
    acknowledged: 3,
    capacityLost: 1,
    expiredLost: 2,
    rejectedLost: 0,
    storageLost: 0,
  };
  assert.equal(
    (
      await call(
        "/sessions/" + s.id + "/delivery-status",
        s.token,
        "POST",
        report,
      )
    ).status,
    200,
  );
  await call("/sessions/" + s.id + "/delivery-status", s.token, "POST", {
    ...report,
    reportSequence: 1,
    pending: 0,
    retrying: 0,
  });
  assert.equal(
    (
      await call("/sessions/" + s.id + "/delivery-status", s.token, "POST", {
        ...report,
        token: "secret",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/sessions/" + other.id + "/delivery-status",
        s.token,
        "POST",
        report,
      )
    ).status,
    404,
  );
  assert.equal(
    (await call("/research/sessions/" + s.id + "/delivery-status", s.token))
      .status,
    403,
  );
  const status = (
    await call("/research/sessions/" + s.id + "/delivery-status", researcher)
  ).body;
  assert.equal(status.clientReported[0].pending, 4);
  assert.equal(status.serverVerified[0].persisted, 3);
  assert.equal(status.serverVerified[0].sequence_gaps, "1");
  await call("/session-stages/" + prior.id + "/start", s.token, "POST", {});
  const creationKey = randomUUID();
  const map = (
    await call(
      "/session-stages/" + prior.id + "/prior-map",
      s.token,
      "POST",
      undefined,
      creationKey,
    )
  ).body;
  assert.ok(map.id);
  const conceptBody = {
      label: "Duplicate-safe concept",
      positionX: 20,
      positionY: 30,
    },
    mutationKey = randomUUID(),
    conceptPath = "/maps/" + map.id + "/concepts";
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () =>
      call(conceptPath, s.token, "POST", conceptBody, mutationKey),
    ),
  );
  assert.ok(
    concurrent.every(
      (x) => x.status === 201 && x.body.id === concurrent[0].body.id,
    ),
    JSON.stringify(concurrent),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM concepts WHERE map_id=$1 AND label=$2",
        [map.id, conceptBody.label],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM research_events WHERE map_id=$1 AND event_type='ADD_CONCEPT' AND outcome='SUCCESS'",
        [map.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await call(
        conceptPath,
        s.token,
        "POST",
        { ...conceptBody, label: "different" },
        mutationKey,
      )
    ).status,
    409,
  );
  const failingKey = randomUUID();
  await pool.query(
    "CREATE FUNCTION issue8_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private exception body'; END; $$; CREATE TRIGGER issue8_failure BEFORE INSERT ON research_events FOR EACH ROW EXECUTE FUNCTION issue8_failure()",
  );
  try {
    const failure = await call(
      conceptPath,
      s.token,
      "POST",
      { ...conceptBody, label: "Rollback" },
      failingKey,
    );
    assert.ok(failure.status >= 400);
    assert.ok(!JSON.stringify(failure).includes("private exception"));
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM concepts WHERE map_id=$1 AND label='Rollback'",
          [map.id],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM operation_receipts WHERE operation_key=$1",
          [failingKey],
        )
      ).rowCount,
      0,
    );
  } finally {
    await pool.query(
      "DROP TRIGGER issue8_failure ON research_events; DROP FUNCTION issue8_failure()",
    );
  }
  const recovered = await call(
    conceptPath,
    s.token,
    "POST",
    { ...conceptBody, label: "Rollback" },
    failingKey,
  );
  assert.equal(recovered.status, 201);
  await stop();
  await start();
  assert.equal(
    (
      await call(
        conceptPath,
        s.token,
        "POST",
        { ...conceptBody, label: "Rollback" },
        failingKey,
      )
    ).body.id,
    recovered.body.id,
  );
  const replay = await call(
    "/research/sessions/" + s.id + "/maps/" + map.id + "/mixed-history",
    researcher,
  );
  assert.equal(replay.body.status, "REPLAYABLE");
  const submitKey = randomUUID();
  assert.equal(
    (await call("/maps/" + map.id + "/submit", s.token, "POST", {}, submitKey))
      .status,
    200,
  );
  const receipt = await call(
    "/maps/" + map.id + "/submit",
    s.token,
    "POST",
    {},
    submitKey,
  );
  assert.equal(receipt.status, 409);
  assert.equal(receipt.body.operationCommitted, true);
  assert.ok(!JSON.stringify(receipt.body).includes(conceptBody.label));
  assert.equal((await call("/maps/" + map.id, s.token)).status, 404);
  const creationReplay = await call(
    "/session-stages/" + prior.id + "/prior-map",
    s.token,
    "POST",
    undefined,
    creationKey,
  );
  assert.equal(creationReplay.status, 409);
  assert.ok(
    !("concepts" in creationReplay.body) && !("map" in creationReplay.body),
  );

  assert.equal(
    (
      await call(
        "/maps/44444444-4444-4444-8444-444444444442/concepts",
        s.token,
        "POST",
        conceptBody,
        mutationKey,
      )
    ).status,
    404,
    "Known receipt must not bypass resource ownership",
  );
  await pool.query(
    "UPDATE operation_receipts SET created_at=now()-interval '8 days' WHERE operation_key=$1",
    [mutationKey],
  );
  assert.equal(
    (await call(conceptPath, s.token, "POST", conceptBody, mutationKey)).status,
    410,
    "Expired receipts must never execute again",
  );
  const kb = s.stages.find((x) => x.stageType === "KB_MAP")!;
  await call("/session-stages/" + kb.id + "/start", s.token, "POST", {});
  const kitMap = (
    await call(
      "/kits/66666666-6666-4666-8666-666666666662/kb-map",
      s.token,
      "POST",
      { sessionStageId: kb.id },
      randomUUID(),
    )
  ).body;
  const displayed = {
      ...observation,
      eventType: "FEEDBACK_DISPLAY",
      targetType: "FEEDBACK",
      stageId: kb.id,
      mapId: kitMap.id,
    },
    displayKey = randomUUID();
  const display = await call(path, s.token, "POST", displayed, displayKey, {
    ...headers,
    "X-Client-Sequence": "5",
  });
  assert.equal(display.status, 201, JSON.stringify(display));
  assert.equal(
    (
      await call(path, s.token, "POST", displayed, displayKey, {
        ...headers,
        "X-Client-Sequence": "5",
      })
    ).body.eventId,
    display.body.eventId,
  );
  // Isolated fixture advances to the assessment; research activity order itself is unchanged.
  await pool.query(
    "UPDATE session_stages SET status='COMPLETED',started_at=coalesce(started_at,now()),completed_at=now() WHERE session_id=$1 AND order_index<$2",
    [s.id, pre.orderIndex],
  );
  await call("/session-stages/" + pre.id + "/start", s.token, "POST", {});
  const qs = (
    await pool.query(
      "SELECT id FROM assessment_questions WHERE session_id=$1 ORDER BY display_order",
      [s.id],
    )
  ).rows;
  const answers = {
      answers: qs.map((q, i) => ({
        questionId: q.id,
        answer: "Dummy answer " + i,
      })),
    },
    answerKey = randomUUID(),
    assessment = "/session-stages/" + pre.id + "/assessment";
  const rejectedKey = randomUUID(),
    invalid = { answers: [{ questionId: qs[0].id, answer: " " }] };
  const rejected = await Promise.all(
    Array.from({ length: 4 }, () =>
      call(assessment + "/save", s.token, "POST", invalid, rejectedKey),
    ),
  );
  assert.ok(
    rejected.every((r) => r.status === 400 && r.body.logSaved === true),
    JSON.stringify(rejected),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM research_events WHERE stage_id=$1 AND event_type='ASSESSMENT_EDIT' AND outcome='REJECTED'",
        [pre.id],
      )
    ).rows[0].n,
    1,
  );
  await pool.query(
    "CREATE FUNCTION issue8_answer_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.schema_version=3 THEN RAISE EXCEPTION 'private answer failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER issue8_answer_failure BEFORE INSERT ON research_events FOR EACH ROW EXECUTE FUNCTION issue8_answer_failure()",
  );
  try {
    const failed = await call(
      assessment + "/save",
      s.token,
      "POST",
      answers,
      answerKey,
    );
    assert.equal(failed.status, 500);
    assert.equal(failed.body.logSaved, false);
    assert.ok(!JSON.stringify(failed).includes("private answer"));
    assert.equal(
      (
        await pool.query("SELECT 1 FROM assessment_answers WHERE stage_id=$1", [
          pre.id,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await pool.query(
      "DROP TRIGGER issue8_answer_failure ON research_events; DROP FUNCTION issue8_answer_failure()",
    );
  }
  const saved = await call(
    assessment + "/save",
    s.token,
    "POST",
    answers,
    answerKey,
  );
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal(
    (await call(assessment + "/save", s.token, "POST", answers, answerKey))
      .status,
    200,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM research_events WHERE stage_id=$1 AND event_type='ASSESSMENT_EDIT' AND outcome='SUCCESS'",
        [pre.id],
      )
    ).rows[0].n,
    2,
  );
  const assessmentSubmit = randomUUID();
  assert.equal(
    (
      await call(
        assessment + "/submit",
        s.token,
        "POST",
        answers,
        assessmentSubmit,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        assessment + "/submit",
        s.token,
        "POST",
        answers,
        assessmentSubmit,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM research_events WHERE stage_id=$1 AND event_type='ASSESSMENT_SUBMIT' AND outcome='SUCCESS'",
        [pre.id],
      )
    ).rows[0].n,
    1,
  );
  const exp = await fixture("EXPERIMENTAL"),
    integration = exp.stages.find((x) => x.stageType === "INTEGRATION_MAP")!;
  await pool.query(
    "UPDATE session_stages SET status='COMPLETED',started_at=now(),completed_at=now() WHERE session_id=$1 AND order_index<$2",
    [exp.id, integration.orderIndex],
  );
  await pool.query(
    "UPDATE session_stages SET status='IN_PROGRESS',started_at=now() WHERE id=$1",
    [integration.id],
  );
  await pool.query(
    "INSERT INTO maps(type,status,session_stage_id,submitted_at) SELECT 'PRIOR','SUBMITTED',id,now() FROM session_stages WHERE session_id=$1 AND stage_type='PRIOR_MAP'",
    [exp.id],
  );
  await pool.query(
    "INSERT INTO maps(type,status,session_stage_id,kit_definition_id,submitted_at) SELECT 'KB','SUBMITTED',id,'66666666-6666-4666-8666-666666666662',now() FROM session_stages WHERE session_id=$1 AND stage_type='KB_MAP'",
    [exp.id],
  );
  const integrationKey = randomUUID(),
    integrationPath = "/session-stages/" + integration.id + "/integration-map";
  assert.equal(
    (await call(integrationPath, exp.token, "POST", undefined, integrationKey))
      .status,
    201,
  );
  await pool.query(
    "UPDATE session_stages SET started_at=now()-interval '2 minutes' WHERE id=$1",
    [integration.id],
  );
  const expiredReplay = await call(
    integrationPath,
    exp.token,
    "POST",
    undefined,
    integrationKey,
  );
  assert.equal(expiredReplay.status, 409);
  assert.ok(
    !("concepts" in expiredReplay.body) && !("map" in expiredReplay.body),
  );
  await pool.query("UPDATE maps SET status='SUBMITTED',submitted_at=coalesce(submitted_at,now()) WHERE session_stage_id IN (SELECT id FROM session_stages WHERE session_id=$1)",[s.id]);
  await pool.query("UPDATE session_stages SET status='COMPLETED',started_at=coalesce(started_at,now()),completed_at=coalesce(completed_at,now()) WHERE session_id=$1",[s.id]);
  await pool.query("UPDATE sessions SET status='COMPLETED',completed_at=now() WHERE id=$1",[s.id]);
  const exported=await call("/research/sessions/"+s.id+"/export",researcher);
  assert.equal(exported.status,200);assert.equal(exported.body.delivery.serverVerified[0].persisted,4);assert.equal(exported.body.delivery.missingIsUnknown,true);assert.ok(!JSON.stringify(exported.body.delivery).includes("Dummy answer"));
  const unsafe = JSON.stringify(
    (await call("/research/sessions/" + s.id + "/delivery-status", researcher))
      .body,
  );
  assert.ok(!unsafe.includes("Dummy answer"));
  assert.ok(!unsafe.includes(s.token));
  console.log(
    "Delivery: duplicate/concurrent/reordered observations, delayed recovery, report validation/ownership, actual server restart, atomic Map/assessment retry and rollback: PASS",
  );
} finally {
  await stop();
  await pool.end();
}
