// Synthetic regression only. No labels, questions, counts or timing here are experiment recommendations.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { parse } from "csv-parse/sync";
import { writeFile } from "node:fs/promises";
import { verifyMockTestUrl } from "./mock-db.js";
import { createStage1Session } from "../sessions.js";
import { insertResearchEvent } from "../research-events.js";
import type { MapHistorySnapshot } from "../map-history.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const base = process.env.API_BASE_URL!,
  researcher = process.env.RESEARCHER_API_TOKEN!;
let token = researcher;
const checks: string[] = [];
async function request(
  path: string,
  status = 200,
  method = "GET",
  body?: unknown,
  key?: string,
  auth = token,
) {
  const r = await fetch(base + "/api" + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + auth,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  assert.equal(
    r.status,
    status,
    method + " " + path + ": " + text.slice(0, 700),
  );
  return r.headers.get("content-type")?.includes("json")
    ? JSON.parse(text)
    : text;
}
const research = (path: string, status = 200, method = "GET", body?: unknown) =>
  request(path, status, method, body, undefined, researcher);
const clean = (x: unknown) => JSON.parse(JSON.stringify(x));
function graph(s: MapHistorySnapshot) {
  const prov = (p: unknown[]) =>
    clean(p).sort((a: { id: string }, b: { id: string }) =>
      a.id.localeCompare(b.id),
    );
  return {
    concepts: s.concepts
      .map((c) => ({
        id: c.id,
        label: c.label,
        positionX: c.positionX,
        positionY: c.positionY,
        mergedIntoConceptId: c.mergedIntoConceptId ?? null,
        provenance: prov(c.provenance ?? []),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    links: s.links
      .map((l) => ({
        id: l.id,
        label: l.label,
        sourceConceptId: l.sourceConceptId,
        targetConceptId: l.targetConceptId,
        labelPositionX: l.labelPositionX ?? null,
        labelPositionY: l.labelPositionY ?? null,
        provenance: prov(l.provenance ?? []),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
async function dbState(id: string): Promise<MapHistorySnapshot> {
  const concepts = (
    await pool.query(
      'SELECT id,map_id AS "mapId",label,position_x AS "positionX",position_y AS "positionY",merged_into_concept_id AS "mergedIntoConceptId" FROM concepts WHERE map_id=$1',
      [id],
    )
  ).rows;
  const links = (
    await pool.query(
      'SELECT id,map_id AS "mapId",label,source_concept_id AS "sourceConceptId",target_concept_id AS "targetConceptId",label_position_x AS "labelPositionX",label_position_y AS "labelPositionY" FROM links WHERE map_id=$1',
      [id],
    )
  ).rows;
  for (const c of concepts)
    c.provenance = clean(
      (
        await pool.query(
          'SELECT id,target_concept_id AS "targetConceptId",source_concept_id AS "sourceConceptId",relation_type AS "relationType",created_at AS "createdAt" FROM concept_provenance WHERE target_concept_id=$1',
          [c.id],
        )
      ).rows,
    );
  for (const l of links)
    l.provenance = clean(
      (
        await pool.query(
          'SELECT id,target_link_id AS "targetLinkId",source_link_id AS "sourceLinkId",relation_type AS "relationType",created_at AS "createdAt" FROM link_provenance WHERE target_link_id=$1',
          [l.id],
        )
      ).rows,
    );
  return {
    snapshotVersion: 1,
    mapId: id,
    mapType: "INTEGRATION",
    basedOnMapId: null,
    kitDefinitionId: null,
    concepts,
    links,
  };
}
async function checkpoint(sid: string, id: string) {
  const replay = await research(
    `/research/sessions/${sid}/maps/${id}/mixed-history`,
  );
  assert.equal(replay.status, "REPLAYABLE", replay.reason);
  const state = await dbState(id);
  assert.deepEqual(
    graph(replay.state),
    graph(state),
    "DB/replay checkpoint " + id,
  );
  return state;
}
async function undo(id: string, action: "UNDO" | "REDO") {
  const state = await request(`/maps/${id}/undo-redo`);
  return request(`/maps/${id}/undo-redo`, 200, "POST", {
    action,
    expectedSequenceNumber: state.sequenceNumber,
    idempotencyKey: randomUUID(),
  });
}
async function legacyFixture(protocol: "STAGE1_4" | "STAGE1_6", kit: string) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    let id: string;
    if (protocol === "STAGE1_6")
      id = (
        await createStage1Session(c, {
          participantCode: "TEST-ONLY-LEGACY",
          lessonVideoUrl: "/test-only.mp4",
          kitDefinitionId: kit,
          studyGroup: "EXPERIMENTAL",
          groupActivitySeconds: 600,
        })
      ).id;
    else {
      id = (
        await c.query(
          "INSERT INTO sessions(protocol_key,participant_code,lesson_video_url,research_kit_definition_id) VALUES('STAGE1_4','TEST-ONLY-LEGACY','/test-only.mp4',$1) RETURNING id",
          [kit],
        )
      ).rows[0].id;
      for (const [i, t] of [
        "LESSON",
        "PRIOR_MAP",
        "KB_MAP",
        "INTEGRATION_MAP",
      ].entries())
        await c.query(
          "INSERT INTO session_stages(session_id,stage_type,order_index) VALUES($1,$2,$3)",
          [id, t, i],
        );
    }
    await c.query(
      "UPDATE session_stages SET status='COMPLETED',started_at=clock_timestamp(),completed_at=clock_timestamp() WHERE session_id=$1",
      [id],
    );
    await c.query(
      "UPDATE sessions SET status='COMPLETED',started_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=$1",
      [id],
    );
    await c.query("COMMIT");
    return id;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
const legacyShape = (raw: Record<string, unknown>) => ({
  exportVersion: raw.exportVersion,
  session: raw.session,
  stages: raw.stages,
  maps: raw.maps,
  assessment: raw.assessment,
  survey: raw.survey,
});
try {
  const goal = await research("/research/goal-maps", 201, "POST", {
    title: "TEST-ONLY composite " + randomUUID(),
  });
  const source: string[] = [];
  for (let i = 0; i < 3; i++)
    source.push(
      (
        await research(`/maps/${goal.id}/concepts`, 201, "POST", {
          label: "TEST-ONLY-C" + i,
          positionX: 100 + i * 200,
          positionY: 100,
        })
      ).id,
    );
  const goalLinks: string[] = [];
  for (let i = 0; i < 2; i++)
    goalLinks.push(
      (
        await research(`/maps/${goal.id}/links`, 201, "POST", {
          label: "TEST-ONLY-R" + i,
          sourceConceptId: source[i],
          targetConceptId: source[i + 1],
        })
      ).id,
    );
  const kit = await research(`/maps/${goal.id}/kits`, 201, "POST", {
    name: "TEST-ONLY composite Kit " + randomUUID(),
    conceptIds: source,
    linkIds: goalLinks,
  });
  // The public Kit parts intentionally conceal Goal endpoints. Test-only source
  // correspondence comes from the guarded fixture DB, never from learner data.
  const parts = {
    concepts: (
      await pool.query(
        'SELECT id AS "kitConceptItemId",source_concept_id AS "sourceConceptId" FROM kit_concept_items WHERE kit_definition_id=$1 ORDER BY created_at,id',
        [kit.id],
      )
    ).rows,
    links: (
      await pool.query(
        'SELECT i.id AS "kitLinkItemId",l.source_concept_id AS "sourceConceptId",l.target_concept_id AS "targetConceptId" FROM kit_link_items i JOIN links l ON l.id=i.source_link_id WHERE i.kit_definition_id=$1 ORDER BY i.created_at,i.id',
        [kit.id],
      )
    ).rows,
  };
  const legacyIds = await Promise.all([
    legacyFixture("STAGE1_4", kit.id),
    legacyFixture("STAGE1_6", kit.id),
  ]);
  const legacyBefore = await Promise.all(
    legacyIds.map((id) => research(`/research/sessions/${id}/export`)),
  );
  assert.deepEqual(
    legacyBefore.map((r) => r.exportVersion),
    [1, 2],
  );
  assert.equal(legacyBefore[1].session.studyGroup, "EXPERIMENTAL");
  assert.ok(legacyBefore[1].assessment);
  assert.equal(legacyBefore[0].survey, undefined);
  await research("/research/stage1/settings", 200, "PUT", { minutes: 30 }); // Test execution headroom only.
  const s = await research("/research/stage1/sessions", 201, "POST", {
    participantCode: "TEST-ONLY-COMPOSITE",
    videoUrl: "/test-only.mp4",
    kitDefinitionId: kit.id,
    seedConceptIds: parts.concepts
      .slice(0, 2)
      .map((p: { kitConceptItemId: string }) => p.kitConceptItemId),
    surveyQuestions: [
      {
        kind: "TEXT",
        prompt: "TEST-ONLY fixture completion",
        required: true,
        config: {},
      },
    ],
  });
  token = s.learnerAccessToken;
  assert.equal(s.protocolKey, "STAGE1_5");
  assert.equal(s.studyGroup, null);
  assert.deepEqual(
    s.stages.map((st: { stageType: string }) => st.stageType),
    ["LESSON", "PRIOR_MAP", "KB_MAP", "INTEGRATION_MAP", "SURVEY"],
  );
  const stage = (t: string) =>
    s.stages.find((st: { stageType: string }) => st.stageType === t);
  const start = (t: string) =>
    request(`/session-stages/${stage(t).id}/start`, 200, "POST", {});
  await request(`/sessions/${s.id}/start`, 200, "POST", {});
  await start("LESSON");
  await request(
    `/session-stages/${stage("LESSON").id}/complete`,
    200,
    "POST",
    {},
  );
  await start("PRIOR_MAP");
  const sb = await request(
    `/session-stages/${stage("PRIOR_MAP").id}/prior-map`,
    201,
    "POST",
    {},
  );
  const sbInitial = await dbState(sb.id);
  assert.equal(sbInitial.concepts.length, 2);
  assert.equal(sbInitial.links.length, 0);
  assert.ok(
    sbInitial.concepts.every(
      (c) =>
        c.provenance.length === 1 &&
        c.provenance[0].relationType === "CLONED_FROM",
    ),
  );
  const seed = sbInitial.concepts[0]!;
  await request(`/concepts/${seed.id}/label`, 409, "PATCH", {
    label: "TEST-ONLY denied",
  });
  await request(`/concepts/${seed.id}`, 409, "DELETE", {});
  await request(`/concepts/${seed.id}/position`, 200, "PATCH", {
    positionX: 340,
    positionY: 280,
  });
  const ordinary = await request(`/maps/${sb.id}/concepts`, 201, "POST", {
    label: "TEST-ONLY SB added",
    positionX: 600,
    positionY: 300,
  });
  await request(`/concepts/${ordinary.id}/label`, 200, "PATCH", {
    label: "TEST-ONLY SB edited",
  });
  await request(`/maps/${sb.id}/links`, 201, "POST", {
    label: "TEST-ONLY SB relation",
    sourceConceptId: seed.id,
    targetConceptId: ordinary.id,
  });
  await checkpoint(s.id, sb.id);
  await request(`/maps/${sb.id}/submit`, 200, "POST", {});
  checks.push(
    "five stages/null group; SB seed restrictions, ordinary edits, provenance and replay",
  );
  await start("KB_MAP");
  const kb = await request(`/kits/${kit.id}/kb-map`, 201, "POST", {
    sessionStageId: stage("KB_MAP").id,
  });
  const built = new Map<string, string>();
  for (const [i, p] of parts.concepts.entries())
    built.set(
      p.sourceConceptId,
      (
        await request(
          `/maps/${kb.id}/kit-concepts/${p.kitConceptItemId}/import`,
          201,
          "POST",
          { positionX: 100 + i * 200, positionY: 100 },
        )
      ).id,
    );
  const links: string[] = [];
  for (const p of parts.links)
    links.push(
      (
        await request(
          `/maps/${kb.id}/kit-links/${p.kitLinkItemId}`,
          201,
          "POST",
          {
            sourceConceptId: built.get(p.sourceConceptId),
            targetConceptId: built.get(p.targetConceptId),
          },
        )
      ).id,
    );
  const matched = await request(`/maps/${kb.id}/kit-feedback`);
  assert.equal(matched.matched, true);
  await request(`/maps/${kb.id}/kit-feedback/display`, 200, "POST", {});
  const k = parts.links[0];
  await request(`/links/${links[0]}/reconnect`, 200, "PATCH", {
    sourceConceptId: built.get(k.targetConceptId),
    targetConceptId: built.get(k.sourceConceptId),
  });
  await request(`/maps/${kb.id}/submit`, 409, "POST", {});
  assert.equal(
    (await pool.query("SELECT status FROM maps WHERE id=$1", [kb.id])).rows[0]
      .status,
    "DRAFT",
  );
  const mismatch = await request(`/maps/${kb.id}/kit-feedback`);
  assert.equal(mismatch.matched, false);
  assert.notEqual(mismatch.mapSignature, matched.mapSignature);
  await request(`/links/${links[0]}/reconnect`, 200, "PATCH", {
    sourceConceptId: built.get(k.sourceConceptId),
    targetConceptId: built.get(k.targetConceptId),
  });
  assert.equal((await request(`/maps/${kb.id}/kit-feedback`)).matched, true);
  await request(`/maps/${kb.id}/submit`, 200, "POST", {});
  assert.equal(
    (await pool.query("SELECT status FROM maps WHERE id=$1", [kb.id])).rows[0]
      .status,
    "SUBMITTED",
  );
  checks.push(
    "KB matched/display, stale structural result rejected by submit, corrected state rechecked and submitted",
  );
  await start("INTEGRATION_MAP");
  const integration = await request(
    `/session-stages/${stage("INTEGRATION_MAP").id}/integration-map`,
    201,
    "POST",
    {},
  );
  const id = integration.id as string;
  assert.equal(integration.kitDefinitionId, kit.id);
  const initial = (
    await pool.query(
      "SELECT snapshot FROM map_initial_snapshots WHERE map_id=$1",
      [id],
    )
  ).rows[0].snapshot as MapHistorySnapshot;
  assert.equal(initial.concepts.length, (await dbState(sb.id)).concepts.length);
  assert.ok(
    initial.concepts.every((c) =>
      c.provenance.some(
        (p) =>
          p.relationType === "CLONED_FROM" &&
          sbInitial.concepts
            .map((c) => c.id)
            .concat(ordinary.id)
            .includes(p.sourceConceptId),
      ),
    ),
  );
  const integrationRow = (
    await pool.query(
      "SELECT based_on_map_id,kit_definition_id FROM maps WHERE id=$1",
      [id],
    )
  ).rows[0];
  assert.equal(integrationRow.based_on_map_id, sb.id);
  const submittedSB = await dbState(sb.id);
  const cloneSource = new Map(
    initial.concepts.map((c) => [
      c.id,
      c.provenance.find((p) => p.relationType === "CLONED_FROM")!
        .sourceConceptId,
    ]),
  );
  for (const link of initial.links) {
    const source = link.provenance.find(
      (p) => p.relationType === "CLONED_FROM",
    )!.sourceLinkId;
    const original = submittedSB.links.find((l) => l.id === source)!;
    assert.ok(original);
    assert.equal(link.label, original.label);
    assert.equal(
      cloneSource.get(link.sourceConceptId),
      original.sourceConceptId,
    );
    assert.equal(
      cloneSource.get(link.targetConceptId),
      original.targetConceptId,
    );
  }
  await request(`/maps/${id}/kit-feedback`, 404);
  await request(`/maps/${id}/kit-feedback/display`, 404, "POST", {});
  await request(`/maps/${id}/kit-definition`, 200, "PATCH", {
    kitDefinitionId: kit.id,
  });
  assert.equal(
    (await pool.query("SELECT kit_definition_id FROM maps WHERE id=$1", [id]))
      .rows[0].kit_definition_id,
    kit.id,
  );
  await checkpoint(s.id, id);
  const a = await request(`/maps/${id}/concepts`, 201, "POST", {
    label: "TEST-ONLY integration A",
    positionX: 800,
    positionY: 200,
  });
  await checkpoint(s.id, id);
  const beforeFault = graph(await dbState(id)),
    retryKey = randomUUID();
  await pool.query(
    `CREATE FUNCTION test60483_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST-ONLY injected event failure'; END $$; CREATE TRIGGER test60483_fault BEFORE INSERT ON research_events FOR EACH ROW WHEN (NEW.map_id='${id}'::uuid AND NEW.event_type='EDIT_CONCEPT' AND NEW.outcome='SUCCESS') EXECUTE FUNCTION test60483_fault()`,
  );
  try {
    const failure = await request(
      `/concepts/${a.id}/label`,
      409,
      "PATCH",
      { label: "TEST-ONLY retried edit" },
      retryKey,
    );
    assert.equal(failure.error, "map_history_unavailable");
    assert.equal(failure.operationOutcome, "FAILURE");
    assert.ok(
      !JSON.stringify(failure).includes("TEST-ONLY injected event failure"),
    );
    assert.deepEqual(graph(await dbState(id)), beforeFault);
  } finally {
    await pool.query(
      "DROP TRIGGER test60483_fault ON research_events; DROP FUNCTION test60483_fault()",
    );
  }
  await request(
    `/concepts/${a.id}/label`,
    200,
    "PATCH",
    { label: "TEST-ONLY retried edit" },
    retryKey,
  );
  await request(
    `/concepts/${a.id}/label`,
    200,
    "PATCH",
    { label: "TEST-ONLY retried edit" },
    retryKey,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM research_events WHERE map_id=$1 AND event_type='EDIT_CONCEPT' AND target_id=$2 AND outcome='SUCCESS'",
        [id, a.id],
      )
    ).rows[0].n,
    1,
  );
  await checkpoint(s.id, id);
  await request(`/concepts/${a.id}/position`, 200, "PATCH", {
    positionX: 840,
    positionY: 260,
  });
  await checkpoint(s.id, id);
  const l = await request(`/maps/${id}/links`, 201, "POST", {
    label: "TEST-ONLY relation",
    sourceConceptId: initial.concepts[0]!.id,
    targetConceptId: a.id,
  });
  await checkpoint(s.id, id);
  await request(`/links/${l.id}/label`, 200, "PATCH", {
    label: "TEST-ONLY relation edited",
  });
  await checkpoint(s.id, id);
  await request(`/links/${l.id}/reconnect`, 200, "PATCH", {
    sourceConceptId: initial.concepts[1]!.id,
    targetConceptId: a.id,
  });
  await checkpoint(s.id, id);
  const imported: { id: string }[] = [];
  for (const [i, p] of parts.concepts.slice(0, 2).entries())
    imported.push(
      await request(
        `/maps/${id}/kit-concepts/${p.kitConceptItemId}/import`,
        201,
        "POST",
        { positionX: 1000 + i * 200, positionY: 400 },
      ),
    );
  const il = await request(
    `/maps/${id}/kit-links/${parts.links[0].kitLinkItemId}/import`,
    201,
    "POST",
    { sourceConceptId: imported[0].id, targetConceptId: imported[1].id },
  );
  await checkpoint(s.id, id);
  const withImported = graph(await dbState(id));
  assert.ok(
    (await dbState(id)).concepts
      .find((c) => c.id === imported[0].id)!
      .provenance.some((p) => p.relationType === "IMPORTED_FROM"),
  );
  await request(`/concepts/${imported[1].id}`, 200, "DELETE", {});
  await checkpoint(s.id, id);
  assert.equal(
    (await pool.query("SELECT 1 FROM links WHERE id=$1", [il.id])).rowCount,
    0,
  );
  await undo(id, "UNDO");
  assert.deepEqual(
    graph(await checkpoint(s.id, id)),
    withImported,
    "Undo restores IDs/positions/provenance of cascaded Kit link",
  );
  await undo(id, "REDO");
  await checkpoint(s.id, id);
  await undo(id, "UNDO");
  assert.deepEqual(graph(await checkpoint(s.id, id)), withImported);
  await request(`/links/${l.id}`, 200, "DELETE", {});
  await checkpoint(s.id, id);
  await undo(id, "UNDO");
  await checkpoint(s.id, id);
  await undo(id, "REDO");
  await checkpoint(s.id, id);
  const mergeA = await request(`/maps/${id}/concepts`, 201, "POST", {
    label: "TEST-ONLY merge A",
    positionX: 1400,
    positionY: 100,
  });
  const mergeB = await request(`/maps/${id}/concepts`, 201, "POST", {
    label: "TEST-ONLY merge B",
    positionX: 1600,
    positionY: 100,
  });
  const merged = await request(`/maps/${id}/concepts/merge`, 201, "POST", {
    conceptIds: [mergeA.id, mergeB.id],
    label: "TEST-ONLY merged",
  });
  await checkpoint(s.id, id);
  const beforeProtectedDelete = graph(await dbState(id));
  const draftFeatures=await research(`/research/stage1/sessions/${s.id}/descriptive-features`);
  assert.equal(draftFeatures.completion.reason,"NOT_SUBMITTED");
  assert.equal(draftFeatures.completion.activeConcepts,null);
  await request(`/concepts/${merged.concept.id}`, 200, "DELETE", {});
  const released = graph(await checkpoint(s.id, id));
  assert.ok(!released.concepts.some((c) => c.id === merged.concept.id));
  assert.equal(
    released.concepts.find((c) => c.id === mergeA.id)!.mergedIntoConceptId,
    null,
  );
  assert.equal(
    released.concepts.find((c) => c.id === mergeB.id)!.mergedIntoConceptId,
    null,
  );
  await undo(id, "UNDO");
  assert.deepEqual(graph(await checkpoint(s.id, id)), beforeProtectedDelete);
  await undo(id, "REDO");
  assert.deepEqual(graph(await checkpoint(s.id, id)), released);
  // TEST-ONLY regression: a local inverse of the outer Merge, not a map rollback.
  const make = (label: string, x: number) =>
    request(`/maps/${id}/concepts`, 201, "POST", {
      label: "TEST-ONLY " + label,
      positionX: x,
      positionY: 800,
    });
  const ra = await make("release A", 100),
    rb = await make("release B", 300),
    rc = await make("release C", 500);
  const originalLink = await request(`/maps/${id}/links`, 201, "POST", {
    label: "TEST-ONLY original",
    sourceConceptId: ra.id,
    targetConceptId: initial.concepts[0]!.id,
  });
  await request(`/links/${originalLink.id}/position`, 200, "PATCH", {
    labelPositionX: 210,
    labelPositionY: 420,
  });
  const beforeInner = graph(await checkpoint(s.id, id));
  const inner = await request(`/maps/${id}/concepts/merge`, 201, "POST", {
    conceptIds: [ra.id, rb.id],
    label: "TEST-ONLY inner M",
  });
  const mid = inner.concept.id;
  // Merge sources remain hidden and cannot be manipulated directly.
  await request(`/concepts/${ra.id}`, 409, "DELETE", {});
  await request(`/links/${originalLink.id}/label`, 200, "PATCH", {
    label: "TEST-ONLY edited after merge",
  });
  await request(`/links/${originalLink.id}/position`, 200, "PATCH", {
    labelPositionX: 777,
    labelPositionY: 888,
  });
  const late = await request(`/maps/${id}/links`, 201, "POST", {
    label: "TEST-ONLY later",
    sourceConceptId: mid,
    targetConceptId: rc.id,
  });
  const outerBefore = graph(await checkpoint(s.id, id));
  const outer = await request(`/maps/${id}/concepts/merge`, 201, "POST", {
    conceptIds: [mid, rc.id],
    label: "TEST-ONLY outer N",
  });
  const nid = outer.concept.id;
  const unrelated = await make("unrelated retained", 1700);
  const unrelatedLink = await request(`/maps/${id}/links`, 201, "POST", {
    label: "TEST-ONLY unrelated link",
    sourceConceptId: unrelated.id,
    targetConceptId: a.id,
  });
  await request(`/links/${unrelatedLink.id}/label`, 200, "PATCH", {
    label: "TEST-ONLY unrelated edit retained",
  });
  await request(`/links/${unrelatedLink.id}/position`, 200, "PATCH", {
    labelPositionX: 900,
    labelPositionY: 900,
  });
  const beforeRelease = graph(await checkpoint(s.id, id));
  await request(`/concepts/${nid}`, 401, "DELETE", {}, undefined, "");
  const otherSession = await research(
    "/research/stage1/sessions",
    201,
    "POST",
    {
      participantCode: "TEST-ONLY-OTHER",
      videoUrl: "/test-only.mp4",
      kitDefinitionId: kit.id,
      seedConceptIds: [],
      surveyQuestions: [
        {
          kind: "TEXT",
          prompt: "TEST-ONLY authorization fixture",
          required: true,
          config: {},
        },
      ],
    },
  );
  await request(
    `/concepts/${nid}`,
    404,
    "DELETE",
    {},
    undefined,
    otherSession.learnerAccessToken,
  );
  const historyBeforeRelease = (
    await pool.query(
      "SELECT event_id,before_state,after_state FROM research_events WHERE map_id=$1 ORDER BY sequence_number",
      [id],
    )
  ).rows;
  // Fail after state updates but before SUCCESS event: everything must roll back.
  const releaseKey = randomUUID();
  await pool.query(
    `CREATE FUNCTION test58304_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST-ONLY release write failure'; END $$; CREATE TRIGGER test58304_fault BEFORE INSERT ON research_events FOR EACH ROW WHEN (NEW.map_id='${id}'::uuid AND NEW.event_type='DELETE_CONCEPT' AND NEW.target_id='${nid}'::uuid AND NEW.outcome='SUCCESS') EXECUTE FUNCTION test58304_fault()`,
  );
  try {
    const failed = await request(
      `/concepts/${nid}`,
      409,
      "DELETE",
      {},
      releaseKey,
    );
    assert.equal(failed.error, "map_history_unavailable");
    assert.equal(failed.operationOutcome, "FAILURE");
    assert.equal(failed.logSaved, true);
    assert.ok(
      !JSON.stringify(failed).includes("TEST-ONLY release write failure"),
    );
    assert.deepEqual(graph(await checkpoint(s.id, id)), beforeRelease);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM operation_receipts WHERE operation_key=$1 AND principal_scope NOT LIKE '%:audit'",
          [releaseKey],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await pool.query(
      "DROP TRIGGER test58304_fault ON research_events; DROP FUNCTION test58304_fault()",
    );
  }
  await request(`/concepts/${nid}`, 200, "DELETE", {}, releaseKey);
  const afterOuter = graph(await checkpoint(s.id, id));
  await request(`/concepts/${nid}`, 200, "DELETE", {}, releaseKey);
  assert.deepEqual(graph(await checkpoint(s.id, id)), afterOuter);
  await request(
    `/concepts/${nid}`,
    404,
    "DELETE",
    {},
    releaseKey,
    otherSession.learnerAccessToken,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM research_events WHERE map_id=$1 AND target_id=$2 AND event_type='DELETE_CONCEPT' AND outcome='SUCCESS'",
        [id, nid],
      )
    ).rows[0].n,
    1,
  );
  for (const cid of [mid, rc.id])
    assert.deepEqual(
      afterOuter.concepts.find((c) => c.id === cid),
      outerBefore.concepts.find((c) => c.id === cid),
    );
  for (const cid of [ra.id, rb.id])
    assert.equal(
      afterOuter.concepts.find((c) => c.id === cid)!.mergedIntoConceptId,
      mid,
    );
  for (const lid of [originalLink.id, late.id])
    assert.deepEqual(
      afterOuter.links.find((l) => l.id === lid),
      outerBefore.links.find((l) => l.id === lid),
    );
  assert.deepEqual(
    afterOuter.links.find((l) => l.id === unrelatedLink.id),
    beforeRelease.links.find((l) => l.id === unrelatedLink.id),
  );
  await undo(id, "UNDO");
  assert.deepEqual(graph(await checkpoint(s.id, id)), beforeRelease);
  await undo(id, "REDO");
  assert.deepEqual(graph(await checkpoint(s.id, id)), afterOuter);
  // Missing/unrecorded lineage must fail closed, without inventing a before state.
  const fake = randomUUID();
  await pool.query(
    "INSERT INTO concepts(id,map_id,label,position_x,position_y,merged_into_concept_id) VALUES($1,$2,'TEST-ONLY invalid unrecorded lineage',0,0,$3)",
    [fake, id, mid],
  );
  const invalidBefore = graph(await dbState(id));
  try {
    assert.equal(
      (await request(`/concepts/${mid}`, 409, "DELETE", {})).error,
      "merge_release_unavailable",
    );
    assert.deepEqual(graph(await dbState(id)), invalidBefore);
  } finally {
    await pool.query("DELETE FROM concepts WHERE id=$1", [fake]);
  }
  await request(`/concepts/${mid}`, 200, "DELETE", {});
  const afterInner = graph(await checkpoint(s.id, id));
  for (const cid of [ra.id, rb.id])
    assert.deepEqual(
      afterInner.concepts.find((c) => c.id === cid),
      beforeInner.concepts.find((c) => c.id === cid),
    );
  assert.deepEqual(
    afterInner.links.find((l) => l.id === originalLink.id),
    beforeInner.links.find((l) => l.id === originalLink.id),
  );
  assert.ok(!afterInner.links.some((l) => l.id === late.id));
  assert.deepEqual(
    afterInner.concepts.find((c) => c.id === unrelated.id),
    beforeRelease.concepts.find((c) => c.id === unrelated.id),
  );
  assert.deepEqual(
    afterInner.links.find((l) => l.id === unrelatedLink.id),
    beforeRelease.links.find((l) => l.id === unrelatedLink.id),
  );
  await undo(id, "UNDO");
  assert.deepEqual(graph(await checkpoint(s.id, id)), afterOuter);
  await undo(id, "REDO");
  assert.deepEqual(graph(await checkpoint(s.id, id)), afterInner);
  for (const row of historyBeforeRelease)
    assert.deepEqual(
      (
        await pool.query(
          "SELECT event_id,before_state,after_state FROM research_events WHERE event_id=$1",
          [row.event_id],
        )
      ).rows[0],
      row,
    );
  checks.push(
    "single/nested Merge release; source denial; original Link labels/positions restored; unrelated edits retained; failure and receipt rollback; same-key retry; missing history refused; Undo/Redo and immutable prior events",
  );
  await request(`/maps/${id}/operation-cancellations/ADD_CONCEPT`,201,"POST",{});
  const unknownClient=await pool.connect();
  try{await unknownClient.query("BEGIN");await insertResearchEvent(unknownClient,s.id,"SYSTEM",{schemaVersion:5,eventType:"MAP_SAVE",targetType:"MAP",targetId:id,mapId:id,outcome:"UNKNOWN",clientTimeQuality:"NOT_APPLICABLE"});await unknownClient.query("COMMIT");}catch(error){await unknownClient.query("ROLLBACK");throw error;}finally{unknownClient.release();}
  await request(`/maps/${id}/submit`, 200, "POST", {});
  const final = await dbState(id);
  const featurePath=`/research/stage1/sessions/${s.id}/descriptive-features`;
  const features=await research(featurePath);
  assert.equal(features.featureVersion,"stage1-5-descriptive-v1");
  assert.equal(features.protocolKey,"STAGE1_5");
  const expectedCounts=(state:MapHistorySnapshot)=>[state.concepts.filter(c=>c.mergedIntoConceptId===null).length,state.concepts.filter(c=>c.mergedIntoConceptId!==null).length,state.links.length];
  const startCounts=expectedCounts(initial),finalCounts=expectedCounts(final);
  assert.equal(features.start.status,"AVAILABLE");
  assert.equal(features.completion.status,"AVAILABLE");
  for(const [index,key] of ["activeConcepts","hiddenMergeSources","links"].entries()){
    assert.equal(features.start[key],startCounts[index]);assert.equal(features.completion[key],finalCounts[index]);assert.equal(features.delta[key],finalCounts[index]!-startCounts[index]!);
  }
  const featureCsv=parse(await research(featurePath+".csv"),{columns:true,bom:true}) as Record<string,string>[];
  for(const point of ["start","completion","delta"]){const row=featureCsv.find(r=>r.aggregationPoint===point)!;for(const key of ["activeConcepts","hiddenMergeSources","links"])assert.equal(Number(row[key]),features[point][key]);assert.equal(row.featureVersion,features.featureVersion);assert.equal(row.protocolKey,features.protocolKey);}
  const savedCounts=(await pool.query("SELECT actor_type,outcome,count(*)::int n FROM research_events WHERE map_id=$1 AND schema_version IN(2,5) GROUP BY actor_type,outcome",[id])).rows;
  for(const r of savedCounts)assert.equal(features.operationResults.rows.find((x:{actorType:string;outcome:string})=>x.actorType===r.actor_type&&x.outcome===r.outcome)?.count,r.n);
  for(const suffix of ["",".csv"]){await request(featurePath+suffix,401,"GET",undefined,undefined,"");await request(featurePath+suffix,403,"GET",undefined,undefined,token);}
  const storedInitial=(await pool.query("SELECT snapshot,captured_at FROM map_initial_snapshots WHERE map_id=$1",[id])).rows[0];
  await pool.query("DELETE FROM map_initial_snapshots WHERE map_id=$1",[id]);
  try {const missing=await research(featurePath);assert.equal(missing.start.activeConcepts,null);assert.equal(missing.delta.links,null);const rows=parse(await research(featurePath+".csv"),{columns:true,bom:true}) as Record<string,string>[];assert.equal(rows.find(r=>r.aggregationPoint==="delta")!.links,"");}
  finally {await pool.query("INSERT INTO map_initial_snapshots(map_id,snapshot_version,snapshot,captured_at) VALUES($1,1,$2,$3)",[id,storedInitial.snapshot,storedInitial.captured_at]);}
  const unmatched=randomUUID();
  await pool.query("INSERT INTO concepts(id,map_id,label,position_x,position_y) VALUES($1,$2,'TEST-ONLY inconsistent current map',0,0)",[unmatched,id]);
  try {const missing=await research(featurePath);assert.equal(missing.completion.reason,"HISTORY_INCONSISTENT");assert.equal(missing.delta.activeConcepts,null);}finally{await pool.query("DELETE FROM concepts WHERE id=$1",[unmatched]);}
  assert.equal(
    (await pool.query("SELECT status FROM maps WHERE id=$1", [id])).rows[0]
      .status,
    "SUBMITTED",
  );
  checks.push(
    "integration initial SB provenance/Kit assignment; direct feedback denied; edit/move/reconnect/import/delete/cascade Undo/Redo; injected failure rolls back; same-key retry commits once",
  );
  await start("SURVEY");
  const sq = await request(`/session-stages/${stage("SURVEY").id}/survey`);
  await request(
    `/session-stages/${stage("SURVEY").id}/survey/submit`,
    200,
    "POST",
    {
      answers: [
        { questionId: sq.questions[0].id, value: "TEST-ONLY completed" },
      ],
    },
  );
  const raw = await research(`/research/sessions/${s.id}/export`);
  assert.equal(raw.exportVersion, 3);
  assert.equal(raw.session.studyGroup, null);
  assert.equal(raw.session.status, "COMPLETED");
  assert.equal(raw.seedConcepts.length, 2);
  assert.deepEqual(
    raw.seedConcepts.map((p: { conceptId: string }) => p.conceptId).sort(),
    sbInitial.concepts.map((c) => c.id).sort(),
  );
  for (const entry of raw.seedConcepts)
    assert.ok(
      sbInitial.concepts
        .find((c) => c.id === entry.conceptId)!
        .provenance.some((p) => p.sourceConceptId === entry.sourceConceptId),
    );
  const map = raw.maps.find((m: { id: string }) => m.id === id);
  assert.deepEqual(graph(map), graph(final));
  assert.deepEqual(graph(map.initialSnapshot), graph(initial));
  const events = (
    await pool.query(
      "SELECT event_id,event_type,map_id,target_id,actor_type,outcome,reason_code,sequence_number,server_timestamp,before_state,after_state FROM research_events WHERE session_id=$1 AND schema_version IN (2,5) ORDER BY sequence_number",
      [s.id],
    )
  ).rows;
  const own = events.filter((e) => e.map_id === id);
  assert.ok(own.some((e) => e.outcome === "FAILURE"));
  assert.ok(
    own.every(
      (e, i) =>
        i === 0 ||
        BigInt(e.sequence_number) > BigInt(own[i - 1].sequence_number),
    ),
  );
  for (const [i, e] of own.entries()) {
    const replay = await research(
      `/research/stage1/sessions/${s.id}/maps/${id}/history?sequenceNumber=${i + 1}`,
    );
    assert.equal(replay.status, "REPLAYABLE", replay.reason);
    if (e.outcome === "SUCCESS") {
      assert.deepEqual(graph(replay.afterState), graph(e.after_state));
      assert.deepEqual(graph(replay.beforeState), graph(e.before_state));
    } else {
      assert.equal(e.before_state, null);
      assert.equal(e.after_state, null);
      assert.deepEqual(graph(replay.beforeState), graph(replay.afterState));
    }
  }
  assert.equal(map.operationLogs.length, own.length);
  const analysis = await research(`/research/stage1/sessions/${s.id}/analysis`);
  assert.deepEqual(analysis.descriptiveFeatures.start.activeConcepts,features.start.activeConcepts);
  assert.deepEqual(analysis.descriptiveFeatures.completion,features.completion);
  assert.deepEqual(analysis.descriptiveFeatures.delta,features.delta);
  checks.push("new-five-flow version-separated start/submission/delta counts, actor/outcome counts, JSON/CSV agreement, auth, missing snapshot and inconsistent history refusal");
  assert.deepEqual(
    analysis.operations.map((o: { eventId: string }) => o.eventId).sort(),
    events.map((e) => e.event_id).sort(),
  );
  assert.deepEqual(
    graph(analysis.maps.find((m: { id: string }) => m.id === id)),
    graph(final),
  );
  assert.deepEqual(
    analysis.features,
    {},
    "legacy features field remains empty; new-five-flow descriptiveFeatures is version-separated",
  );
  const full = await research(
    `/research/stage1/sessions/${s.id}/maps/${id}/history?sequenceNumber=${own.length}`,
  );
  assert.deepEqual(graph(full.afterState), graph(final));
  const job = await research("/research/event-exports", 201, "POST", {
    filters: {
      sessionIds: [s.id],
      eventTypes: [...new Set(events.map((e) => e.event_type))],
    },
  });
  try {
    const json = await research(
      `/research/event-exports/${job.exportId}/events.json`,
    );
    const common = parse(
      await research(`/research/event-exports/${job.exportId}/events.csv`),
      { columns: true, bom: true },
    ) as Record<string, string>[];
    const detail = parse(
      await research(
        `/research/event-exports/${job.exportId}/map_operations.csv`,
      ),
      { columns: true, bom: true },
    ) as Record<string, string>[];
    assert.equal(json.event_count, events.length);
    assert.equal(common.length, events.length);
    assert.equal(detail.length, events.length);
    assert.deepEqual(
      json.events.map((e: { event_id: string }) => e.event_id),
      events.map((e) => e.event_id),
    );
    for (const e of events) {
      const out = json.events.find(
          (x: { event_id: string }) => x.event_id === e.event_id,
        ),
        row = common.find((x) => x.event_id === e.event_id)!,
        d = detail.find((x) => x.event_id === e.event_id)!;
      for (const x of [out, row, d]) {
        assert.equal(x.session_id, s.id);
        assert.equal(x.map_id, e.map_id);
        assert.equal(x.event_type, e.event_type);
        assert.equal(x.outcome, e.outcome);
        assert.equal(x.target_id ?? "", e.target_id ?? "");
        assert.equal(x.reason_code ?? "", e.reason_code ?? "");
        assert.equal(
          x.server_timestamp,
          new Date(e.server_timestamp).toISOString(),
        );
        assert.equal(String(x.sequence_number), String(e.sequence_number));
        assert.equal(x.protocol_key, "STAGE1_5");
        assert.equal(x.actor_type, e.actor_type);
      }
      assert.deepEqual(out.before, e.before_state);
      assert.deepEqual(out.after, e.after_state);
      assert.deepEqual(JSON.parse(d.before_json || "null"), e.before_state);
      assert.deepEqual(JSON.parse(d.after_json || "null"), e.after_state);
      const rawOp = raw.maps
        .find((m: { id: string }) => m.id === e.map_id)
        .operationLogs.find(
          (o: { eventId: string }) => o.eventId === e.event_id,
        );
      assert.ok(rawOp);
      assert.equal(rawOp.outcome, e.outcome);
      assert.equal(rawOp.actorType, e.actor_type);
      assert.deepEqual(rawOp.before, e.before_state);
      assert.deepEqual(rawOp.after, e.after_state);
    }
  } finally {
    await research(`/research/event-exports/${job.exportId}`, 200, "DELETE");
  }
  checks.push(
    "initial/final DB and all map-event replay prefixes; raw JSON/common CSV/map detail IDs/count/order/outcome/time/before/after and provenance exact",
  );
  const legacyAfter = await Promise.all(
    legacyIds.map((id) => research(`/research/sessions/${id}/export`)),
  );
  for (let i = 0; i < 2; i++)
    assert.deepEqual(legacyShape(legacyAfter[i]), legacyShape(legacyBefore[i]));
  for (const protocol of ["STAGE1_4", "STAGE1_6"] as const) {
    const oldSid = await legacyFixture(protocol, kit.id);
    await research(`/research/stage1/sessions/${oldSid}/descriptive-features`,409);
    await research(`/research/stage1/sessions/${oldSid}/descriptive-features.csv`,409);
    const oldStage = (
      await pool.query(
        "UPDATE session_stages SET status='IN_PROGRESS',completed_at=NULL WHERE session_id=$1 AND stage_type='INTEGRATION_MAP' RETURNING id",
        [oldSid],
      )
    ).rows[0].id;
    await pool.query(
      "UPDATE sessions SET status='IN_PROGRESS',completed_at=NULL WHERE id=$1",
      [oldSid],
    );
    const oldMap = (
      await pool.query(
        "INSERT INTO maps(type,session_stage_id) VALUES('INTEGRATION',$1) RETURNING id",
        [oldStage],
      )
    ).rows[0].id;
    const oldResult = (
      await pool.query(
        "INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1,'TEST-ONLY legacy Merge result',0,0) RETURNING id",
        [oldMap],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO concepts(map_id,label,position_x,position_y,merged_into_concept_id) VALUES($1,'TEST-ONLY legacy source A',0,0,$2),($1,'TEST-ONLY legacy source B',1,1,$2)",
      [oldMap, oldResult],
    );
    const oldBefore = graph(await dbState(oldMap));
    assert.equal(
      (await research(`/concepts/${oldResult}`, 409, "DELETE", {})).error,
      "concept_merge_result_protected",
    );
    assert.deepEqual(graph(await dbState(oldMap)), oldBefore);
  }
  checks.push(
    "legacy 4/6 export versions/group/assessment shape and data unchanged across new five-flow run",
  );
  const prefix = process.env.RESEARCH_CHECK_REPORT_PREFIX ?? "five-flow";
  await writeFile(
    "../docs/" + prefix + "-composite-results.json",
    JSON.stringify(
      {
        syntheticOnly: true,
        checks,
        mapEventCount: events.length,
        integrationEventCount: own.length,
        descriptiveFeatureVersion:features.featureVersion,
        featureCounts:{start:startCounts,completion:finalCounts,delta:finalCounts.map((n,i)=>n-startCounts[i]!)},
        knownUnresolved: [
          "Merge release restricted to new-five-flow integration; ambiguous history refused",
          "only active/hidden Concept and Link counts defined; finer provenance/features remain out of scope",
          "SB link-label coordinate inheritance not asserted as a requirement",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Synthetic new-five-flow composite: " +
      checks.length +
      " boundary groups PASS",
  );
} finally {
  await pool
    .query(
      "DROP TRIGGER IF EXISTS test60483_fault ON research_events; DROP FUNCTION IF EXISTS test60483_fault()",
    )
    .catch(() => undefined);
  await pool.end();
}
