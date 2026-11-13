// TEST ONLY. New disposable DB; no learner flow or real participants.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { verifyMockTestUrl, verificationReportPath } from "./mock-db.js";
import {
  createLearnerToken,
  storeLearnerToken,
  tokenHash,
} from "../access-control.js";
import { registerExperimentSession } from "../experiment-foundation.js";
import {
  authenticateExperimentToken,
  lockExperimentProof,
  lockCurrentExperimentClient,
  ParticipantAccessError,
} from "../experiment-participant-access.js";
import { loadResearchTextSafety } from "../research-output-safety.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
  researcher = process.env.RESEARCHER_API_TOKEN!,
  root = "/research/experiment-runs",
  checks: string[] = [];
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  status = 200,
  key: string = randomUUID(),
  token = researcher,
  extra: Record<string, string> = {},
) {
  const r = await fetch(process.env.API_BASE_URL + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, status, method + " " + path);
  return { data: await r.json().catch(() => null), response: r };
}
async function audit(
  action: string,
  run: string,
  status: number,
  code: string,
) {
  const r = (
    await pool.query(
      "SELECT * FROM experiment_access_audit WHERE action=$1 AND run_id=$2 ORDER BY server_timestamp DESC LIMIT 1",
      [action, run],
    )
  ).rows[0];
  assert.ok(r);
  assert.equal(r.http_status, status);
  assert.equal(r.reason_code, code);
  assert.equal(
    r.outcome,
    status >= 500 ? "FAILURE" : status >= 400 ? "REJECTED" : "SUCCESS",
  );
  assert.equal(
    r.reason,
    status >= 500
      ? "SERVER"
      : status === 409
        ? "CONFLICT"
        : status >= 400
          ? "VALIDATION"
          : null,
  );
}
const counts = async () =>
  (
    await pool.query(
      "SELECT (SELECT count(*) FROM sessions)::int sessions,(SELECT count(*) FROM session_stages)::int stages,(SELECT count(*) FROM experiment_run_sessions)::int members,(SELECT count(*) FROM experiment_participant_access)::int access,(SELECT count(*) FROM experiment_access_operations)::int receipts,(SELECT count(*) FROM research_session_ids)::int identities",
    )
  ).rows[0];
const state = async (sid: string) =>
  (
    await pool.query(
      "SELECT to_jsonb(s) session,(SELECT jsonb_agg(to_jsonb(st) ORDER BY st.order_index) FROM session_stages st WHERE st.session_id=s.id) stages,(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM maps m JOIN session_stages st ON st.id=m.session_stage_id WHERE st.session_id=s.id) maps,(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.event_id) FROM research_events e WHERE e.session_id=s.id) events FROM sessions s WHERE s.id=$1",
      [sid],
    )
  ).rows[0];
