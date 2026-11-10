// Synthetic TEST ONLY fixtures. Not course content, defaults or research Sessions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { verifyMockTestUrl, verificationReportPath } from "./mock-db.js";
import { createExperimentRun } from "../experiment-foundation.js";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";
import type { MaterialBody } from "../material-catalog.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const token = process.env.RESEARCHER_API_TOKEN!,
  checks: string[] = [];
const prefix = "/research/materials";
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  status = 200,
  key = randomUUID(),
  credential = token,
) {
  const response = await fetch(process.env.API_BASE_URL + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + credential,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, status, `${method} ${path} status`);
  const payload = await response.json();
  return { payload, response };
}
async function audit(
  action: string,
  id: string | null,
  status: number,
  code: string,
) {
  const row = (
    await pool.query(
      "SELECT * FROM material_catalog_audit WHERE action=$1 AND target_id IS NOT DISTINCT FROM $2 ORDER BY server_timestamp DESC LIMIT 1",
      [action, id],
    )
  ).rows[0];
  assert.ok(row);
  assert.equal(row.http_status, status);
  assert.equal(row.reason_code, code);
  assert.equal(
    row.outcome,
    status >= 500 ? "FAILURE" : status >= 400 ? "REJECTED" : "SUCCESS",
  );
  assert.equal(
    row.reason,
    status >= 500
      ? "SERVER"
      : status === 409
        ? "CONFLICT"
        : status >= 400
          ? "VALIDATION"
          : null,
  );
}
async function fixture() {
  const imported = await call(
    "/research/goal-maps/import",
    "POST",
    {
      format: "sb-kb-goal-map",
      schemaVersion: 1,
      goalMap: {
        title: "TEST ONLY material asset " + randomUUID(),
        concepts: [
          { id: "a", label: "TEST ONLY alpha", position: { x: 10, y: 20 } },
          { id: "b", label: "TEST ONLY beta", position: { x: 90, y: 140 } },
        ],
        links: [
          {
            id: "ab",
            label: "TEST ONLY relation",
            sourceId: "a",
            targetId: "b",
            labelPosition: { x: 40, y: 70 },
          },
        ],
      },
    },
    201,
  );
  const goal = imported.payload.id as string,
    kit = imported.payload.kitDefinitionId as string;
  const parts = (
    await pool.query(
      "SELECT i.id,c.id AS concept_id FROM kit_concept_items i JOIN concepts c ON c.id=i.source_concept_id WHERE i.kit_definition_id=$1 ORDER BY c.position_x",
      [kit],
    )
  ).rows;
  const link = (
    await pool.query("SELECT id FROM links WHERE map_id=$1", [goal])
  ).rows[0].id;
  return { goal, kit, parts, link };
}
async function read(id: string) {
  return (await call(prefix + "/" + id)).payload;
}
async function save(id: string, body: MaterialBody) {
  const v = await read(id);
  return (
    await call(prefix + "/" + id, "PUT", {
      expectedRevision: v.editRevision,
      body,
    })
  ).payload;
}
const count = async (table: string) =>
  Number((await pool.query("SELECT count(*) n FROM " + table)).rows[0].n);
