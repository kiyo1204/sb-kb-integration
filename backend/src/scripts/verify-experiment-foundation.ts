// TEST-ONLY synthetic content, not experimental materials or defaults.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { verifyMockTestUrl, verificationReportPath } from "./mock-db.js";
import { writeFile } from "node:fs/promises";
import {
  publishMaterialVersion,
  createExperimentRun,
  registerExperimentSession,
  getMaterialVersion,
  getExperimentSession,
  getExperimentRun,
  resolveExperimentOwnership,
  EXPERIMENT_PROTOCOL,
} from "../experiment-foundation.js";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const actor = { role: "researcher" as const },
  checks: string[] = [];
async function kit() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const goal = (
      await c.query(
        "INSERT INTO maps(type,title) VALUES('GOAL',$1) RETURNING id",
        ["TEST ONLY " + randomUUID()],
      )
    ).rows[0].id as string;
    const a = (
      await c.query(
        "INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1,'TEST ONLY alpha',10,20) RETURNING id",
        [goal],
      )
    ).rows[0].id as string;
    const b = (
      await c.query(
        "INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1,'TEST ONLY beta',100,200) RETURNING id",
        [goal],
      )
    ).rows[0].id as string;
    const link = (
      await c.query(
        "INSERT INTO links(map_id,source_concept_id,target_concept_id,label) VALUES($1,$2,$3,'TEST ONLY relation') RETURNING id",
        [goal, a, b],
      )
    ).rows[0].id as string;
    const id = (
      await c.query(
        "INSERT INTO kit_definitions(goal_map_id,name) VALUES($1,'TEST ONLY kit') RETURNING id",
        [goal],
      )
    ).rows[0].id as string;
    const seed = (
      await c.query(
        "INSERT INTO kit_concept_items(kit_definition_id,source_concept_id) VALUES($1,$2) RETURNING id",
        [id, a],
      )
    ).rows[0].id as string;
    await c.query(
      "INSERT INTO kit_concept_items(kit_definition_id,source_concept_id) VALUES($1,$2)",
      [id, b],
    );
    const part = (
      await c.query(
        "INSERT INTO kit_link_items(kit_definition_id,source_link_id) VALUES($1,$2) RETURNING id",
        [id, link],
      )
    ).rows[0].id as string;
    await c.query("COMMIT");
    return { goal, a, b, link, id, seed, part };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
