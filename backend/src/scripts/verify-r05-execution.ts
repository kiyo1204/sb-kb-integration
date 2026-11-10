// TEST ONLY real isolated API. R05 operations never use participant credentials.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { verifyMockTestUrl, verificationReportPath } from "./mock-db.js";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";
import { extractionQuery } from "../event-export-query.js";
import { replayMapAt } from "../map-history.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
  base = process.env.API_BASE_URL!,
  token = process.env.RESEARCHER_API_TOKEN!;
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  status = 200,
  key = randomUUID(),
  auth = token,
) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + auth,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json();
  assert.equal(r.status, status, method + " " + path + " " + (d.error ?? ""));
  return d;
}
async function fixture(seconds: number) {
  const g = await call(
    "/research/goal-maps/import",
    "POST",
    {
      format: "sb-kb-goal-map",
      schemaVersion: 1,
      goalMap: {
        title: "TEST ONLY R05 " + randomUUID(),
        concepts: [
          { id: "a", label: "TEST ONLY alpha", position: { x: 80, y: 120 } },
          { id: "b", label: "TEST ONLY beta", position: { x: 330, y: 120 } },
        ],
        links: [
          {
            id: "ab",
            label: "TEST ONLY relation",
            sourceId: "a",
            targetId: "b",
            labelPosition: null,
          },
        ],
      },
    },
    201,
  );
  const asset = (await call("/research/materials/assets")).assets.find(
    (x: { kitId: string }) => x.kitId === g.kitDefinitionId,
  );
  const d = await call("/research/materials", "POST", {}, 201);
  const s = await call("/research/materials/" + d.id, "PUT", {
    expectedRevision: d.editRevision,
    body: {
      title: "TEST ONLY R05 version",
      researcherDescription: "",
      videoRef: "/test-only.mp4",
      sbInstructions: "TEST ONLY SB",
      kbInstructions: "TEST ONLY KB",
      integrationInstructions: "TEST ONLY integration",
      kitId: g.kitDefinitionId,
      seedConceptItemIds: [asset.concepts[0].id],
      integrationSeconds: seconds,
    },
  });
  return call("/research/materials/" + d.id + "/publish", "POST", {
    expectedRevision: s.editRevision,
  });
}
const root = (v: string) => "/research/materials/" + v + "/r05";
async function operation(
  v: string,
  id: string,
  executionId: string,
  action: string,
  data: Record<string, unknown> = {},
  status = 200,
  key = randomUUID(),
) {
  const view = await call(root(v));
  return call(
    root(v) + "/" + id + "/operations",
    "POST",
    { executionId, expectedRevision: view.run.revision, action, data },
    status,
    key,
  );
}
async function throughKB(v: string, id: string, e: string) {
  await operation(v, id, e, "LESSON_COMPLETE", { viewed: true });
  let view = await call(root(v));
  let map = view.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "SB",
  );
  await operation(
    v,
    id,
    e,
    "EDIT_CONCEPT",
    { id: map.state.concepts[0].id, label: "TEST ONLY forbidden" },
    409,
  );
  await operation(v, id, e, "SUBMIT");
  await operation(v, id, e, "CHECK");
  await operation(v, id, e, "SUBMIT", {}, 409);
  view = await call(root(v));
  for (const p of view.material.concepts)
    await operation(v, id, e, "IMPORT_KIT_CONCEPT", {
      partId: p.id,
      x: 120,
      y: 120,
    });
  view = await call(root(v));
  map = view.data.maps.find((m: { map_kind: string }) => m.map_kind === "KB");
  const ids = new Map<string, string>(
    map.state.concepts.map(
      (c: { id: string; provenance: { sourceConceptId: string }[] }) => [
        c.provenance[0].sourceConceptId,
        c.id,
      ],
    ),
  );
  for (const l of view.material.links)
    await operation(v, id, e, "IMPORT_KIT_LINK", {
      partId: l.id,
      sourceId: ids.get(l.sourceConceptId),
      targetId: ids.get(l.targetConceptId),
    });
  const good = await operation(v, id, e, "CHECK");
  assert.equal(good.outcome.matched, true);
  view = await call(root(v));
  map = view.data.maps.find((m: { map_kind: string }) => m.map_kind === "KB");
  await operation(v, id, e, "MOVE_CONCEPT", {
    id: map.state.concepts[0].id,
    x: 350,
    y: 225,
  });
  // Position changes retain the current structural signature.
  assert.ok((await call(root(v))).run.lastCheck);
  const link = map.state.links[0];
  await operation(v, id, e, "RECONNECT_LINK", {
    id: link.id,
    sourceId: link.targetConceptId,
    targetId: link.sourceConceptId,
  });
  await operation(v, id, e, "SUBMIT", {}, 409);
  const bad = await operation(v, id, e, "CHECK");
  assert.equal(bad.outcome.matched, false);
  await operation(v, id, e, "UNDO");
  await operation(v, id, e, "SUBMIT", {}, 409); // mismatch check cleared the earlier match
  await operation(v, id, e, "CHECK");
  await operation(v, id, e, "SUBMIT");
}
try {
  const version = await fixture(180),
    v = version.id,
    e = randomUUID(),
    startKey = randomUUID();
  const cred = createLearnerToken();
  const s = (
    await pool.query(
      `INSERT INTO sessions(protocol_key,participant_code,lesson_video_url,research_kit_definition_id) SELECT 'STAGE1_4','TEST ONLY R05 authorization','/test-only.mp4',kit_id FROM experiment_material_versions WHERE id=$1 RETURNING id`,
      [version.foundationVersionId],
    )
  ).rows[0];
  // Catalog DTO property is verified below; keep the fixture independent of DTO aliases.
  assert.ok(s, "learner authorization fixture is required");
  if (s) {
    const c = await pool.connect();
    try {
      await storeLearnerToken(c, s.id, cred.hash);
    } finally {
      c.release();
    }
  }
  await call(root(v), "GET", undefined, 401, randomUUID(), "");
  if (s)
    for (const [path, method, body] of [
      [root(v), "POST", { executionId: e }],
      [root(v), "GET", undefined],
      [
        root(v) + "/" + randomUUID(),
        "DELETE",
        { confirmed: true, confirmation: "x" },
      ],
      [root(v) + "/" + randomUUID() + "/operations", "POST", {}],
    ] as const)
      await call(path, method, body, 403, randomUUID(), cred.token);
  const baseline = async () => {
    const snapshot = (
      await pool.query(
        `SELECT (SELECT count(*) FROM sessions)::int sessions,(SELECT count(*) FROM maps)::int maps,(SELECT count(*) FROM concepts)::int concepts,(SELECT count(*) FROM links)::int links,(SELECT count(*) FROM research_events)::int events,(SELECT count(*) FROM experiment_runs)::int runs,(SELECT count(*) FROM experiment_participant_access)::int access`,
      )
    ).rows[0];
    const q = extractionQuery({
      sessionIds: [],
      learnerIds: [],
      groups: [],
      activities: [],
      eventTypes: [],
      from: null,
      to: null,
    });
    const rows = (await pool.query(q.text, q.values)).rows;
    return { snapshot, eventJson: JSON.stringify(rows) };
  };
  const before = await baseline();
  const a = await call(root(v), "POST", { executionId: e }, 200, startKey);
  assert.deepEqual(
    await call(root(v), "POST", { executionId: e }, 200, startKey),
    a,
  );
  await call(root(v), "POST", { executionId: randomUUID() }, 409);
  await throughKB(v, a.id, e);
  let view = await call(root(v));
  let map = view.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "INTEGRATION",
  );
  await operation(v, a.id, e, "CHECK", {}, 404);
  await operation(v, a.id, e, "ADD_CONCEPT", {
    label: "TEST ONLY merge A",
    x: 100,
    y: 100,
  });
  await operation(v, a.id, e, "ADD_CONCEPT", {
    label: "TEST ONLY merge B",
    x: 300,
    y: 100,
  });
  view = await call(root(v));
  map = view.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "INTEGRATION",
  );
  const x = map.state.concepts.find(
      (c: { label: string }) => c.label === "TEST ONLY merge A",
    ),
    y = map.state.concepts.find(
      (c: { label: string }) => c.label === "TEST ONLY merge B",
    );
  await operation(v, a.id, e, "MERGE_CONCEPT", {
    sourceId: x.id,
    targetId: y.id,
    label: "TEST ONLY merged",
  });
  view = await call(root(v));
  map = view.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "INTEGRATION",
  );
  const m = map.state.concepts.find(
    (c: { label: string }) => c.label === "TEST ONLY merged",
  );
  await operation(v, a.id, e, "ADD_CONCEPT", {
    label: "TEST ONLY merge C",
    x: 500,
    y: 150,
  });
  view = await call(root(v));
  map = view.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "INTEGRATION",
  );
  const third = map.state.concepts.find(
    (c: { label: string }) => c.label === "TEST ONLY merge C",
  );
  await operation(v, a.id, e, "MERGE_CONCEPT", {
    sourceId: m.id,
    targetId: third.id,
    label: "TEST ONLY outer merge",
  });
  view = await call(root(v));
  map = view.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "INTEGRATION",
  );
  const outer = map.state.concepts.find(
    (c: { label: string }) => c.label === "TEST ONLY outer merge",
  );
  await operation(v, a.id, e, "DELETE_CONCEPT", { id: outer.id });
  view = await call(root(v));
  map = view.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "INTEGRATION",
  );
  assert.equal(
    map.state.concepts.find((c: { id: string }) => c.id === x.id)
      .mergedIntoConceptId,
    m.id,
    "inner Merge is retained",
  );
  await operation(v, a.id, e, "DELETE_CONCEPT", { id: m.id });
  await operation(v, a.id, e, "UNDO");
  await operation(v, a.id, e, "REDO");
  view = await call(root(v));
  map = view.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "INTEGRATION",
  );
  const logs = view.data.history
    .filter((h: { test_map_id: string }) => h.test_map_id === map.id)
    .map((h: { operation: unknown }) => h.operation);
  const replay = replayMapAt(map.initial_state, logs, logs.length);
  assert.equal(replay.status, "REPLAYABLE");
  if (replay.status === "REPLAYABLE") assert.deepEqual(replay.state, map.state);
  assert.deepEqual(
    await baseline(),
    before,
    "live R05 maps/history did not write normal rows/events",
  );
  await call("/research/sessions/" + a.id + "/export", "GET", undefined, 404);
  const exported = await call(
    "/research/event-exports",
    "POST",
    { filters: { sessionIds: [a.id] } },
    201,
  );
  for (const file of ["events.json", "events.csv"]) {
    const response = await fetch(
      base + "/api/research/event-exports/" + exported.exportId + "/" + file,
      { headers: { Authorization: "Bearer " + token } },
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    if (file.endsWith(".json")) assert.equal(JSON.parse(text).events.length, 0);
    assert.ok(!text.includes("TEST ONLY merge A"));
    assert.ok(!text.includes(map.id));
  }
  await call("/research/event-exports/" + exported.exportId, "DELETE");
  const afterExport = await baseline(); // Export may legitimately add its own audit metadata.
  const failedKey = randomUUID();
  await pool.query(
    `CREATE FUNCTION mock_r05_submit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST ONLY private submit fault';END $$;CREATE TRIGGER mock_r05_submit_fault BEFORE INSERT ON r05_submission_acceptances FOR EACH ROW EXECUTE FUNCTION mock_r05_submit_fault()`,
  );
  try {
    const failure = await operation(v, a.id, e, "SUBMIT", {}, 503, failedKey);
    assert.ok(!JSON.stringify(failure).includes("private submit fault"));
    assert.equal((await call(root(v))).acceptance, null);
    assert.equal(
      (
        await pool.query("SELECT submitted_at FROM r05_test_maps WHERE id=$1", [
          map.id,
        ])
      ).rows[0].submitted_at,
      null,
    );
  } finally {
    await pool.query(
      "DROP TRIGGER mock_r05_submit_fault ON r05_submission_acceptances;DROP FUNCTION mock_r05_submit_fault()",
    );
  }
  const revision = (await call(root(v))).run.revision,
    body = {
      executionId: e,
      expectedRevision: revision,
      action: "SUBMIT",
      data: {},
    };
  const accepted = await Promise.all([
    call(root(v) + "/" + a.id + "/operations", "POST", body, 200, failedKey),
    call(root(v) + "/" + a.id + "/operations", "POST", body, 200, failedKey),
  ]);
  assert.deepEqual(accepted[0], accepted[1]);
  assert.equal(accepted[0].accepted, true);
  assert.equal((await call(root(v))).acceptance.submission_kind, "MANUAL");
  const preview = await call(root(v) + "/" + a.id + "/deletion-preview");
  await call(root(v) + "/" + a.id, "DELETE", {
    confirmed: true,
    confirmation: preview.confirmation,
  });
  assert.ok((await call(root(v))).acceptance);
  assert.equal((await call(root(v))).run, null);
  await call(root(v), "POST", { executionId: randomUUID() }, 409);
  assert.deepEqual(
    await baseline(),
    afterExport,
    "R05 submission/deletion did not write normal research rows/events",
  );
  for (const suffix of [
    "analysis",
    "operations.csv",
    "evaluations.csv",
    "reflections.csv",
    "features.csv",
  ])
    await call(
      "/research/stage1/sessions/" + a.id + "/" + suffix,
      "GET",
      undefined,
      404,
    );
  const pinned = (
    await pool.query(
      `SELECT c.id,c.label FROM material_catalog_versions v JOIN experiment_material_versions f ON f.id=v.foundation_version_id JOIN kit_definitions k ON k.id=f.kit_id JOIN concepts c ON c.map_id=k.goal_map_id WHERE v.id=$1 LIMIT 1`,
      [v],
    )
  ).rows[0];
  await assert.rejects(
    pool.query("UPDATE concepts SET label=$2 WHERE id=$1", [
      pinned.id,
      "TEST ONLY frozen mutation",
    ]),
  );
  assert.equal(
    (await pool.query("SELECT label FROM concepts WHERE id=$1", [pinned.id]))
      .rows[0].label,
    pinned.label,
  );
  const auto = await fixture(1),
    ae = randomUUID(),
    ar = await call(root(auto.id), "POST", { executionId: ae });
  await throughKB(auto.id, ar.id, ae);
  let finished = false;
  for (let i = 0; i < 50; i++) {
    const result = await operation(auto.id, ar.id, ae, "TICK");
    if (result.accepted) {
      finished = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(finished);
  assert.equal(
    (await call(root(auto.id))).acceptance.submission_kind,
    "AUTOMATIC",
  );
  const interrupted = await fixture(180),
    ie = randomUUID(),
    ir = await call(root(interrupted.id), "POST", { executionId: ie });
  await operation(
    interrupted.id,
    ir.id,
    randomUUID(),
    "LESSON_COMPLETE",
    { viewed: true },
    409,
  );
  await operation(interrupted.id, ir.id, ie, "INTERRUPT");
  assert.equal((await call(root(interrupted.id))).acceptance, null);
  await operation(
    interrupted.id,
    ir.id,
    ie,
    "LESSON_COMPLETE",
    { viewed: true },
    409,
  );
  const ip = await call(
    root(interrupted.id) + "/" + ir.id + "/deletion-preview",
  );
  const deleteKey = randomUUID();
  await pool.query(
    `CREATE FUNCTION mock_r05_api_delete_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='DELETE' THEN RAISE EXCEPTION 'TEST ONLY private delete fault';END IF;RETURN NEW;END $$;CREATE TRIGGER mock_r05_api_delete_fault BEFORE INSERT ON r05_storage_audit FOR EACH ROW EXECUTE FUNCTION mock_r05_api_delete_fault()`,
  );
  try {
    await call(
      root(interrupted.id) + "/" + ir.id,
      "DELETE",
      { confirmed: true, confirmation: ip.confirmation },
      503,
      deleteKey,
    );
    assert.equal((await call(root(interrupted.id))).run.id, ir.id);
    await call(
      root(interrupted.id),
      "POST",
      { executionId: randomUUID() },
      409,
    );
  } finally {
    await pool.query(
      "DROP TRIGGER mock_r05_api_delete_fault ON r05_storage_audit;DROP FUNCTION mock_r05_api_delete_fault()",
    );
  }
  await call(
    root(interrupted.id) + "/" + ir.id,
    "DELETE",
    { confirmed: true, confirmation: ip.confirmation },
    200,
    deleteKey,
  );
  await call(root(interrupted.id), "POST", { executionId: randomUUID() });
  if (process.env.RESEARCH_BROWSER_CHECKS === "1") {
    const browserMaterial = await fixture(180);
    const child = spawn(
      process.execPath,
      [process.env.npm_execpath!, "run", "test:r05-browser"],
      {
        cwd: "../frontend",
        env: { ...process.env, R05_BROWSER_VERSION: browserMaterial.id },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    assert.equal((await once(child, "exit"))[0], 0);
  }
  await writeFile(
    verificationReportPath("invariants").replace(
      "invariants.json",
      "r05-execution.json",
    ),
    JSON.stringify(
      {
        status: "PASS",
        scope: "real R05 API and optional browser",
        manual: true,
        automatic: true,
        rollback: true,
        isolation: true,
      },
      null,
      2,
    ),
  );
  console.log("R05 real execution API: PASS");
} finally {
  await pool.end();
}
