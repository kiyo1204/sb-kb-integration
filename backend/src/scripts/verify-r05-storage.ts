// TEST ONLY: internal R05 storage. Does not prove a complete R05 flow.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { writeFile } from "node:fs/promises";
import { verifyMockTestUrl, verificationReportPath } from "./mock-db.js";
import { mutateMaterial, materialAssets } from "../material-catalog.js";
import {
  mutateR05Storage,
  readR05Test,
  R05StorageError,
} from "../r05-storage.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
  actor = { role: "researcher" } as const;
const rejected = (code: string) => (e: unknown) =>
  e instanceof R05StorageError && e.code === code;
try {
  const assets = await materialAssets(pool, actor);
  const asset = assets.assets.find(
    (x: { concepts: unknown[]; available: boolean }) =>
      x.available && x.concepts.length,
  );
  assert.ok(asset, "synthetic seeded Kit exists");
  const draft = await mutateMaterial(
    pool,
    actor,
    "CREATE",
    randomUUID(),
    null,
    {},
  );
  const body = {
    title: "TEST ONLY R05 storage",
    researcherDescription: "",
    videoRef: "/test-only.mp4",
    sbInstructions: "TEST ONLY SB",
    kbInstructions: "TEST ONLY KB",
    integrationInstructions: "TEST ONLY integration",
    kitId: asset.kitId,
    seedConceptItemIds: [asset.concepts[0].id],
    integrationSeconds: 31,
  };
  const saved = await mutateMaterial(
    pool,
    actor,
    "SAVE",
    randomUUID(),
    draft.id,
    { expectedRevision: draft.editRevision, body },
  );
  await assert.rejects(
    mutateR05Storage(pool, actor, "CREATE", randomUUID(), draft.id),
    rejected("published_material_required"),
  );
  const version = await mutateMaterial(
    pool,
    actor,
    "PUBLISH",
    randomUUID(),
    draft.id,
    { expectedRevision: saved.editRevision },
  );
  const baseline = async () =>
    (
      await pool.query(
        `SELECT (SELECT count(*) FROM sessions)::text sessions,(SELECT count(*) FROM maps)::text maps,(SELECT count(*) FROM research_events)::text events,(SELECT md5(body::text) FROM material_catalog_versions WHERE id=$1) material`,
        [version.id],
      )
    ).rows[0];
  const before = await baseline();
  await assert.rejects(
    mutateR05Storage(
      pool,
      { role: "learner" },
      "CREATE",
      randomUUID(),
      version.id,
    ),
    rejected("forbidden"),
  );
  const key = randomUUID();
  const [a, b] = await Promise.all([
    mutateR05Storage(pool, actor, "CREATE", key, version.id),
    mutateR05Storage(pool, actor, "CREATE", key, version.id),
  ]);
  assert.equal(a.id, b.id);
  await assert.rejects(
    readR05Test(pool, { role: "learner" }, a.id),
    rejected("forbidden"),
  );
  await assert.rejects(
    mutateR05Storage(pool, actor, "CREATE", randomUUID(), version.id),
    rejected("test_already_exists_or_completed"),
  );
  const map = (
    await pool.query(
      `INSERT INTO r05_test_maps(test_run_id,map_kind,state) VALUES($1,'SB','{}') RETURNING id`,
      [a.id],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO r05_test_history(test_map_id,sequence_number,operation) VALUES($1,1,'{}')`,
    [map],
  );
  const view = await readR05Test(pool, actor, a.id);
  assert.equal(view.maps.length, 1);
  assert.equal(view.history.length, 1);
  await assert.rejects(
    mutateR05Storage(pool, actor, "DELETE", randomUUID(), version.id, {
      runId: a.id,
      confirmation: "wrong",
    }),
    rejected("confirmation_changed"),
  );
  await pool.query(
    `CREATE FUNCTION mock_r05_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST ONLY rollback';END $$;CREATE TRIGGER mock_r05_fault BEFORE INSERT ON r05_storage_audit FOR EACH ROW EXECUTE FUNCTION mock_r05_fault()`,
  );
  const deletionKey = randomUUID();
  try {
    await assert.rejects(
      mutateR05Storage(pool, actor, "DELETE", deletionKey, version.id, {
        runId: a.id,
        confirmation: view.confirmation,
      }),
    );
    assert.equal((await readR05Test(pool, actor, a.id)).history.length, 1);
    await assert.rejects(
      mutateR05Storage(pool, actor, "CREATE", randomUUID(), version.id),
      rejected("test_already_exists_or_completed"),
    );
  } finally {
    await pool.query(
      "DROP TRIGGER mock_r05_fault ON r05_storage_audit;DROP FUNCTION mock_r05_fault()",
    );
  }
  const deleted = await mutateR05Storage(
    pool,
    actor,
    "DELETE",
    deletionKey,
    version.id,
    { runId: a.id, confirmation: view.confirmation },
  );
  assert.ok(deleted.deleted);
  assert.deepEqual(
    await mutateR05Storage(pool, actor, "DELETE", deletionKey, version.id, {
      runId: a.id,
      confirmation: view.confirmation,
    }),
    deleted,
  );
  const next = await mutateR05Storage(
    pool,
    actor,
    "CREATE",
    randomUUID(),
    version.id,
  );
  assert.notEqual(next.id, a.id);
  await assert.rejects(
    pool.query(
      `INSERT INTO r05_submission_acceptances(test_run_id,material_version_id,submission_kind) VALUES($1,$2,'MANUAL')`,
      [next.id, version.id],
    ),
  );
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO r05_test_maps(test_run_id,map_kind,state,submitted_at,submission_kind) VALUES($1,'INTEGRATION','{}',clock_timestamp(),'MANUAL') RETURNING submitted_at`,
      [next.id],
    );
    // Keep PostgreSQL microseconds: JS Date round-trips truncate them.
    await c.query(
      `INSERT INTO r05_submission_acceptances(test_run_id,material_version_id,submission_kind,accepted_at) SELECT test_run_id,$2,submission_kind,submitted_at FROM r05_test_maps WHERE test_run_id=$1 AND map_kind='INTEGRATION'`,
      [next.id, version.id],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  const completed = await readR05Test(pool, actor, next.id);
  await mutateR05Storage(pool, actor, "DELETE", randomUUID(), version.id, {
    runId: next.id,
    confirmation: completed.confirmation,
  });
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM r05_submission_acceptances WHERE material_version_id=$1",
        [version.id],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    mutateR05Storage(pool, actor, "CREATE", randomUUID(), version.id),
    rejected("test_already_exists_or_completed"),
  );
  assert.deepEqual(await baseline(), before);
  await writeFile(
    verificationReportPath("invariants").replace(
      "invariants.json",
      "r05-storage.json",
    ),
    JSON.stringify(
      {
        status: "PASS",
        scope: "internal storage only; no R05 API/UI",
        checks: [
          "researcher role",
          "published version",
          "parallel same key",
          "live run conflict",
          "confirmation",
          "rollback/retry",
          "cascade history deletion",
          "new run after incomplete deletion",
          "acceptance prerequisites",
          "retained acceptance blocks completed retest",
          "research rows unchanged",
        ],
      },
      null,
      2,
    ),
  );
  console.log("R05 internal storage: PASS");
} finally {
  await pool.end();
}
