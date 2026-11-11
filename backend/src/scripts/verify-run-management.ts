// TEST ONLY synthetic fixtures. Internal registration below tests the already
// existing storage service; no participant-registration API is introduced.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { verifyMockTestUrl, verificationReportPath } from "./mock-db.js";
import {
  createExperimentRun,
  registerExperimentSession,
} from "../experiment-foundation.js";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
  token = process.env.RESEARCHER_API_TOKEN!,
  root = "/research/experiment-runs",
  checks: string[] = [];
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  status = 200,
  key: string = randomUUID(),
  credential = token,
) {
  const r = await fetch(process.env.API_BASE_URL + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + credential,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, status, `${method} ${path}`);
  return { data: await r.json().catch(() => null), response: r };
}
const count = async (table: string) =>
  Number((await pool.query("SELECT count(*) n FROM " + table)).rows[0].n);
async function audit(
  action: string,
  id: string | null,
  status: number,
  code: string,
) {
  const a = (
    await pool.query(
      "SELECT * FROM experiment_run_audit WHERE action=$1 AND target_id IS NOT DISTINCT FROM $2 ORDER BY server_timestamp DESC LIMIT 1",
      [action, id],
    )
  ).rows[0];
  assert.ok(a);
  assert.equal(a.http_status, status);
  assert.equal(a.reason_code, code);
  assert.equal(
    a.outcome,
    status >= 500 ? "FAILURE" : status >= 400 ? "REJECTED" : "SUCCESS",
  );
  assert.equal(
    a.reason,
    status >= 500
      ? "SERVER"
      : status === 409
        ? "CONFLICT"
        : status >= 400
          ? "VALIDATION"
          : null,
  );
}
try {
  const imported = (
    await call(
      "/research/goal-maps/import",
      "POST",
      {
        format: "sb-kb-goal-map",
        schemaVersion: 1,
        goalMap: {
          title: "TEST ONLY run asset " + randomUUID(),
          concepts: [
            { id: "a", label: "TEST ONLY A", position: { x: 0, y: 0 } },
            { id: "b", label: "TEST ONLY B", position: { x: 100, y: 100 } },
          ],
          links: [],
        },
      },
      201,
    )
  ).data;
  const part = (
    await pool.query(
      "SELECT id FROM kit_concept_items WHERE kit_definition_id=$1 ORDER BY id LIMIT 1",
      [imported.kitDefinitionId],
    )
  ).rows[0].id;
  const draft = (await call("/research/materials", "POST", {}, 201)).data;
  const body = {
    title: "TEST ONLY run material",
    researcherDescription: "TEST ONLY researcher description",
    videoRef: "/test-only.mp4",
    sbInstructions: "TEST ONLY SB",
    kbInstructions: "TEST ONLY KB",
    integrationInstructions: "TEST ONLY integration",
    kitId: imported.kitDefinitionId,
    seedConceptItemIds: [part],
    integrationSeconds: 601,
  };
  const saved = (
    await call(`/research/materials/${draft.id}`, "PUT", {
      expectedRevision: draft.editRevision,
      body,
    })
  ).data;
  const material = (
    await call(`/research/materials/${draft.id}/publish`, "POST", {
      expectedRevision: saved.editRevision,
    })
  ).data;
  const learner = createLearnerToken();
  const authSession = (
    await pool.query(
      "INSERT INTO sessions(protocol_key,participant_code,lesson_video_url,research_kit_definition_id) VALUES('STAGE1_4','TEST ONLY run auth','/test-only.mp4',$1) RETURNING id",
      [imported.kitDefinitionId],
    )
  ).rows[0].id;
  const auth = await pool.connect();
  try {
    await storeLearnerToken(auth, authSession, learner.hash);
  } finally {
    auth.release();
  }
  const legacyBefore = (
    await pool.query(
      "SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY id)::text) hash FROM sessions s WHERE protocol_key IN ('STAGE1_4','STAGE1_5','STAGE1_6')",
    )
  ).rows[0].hash;
  const sessionsBefore = await count("sessions"),
    stagesBefore = await count("session_stages"),
    mapsBefore = await count("maps"),
    versionsBefore = await count("experiment_material_versions");
  const input = {
    name: "TEST ONLY run",
    catalogVersionId: material.id,
    plannedParticipants: 1,
  };
  await call(root, "GET", undefined, 401, randomUUID(), "");
  for (const [path, method, payload] of [
    [root, "GET", undefined],
    [root, "POST", input],
    [root + "/material-versions", "GET", undefined],
  ] as const)
    await call(path, method, payload, 403, randomUUID(), learner.token);
  const key = randomUUID(),
    created = (await call(root, "POST", input, 201, key)).data;
  assert.equal(created.state, "PREPARING");
  assert.equal(created.registeredSessions, 0);
  assert.equal(created.integrationSeconds, 601);
  assert.equal(created.materialVersionId, material.foundationVersionId);
  assert.equal(created.catalogVersionId, material.id);
  assert.equal(await count("sessions"), sessionsBefore);
  assert.equal(await count("session_stages"), stagesBefore);
  assert.equal(await count("maps"), mapsBefore);
  assert.equal(await count("experiment_material_versions"), versionsBefore);
  await audit("CREATE", created.id, 201, "ok");
  assert.equal((await call(root + "/" + created.id)).data.name, input.name);
  assert.ok(
    (await call(root)).data.runs.some(
      (r: { id: string }) => r.id === created.id,
    ),
  );
  await call(
    root + "/" + created.id,
    "GET",
    undefined,
    403,
    randomUUID(),
    learner.token,
  );
  checks.push(
    "researcher-only create/list/read; PREPARING run pins published material/time, zero Session/Stage/Map creation",
  );
  const parallelKey = randomUUID(),
    parallel = await Promise.all(
      [0, 1].map((i) =>
        call(
          root,
          "POST",
          input,
          201,
          i ? parallelKey.toUpperCase() : parallelKey,
        ),
      ),
    );
  assert.equal(parallel[0].data.id, parallel[1].data.id);
  assert.equal((await call(root, "POST", input, 201, key)).data.id, created.id);
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) n FROM experiment_runs WHERE request_key=$1",
          [parallelKey],
        )
      ).rows[0].n,
    ),
    1,
  );
  await call(root, "POST", { ...input, name: "TEST ONLY changed" }, 409, key);
  await audit("CREATE", null, 409, "run_request_conflict");
  const standaloneKey = randomUUID();
  const standalone = await createExperimentRun(
    pool,
    { role: "researcher" },
    {
      requestKey: standaloneKey,
      materialVersionId: material.foundationVersionId,
      plannedParticipants: 1,
    },
  );
  await call(root, "POST", input, 409, standaloneKey);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) n FROM experiment_run_catalog WHERE run_id=$1",
        [standalone],
      )
    ).rows[0].n,
    "0",
  );
  await call(root + "/" + standalone, "GET", undefined, 404);
  checks.push(
    "same-key concurrent retry creates once; changed payload rejected; existing standalone runs never adopted",
  );
  const unfinished = (await call("/research/materials", "POST", {}, 201)).data;
  for (const id of [
    unfinished.id,
    randomUUID(),
    material.foundationVersionId,
  ]) {
    await call(root, "POST", { ...input, catalogVersionId: id }, 422);
    await audit("CREATE", null, 422, "run_material_unavailable");
  }
  for (const planned of [-1, 0.5, "20", 2147483648])
    await call(root, "POST", { ...input, plannedParticipants: planned }, 400);
  await call(root, "POST", { ...input, integrationSeconds: 999 }, 400);
  await call(root, "POST", { ...input, participants: [{}] }, 400);
  const zero = (
    await call(
      root,
      "POST",
      { ...input, name: "TEST ONLY zero", plannedParticipants: 0 },
      201,
    )
  ).data;
  assert.equal(zero.plannedParticipants, 0);
  const boundary = (
    await call(
      root,
      "POST",
      {
        ...input,
        name: "TEST ONLY integer boundary",
        plannedParticipants: 2147483647,
      },
      201,
    )
  ).data;
  assert.equal(boundary.plannedParticipants, 2147483647);
  const secret = (await call(root, "POST", { ...input, name: token }, 422))
    .data;
  assert.equal(secret.error, "run_sensitive_text");
  assert.ok(!JSON.stringify(secret).includes(token));
  checks.push(
    "only published catalog IDs accepted; no client time/participant injection; technical integer boundary and zero allowed, no business cap",
  );
  for (const failure of ["metadata", "audit"]) {
    const before = await count("experiment_runs"),
      metaBefore = await count("experiment_run_catalog"),
      retry = randomUUID();
    if (failure === "metadata")
      await pool.query(
        "CREATE FUNCTION mock_run_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'TEST ONLY injected run failure';END$$; CREATE TRIGGER mock_run_fail BEFORE INSERT ON experiment_run_catalog FOR EACH ROW EXECUTE FUNCTION mock_run_fail()",
      );
    else
      await pool.query(
        "CREATE FUNCTION mock_run_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.outcome='SUCCESS' AND NEW.action='CREATE' THEN RAISE EXCEPTION 'TEST ONLY injected run failure';END IF;RETURN NEW;END$$; CREATE TRIGGER mock_run_fail BEFORE INSERT ON experiment_run_audit FOR EACH ROW EXECUTE FUNCTION mock_run_fail()",
      );
    try {
      const failed = (await call(root, "POST", input, 503, retry)).data;
      assert.equal(failed.error, "run_storage_unavailable");
      assert.ok(!JSON.stringify(failed).includes("injected"));
      await audit("CREATE", null, 503, "run_storage_unavailable");
      assert.equal(await count("experiment_runs"), before);
      assert.equal(await count("experiment_run_catalog"), metaBefore);
    } finally {
      await pool.query(
        `DROP TRIGGER mock_run_fail ON ${failure === "metadata" ? "experiment_run_catalog" : "experiment_run_audit"};DROP FUNCTION mock_run_fail()`,
      );
    }
    const recovered = (await call(root, "POST", input, 201, retry)).data;
    assert.equal(
      (await call(root, "POST", input, 201, retry)).data.id,
      recovered.id,
    );
  }
  await pool.query(
    "ALTER TABLE research_identity.revocations RENAME TO mock_run_lookup_unavailable",
  );
  try {
    for (const [path, method, payload, action] of [
      [root, "POST", input, "CREATE"],
      [root, "GET", undefined, "LIST"],
      [root + "/material-versions", "GET", undefined, "MATERIALS"],
      [root + "/" + created.id, "GET", undefined, "READ"],
    ] as const) {
      const failed = (await call(path, method, payload, 503)).data;
      assert.equal(failed.error, "safety_lookup_unavailable");
      assert.ok(!JSON.stringify(failed).includes("revocations"));
      await audit(
        action,
        action === "READ" ? created.id : null,
        503,
        "safety_lookup_unavailable",
      );
    }
  } finally {
    await pool.query(
      "ALTER TABLE research_identity.mock_run_lookup_unavailable RENAME TO revocations",
    );
  }
  checks.push(
    "metadata/audit failure rolls back run/receipt; retry succeeds; lookup errors yield safe 503 FAILURE/SERVER on every new path",
  );
  const next = (
    await call(`/research/materials/${material.id}/next-draft`, "POST", {}, 201)
  ).data;
  const saved2 = (
    await call(`/research/materials/${next.id}`, "PUT", {
      expectedRevision: next.editRevision,
      body: {
        ...body,
        title: "TEST ONLY later material",
        integrationSeconds: 777,
      },
    })
  ).data;
  const v2 = (
    await call(`/research/materials/${next.id}/publish`, "POST", {
      expectedRevision: saved2.editRevision,
    })
  ).data;
  const fixed = (await call(root + "/" + created.id)).data;
  assert.equal(fixed.materialVersionId, material.foundationVersionId);
  assert.equal(fixed.integrationSeconds, 601);
  assert.notEqual(fixed.materialVersionId, v2.foundationVersionId);
  for (const [sql, value] of [
    [
      "UPDATE experiment_runs SET material_version_id=$2 WHERE id=$1",
      v2.foundationVersionId,
    ],
    [
      "UPDATE experiment_run_catalog SET catalog_version_id=$2 WHERE run_id=$1",
      v2.id,
    ],
  ])
    await assert.rejects(pool.query(sql, [created.id, value]));
  await assert.rejects(
    pool.query(
      "UPDATE experiment_material_versions SET integration_seconds=999 WHERE id=$1",
      [material.foundationVersionId],
    ),
  );
  // End now exists, but requires confirmation and an actually running experiment.
  await call(root + "/" + created.id + "/end", "POST", {}, 400);
  await call(root + "/" + created.id + "/end", "POST", {confirmed:true}, 409);
  assert.equal((await call(root + "/" + created.id)).data.state,"PREPARING");
  await call(root + "/" + created.id + "/learner-token", "POST", {}, 404);
  // Existing internal-only service proves future registration is not capped.
  for (let n = 0; n < 2; n++)
    await registerExperimentSession(
      pool,
      { role: "researcher" },
      {
        requestKey: randomUUID(),
        runId: created.id,
        participantLabel: "TEST ONLY future registration " + n,
      },
    );
  const registered = (await call(root + "/" + created.id)).data;
  assert.equal(registered.plannedParticipants, 1);
  assert.equal(registered.registeredSessions, 2);
  assert.equal(registered.state, "PREPARING");
  const member = (
    await pool.query(
      "SELECT session_id FROM experiment_run_sessions WHERE run_id=$1 LIMIT 1",
      [created.id],
    )
  ).rows[0].session_id;
  await call(`/sessions/${member}/start`, "POST", {}, 409);
  assert.equal(
    (
      await pool.query(
        "SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY id)::text) hash FROM sessions s WHERE protocol_key IN ('STAGE1_4','STAGE1_5','STAGE1_6')",
      )
    ).rows[0].hash,
    legacyBefore,
  );
  checks.push(
    "later versions do not replace pin/time; DB immutable; future internal registration exceeds planned count while public start/register/code routes stay unavailable",
  );
  await writeFile(
    verificationReportPath("invariants").replace(
      /invariants\.json$/,
      "runs.json",
    ),
    JSON.stringify(
      {
        syntheticOnly: true,
        checks,
        publicParticipantRegistration: false,
        publicRunStart: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Run management: PASS (${checks.length} groups; real API, atomicity, authorization, pinning, counts, audits and fail-closed routes)`,
  );
} finally {
  await pool.end();
}