try {
  const goal = (
    await call(
      "/research/goal-maps/import",
      "POST",
      {
        format: "sb-kb-goal-map",
        schemaVersion: 1,
        goalMap: {
          title: "TEST ONLY access " + randomUUID(),
          concepts: [
            { id: "a", label: "TEST ONLY seed", position: { x: 0, y: 0 } },
          ],
          links: [],
        },
      },
      201,
    )
  ).data;
  const part = (
    await pool.query(
      "SELECT id FROM kit_concept_items WHERE kit_definition_id=$1",
      [goal.kitDefinitionId],
    )
  ).rows[0].id;
  const d = (await call("/research/materials", "POST", {}, 201)).data;
  const body = {
    title: "TEST ONLY access material",
    researcherDescription: "",
    videoRef: "/test-only.mp4",
    sbInstructions: "TEST ONLY SB",
    kbInstructions: "TEST ONLY KB",
    integrationInstructions: "TEST ONLY integration",
    kitId: goal.kitDefinitionId,
    seedConceptItemIds: [part],
    integrationSeconds: 601,
  };
  const s = (
    await call(`/research/materials/${d.id}`, "PUT", {
      expectedRevision: d.editRevision,
      body,
    })
  ).data;
  const mat = (
    await call(`/research/materials/${d.id}/publish`, "POST", {
      expectedRevision: s.editRevision,
    })
  ).data;
  const run = (
    await call(
      root,
      "POST",
      {
        name: "TEST ONLY R08",
        catalogVersionId: mat.id,
        plannedParticipants: 1,
      },
      201,
    )
  ).data;
  const other = (
    await call(
      root,
      "POST",
      {
        name: "TEST ONLY other R08",
        catalogVersionId: mat.id,
        plannedParticipants: 0,
      },
      201,
    )
  ).data;
  const legacyToken = createLearnerToken(),
    legacy = (
      await pool.query(
        "INSERT INTO sessions(protocol_key,participant_code,lesson_video_url,research_kit_definition_id) VALUES('STAGE1_4','TEST ONLY old auth','/test-only.mp4',$1) RETURNING id",
        [goal.kitDefinitionId],
      )
    ).rows[0].id;
  const auth = await pool.connect();
  try {
    await storeLearnerToken(auth, legacy, legacyToken.hash);
  } finally {
    auth.release();
  }
  const legacyBefore = await state(legacy);
  await call(`${root}/${run.id}/start`, "POST", {}, 409);
  await call(
    `${root}/${run.id}/participants`,
    "GET",
    undefined,
    401,
    randomUUID(),
    "",
  );
  await call(
    `${root}/${run.id}/participants`,
    "POST",
    { participantLabel: "TEST ONLY denied" },
    403,
    randomUUID(),
    legacyToken.token,
  );
  const key = randomUUID(),
    p = (
      await call(
        `${root}/${run.id}/participants`,
        "POST",
        { participantLabel: "TEST ONLY P1" },
        201,
        key,
      )
    ).data;
  assert.equal(p.issuedCode.length, 43);
  const code1 = p.issuedCode as string,
    sid = p.sessionId as string;
  const replay = (
    await call(
      `${root}/${run.id}/participants`,
      "POST",
      { participantLabel: "TEST ONLY P1" },
      201,
      key,
    )
  ).data;
  assert.equal(replay.sessionId, sid);
  assert.equal(replay.issuedCode, null);
  assert.equal(replay.codeDelivery, "NOT_REPLAYED");
  await call(
    `${root}/${run.id}/participants`,
    "POST",
    { participantLabel: "TEST ONLY changed" },
    409,
    key,
  );
  await audit("REGISTER", run.id, 409, "access_conflict");
  const p2 = (
    await call(
      `${root}/${run.id}/participants`,
      "POST",
      { participantLabel: "TEST ONLY P2" },
      201,
    )
  ).data;
  const view = (await call(`${root}/${run.id}/participants`)).data;
  assert.equal(view.participants.length, 2);
  assert.equal(view.run.plannedParticipants, 1);
  assert.equal(view.startAvailable, false);
  const stored = (
    await pool.query(
      "SELECT s.protocol_key,s.group_activity_seconds,s.research_kit_definition_id,a.code_hash FROM sessions s JOIN experiment_participant_access a ON a.session_id=s.id WHERE s.id=$1",
      [sid],
    )
  ).rows[0];
  assert.equal(stored.protocol_key, "SBKB_INTEGRATION_V1");
  assert.equal(stored.group_activity_seconds, 601);
  assert.equal(stored.research_kit_definition_id, goal.kitDefinitionId);
  assert.ok(stored.code_hash === tokenHash(code1));
  const snapshot = await state(sid);
  assert.equal(snapshot.stages.length, 4);
  assert.equal(snapshot.maps, null);
  const me = (await call("/me", "GET", undefined, 200, randomUUID(), code1))
    .data;
  assert.equal(me.flowAvailable, false);
  assert.deepEqual(Object.keys(me).sort(), [
    "flowAvailable",
    "protocolKey",
    "role",
    "sessionId",
  ]);
  await call(`${root}/${run.id}/start`, "POST", {}, 409);
  for (const path of [
    `${root}/${run.id}/participants`,
    `${root}/${other.id}/participants`,
  ])
    await call(path, "GET", undefined, 403, randomUUID(), code1);
  await call(
    `/sessions/${p2.sessionId}/start`,
    "POST",
    {},
    409,
    randomUUID(),
    code1,
  );
  await call(
    "/experiment-client/claim",
    "POST",
    { sessionId: p2.sessionId },
    400,
    randomUUID(),
    code1,
    { "X-Experiment-Client": createLearnerToken().token },
  );
  checks.push(
    "atomic registration/code hash, no replayed plaintext or duplicate Session; fixed 4-stage material, planned count not a cap; researcher authorization and flow gate",
  );
  const clientA = createLearnerToken().token,
    clientB = createLearnerToken().token;
  const a = (
    await call(
      "/experiment-client/claim",
      "POST",
      {},
      200,
      randomUUID(),
      code1,
      { "X-Experiment-Client": clientA },
    )
  ).data;
  const aRetry = (
    await call(
      "/experiment-client/claim",
      "POST",
      {},
      200,
      randomUUID(),
      code1,
      { "X-Experiment-Client": clientA },
    )
  ).data;
  assert.equal(aRetry.clientId, a.clientId);
  assert.equal(aRetry.deviceGeneration, a.deviceGeneration);
  const b = (
    await call(
      "/experiment-client/claim",
      "POST",
      {},
      409,
      randomUUID(),
      code1,
      { "X-Experiment-Client": clientB },
    )
  ).data;
  assert.equal(b.ownership, "PENDING");
  await audit("CLAIM", run.id, 409, "experiment_client_in_use");
  const proof = (await authenticateExperimentToken(pool, tokenHash(code1)))!;
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await lockCurrentExperimentClient(c, proof, clientA, a.deviceGeneration);
    await c.query("ROLLBACK");
  } finally {
    c.release();
  }
  const switchKey = randomUUID(),
    sw = (
      await call(
        `${root}/${run.id}/participants/${sid}/client-switch`,
        "POST",
        { clientId: b.clientId, expectedDeviceGeneration: a.deviceGeneration },
        200,
        switchKey,
      )
    ).data;
  const swRetry = (
    await call(
      `${root}/${run.id}/participants/${sid}/client-switch`,
      "POST",
      { clientId: b.clientId, expectedDeviceGeneration: a.deviceGeneration },
      200,
      switchKey,
    )
  ).data;
  assert.equal(sw.deviceGeneration, swRetry.deviceGeneration);
  await call("/experiment-client/claim", "POST", {}, 409, randomUUID(), code1, {
    "X-Experiment-Client": clientA,
  });
  const cb = await pool.connect();
  try {
    await cb.query("BEGIN");
    await assert.rejects(
      lockCurrentExperimentClient(cb, proof, clientA, a.deviceGeneration),
      (e) =>
        e instanceof ParticipantAccessError &&
        e.code === "experiment_client_stale",
    );
    await cb.query("ROLLBACK");
    await cb.query("BEGIN");
    await lockCurrentExperimentClient(cb, proof, clientB, sw.deviceGeneration);
    await cb.query("ROLLBACK");
  } finally {
    cb.release();
  }
  await call(
    `${root}/${other.id}/participants/${sid}/code/reissue`,
    "POST",
    { expectedCredentialGeneration: 1 },
    404,
  );
  const reKey = randomUUID(),
    re = (
      await call(
        `${root}/${run.id}/participants/${sid}/code/reissue`,
        "POST",
        { expectedCredentialGeneration: 1 },
        200,
        reKey,
      )
    ).data;
  assert.equal(re.credentialGeneration, 2);
  assert.equal(re.activeClientId, null);
  assert.equal(
    (
      await call(
        `${root}/${run.id}/participants/${sid}/code/reissue`,
        "POST",
        { expectedCredentialGeneration: 1 },
        200,
        reKey,
      )
    ).data.issuedCode,
    null,
  );
  const code2 = re.issuedCode as string;
  assert.ok(code2 !== code1);
  await call("/me", "GET", undefined, 401, randomUUID(), code1);
  await call("/me", "GET", undefined, 200, randomUUID(), code2);
  const stale = await pool.connect();
  try {
    await stale.query("BEGIN");
    await assert.rejects(
      lockExperimentProof(stale, proof),
      (e) =>
        e instanceof ParticipantAccessError &&
        e.code === "experiment_code_invalidated",
    );
    await stale.query("ROLLBACK");
  } finally {
    stale.release();
  }
  assert.deepEqual(await state(sid), snapshot);
  assert.deepEqual(await state(legacy), legacyBefore);
  await call("/me", "GET", undefined, 200, randomUUID(), legacyToken.token);
  for (const path of [
    `/sessions/${sid}/start`,
    `/session-stages/${snapshot.stages[0].id}/start`,
    `/maps/${randomUUID()}/submit`,
    `/maps/${randomUUID()}/undo`,
  ]) {
    const gated = (await call(path, "POST", {}, 409, randomUUID(), code2)).data;
    assert.equal(gated.error, "experiment_learner_flow_unavailable");
  }
  checks.push(
    "same-page reconnect vs pending second client, explicit researcher switch, stale generations rejected; reissue keeps Session/Stage/map/event state and invalidates old code",
  );
  const bare = await registerExperimentSession(
    pool,
    { role: "researcher" },
    {
      requestKey: randomUUID(),
      runId: run.id,
      participantLabel: "TEST ONLY existing unissued",
    },
  );
  const bareBefore = await state(bare),
    issueKey = randomUUID();
  const issue = (
    await call(
      `${root}/${run.id}/participants/${bare}/code`,
      "POST",
      { expectedCredentialGeneration: 0 },
      200,
      issueKey,
    )
  ).data;
  assert.equal(issue.issuedCode.length, 43);
  assert.equal(
    (
      await call(
        `${root}/${run.id}/participants/${bare}/code`,
        "POST",
        { expectedCredentialGeneration: 0 },
        200,
        issueKey,
      )
    ).data.issuedCode,
    null,
  );
  assert.deepEqual(await state(bare), bareBefore);
  const registerRaceKey = randomUUID(),
    race = await Promise.all(
      [0, 1].map(() =>
        call(
          `${root}/${run.id}/participants`,
          "POST",
          { participantLabel: "TEST ONLY parallel" },
          201,
          registerRaceKey,
        ),
      ),
    );
  assert.equal(race[0].data.sessionId, race[1].data.sessionId);
  assert.equal(race.filter((r) => r.data.issuedCode).length, 1);
  const reRaceKey = randomUUID(),
    reRace = await Promise.all(
      [0, 1].map(() =>
        call(
          `${root}/${run.id}/participants/${sid}/code/reissue`,
          "POST",
          { expectedCredentialGeneration: 2 },
          200,
          reRaceKey,
        ),
      ),
    );
  assert.equal(reRace.filter((r) => r.data.issuedCode).length, 1);
  let currentCode = reRace.find((r) => r.data.issuedCode)!.data
    .issuedCode as string;
  checks.push(
    "initial issuance for stored code-less Session, parallel registration/reissue and lost one-time responses preserve IDs and rotate exactly once",
  );
  for (const failure of ["access", "audit"]) {
    const before = await counts(),
      op = randomUUID();
    if (failure === "access")
      await pool.query(
        "CREATE FUNCTION mock_access_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'TEST ONLY access failure';END$$;CREATE TRIGGER mock_access_fail BEFORE INSERT ON experiment_participant_access FOR EACH ROW EXECUTE FUNCTION mock_access_fail()",
      );
    else
      await pool.query(
        "CREATE FUNCTION mock_access_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='REGISTER' AND NEW.outcome='SUCCESS' THEN RAISE EXCEPTION 'TEST ONLY audit failure';END IF;RETURN NEW;END$$;CREATE TRIGGER mock_access_fail BEFORE INSERT ON experiment_access_audit FOR EACH ROW EXECUTE FUNCTION mock_access_fail()",
      );
    try {
      const failed = (
        await call(
          `${root}/${run.id}/participants`,
          "POST",
          { participantLabel: "TEST ONLY rollback" },
          503,
          op,
        )
      ).data;
      assert.equal(failed.error, "access_storage_unavailable");
      assert.ok(!JSON.stringify(failed).includes("failure"));
      assert.deepEqual(await counts(), before);
      await audit("REGISTER", run.id, 503, "access_storage_unavailable");
    } finally {
      await pool.query(
        `DROP TRIGGER mock_access_fail ON ${failure === "access" ? "experiment_participant_access" : "experiment_access_audit"};DROP FUNCTION mock_access_fail()`,
      );
    }
    await call(
      `${root}/${run.id}/participants`,
      "POST",
      { participantLabel: "TEST ONLY rollback" },
      201,
      op,
    );
  }
  // Hold an access row, enqueue reissue first, then a proof authenticated earlier.
  const captured = (await authenticateExperimentToken(
      pool,
      tokenHash(currentCode),
    ))!,
    holder = await pool.connect(),
    old = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT 1 FROM experiment_participant_access WHERE session_id=$1 FOR UPDATE",
      [sid],
    );
    const pending = call(
      `${root}/${run.id}/participants/${sid}/code/reissue`,
      "POST",
      { expectedCredentialGeneration: captured.credentialGeneration },
    );
    let waiting = false;
    for (let i = 0; i < 250; i++) {
      waiting = !!(
        await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM experiment_participant_access WHERE session_id=%' LIMIT 1",
        )
      ).rowCount;
      if (waiting) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(waiting, "reissue waits for the access row");
    await old.query("BEGIN");
    const staleResult = lockExperimentProof(old, captured).then(
      () => false,
      (e) =>
        e instanceof ParticipantAccessError &&
        e.code === "experiment_code_invalidated",
    );
    await holder.query("COMMIT");
    const rotated = (await pending).data;
    currentCode = rotated.issuedCode;
    assert.equal(await staleResult, true);
    await old.query("ROLLBACK");
  } finally {
    await holder.query("ROLLBACK");
    await old.query("ROLLBACK");
    holder.release();
    old.release();
  }
  assert.deepEqual(await state(sid), snapshot);
  const safety = await loadResearchTextSafety(pool);
  for (const secret of [code1, code2, currentCode, clientA, clientB])
    assert.equal(safety.containsKnownSecret(secret), true);
  const storedText = JSON.stringify(
    (
      await pool.query(
        "SELECT (SELECT jsonb_agg(to_jsonb(a)) FROM experiment_access_audit a) audit,(SELECT jsonb_agg(to_jsonb(o)) FROM experiment_access_operations o) operations,(SELECT jsonb_agg(to_jsonb(s)) FROM sessions s) sessions",
      )
    ).rows[0],
  );
  for (const secret of [code1, code2, currentCode, clientA, clientB])
    assert.ok(
      !storedText.includes(secret),
      "no plaintext credentials in stored records",
    );
  checks.push(
    "mid-write faults roll back identities/Session/stages/access/receipt; row-lock race refuses pre-reissue proof; current/retired/client hashes stay detectable without stored plaintext",
  );
  await writeFile(
    verificationReportPath("invariants").replace(
      /invariants\.json$/,
      "participant-access.json",
    ),
    JSON.stringify(
      {
        syntheticOnly: true,
        checks,
        learnerFlowEnabled: false,
        startEnabled: false,
        startSuccessAndPostStartRegistration:
          "DEFERRED_UNTIL_LEARNER_FLOW_EXISTS",
        nonemptyNewProtocolMapReissue:
          "NOT_TESTABLE_WHILE_MAP_CREATION_IS_GATED",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Participant access: PASS (${checks.length} groups; real API, credentials, clients, audit, races and closed learner gate; start deliberately unavailable)`,
  );
} finally {
  await pool.end();
}
