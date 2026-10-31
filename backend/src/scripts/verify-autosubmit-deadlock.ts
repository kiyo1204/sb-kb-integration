import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { verifyMockTestUrl } from "./mock-db.js";
import { createStage1Session } from "../sessions.js";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";
import { observeExpiredStages } from "../system-submission.js";

await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: "deadline-probe",
});
const base = process.env.API_BASE_URL!;
const baseline = process.env.DEADLOCK_EXPECT_BASELINE === "1";
const report: unknown[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(test: () => Promise<boolean>, label: string) {
  for (let i = 0; i < 200; i++) {
    if (await test()) return;
    await pause(25);
  }
  throw new Error("probe_timeout:" + label);
}
async function request(
  path: string,
  token: string,
  body?: unknown,
  headers = {},
) {
  const r = await fetch(base + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
async function fixture(group: "CONTROL" | "EXPERIMENTAL") {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const session = await createStage1Session(c, {
      participantCode: "deadline-mock-" + randomUUID(),
      lessonVideoUrl: "/dummy.mp4",
      kitDefinitionId: "66666666-6666-4666-8666-666666666662",
      studyGroup: group,
      groupActivitySeconds: 60,
    });
    const token = createLearnerToken();
    await storeLearnerToken(c, session.id, token.hash);
    const stage = session.stages.find(
      (st) =>
        st.stageType ===
        (group === "CONTROL" ? "SELF_STUDY" : "INTEGRATION_MAP"),
    )!;
    await c.query(
      "UPDATE sessions SET status='IN_PROGRESS',started_at=clock_timestamp() WHERE id=$1",
      [session.id],
    );
    await c.query(
      "UPDATE session_stages SET status='COMPLETED',started_at=clock_timestamp(),completed_at=clock_timestamp() WHERE session_id=$1 AND order_index<$2",
      [session.id, stage.orderIndex],
    );
    await c.query(
      "UPDATE session_stages SET status='IN_PROGRESS',started_at=clock_timestamp() WHERE id=$1",
      [stage.id],
    );
    const referenceMaps: string[] = [];
    if (group === "CONTROL") {
      for (const [stageType, mapType] of [
        ["PRIOR_MAP", "PRIOR"],
        ["KB_MAP", "KB"],
      ]) {
        const previous = session.stages.find(
          (st) => st.stageType === stageType,
        )!;
        referenceMaps.push(
          (
            await c.query(
              "INSERT INTO maps(type,status,submitted_at,session_stage_id) VALUES($1,'SUBMITTED',clock_timestamp(),$2) RETURNING id",
              [mapType, previous.id],
            )
          ).rows[0].id,
        );
      }
    }
    let map: string | undefined;
    if (group === "EXPERIMENTAL") {
      map = (
        await c.query(
          "INSERT INTO maps(type,session_stage_id) VALUES('INTEGRATION',$1) RETURNING id",
          [stage.id],
        )
      ).rows[0].id;
      await c.query(
        "INSERT INTO map_initial_snapshots(map_id,snapshot_version,snapshot) VALUES($1,1,$2)",
        [
          map,
          {
            snapshotVersion: 1,
            mapId: map,
            mapType: "INTEGRATION",
            basedOnMapId: null,
            kitDefinitionId: null,
            concepts: [],
            links: [],
          },
        ],
      );
    }
    await c.query("COMMIT");
    return {
      session: session.id,
      stage: stage.id,
      map,
      referenceMaps,
      token: token.token,
    };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function cycle(
  group: "CONTROL" | "EXPERIMENTAL",
  mode: "deadline" | "auto-submit" | "complete",
) {
  const f = await fixture(group);
  if (f.map)
    assert.equal((await request(`/maps/${f.map}`, f.token)).status, 200);
  if (f.referenceMaps.length) {
    assert.equal(
      (await request(`/sessions/${f.session}/self-study-maps`, f.token)).status,
      200,
    );
    for (const id of f.referenceMaps)
      assert.equal((await request(`/maps/${id}`, f.token)).status, 200);
  }
  const key = randomUUID(),
    stream = randomUUID();
  const body = {
    schemaVersion: 1,
    eventType: "SCREEN_ENTER",
    targetType: "SCREEN",
    stageId: f.stage,
    ...(mode === "auto-submit" ? { mapId: f.map } : {}),
    outcome: "SUCCESS",
    clientTimeQuality: "OBSERVED",
    clientTimestamp: new Date().toISOString(),
  };
  // Warm the counter so its foreign-key check is already satisfied before this interleaving.
  assert.equal(
    (
      await request(`/sessions/${f.session}/events`, f.token, {
        ...body,
        eventType: "SCREEN_LEAVE",
      })
    ).status,
    201,
  );
  const gate = await pool.connect();
  let released = false;
  let pending: ReturnType<typeof request> | undefined;
  let observer: Promise<void> | undefined;
  let completion: ReturnType<typeof request> | undefined;
  try {
    const gatePid = (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    await gate.query("SELECT pg_advisory_lock(481613)");
    await pool.query(
      `CREATE TRIGGER deadline_probe_gate BEFORE INSERT ON research_events FOR EACH ROW WHEN (NEW.session_id='${f.session}'::uuid AND NEW.event_type='SCREEN_ENTER') EXECUTE FUNCTION deadline_probe_gate()`,
    );
    const headers = {
      "Idempotency-Key": key,
      "X-Client-Stream-Id": stream,
      "X-Client-Sequence": "1",
    };
    if (mode === "auto-submit") {
      // Hold the actual auto-submit UPDATE after it has locked the Map. This
      // separates the Map FK cycle from the preceding Session deadline audit.
      await gate.query("SELECT pg_advisory_lock(481614)");
      await pool.query(
        `CREATE TRIGGER deadline_probe_map BEFORE UPDATE ON maps FOR EACH ROW WHEN (NEW.id='${f.map}'::uuid AND NEW.status='SUBMITTED') EXECUTE FUNCTION deadline_probe_map()`,
      );
      await pool.query(
        "UPDATE session_stages SET started_at=clock_timestamp()-interval '61 seconds' WHERE id=$1",
        [f.stage],
      );
      await until(
        async () =>
          (
            await pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'WITH submission_clock%'",
              [gatePid],
            )
          ).rowCount! > 0,
        "auto-submit-gated-with-map-lock",
      );
    }
    pending = request(`/sessions/${f.session}/events`, f.token, body, headers);
    let eventPid = 0;
    await until(async () => {
      const rows = (
        await pool.query(
          "SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'INSERT INTO research_events%'",
          [gatePid],
        )
      ).rows;
      eventPid = rows[0]?.pid ?? 0;
      return !!eventPid;
    }, "event-gated-after-counter");
    if (mode !== "auto-submit")
      await pool.query(
        "UPDATE session_stages SET started_at=clock_timestamp()-interval '61 seconds' WHERE id=$1",
        [f.stage],
      );
    if (mode === "deadline") observer = observeExpiredStages(pool);
    if (mode === "complete")
      completion = request(`/session-stages/${f.stage}/complete`, f.token, {});
    if (mode === "auto-submit")
      await gate.query("SELECT pg_advisory_unlock(481614)");
    // Otherwise the actual API's automatic submission timer owns the Map transaction.
    let blockers: { pid: number; waitEvent: string; waitingFor: number[] }[] =
      [];
    await until(async () => {
      const rows = (
        await pool.query(
          `SELECT pid,wait_event AS "waitEvent",pg_blocking_pids(pid) AS "waitingFor" FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'INSERT INTO research_event_counters%'`,
          [eventPid],
        )
      ).rows;
      blockers = rows;
      return rows.length > 0;
    }, "deadline-or-map-waiting-for-counter");
    await gate.query("SELECT pg_advisory_unlock(481613)");
    released = true;
    const response = await pending;
    if (observer) await observer;
    if (completion) {
      const completed = await completion;
      assert.equal(completed.status, 200);
      assert.equal(completed.body.logSaved, true);
    }
    assert.equal(
      response.status,
      baseline ? 500 : 201,
      mode + ": " + JSON.stringify(response.body),
    );
    const firstCount = (
      await pool.query(
        "SELECT count(*)::int AS n FROM client_event_receipts WHERE session_id=$1 AND event_key=$2",
        [f.session, key],
      )
    ).rows[0].n;
    assert.equal(firstCount, baseline ? 0 : 1);
    if (f.map)
      await until(
        async () =>
          (await pool.query("SELECT status FROM maps WHERE id=$1", [f.map]))
            .rows[0].status === "SUBMITTED",
        "worker-completed-before-retry",
      );
    const retry = await request(
      `/sessions/${f.session}/events`,
      f.token,
      body,
      headers,
    );
    assert.equal(retry.status, 201);
    const duplicates = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(`/sessions/${f.session}/events`, f.token, body, headers),
      ),
    );
    for (const duplicate of duplicates) {
      assert.equal(duplicate.status, 201);
      assert.deepEqual(duplicate.body, retry.body);
    }
    const delivery = {
      clientId: stream,
      reportSequence: 1,
      pending: 0,
      retrying: 0,
      acknowledged: 1,
      capacityLost: 0,
      expiredLost: 0,
      rejectedLost: 0,
      storageLost: 0,
      attempts: baseline ? 3 : 2,
      lastResponse: "ACK",
    };
    assert.equal(
      (
        await request(
          `/sessions/${f.session}/delivery-status`,
          f.token,
          delivery,
        )
      ).status,
      200,
    );
    const verified = await request(
      `/research/sessions/${f.session}/delivery-status`,
      process.env.RESEARCHER_API_TOKEN!,
    );
    assert.equal(
      verified.body.serverVerified.find(
        (item: { client_id: string }) => item.client_id === stream,
      ).persisted,
      1,
    );
    assert.equal(
      verified.body.clientReported.find(
        (item: { client_id: string }) => item.client_id === stream,
      ).last_response,
      "ACK",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM client_event_receipts WHERE session_id=$1 AND event_key=$2",
          [f.session, key],
        )
      ).rows[0].n,
      1,
    );
    // A completed Stage need not be observed again by the deadline scanner.
    if (mode !== "complete")
      await until(
        async () =>
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM research_events WHERE session_id=$1 AND event_type='STAGE_DEADLINE' AND outcome='SUCCESS'",
              [f.session],
            )
          ).rows[0].n === 1,
        "deadline-event",
      );
    if (f.map) {
      await until(
        async () =>
          (await pool.query("SELECT status FROM maps WHERE id=$1", [f.map]))
            .rows[0].status === "SUBMITTED",
        "auto-submission",
      );
      const events = (
        await pool.query(
          "SELECT actor_type,outcome FROM research_events WHERE map_id=$1 AND event_type='MAP_AUTO_SUBMIT'",
          [f.map],
        )
      ).rows;
      assert.deepEqual(events, [{ actor_type: "SYSTEM", outcome: "SUCCESS" }]);
      const replay = await request(
        `/research/sessions/${f.session}/maps/${f.map}/mixed-history`,
        process.env.RESEARCHER_API_TOKEN!,
      );
      assert.equal(replay.status, 200);
      assert.equal(replay.body.status, "REPLAYABLE");
      assert.equal((await request(`/maps/${f.map}`, f.token)).status, 404);
    }
    if (f.referenceMaps.length) {
      assert.equal(
        (await request(`/sessions/${f.session}/self-study-maps`, f.token))
          .status,
        409,
      );
      for (const id of f.referenceMaps) {
        assert.equal((await request(`/maps/${id}`, f.token)).status, 404);
        assert.equal(
          (await request(`/maps/${id}`, process.env.RESEARCHER_API_TOKEN!))
            .status,
          200,
        );
      }
    }
    const ordered = (
      await pool.query(
        "SELECT sequence_number,server_timestamp FROM research_events WHERE session_id=$1 ORDER BY sequence_number",
        [f.session],
      )
    ).rows;
    ordered.forEach((row, i) => {
      assert.equal(Number(row.sequence_number), i + 1);
      assert.ok(Number.isFinite(new Date(row.server_timestamp).getTime()));
    });
    const flow = await request(`/sessions/${f.session}/flow`, f.token);
    assert.equal(flow.status, 200);
    assert.equal(
      flow.body.currentStage.id,
      mode === "complete"
        ? flow.body.stages.find(
            (st: { stageType: string }) => st.stageType === "POST_ASSESSMENT",
          ).id
        : f.stage,
    );
    report.push({
      group,
      mode,
      eventPid,
      counterWaiters: blockers,
      httpStatus: response.status,
      rollbackReceiptAbsent: firstCount === 0,
      retryAcknowledged: true,
      receiptCount: 1,
      autoSubmitted: !!f.map,
      stageStillInProgress: mode !== "complete",
    });
    console.log(
      `${group}/${mode}: HTTP ${response.status}; retry ACK, single receipt, deadline/state/replay OK`,
    );
  } finally {
    if (!released)
      await gate
        .query("SELECT pg_advisory_unlock(481613)")
        .catch(() => undefined);
    await gate
      .query("SELECT pg_advisory_unlock(481614)")
      .catch(() => undefined);
    await pending?.catch(() => undefined);
    await observer?.catch(() => undefined);
    await completion?.catch(() => undefined);
    gate.release();
    await pool.query(
      "DROP TRIGGER IF EXISTS deadline_probe_gate ON research_events; DROP TRIGGER IF EXISTS deadline_probe_map ON maps",
    );
    await pool.query(
      "UPDATE sessions SET status='COMPLETED',completed_at=clock_timestamp() WHERE id=$1",
      [f.session],
    );
  }
}
async function autoRollback() {
  const f = await fixture("EXPERIMENTAL");
  try {
    await pool.query(
      `CREATE FUNCTION deadline_probe_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_event_failure' USING ERRCODE='23514'; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER deadline_probe_fail BEFORE INSERT ON research_events FOR EACH ROW WHEN (NEW.map_id='${f.map}'::uuid AND NEW.event_type='MAP_AUTO_SUBMIT' AND NEW.outcome='SUCCESS') EXECUTE FUNCTION deadline_probe_fail()`,
    );
    await pool.query(
      "UPDATE session_stages SET started_at=clock_timestamp()-interval '61 seconds' WHERE id=$1",
      [f.stage],
    );
    await until(
      async () =>
        (
          await pool.query(
            "SELECT 1 FROM research_events WHERE map_id=$1 AND event_type='MAP_AUTO_SUBMIT' AND outcome='FAILURE'",
            [f.map],
          )
        ).rowCount! > 0,
      "atomic-failure-audit",
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT status,submitted_at,auto_submitted_at FROM maps WHERE id=$1",
          [f.map],
        )
      ).rows,
      [{ status: "DRAFT", submitted_at: null, auto_submitted_at: null }],
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM map_history_boundaries WHERE map_id=$1",
          [f.map],
        )
      ).rows[0].n,
      0,
    );
    await pool.query("DROP TRIGGER deadline_probe_fail ON research_events");
    await until(
      async () =>
        (await pool.query("SELECT status FROM maps WHERE id=$1", [f.map]))
          .rows[0].status === "SUBMITTED",
      "recover-after-fault-removed",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM research_events WHERE map_id=$1 AND event_type='MAP_AUTO_SUBMIT' AND outcome='SUCCESS'",
          [f.map],
        )
      ).rows[0].n,
      1,
    );
    const replay = await request(
      `/research/sessions/${f.session}/maps/${f.map}/mixed-history`,
      process.env.RESEARCHER_API_TOKEN!,
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.status, "REPLAYABLE");
    report.push({
      case: "auto-submit-event-failure",
      rollbackMapAndBoundary: true,
      recoveredWithSingleSuccess: true,
      replay: "REPLAYABLE",
    });
    console.log(
      "Auto-submit event failure: Map/boundary rollback, safe audit, later recovery/replay OK",
    );
  } finally {
    await pool.query(
      "DROP TRIGGER IF EXISTS deadline_probe_fail ON research_events; DROP FUNCTION IF EXISTS deadline_probe_fail()",
    );
    await pool.query(
      "UPDATE sessions SET status='COMPLETED',completed_at=clock_timestamp() WHERE id=$1",
      [f.session],
    );
  }
}
try {
  await pool.query(
    `CREATE FUNCTION deadline_probe_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('deadlock_timeout','100ms',true); PERFORM pg_advisory_xact_lock(481613); RETURN NEW; END $$`,
  );
  await pool.query(
    `CREATE FUNCTION deadline_probe_map() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(481614); RETURN NEW; END $$`,
  );
  await cycle("CONTROL", "deadline");
  await cycle("EXPERIMENTAL", "auto-submit");
  if (!baseline) await cycle("CONTROL", "complete");
  if (!baseline) await autoRollback();
  if (process.env.DEADLOCK_REPORT)
    await writeFile(
      process.env.DEADLOCK_REPORT,
      JSON.stringify({ baseline, cases: report }, null, 2) + "\n",
    );
} finally {
  await pool.query(
    "DROP TRIGGER IF EXISTS deadline_probe_gate ON research_events; DROP TRIGGER IF EXISTS deadline_probe_map ON maps; DROP FUNCTION IF EXISTS deadline_probe_gate(); DROP FUNCTION IF EXISTS deadline_probe_map()",
  );
  await pool.end();
}