function input(k: Awaited<ReturnType<typeof kit>>) {
  return {
    requestKey: randomUUID(),
    title: "TEST ONLY material",
    videoRef: "/test-only.mp4",
    sbInstructions: "TEST ONLY SB instruction",
    kbInstructions: "TEST ONLY KB instruction",
    integrationInstructions: "TEST ONLY integration instruction",
    kitId: k.id,
    seedConceptItemIds: [k.seed],
    integrationSeconds: 600,
  };
}
async function count(table: string) {
  return Number(
    (await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count,
  );
}
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  token = process.env.RESEARCHER_API_TOKEN!,
  expected = 409,
) {
  const r = await fetch(process.env.API_BASE_URL + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, expected, path);
  return r.json();
}
try {
  const old = (
    await pool.query(
      "SELECT md5(coalesce(jsonb_agg(to_jsonb(s) ORDER BY id)::text,'')) hash FROM sessions s WHERE protocol_key IN('STAGE1_4','STAGE1_5','STAGE1_6')",
    )
  ).rows[0].hash;
  const k = await kit(),
    foreign = await kit(),
    vinput = input(k);
  await assert.rejects(
    publishMaterialVersion(
      pool,
      { role: "learner", sessionId: randomUUID(), kitId: k.id },
      vinput,
    ),
  );
  await assert.rejects(
    publishMaterialVersion(pool, actor, {
      ...vinput,
      seedConceptItemIds: [k.seed, k.seed],
    }),
  );
  const versions = await count("experiment_material_versions");
  await assert.rejects(
    publishMaterialVersion(pool, actor, {
      ...vinput,
      seedConceptItemIds: [foreign.seed],
    }),
  );
  assert.equal(await count("experiment_material_versions"), versions);
  const partial = await kit();
  await pool.query("DELETE FROM kit_link_items WHERE kit_definition_id=$1", [
    partial.id,
  ]);
  await assert.rejects(publishMaterialVersion(pool, actor, input(partial)));
  checks.push(
    "foreign/duplicate seeds, incomplete Kit and learner service calls rejected atomically",
  );
  await assert.rejects(
    publishMaterialVersion(pool, actor, {
      ...vinput,
      sbInstructions: process.env.RESEARCHER_API_TOKEN!,
    }),
    /foundation_sensitive_text/,
  );
  await assert.rejects(
    publishMaterialVersion(pool, actor, {
      ...vinput,
      kbInstructions: "password=TEST_ONLY_SYNTHETIC_CREDENTIAL",
    }),
    /foundation_sensitive_text/,
  );
  const [version, again] = await Promise.all([
    publishMaterialVersion(pool, actor, vinput),
    publishMaterialVersion(pool, actor, vinput),
  ]);
  assert.equal(version, again);
  await assert.rejects(
    publishMaterialVersion(pool, actor, {
      ...vinput,
      title: "TEST ONLY conflicting request",
    }),
  );
  assert.equal(
    (await getMaterialVersion(pool, actor, version)).integration_seconds,
    600,
  );
  const originalResearcher = process.env.RESEARCHER_API_TOKEN;
  try {
    process.env.RESEARCHER_API_TOKEN = vinput.integrationInstructions;
    assert.equal(
      (await getMaterialVersion(pool, actor, version)).integration_instructions,
      "[REDACTED]",
    );
  } finally {
    process.env.RESEARCHER_API_TOKEN = originalResearcher;
  }
  const denied: Array<[string, unknown[]]> = [
    [
      "UPDATE kit_definitions SET goal_map_id=$2 WHERE id=$1",
      [k.id, foreign.goal],
    ],
    ["UPDATE concepts SET map_id=$2 WHERE id=$1", [k.a, foreign.goal]],
    [
      "INSERT INTO kit_concept_items(kit_definition_id,source_concept_id) VALUES($1,$2)",
      [k.id, foreign.a],
    ],
    ["TRUNCATE concepts CASCADE", []],
    ["UPDATE maps SET title=$2 WHERE id=$1", [k.goal, "TEST ONLY changed"]],
    ["DELETE FROM maps WHERE id=$1", [k.goal]],
    [
      "INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1,$2,1,1)",
      [k.goal, "TEST ONLY added"],
    ],
    ["UPDATE concepts SET label=$2 WHERE id=$1", [k.a, "TEST ONLY changed"]],
    ["UPDATE concepts SET position_x=99 WHERE id=$1", [k.a]],
    ["DELETE FROM concepts WHERE id=$1", [k.a]],
    ["UPDATE links SET label=$2 WHERE id=$1", [k.link, "TEST ONLY changed"]],
    ["UPDATE links SET target_concept_id=$2 WHERE id=$1", [k.link, k.a]],
    ["DELETE FROM links WHERE id=$1", [k.link]],
    [
      "UPDATE kit_definitions SET name=$2 WHERE id=$1",
      [k.id, "TEST ONLY changed"],
    ],
    ["DELETE FROM kit_definitions WHERE id=$1", [k.id]],
    [
      "INSERT INTO kit_definitions(goal_map_id,name) VALUES($1,$2)",
      [k.goal, "TEST ONLY reregistered"],
    ],
    ["DELETE FROM kit_concept_items WHERE id=$1", [k.seed]],
    [
      "UPDATE kit_link_items SET source_link_id=$2 WHERE id=$1",
      [k.part, k.link],
    ],
    [
      "UPDATE experiment_material_versions SET integration_seconds=1 WHERE id=$1",
      [version],
    ],
    ["DELETE FROM experiment_material_versions WHERE id=$1", [version]],
    [
      "INSERT INTO experiment_material_seeds VALUES($1,$2)",
      [version, foreign.seed],
    ],
    ["DELETE FROM experiment_material_seeds WHERE version_id=$1", [version]],
  ];
  for (const [q, p] of denied) await assert.rejects(pool.query(q, p));
  checks.push(
    "published version, seeds, Goal, Concept/Link and Kit/parts immutable through SQL",
  );
  // API import creates new resources; it must not alter the frozen source.
  const exported = await call(
    `/research/goal-maps/${k.goal}/export`,
    "GET",
    undefined,
    undefined,
    200,
  );
  // Accept the actual transfer route contract below after inspecting its format.
  assert.equal(exported.format, "sb-kb-goal-map");
  const portable = structuredClone(exported);
  portable.goalMap.title = "TEST ONLY imported " + randomUUID();
  await call("/research/goal-maps/import", "POST", portable, undefined, 201);
  for (const [path, method, body] of [
    [`/concepts/${k.a}/label`, "PATCH", { label: "TEST ONLY new" }],
    [`/concepts/${k.a}/position`, "PATCH", { positionX: 9, positionY: 9 }],
    [
      `/links/${k.link}/reconnect`,
      "PATCH",
      { sourceConceptId: k.a, targetConceptId: k.b },
    ],
    [
      `/maps/${k.goal}/kits`,
      "POST",
      {
        name: "TEST ONLY reregister",
        conceptIds: [k.a, k.b],
        linkIds: [k.link],
      },
    ],
  ] as const) {
    assert.equal(
      (await call(path, method, body)).error,
      "experiment_asset_frozen",
    );
  }
  checks.push(
    "real API frozen mutation/reregistration refusal and independent JSON import",
  );
  const reg = {
    requestKey: randomUUID(),
    participantLabel: "TEST ONLY participant",
  };
  const runInput = {
    requestKey: randomUUID(),
    materialVersionId: version,
    plannedParticipants: 1,
    participants: [reg],
  };
  const run = await createExperimentRun(pool, actor, runInput);
  assert.equal(await createExperimentRun(pool, actor, runInput), run);
  const sid = (
    await pool.query(
      "SELECT session_id FROM experiment_run_sessions WHERE run_id=$1",
      [run],
    )
  ).rows[0].session_id as string;
  await registerExperimentSession(pool, actor, {
    requestKey: randomUUID(),
    participantLabel: "TEST ONLY extra",
    runId: run,
  });
  const saved = await getExperimentRun(pool, actor, run);
  assert.equal(saved.planned_participants, 1);
  assert.equal(saved.registered_participants, 2);
  assert.equal(saved.state, "PREPARING");
  assert.deepEqual(
    (
      await pool.query(
        "SELECT stage_type FROM session_stages WHERE session_id=$1 ORDER BY order_index",
        [sid],
      )
    ).rows.map((x) => x.stage_type),
    ["LESSON", "PRIOR_MAP", "KB_MAP", "INTEGRATION_MAP"],
  );
  const session = (
    await pool.query("SELECT * FROM sessions WHERE id=$1", [sid])
  ).rows[0];
  assert.equal(session.learner_access_token_hash, null);
  assert.equal(session.research_kit_definition_id, k.id);
  assert.equal(session.group_activity_seconds, 600);
  assert.equal(session.study_group, null);
  const fetched = await getExperimentSession(pool, actor, sid);
  assert.equal(fetched.stages.length, 4);
  assert.ok(!("learner_access_token_hash" in fetched));
  const stages = (
    await pool.query(
      "SELECT id FROM session_stages WHERE session_id=$1 ORDER BY order_index",
      [sid],
    )
  ).rows;
  assert.equal(
    (
      await resolveExperimentOwnership(
        pool,
        actor,
        "session-stages",
        stages[0].id,
      )
    ).run_id,
    run,
  );
  assert.equal(
    await resolveExperimentOwnership(
      pool,
      { role: "learner", sessionId: randomUUID(), kitId: k.id },
      "sessions",
      sid,
    ),
    null,
  );
  assert.equal(
    (
      await resolveExperimentOwnership(
        pool,
        { role: "learner", sessionId: sid, kitId: k.id },
        "sessions",
        sid,
      )
    ).session_id,
    sid,
  );
  await assert.rejects(
    pool.query("UPDATE sessions SET learner_access_token_hash=$2 WHERE id=$1", [
      sid,
      "a".repeat(64),
    ]),
  );
  await assert.rejects(
    pool.query(
      "UPDATE session_stages SET status='IN_PROGRESS',started_at=now() WHERE id=$1",
      [stages[0].id],
    ),
  );
  await assert.rejects(
    pool.query("INSERT INTO maps(type,session_stage_id) VALUES('PRIOR',$1)", [
      stages[1].id,
    ]),
  );
  await assert.rejects(
    pool.query(
      "UPDATE experiment_runs SET material_version_id=$2 WHERE id=$1",
      [run, version],
    ),
  );
  await assert.rejects(
    pool.query(
      "UPDATE experiment_run_sessions SET run_id=$2 WHERE session_id=$1",
      [sid, run],
    ),
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO experiment_run_sessions(session_id,run_id,request_key,request_hash) VALUES($1,$2,$3,$4)",
      [sid, run, randomUUID(), "test"],
    ),
  );
  // Direct SQL cannot commit an orphan or a material-mismatched execution.
  for (const mismatch of [false, true]) {
    const c = await pool.connect();
    const beforeRows = await count("sessions");
    try {
      await c.query("BEGIN");
      const x = (
        await c.query(
          `INSERT INTO sessions(protocol_key,participant_code,lesson_video_url,research_kit_definition_id,group_activity_seconds) VALUES($1,'TEST ONLY mismatch','/test-only.mp4',$2,600) RETURNING id`,
          [EXPERIMENT_PROTOCOL, mismatch ? foreign.id : k.id],
        )
      ).rows[0].id;
      if (mismatch) {
        await c.query(
          "INSERT INTO experiment_run_sessions(session_id,run_id,request_key,request_hash) VALUES($1,$2,$3,$4)",
          [x, run, randomUUID(), "test-only"],
        );
        for (const [i, t] of [
          "LESSON",
          "PRIOR_MAP",
          "KB_MAP",
          "INTEGRATION_MAP",
        ].entries())
          await c.query(
            "INSERT INTO session_stages(session_id,stage_type,order_index) VALUES($1,$2,$3)",
            [x, t, i],
          );
        await c.query("INSERT INTO session_seed_concepts VALUES($1,$2)", [
          x,
          k.seed,
        ]);
      }
      await assert.rejects(
        c.query("COMMIT"),
        (e) => (e as { code: string }).code === "23514",
      );
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    assert.equal(await count("sessions"), beforeRows);
  }
  checks.push(
    "atomic run/session/stages/membership, counts not capped, ownership and storage-only DB guards",
  );
  for (const [path, method, body] of [
    [`/sessions/${sid}/start`, "POST", {}],
    [`/session-stages/${stages[0].id}/start`, "POST", {}],
    [`/research/stage1/sessions/${sid}/learner-token`, "POST", {}],
    [
      "/research/data-management/cleanup",
      "POST",
      { sessionId: sid, confirm: "DELETE_UNSTARTED" },
    ],
    ["/research/data-management/preview", "POST", { sessionId: sid }],
  ] as const) {
    assert.equal(
      (await call(path, method, body)).error,
      "experiment_storage_only",
    );
  }
  await call(`/sessions/${sid}`, "GET", undefined, "", 401);
  const token = createLearnerToken();
  const oldSession = (
    await pool.query(
      "INSERT INTO sessions(protocol_key,participant_code,lesson_video_url,research_kit_definition_id) VALUES('STAGE1_4','TEST ONLY auth','/test.mp4',$1) RETURNING id",
      [foreign.id],
    )
  ).rows[0].id as string;
  const auth = await pool.connect();
  try {
    await storeLearnerToken(auth, oldSession, token.hash);
  } finally {
    auth.release();
  }
  await call(`/sessions/${sid}/start`, "POST", {}, token.token, 404);
  checks.push(
    "real API start/stage/token/deletion refusals, missing auth and different Session denied",
  );
  await pool.query(
    "ALTER FUNCTION experiment_asset_is_frozen(uuid) RENAME TO mock_foundation_lookup_unavailable",
  );
  try {
    const refusal = await call(
      `/concepts/${k.a}/label`,
      "PATCH",
      { label: "TEST ONLY fault" },
      undefined,
      503,
    );
    assert.equal(refusal.error, "experiment_guard_unavailable");
    assert.ok(!JSON.stringify(refusal).includes("SELECT"));
  } finally {
    await pool.query(
      "ALTER FUNCTION mock_foundation_lookup_unavailable(uuid) RENAME TO experiment_asset_is_frozen",
    );
  }
  // An actual write failure must roll back the run, identity trigger, stages and association.
  const before = [
    await count("experiment_runs"),
    await count("sessions"),
    await count("research_identity.participants"),
  ];
  await pool.query(
    "CREATE FUNCTION mock_foundation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST ONLY injected failure'; END $$; CREATE TRIGGER mock_foundation_failure BEFORE INSERT ON session_stages FOR EACH ROW EXECUTE FUNCTION mock_foundation_failure()",
  );
  const retry = {
    requestKey: randomUUID(),
    materialVersionId: version,
    plannedParticipants: 0,
    participants: [
      { requestKey: randomUUID(), participantLabel: "TEST ONLY retry" },
    ],
  };
  try {
    await assert.rejects(
      createExperimentRun(pool, actor, retry),
      /foundation_storage_failed/,
    );
    assert.deepEqual(
      [
        await count("experiment_runs"),
        await count("sessions"),
        await count("research_identity.participants"),
      ],
      before,
    );
  } finally {
    await pool.query(
      "DROP TRIGGER mock_foundation_failure ON session_stages; DROP FUNCTION mock_foundation_failure()",
    );
  }
  const results = await Promise.all([
    createExperimentRun(pool, actor, retry),
    createExperimentRun(pool, actor, retry),
  ]);
  assert.equal(results[0], results[1]);
  assert.equal(
    (await getExperimentRun(pool, actor, results[0])).registered_participants,
    1,
  );
  checks.push(
    "injected mid-stage failure rolls back identities/run/session; concurrent retry creates once",
  );
  // Frozen commit must be visible to an earlier repeatable-read writer.
  const concurrent = await kit(),
    oldWriter = await pool.connect();
  try {
    await oldWriter.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await oldWriter.query("SELECT count(*) FROM experiment_material_versions");
    await publishMaterialVersion(pool, actor, input(concurrent));
    await assert.rejects(
      oldWriter.query("UPDATE concepts SET position_x=123 WHERE id=$1", [
        concurrent.a,
      ]),
      (e) => (e as { code: string }).code === "40001",
    );
  } finally {
    await oldWriter.query("ROLLBACK");
    oldWriter.release();
  }
  // Writer first: publication waits, then freezes the committed content.
  const race = await kit(),
    writer = await pool.connect();
  let published: string;
  try {
    await writer.query("BEGIN");
    await writer.query("UPDATE concepts SET position_x=321 WHERE id=$1", [
      race.a,
    ]);
    const pending = publishMaterialVersion(pool, actor, input(race));
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      if (
        (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%experiment_lock_asset%' LIMIT 1",
          )
        ).rowCount
      ) {
        waiting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(waiting, "publication must wait for the resource writer");
    await writer.query("COMMIT");
    published = await pending;
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
  assert.ok(published!);
  assert.equal(
    (await pool.query("SELECT position_x FROM concepts WHERE id=$1", [race.a]))
      .rows[0].position_x,
    321,
  );
  await assert.rejects(
    pool.query("UPDATE concepts SET position_x=999 WHERE id=$1", [race.a]),
  );
  checks.push(
    "publication/writer concurrency and old repeatable-read snapshots cannot bypass freeze",
  );
  const after = (
    await pool.query(
      "SELECT md5(coalesce(jsonb_agg(to_jsonb(s) ORDER BY id)::text,'')) hash FROM sessions s WHERE protocol_key IN('STAGE1_4','STAGE1_5','STAGE1_6') AND id<>$1",
      [oldSession],
    )
  ).rows[0].hash;
  assert.equal(old, after);
  await writeFile(
    verificationReportPath("invariants").replace(
      /invariants\.json$/,
      "foundation.json",
    ),
    JSON.stringify(
      {
        protocol: EXPERIMENT_PROTOCOL,
        checks,
        existingSessionsUnchanged: true,
        publicExecutionEnabled: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Experiment foundation: PASS (" +
      checks.length +
      " groups; SQL, internal services and actual public API refusals)",
  );
} finally {
  await pool.end();
}
