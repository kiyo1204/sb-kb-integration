import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { verifyMockTestUrl } from "./mock-db.js";
export async function checkExperimentEnd(
  pool: Pool,
  base: string,
  run: string,
) {
  await verifyMockTestUrl(process.env.DATABASE_URL!);
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    token = process.env.RESEARCHER_API_TOKEN!,
    key = randomUUID(),
  ) =>
    fetch(base + "/api" + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  const snapshot = async () =>
    JSON.stringify(
      (
        await pool.query(
          `SELECT s.id,s.status,s.started_at,s.completed_at,(SELECT jsonb_agg(to_jsonb(st) ORDER BY st.id) FROM session_stages st WHERE st.session_id=s.id) stages,(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM maps m JOIN session_stages st ON st.id=m.session_stage_id WHERE st.session_id=s.id) maps FROM sessions s JOIN experiment_run_sessions p ON p.session_id=s.id WHERE p.run_id=$1 ORDER BY s.id`,
          [run],
        )
      ).rows,
    );
  // Add a real active participant with an unsubmitted SB map to the completed participants.
  const added = await call(
    `/research/experiment-runs/${run}/participants`,
    "POST",
    { participantLabel: "TEST ONLY unfinished" },
  );
  assert.equal(added.status, 201);
  const participant = await added.json();
  const learner = participant.issuedCode as string;
  const secret = randomBytes(32).toString("base64url");
  const claim = await fetch(base + "/api/experiment-client/claim", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + participant.issuedCode,
      "Content-Type": "application/json",
      "X-Experiment-Client": secret,
    },
    body: "{}",
  });
  assert.equal(claim.status, 200);
  const client = await claim.json();
  let sequence = 0;
  const stream = randomUUID();
  const active = async (
    path: string,
    method = "POST",
    body: unknown = {},
    expected?: number,
  ) => {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: {
        Authorization: "Bearer " + participant.issuedCode,
        "Content-Type": "application/json",
        "X-Experiment-Client": secret,
        "X-Experiment-Generation": String(client.deviceGeneration),
        "X-Experiment-Origin-Client": client.clientId,
        "X-Experiment-Origin-Generation": String(client.deviceGeneration),
        "Idempotency-Key": randomUUID(),
        "X-Client-Stream-Id": stream,
        "X-Client-Sequence": String(++sequence),
      },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
    if (expected !== undefined) assert.equal(r.status, expected);
    else assert.ok(r.ok, `${path} ${r.status}`);
    return r.json();
  };
  await active(`/sessions/${participant.sessionId}/start`);
  const flow = await active(`/sessions/${participant.sessionId}/flow`, "GET");
  const stages = flow.stages as Array<{ id: string; stageType: string }>;
  const lesson = stages.find((x) => x.stageType === "LESSON")!.id,
    sb = stages.find((x) => x.stageType === "PRIOR_MAP")!.id;
  await active(`/session-stages/${lesson}/start`);
  await active(`/sessions/${participant.sessionId}/events`, "POST", {
    schemaVersion: 1,
    eventType: "VIDEO_COMPLETE",
    targetType: "VIDEO",
    stageId: lesson,
    outcome: "SUCCESS",
    clientTimeQuality: "NOT_APPLICABLE",
  });
  await active(`/session-stages/${lesson}/complete`);
  await active(`/session-stages/${sb}/start`);
  let draft = await active(`/session-stages/${sb}/prior-map`);
  let before = await snapshot();
  assert.equal(
    (
      await call(
        `/research/experiment-runs/${run}/end`,
        "POST",
        { confirmed: true },
        learner,
      )
    ).status,
    403,
  );
  // Force a failure after the run UPDATE using a dedicated mock-only trigger.
  await pool.query(
    "CREATE FUNCTION test_end_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST ONLY end fault'; END $$; CREATE TRIGGER test_end_fault BEFORE INSERT ON experiment_end_receipts FOR EACH ROW EXECUTE FUNCTION test_end_receipt_fault()",
  );
  const failed = await call(`/research/experiment-runs/${run}/end`, "POST", {
    confirmed: true,
  });
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes("TEST ONLY"));
  assert.equal(
    (await pool.query("SELECT state FROM experiment_runs WHERE id=$1", [run]))
      .rows[0].state,
    "RUNNING",
  );
  assert.equal(await snapshot(), before);
  await pool.query(
    "DROP TRIGGER test_end_fault ON experiment_end_receipts;DROP FUNCTION test_end_receipt_fault()",
  );
  // Keep integration unsubmitted and end before its real background deadline.
  await active(`/maps/${draft.id}/submit`);
  const kbStage = stages.find((x) => x.stageType === "KB_MAP")!.id,
    intStage = stages.find((x) => x.stageType === "INTEGRATION_MAP")!.id;
  await active(`/session-stages/${kbStage}/start`);
  const kit = (
    await pool.query(
      "SELECT research_kit_definition_id id FROM sessions WHERE id=$1",
      [participant.sessionId],
    )
  ).rows[0].id;
  const kb = await active(`/kits/${kit}/kb-map`, "POST", {
    sessionStageId: kbStage,
  });
  const parts = (
    await pool.query(
      "SELECT id,source_concept_id source FROM kit_concept_items WHERE kit_definition_id=$1",
      [kit],
    )
  ).rows;
  const nodes = new Map<string, string>();
  for (const part of parts) {
    const node = await active(
      `/maps/${kb.id}/kit-concepts/${part.id}/import`,
      "POST",
      { positionX: 100 + nodes.size * 150, positionY: 100 },
    );
    nodes.set(part.source, node.id);
  }
  for (const part of (
    await pool.query(
      "SELECT i.id,l.source_concept_id source,l.target_concept_id target FROM kit_link_items i JOIN links l ON l.id=i.source_link_id WHERE i.kit_definition_id=$1",
      [kit],
    )
  ).rows)
    await active(`/maps/${kb.id}/kit-links/${part.id}`, "POST", {
      sourceConceptId: nodes.get(part.source),
      targetConceptId: nodes.get(part.target),
    });
  assert.equal(
    (await active(`/maps/${kb.id}/kit-feedback`, "GET")).matched,
    true,
  );
  await active(`/maps/${kb.id}/submit`);
  await active(`/session-stages/${intStage}/start`);
  draft = await active(`/session-stages/${intStage}/integration-map`);
  // Block an actual Map mutation after its run guard, then queue end behind it.
  const graph = await active(`/maps/${draft.id}`, "GET");
  const held = await pool.connect();
  await held.query("BEGIN");
  await held.query("SELECT id FROM maps WHERE id=$1 FOR UPDATE", [draft.id]);
  const moving = active(`/concepts/${graph.concepts[0].id}/position`, "PATCH", {
    positionX: 321,
    positionY: 123,
  });
  try {
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      blocked =
        Number(
          (
            await pool.query(
              "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%maps%' ",
            )
          ).rows[0].n,
        ) > 0;
      if (blocked) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(blocked, "actual Map request holds run lock before end");
    const key = randomUUID();
    const ending = Promise.all(
      Array.from({ length: 4 }, () =>
        call(
          `/research/experiment-runs/${run}/end`,
          "POST",
          { confirmed: true },
          undefined,
          key,
        ),
      ),
    );
    let endingBlocked = false;
    for (let i = 0; i < 100; i++) {
      endingBlocked =
        Number(
          (
            await pool.query(
              "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT r.* FROM experiment_runs%' ",
            )
          ).rows[0].n,
        ) > 0;
      if (endingBlocked) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(endingBlocked);
    const lateSubmit = active(`/maps/${draft.id}/submit`, "POST", {}, 409);
    await held.query("COMMIT");
    await moving;
    before = await snapshot();
    const responses = await ending;
    assert.equal((await lateSubmit).error, "experiment_ended");
    for (const r of responses) {
      assert.equal(r.status, 200);
      assert.equal((await r.json()).state, "ENDED");
    }
    assert.equal(
      await snapshot(),
      before,
      "no forced submission or participant status rewriting",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM experiment_end_receipts WHERE run_id=$1",
          [run],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM experiment_end_audit WHERE run_id=$1 AND outcome='SUCCESS'",
          [run],
        )
      ).rows[0].n,
      1,
    );
    const members = (
      await pool.query(
        "SELECT session_id FROM experiment_run_sessions WHERE run_id=$1",
        [run],
      )
    ).rows;
    const maps = (
      await pool.query(
        "SELECT m.id FROM maps m JOIN session_stages st ON st.id=m.session_stage_id JOIN experiment_run_sessions p ON p.session_id=st.session_id WHERE p.run_id=$1",
        [run],
      )
    ).rows;
    for (const m of maps) {
      assert.equal(
        (await call(`/maps/${m.id}`, "GET", undefined, learner)).status,
        409,
      );
      assert.equal(
        (await call(`/maps/${m.id}/submit`, "POST", {}, learner)).status,
        409,
      );
      assert.equal(
        (await call(`/maps/${m.id}`, "PATCH", { title: "TEST ONLY" }, learner))
          .status,
        409,
      );
    }
    for (const p of members)
      assert.equal(
        (await call(`/sessions/${p.session_id}/events`, "POST", {}, learner))
          .status,
        409,
      );
    assert.equal(
      (await call("/experiment-status", "GET", undefined, learner)).status,
      200,
    );
    assert.equal((await call("/me", "GET", undefined, learner)).status, 200);
    for (const suffix of ["research.json", "research.csv"]) {
      const r = await call(`/research/experiment-runs/${run}/${suffix}`);
      assert.equal(r.status, 200);
      assert.ok((await r.text()).length > 0);
    }
    const analysis = await call(
      `/research/stage1/sessions/${participant.sessionId}/analysis`,
    );
    assert.equal(analysis.status, 200);
    assert.equal(
      (await analysis.json()).integrationStates.submission.reason,
      "NOT_SUBMITTED",
    );
    for (let i = 0; i < 150; i++) {
      const expired = (
        await pool.query(
          "SELECT clock_timestamp()>st.started_at+s.group_activity_seconds*interval '1 second'+interval '2 seconds' AS done FROM session_stages st JOIN sessions s ON s.id=st.session_id WHERE st.id=$1",
          [intStage],
        )
      ).rows[0].done;
      if (expired) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(
      (await pool.query("SELECT status FROM maps WHERE id=$1", [draft.id]))
        .rows[0].status,
      "DRAFT",
      "background deadline must not submit ended run",
    );
    assert.equal(await snapshot(), before);
    // DB guard also blocks post-end writes without relying on the UI.
    if (maps.length)
      await assert.rejects(() =>
        pool.query("UPDATE maps SET title=title WHERE id=$1", [maps[0].id]),
      );
  } finally {
    await held.query("ROLLBACK").catch(() => undefined);
    held.release();
  }
  console.log(
    "Experiment end: real API/DB, failure rollback, shared-lock ordering, 4 concurrent retries, frozen participant records, direct denial and researcher output PASS",
  );
}