try {
  const a = await fixture(),
    other = await fixture();
  const learner = createLearnerToken();
  const session = (
    await pool.query(
      "INSERT INTO sessions(protocol_key,participant_code,lesson_video_url,research_kit_definition_id) VALUES('STAGE1_4','TEST ONLY material auth','/test-only.mp4',$1) RETURNING id",
      [other.kit],
    )
  ).rows[0].id;
  const c = await pool.connect();
  try {
    await storeLearnerToken(c, session, learner.hash);
  } finally {
    c.release();
  }
  const sessionCount = await count("sessions");
  const before = (
    await pool.query(
      "SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY id)::text) hash FROM sessions s",
    )
  ).rows[0].hash;
  await call(prefix, "GET", undefined, 401, randomUUID(), "");
  for (const [path, method, body] of [
    [prefix, "GET", undefined],
    [prefix, "POST", {}],
    [prefix + "/assets", "GET", undefined],
  ] as const)
    await call(path, method, body, 403, randomUUID(), learner.token);
  const key = randomUUID();
  const first = await call(prefix, "POST", {}, 201, key),
    id = first.payload.id as string;
  assert.equal((await call(prefix, "POST", {}, 201, key)).payload.id, id);
  let draft = await read(id);
  assert.equal(draft.body.integrationSeconds, null);
  assert.equal(draft.body.title, "");
  assert.equal(draft.body.kitId, null);
  const partial = { ...draft.body, title: "TEST ONLY draft" };
  await save(id, partial);
  const checked = (await call(prefix + `/${id}/check`, "POST")).payload;
  assert.equal(checked.ready, false);
  for (const field of [
    "videoRef",
    "sbInstructions",
    "kbInstructions",
    "integrationInstructions",
    "kitId",
    "seedConceptItemIds",
    "integrationSeconds",
  ])
    assert.ok(checked.issues.some((x: { field: string }) => x.field === field));
  draft = await read(id);
  const rejected = await call(
    prefix + `/${id}/publish`,
    "POST",
    { expectedRevision: draft.editRevision },
    422,
  );
  assert.equal(rejected.payload.error, "material_not_ready");
  assert.ok(rejected.payload.issues.length);
  await audit("PUBLISH", id, 422, "material_not_ready");
  checks.push(
    "incomplete drafts persist without defaults; required fields/time refusal and audit 422 REJECTED/VALIDATION",
  );
  const full: MaterialBody = {
    ...partial,
    videoRef: "/test-only.mp4",
    researcherDescription: "TEST ONLY 研究者向け説明",
    sbInstructions: "TEST ONLY SB instruction",
    kbInstructions: "TEST ONLY KB instruction",
    integrationInstructions: "TEST ONLY integration instruction",
    kitId: a.kit,
    seedConceptItemIds: [a.parts[0].id],
    integrationSeconds: 601,
  };
  await call(
    prefix + `/${id}`,
    "PUT",
    {
      expectedRevision: draft.editRevision,
      body: { ...full, seedConceptItemIds: [a.parts[0].id, a.parts[0].id] },
    },
    400,
  );
  await save(id, { ...full, seedConceptItemIds: [other.parts[0].id] });
  assert.ok(
    (await call(prefix + `/${id}/check`, "POST")).payload.issues.some(
      (x: { field: string }) => x.field === "seedConceptItemIds",
    ),
  );
  await save(id, full);
  draft = await read(id);
  const results = await Promise.all(
    ["TEST ONLY race one", "TEST ONLY race two"].map(async (title) => {
      const r = await fetch(
        process.env.API_BASE_URL + "/api" + prefix + "/" + id,
        {
          method: "PUT",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
            "Idempotency-Key": randomUUID(),
          },
          body: JSON.stringify({
            expectedRevision: draft.editRevision,
            body: { ...full, title },
          }),
        },
      );
      return r.status;
    }),
  );
  assert.deepEqual(results.sort(), [200, 409]);
  await audit("SAVE", id, 409, "material_revision_conflict");
  draft = await read(id);
  const retry = randomUUID();
  const saves = await Promise.all(
    [0, 1].map(() =>
      call(
        prefix + `/${id}`,
        "PUT",
        { expectedRevision: draft.editRevision, body: full },
        200,
        retry,
      ),
    ),
  );
  assert.equal(saves[0].payload.editRevision, saves[1].payload.editRevision);
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) n FROM material_catalog_requests WHERE request_key=$1",
          [retry],
        )
      ).rows[0].n,
    ),
    1,
  );
  checks.push(
    "foreign/duplicate seeds rejected for completion; optimistic concurrent writes and same-key saves create once",
  );
  const labelSecret = await read(id);
  const secretResponse = await call(
    prefix + `/${id}`,
    "PUT",
    {
      expectedRevision: labelSecret.editRevision,
      body: {
        ...full,
        researcherDescription: "TEST ONLY " + learner.token + " embedded",
      },
    },
    422,
  );
  assert.equal(secretResponse.payload.error, "material_sensitive_text");
  assert.ok(!JSON.stringify(secretResponse.payload).includes(learner.token));
  const budgetResponse = await call(
    prefix + `/${id}`,
    "PUT",
    {
      expectedRevision: labelSecret.editRevision,
      body: { ...full, researcherDescription: "Q".repeat(10000) },
    },
    422,
  );
  assert.equal(budgetResponse.payload.error, "safety_budget_exceeded");
  await audit("SAVE", id, 422, "safety_budget_exceeded");
  assert.equal((await read(id)).editRevision, labelSecret.editRevision);
  await pool.query(
    "ALTER TABLE research_identity.revocations RENAME TO mock_material_lookup_unavailable",
  );
  try {
    const failure = await call(
      prefix + `/${id}`,
      "PUT",
      { expectedRevision: labelSecret.editRevision, body: full },
      503,
    );
    assert.equal(failure.payload.error, "safety_lookup_unavailable");
    assert.ok(!JSON.stringify(failure.payload).includes("revocations"));
    await audit("SAVE", id, 503, "safety_lookup_unavailable");
  } finally {
    await pool.query(
      "ALTER TABLE research_identity.mock_material_lookup_unavailable RENAME TO revocations",
    );
  }
  assert.equal((await read(id)).editRevision, labelSecret.editRevision);
  checks.push(
    "secret/budget/lookup failures never save input; fixed HTTP codes match administrative audit without text",
  );
  assert.equal(
    (await call(prefix + `/${id}/check`, "POST")).payload.ready,
    true,
  );
  // A successful check is advisory; publication revalidates current resources.
  const uncovered = (
    await pool.query(
      "INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1,'TEST ONLY uncovered',0,0) RETURNING id",
      [a.goal],
    )
  ).rows[0].id;
  const stale = await read(id);
  await call(
    prefix + `/${id}/publish`,
    "POST",
    { expectedRevision: stale.editRevision },
    422,
  );
  await pool.query("DELETE FROM concepts WHERE id=$1", [uncovered]);
  await pool.query("UPDATE concepts SET label=$2 WHERE id=$1", [
    a.parts[0].concept_id,
    learner.token,
  ]);
  try {
    const invalidAsset = (await call(prefix + `/${id}/check`, "POST")).payload;
    assert.equal(invalidAsset.ready, false);
    assert.ok(
      invalidAsset.issues.some((x: { field: string }) => x.field === "kitId"),
    );
    assert.ok(!JSON.stringify(invalidAsset).includes(learner.token));
  } finally {
    await pool.query(
      "UPDATE concepts SET label='TEST ONLY alpha' WHERE id=$1",
      [a.parts[0].concept_id],
    );
  }
  draft = await read(id);
  const versionsBefore = await count("experiment_material_versions"),
    receiptsBefore = await count("material_catalog_requests");
  await pool.query(
    "CREATE FUNCTION mock_material_fail_seed() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'TEST ONLY injected seed failure'; END$$; CREATE TRIGGER mock_material_fail_seed BEFORE INSERT ON experiment_material_seeds FOR EACH ROW EXECUTE FUNCTION mock_material_fail_seed()",
  );
  const publishKey = randomUUID();
  try {
    const failed = await call(
      prefix + `/${id}/publish`,
      "POST",
      { expectedRevision: draft.editRevision },
      503,
      publishKey,
    );
    assert.equal(failed.payload.error, "material_storage_unavailable");
    assert.ok(!JSON.stringify(failed.payload).includes("injected"));
    await audit("PUBLISH", id, 503, "material_storage_unavailable");
    assert.equal(await count("experiment_material_versions"), versionsBefore);
    assert.equal(await count("material_catalog_requests"), receiptsBefore);
    assert.equal((await read(id)).state, "DRAFT");
  } finally {
    await pool.query(
      "DROP TRIGGER mock_material_fail_seed ON experiment_material_seeds; DROP FUNCTION mock_material_fail_seed()",
    );
  }
  await pool.query(
    "CREATE FUNCTION mock_material_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='PUBLISH' AND NEW.outcome='SUCCESS' THEN RAISE EXCEPTION 'TEST ONLY injected audit failure'; END IF;RETURN NEW;END$$; CREATE TRIGGER mock_material_fail_audit BEFORE INSERT ON material_catalog_audit FOR EACH ROW EXECUTE FUNCTION mock_material_fail_audit()",
  );
  try {
    await call(
      prefix + `/${id}/publish`,
      "POST",
      { expectedRevision: draft.editRevision },
      503,
      publishKey,
    );
    assert.equal(await count("experiment_material_versions"), versionsBefore);
    assert.equal((await read(id)).state, "DRAFT");
  } finally {
    await pool.query(
      "DROP TRIGGER mock_material_fail_audit ON material_catalog_audit; DROP FUNCTION mock_material_fail_audit()",
    );
  }
  const published = (
    await call(
      prefix + `/${id}/publish`,
      "POST",
      { expectedRevision: draft.editRevision },
      200,
      publishKey,
    )
  ).payload;
  assert.equal(published.state, "PUBLISHED");
  assert.ok(published.foundationVersionId);
  assert.equal(
    (
      await call(
        prefix + `/${id}/publish`,
        "POST",
        { expectedRevision: draft.editRevision },
        200,
        publishKey,
      )
    ).payload.foundationVersionId,
    published.foundationVersionId,
  );
  assert.equal(await count("experiment_material_versions"), versionsBefore + 1);
  await audit("PUBLISH", id, 200, "ok");
  checks.push(
    "seed/audit injected failures roll back foundation/seeds/catalog/receipt; retry publishes once atomically",
  );
  await call(
    prefix + `/${id}`,
    "PUT",
    { expectedRevision: published.editRevision, body: full },
    409,
  );
  await call(prefix + `/${id}`, "DELETE", undefined, 409);
  for (const sql of [
    "UPDATE material_catalog_versions SET body=body WHERE id=$1",
    "DELETE FROM material_catalog_versions WHERE id=$1",
  ])
    await assert.rejects(pool.query(sql, [id]));
  for (const [path, method, body] of [
    [
      `/concepts/${a.parts[0].concept_id}/label`,
      "PATCH",
      { label: "TEST ONLY forbidden" },
    ],
    [
      `/concepts/${a.parts[0].concept_id}/position`,
      "PATCH",
      { x: 900, y: 900 },
    ],
    [`/concepts/${a.parts[0].concept_id}`, "DELETE", undefined],
    [`/links/${a.link}/label`, "PATCH", { label: "TEST ONLY forbidden" }],
    [`/links/${a.link}/reconnect`, "PATCH", {}],
    [`/links/${a.link}`, "DELETE", undefined],
    [`/maps/${a.goal}/kits`, "POST", {}],
    [`/maps/${a.goal}/kit-definition`, "PATCH", {}],
    [
      `/maps/${a.goal}/concepts`,
      "POST",
      { label: "TEST ONLY forbidden", position: { x: 1, y: 1 } },
    ],
  ] as const) {
    const r = await call(path, method, body, 409);
    assert.equal(r.payload.error, "experiment_asset_frozen");
  }
  for (const [sql, value] of [
    [
      "UPDATE concepts SET label='TEST ONLY forbidden' WHERE id=$1",
      a.parts[0].concept_id,
    ],
    ["DELETE FROM links WHERE id=$1", a.link],
    ["DELETE FROM maps WHERE id=$1", a.goal],
    [
      "UPDATE kit_definitions SET name='TEST ONLY forbidden' WHERE id=$1",
      a.kit,
    ],
    ["DELETE FROM kit_concept_items WHERE id=$1", a.parts[0].id],
    [
      "UPDATE experiment_material_versions SET title=title WHERE id=$1",
      published.foundationVersionId,
    ],
  ] as const)
    await assert.rejects(pool.query(sql, [value]));
  const exported = (await call(`/research/goal-maps/${a.goal}/export`)).payload;
  exported.goalMap.title = "TEST ONLY independent import " + randomUUID();
  const imported = await call(
    "/research/goal-maps/import",
    "POST",
    exported,
    201,
  );
  assert.notEqual(imported.payload.id, a.goal);
  await call(
    "/research/goal-maps/import",
    "POST",
    { ...exported, targetMapId: a.goal },
    400,
  );
  checks.push(
    "published metadata and referenced Goal/Kit/parts immutable through API/SQL; import creates new IDs, never overwrites",
  );
  const run = await createExperimentRun(
    pool,
    { role: "researcher" },
    {
      requestKey: randomUUID(),
      materialVersionId: published.foundationVersionId,
      plannedParticipants: 1,
    },
  );
  const nextKey = randomUUID();
  const next = (
    await call(prefix + `/${id}/next-draft`, "POST", {}, 201, nextKey)
  ).payload;
  assert.equal(
    (await call(prefix + `/${id}/next-draft`, "POST", {}, 201, nextKey)).payload
      .id,
    next.id,
  );
  await call(prefix + `/${id}/next-draft`, "POST", {}, 409);
  await audit("NEXT", id, 409, "material_draft_exists");
  assert.equal(next.version, 2);
  assert.notEqual(next.id, id);
  const body2 = {
    ...(await read(next.id)).body,
    title: "TEST ONLY version two",
    sbInstructions: "TEST ONLY changed SB",
  };
  await save(next.id, body2);
  const d2 = await read(next.id);
  const samePublishKey = randomUUID();
  const concurrentPublished = await Promise.all(
    [0, 1].map(() =>
      call(
        prefix + `/${next.id}/publish`,
        "POST",
        { expectedRevision: d2.editRevision },
        200,
        samePublishKey,
      ),
    ),
  );
  const p2 = concurrentPublished[0].payload;
  assert.equal(
    p2.foundationVersionId,
    concurrentPublished[1].payload.foundationVersionId,
  );
  assert.notEqual(p2.foundationVersionId, published.foundationVersionId);
  assert.equal(
    (
      await pool.query(
        "SELECT material_version_id FROM experiment_runs WHERE id=$1",
        [run],
      )
    ).rows[0].material_version_id,
    published.foundationVersionId,
  );
  assert.equal((await read(id)).body.sbInstructions, full.sbInstructions);
  // Kit-registered Goals are read-only even before this feature. Exercise an
  // actually editable, unregistered Goal instead of weakening that contract.
  const editableGoal = (
    await pool.query(
      "INSERT INTO maps(type,title) VALUES('GOAL','TEST ONLY unregistered Goal') RETURNING id",
    )
  ).rows[0].id;
  const editableConcept = (
    await pool.query(
      "INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1,'TEST ONLY editable',0,0) RETURNING id",
      [editableGoal],
    )
  ).rows[0].id;
  const mutable = await call(`/concepts/${editableConcept}/label`, "PATCH", {
    label: "TEST ONLY mutable still editable",
  });
  assert.equal(mutable.response.status, 200);
  assert.equal(await count("sessions"), sessionCount);
  assert.equal(
    (
      await pool.query(
        "SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY id)::text) hash FROM sessions s",
      )
    ).rows[0].hash,
    before,
  );
  assert.ok(
    (await call(prefix)).payload.versions.some(
      (v: { id: string; state: string }) =>
        v.id === id && v.state === "PUBLISHED",
    ),
  );
  checks.push(
    "next draft/version preserves original run binding, one draft per series, unused assets and existing Session rows unchanged",
  );
  await writeFile(
    verificationReportPath("invariants").replace(
      /invariants\.json$/,
      "materials.json",
    ),
    JSON.stringify(
      {
        syntheticOnly: true,
        checks,
        publicExperimentExecutionEnabled: false,
        testRunAvailable: "PUBLISHED_ONLY",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Material catalog: PASS (${checks.length} groups; real API, SQL constraints, rollback, audit, authorization and version pinning)`,
  );
} finally {
  await pool.end();
}
