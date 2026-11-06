// TEST-ONLY source fixtures plus actual Merge/release/submit APIs, isolated DB only.
import assert from "node:assert/strict";
import { Pool } from "pg";
import { verifyMockTestUrl } from "./mock-db.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const researcher = process.env.RESEARCHER_API_TOKEN!,
  base = process.env.API_BASE_URL!;
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  token = researcher,
  status = 200,
) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, status, path);
  return r.json();
}
try {
  for (const release of [false, true]) {
    const s = await call(
      "/research/stage1/sessions",
      "POST",
      {
        participantCode: "TEST-ONLY-NESTED-FEATURE",
        videoUrl: "/test-only.mp4",
        kitDefinitionId: "66666666-6666-4666-8666-666666666662",
        seedConceptIds: [],
        surveyQuestions: [
          {
            kind: "TEXT",
            prompt: "TEST-ONLY feature fixture",
            required: true,
            config: {},
          },
        ],
      },
      researcher,
      201,
    );
    await pool.query(
      "UPDATE sessions SET status='IN_PROGRESS',started_at=clock_timestamp() WHERE id=$1",
      [s.id],
    );
    await pool.query(
      "UPDATE session_stages SET status='COMPLETED',started_at=clock_timestamp(),completed_at=clock_timestamp() WHERE session_id=$1 AND order_index<3",
      [s.id],
    );
    const stage = s.stages.find(
      (st: { stageType: string }) => st.stageType === "INTEGRATION_MAP",
    );
    await pool.query(
      "UPDATE session_stages SET status='IN_PROGRESS',started_at=clock_timestamp() WHERE id=$1",
      [stage.id],
    );
    for (const type of ["PRIOR_MAP", "KB_MAP"]) {
      const st = s.stages.find(
        (st: { stageType: string }) => st.stageType === type,
      );
      const map = (
        await pool.query(
          "INSERT INTO maps(type,status,submitted_at,session_stage_id,kit_definition_id) VALUES($1,'SUBMITTED',clock_timestamp(),$2,$3) RETURNING id",
          [
            type === "PRIOR_MAP" ? "PRIOR" : "KB",
            st.id,
            type === "KB_MAP" ? "66666666-6666-4666-8666-666666666662" : null,
          ],
        )
      ).rows[0];
      if (type === "PRIOR_MAP") {
        const ids: string[] = [];
        for (let i = 0; i < 3; i++)
          ids.push(
            (
              await pool.query(
                "INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1,$2,$3,0) RETURNING id",
                [map.id, "TEST-ONLY source " + i, i * 300],
              )
            ).rows[0].id,
          );
        for (let i = 0; i < 2; i++)
          await pool.query(
            "INSERT INTO links(map_id,label,source_concept_id,target_concept_id) VALUES($1,'TEST-ONLY source link',$2,$3)",
            [map.id, ids[i], ids[i + 1]],
          );
      }
    }
    const integration = await call(
      `/session-stages/${stage.id}/integration-map`,
      "POST",
      {},
      s.learnerAccessToken,
      201,
    );
    const initial = (
      await pool.query(
        "SELECT snapshot FROM map_initial_snapshots WHERE map_id=$1",
        [integration.id],
      )
    ).rows[0].snapshot;
    const [a, b, c] = initial.concepts;
    const m = await call(
      `/maps/${integration.id}/concepts/merge`,
      "POST",
      { conceptIds: [a.id, b.id], label: "TEST-ONLY M" },
      s.learnerAccessToken,
      201,
    );
    const n = await call(
      `/maps/${integration.id}/concepts/merge`,
      "POST",
      { conceptIds: [m.concept.id, c.id], label: "TEST-ONLY N" },
      s.learnerAccessToken,
      201,
    );
    if (release)
      await call(
        `/concepts/${n.concept.id}`,
        "DELETE",
        {},
        s.learnerAccessToken,
      );
    await call(
      `/maps/${integration.id}/submit`,
      "POST",
      {},
      s.learnerAccessToken,
    );
    const f = await call(
      `/research/stage1/sessions/${s.id}/descriptive-features`,
    );
    assert.equal(f.completion.status, "AVAILABLE");
    assert.deepEqual(
      [f.start.activeConcepts, f.start.hiddenMergeSources, f.start.links],
      [3, 0, 2],
    );
    assert.deepEqual(
      [
        f.completion.activeConcepts,
        f.completion.hiddenMergeSources,
        f.completion.links,
      ],
      release ? [2, 2, 2] : [1, 4, 2],
    );
    const db = (
      await pool.query(
        "SELECT count(*) FILTER(WHERE merged_into_concept_id IS NULL)::int active,count(*) FILTER(WHERE merged_into_concept_id IS NOT NULL)::int hidden,(SELECT count(*)::int FROM links WHERE map_id=$1) links FROM concepts WHERE map_id=$1",
        [integration.id],
      )
    ).rows[0];
    assert.deepEqual(
      [
        f.completion.activeConcepts,
        f.completion.hiddenMergeSources,
        f.completion.links,
      ],
      [db.active, db.hidden, db.links],
    );
    assert.deepEqual(
      [f.delta.activeConcepts, f.delta.hiddenMergeSources, f.delta.links],
      release ? [-1, 2, 0] : [-2, 4, 0],
    );
  }
  console.log(
    "Isolated real APIs: nested Merge submission 1 active/4 hidden, one-level release submission 2 active/2 hidden; snapshot/DB/features and deltas agree: PASS",
  );
} finally {
  await pool.end();
}