/** Real scheduler wins its run lock before end; no submitted-state fixture writes. */
export async function checkBackgroundEndOrder(
  pool: Pool,
  base: string,
  session: string,
  map: string,
) {
  await verifyMockTestUrl(process.env.DATABASE_URL!);
  const run = (
    await pool.query(
      "SELECT run_id FROM experiment_run_sessions WHERE session_id=$1",
      [session],
    )
  ).rows[0].run_id;
  const held = await pool.connect();
  let ending: Promise<Response> | undefined;
  try {
    await held.query("BEGIN");
    await held.query("SELECT id FROM experiment_runs WHERE id=$1 FOR UPDATE", [
      run,
    ]);
    let backgroundWaiting = false;
    for (let i = 0; i < 180; i++) {
      backgroundWaiting =
        Number(
          (
            await pool.query(
              "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT r.state FROM experiment_participant_access%' ",
            )
          ).rows[0].n,
        ) > 0;
      if (backgroundWaiting) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(
      backgroundWaiting,
      "real background auto-submit reached shared run lock",
    );
    ending = fetch(base + `/api/research/experiment-runs/${run}/end`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.RESEARCHER_API_TOKEN!,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({ confirmed: true }),
      signal: AbortSignal.timeout(15000),
    });
    let endWaiting = false;
    for (let i = 0; i < 100; i++) {
      endWaiting =
        Number(
          (
            await pool.query(
              "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT r.* FROM experiment_runs%' ",
            )
          ).rows[0].n,
        ) > 0;
      if (endWaiting) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(endWaiting, "end queued after real background guard");
    await held.query("COMMIT");
    assert.equal((await ending).status, 200);
    const result = (
      await pool.query(
        "SELECT m.status,m.auto_submitted_at,r.ended_at,m.submitted_at<=r.ended_at AS ordered,s.status AS session_status FROM maps m JOIN session_stages st ON st.id=m.session_stage_id JOIN sessions s ON s.id=st.session_id JOIN experiment_run_sessions p ON p.session_id=s.id JOIN experiment_runs r ON r.id=p.run_id WHERE m.id=$1",
        [map],
      )
    ).rows[0];
    assert.equal(result.status, "SUBMITTED");
    assert.ok(result.auto_submitted_at);
    assert.equal(result.ordered, true);
    assert.equal(result.session_status, "IN_PROGRESS");
    console.log(
      "Experiment end: actual background submission committed before queued end, retained as submitted without Session completion PASS",
    );
  } finally {
    await held.query("ROLLBACK").catch(() => undefined);
    held.release();
    if (ending) await ending.catch(() => undefined);
  }
}
