import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { verifyMockTestUrl } from "./mock-db.js";
import type { GoalMapJson } from "../goal-map-transfer.js";

await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const base = process.env.API_BASE_URL!;
const researcher = process.env.RESEARCHER_API_TOKEN!;
const mapsToDelete: string[] = [];
const kitsToDelete: string[] = [];
const sessionsToDelete: string[] = [];
const checkNames: string[] = [];
async function api<T extends object = Record<string, unknown>>(
  path: string,
  status: number,
  method = "GET",
  body?: unknown,
  token = researcher,
): Promise<T> {
  const response = await fetch(base + "/api" + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(
    response.status,
    status,
    `${method} ${path}: ${text.slice(0, 500)}`,
  );
  return text ? (JSON.parse(text) as T) : ({} as T);
}
async function counts() {
  const result = await pool.query<{
    maps: string;
    concepts: string;
    links: string;
    kits: string;
  }>(
    `SELECT (SELECT count(*) FROM maps WHERE type='GOAL') AS maps,
            (SELECT count(*) FROM concepts) AS concepts,
            (SELECT count(*) FROM links) AS links,
            (SELECT count(*) FROM kit_definitions) AS kits`,
  );
  return result.rows[0];
}
function semanticGraph(document: GoalMapJson) {
  const labels = new Map(
    document.goalMap.concepts.map((concept) => [concept.id, concept.label]),
  );
  return {
    title: document.goalMap.title,
    concepts: document.goalMap.concepts
      .map(({ label, position }) => ({ label, position }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    links: document.goalMap.links
      .map((link) => ({
        label: link.label,
        source: labels.get(link.sourceId),
        target: labels.get(link.targetId),
        labelPosition: link.labelPosition,
      }))
      .sort((a, b) =>
        `${a.label}/${a.source}/${a.target}`.localeCompare(
          `${b.label}/${b.source}/${b.target}`,
        ),
      ),
  };
}
try {
  const source = await api<{ id: string }>("/research/goal-maps", 201, "POST", {
    title: `MOCK transfer source ${randomUUID()}`,
  });
  mapsToDelete.push(source.id);
  const conceptA = randomUUID(),
    conceptB = randomUUID(),
    linkId = randomUUID();
  await pool.query(
    "INSERT INTO concepts(id,map_id,label,position_x,position_y) VALUES($1,$2,$3,120.5,-44.25),($4,$2,$5,640,300)",
    [conceptA, source.id, "転送テストの原因", conceptB, "転送テストの結果"],
  );
  await pool.query(
    `INSERT INTO links(id,map_id,label,source_concept_id,target_concept_id,label_position_x,label_position_y)
    VALUES($1,$2,'によって生じる',$3,$4,320.25,170.75)`,
    [linkId, source.id, conceptA, conceptB],
  );

  const originalBefore = await pool.query(
    "SELECT label,position_x,position_y FROM concepts WHERE map_id=$1 ORDER BY label",
    [source.id],
  );
  const originalLinksBefore = await pool.query(
    "SELECT label,source_concept_id,target_concept_id,label_position_x,label_position_y FROM links WHERE map_id=$1 ORDER BY label",
    [source.id],
  );
  const exportResponse = await fetch(
    `${base}/api/research/goal-maps/${source.id}/export`,
    { headers: { Authorization: `Bearer ${researcher}` } },
  );
  assert.equal(exportResponse.status, 200);
  const first = (await exportResponse.json()) as GoalMapJson;
  assert.equal(first.format, "sb-kb-goal-map");
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.goalMap.concepts.length, 2);
  assert.equal(first.goalMap.links.length, 1);
  assert.deepEqual(Object.keys(first.goalMap.concepts[0]!).sort(), [
    "id",
    "label",
    "position",
  ]);
  const exportedText = JSON.stringify(first);
  for (const internalId of [source.id, conceptA, conceptB, linkId])
    assert.equal(exportedText.includes(internalId), false);
  for (const forbidden of [
    "sessionId",
    "participantCode",
    "learner",
    "events",
    "answers",
    "token",
  ])
    assert.equal(
      exportedText.toLowerCase().includes(forbidden.toLowerCase()),
      false,
    );
  checkNames.push("schema and export privacy");

  const importDocument = structuredClone(first);
  importDocument.goalMap.title += " コピー";
  const imported = await api<{ id: string; kitDefinitionId: string }>(
    "/research/goal-maps/import",
    201,
    "POST",
    importDocument,
  );
  mapsToDelete.push(imported.id);
  kitsToDelete.push(imported.kitDefinitionId);
  assert.notEqual(imported.id, source.id);
  const importedRows = await pool.query<{
    id: string;
    label: string;
    x: number;
    y: number;
  }>(
    "SELECT id,label,position_x AS x,position_y AS y FROM concepts WHERE map_id=$1 ORDER BY label",
    [imported.id],
  );
  assert.equal(
    new Set(importedRows.rows.map((row) => row.id).concat(conceptA, conceptB))
      .size,
    4,
  );
  const secondResponse = await fetch(
    `${base}/api/research/goal-maps/${imported.id}/export`,
    { headers: { Authorization: `Bearer ${researcher}` } },
  );
  assert.equal(secondResponse.status, 200);
  const second = (await secondResponse.json()) as GoalMapJson;
  assert.equal(second.goalMap.title, importDocument.goalMap.title);
  assert.deepEqual(
    semanticGraph({
      ...second,
      goalMap: { ...second.goalMap, title: first.goalMap.title },
    }),
    semanticGraph(first),
  );
  const originalAfter = await pool.query(
    "SELECT label,position_x,position_y FROM concepts WHERE map_id=$1 ORDER BY label",
    [source.id],
  );
  assert.deepEqual(originalAfter.rows, originalBefore.rows);
  const originalLinksAfter = await pool.query(
    "SELECT label,source_concept_id,target_concept_id,label_position_x,label_position_y FROM links WHERE map_id=$1 ORDER BY label",
    [source.id],
  );
  assert.deepEqual(originalLinksAfter.rows, originalLinksBefore.rows);
  const sourceIds = await pool.query<{ id: string }>(
    "SELECT id FROM concepts WHERE map_id=$1 UNION ALL SELECT id FROM links WHERE map_id=$1",
    [source.id],
  );
  const importedIds = await pool.query<{ id: string }>(
    "SELECT id FROM concepts WHERE map_id=$1 UNION ALL SELECT id FROM links WHERE map_id=$1",
    [imported.id],
  );
  assert.equal(
    importedIds.rows.some((row) =>
      sourceIds.rows.some((sourceRow) => sourceRow.id === row.id),
    ),
    false,
  );
  const listed = await api<{ goalMaps: Array<{ id: string }> }>(
    "/research/goal-maps",
    200,
  );
  assert.ok(listed.goalMaps.some((map) => map.id === imported.id));
  checkNames.push(
    "round trip geometry and direction; new internal IDs; original unchanged; manager listing",
  );

  const beforeRejects = await counts();
  await api("/research/goal-maps/import", 409, "POST", first);
  const unknown = structuredClone(importDocument) as GoalMapJson & {
    unexpected?: boolean;
  };
  unknown.unexpected = true;
  await api("/research/goal-maps/import", 400, "POST", unknown);
  await api("/research/goal-maps/import", 400, "POST", {
    ...importDocument,
    format: "unknown",
  });
  const broken = structuredClone(importDocument);
  broken.goalMap.links[0]!.sourceId = "missing-concept";
  await api("/research/goal-maps/import", 400, "POST", broken);
  const duplicateIds = structuredClone(importDocument);
  duplicateIds.goalMap.links[0]!.id = duplicateIds.goalMap.concepts[0]!.id;
  await api("/research/goal-maps/import", 400, "POST", duplicateIds);
  const tooManyConcepts = structuredClone(importDocument);
  tooManyConcepts.goalMap.concepts = Array.from({ length: 1001 }, (_, i) => ({
    id: `c${i}`,
    label: `概念${i}`,
    position: { x: i, y: i },
  }));
  tooManyConcepts.goalMap.links = [];
  await api("/research/goal-maps/import", 400, "POST", tooManyConcepts);
  const tooManyLinks = structuredClone(importDocument);
  tooManyLinks.goalMap.links = Array.from({ length: 2001 }, (_, i) => ({
    id: `l${i}`,
    label: `関係${i}`,
    sourceId: importDocument.goalMap.concepts[0]!.id,
    targetId: importDocument.goalMap.concepts[1]!.id,
    labelPosition: null,
  }));
  await api("/research/goal-maps/import", 400, "POST", tooManyLinks);
  const tooLong = structuredClone(importDocument);
  tooLong.goalMap.concepts[0]!.label = "あ".repeat(513);
  await api("/research/goal-maps/import", 400, "POST", tooLong);
  const unknownLarge = JSON.stringify({
    ...importDocument,
    unexpected: "x".repeat(4_000_100),
  });
  const oversizeResponse = await fetch(
    `${base}/api/research/goal-maps/import`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${researcher}`,
        "Content-Type": "application/json",
      },
      body: unknownLarge,
    },
  );
  assert.equal(oversizeResponse.status, 413);
  const invalidJson = await fetch(`${base}/api/research/goal-maps/import`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${researcher}`,
      "Content-Type": "application/json",
    },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  const unauthenticated = await fetch(`${base}/api/research/goal-maps/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(importDocument),
  });
  assert.equal(unauthenticated.status, 401);
  const invalidToken = await fetch(`${base}/api/research/goal-maps/import`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + "0".repeat(40),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(importDocument),
  });
  assert.equal(invalidToken.status, 401);
  const afterRejects = await counts();
  assert.deepEqual(afterRejects, beforeRejects);
  checkNames.push(
    "duplicate name; invalid/unknown data; broken refs; duplicate IDs; count/string/body limits; unauthenticated access; no partial writes",
  );

  await pool.query(`CREATE OR REPLACE FUNCTION stage1_mock_fail_goal_map_kit() RETURNS trigger AS $$
    BEGIN IF NEW.name='MOCK_FAIL_IMPORT' THEN RAISE EXCEPTION 'mock import failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await pool.query(
    "CREATE TRIGGER stage1_mock_fail_goal_map_kit BEFORE INSERT ON kit_definitions FOR EACH ROW EXECUTE FUNCTION stage1_mock_fail_goal_map_kit()",
  );
  const beforeFailure = await counts();
  const failureDoc = structuredClone(importDocument);
  failureDoc.goalMap.title = "MOCK_FAIL_IMPORT";
  await api("/research/goal-maps/import", 500, "POST", failureDoc);
  await pool.query(
    "DROP TRIGGER stage1_mock_fail_goal_map_kit ON kit_definitions",
  );
  await pool.query("DROP FUNCTION stage1_mock_fail_goal_map_kit()");
  assert.deepEqual(await counts(), beforeFailure);
  checkNames.push("injected failure rolls back map, concepts, links and Kit");

  await api("/research/stage1/settings", 200, "PUT", { minutes: 1 });
  const selected = await pool.query<{ id: string }>(
    "SELECT id FROM kit_concept_items WHERE kit_definition_id=$1 ORDER BY id",
    [imported.kitDefinitionId],
  );
  const makeSession = async (suffix: string) => {
    const session = await api<{ id: string; learnerAccessToken: string }>(
      "/research/stage1/sessions",
      201,
      "POST",
      {
        participantCode: `MOCK-TRANSFER-${randomUUID()}`,
        videoUrl: "/mock.mp4",
        kitDefinitionId: imported.kitDefinitionId,
        seedConceptIds: selected.rows.map((row) => row.id),
        surveyQuestions: [
          {
            kind: "TEXT",
            prompt: `選択テスト${suffix}`,
            required: true,
            config: {},
          },
        ],
      },
    );
    sessionsToDelete.push(session.id);
    return session;
  };
  const sessionOne = await makeSession("1");
  const sessionTwo = await makeSession("2");
  const sessionSeeds = await pool.query<{ mapId: string }>(
    `SELECT c.map_id AS "mapId" FROM session_seed_concepts seed
     JOIN kit_concept_items item ON item.id=seed.kit_concept_item_id
     JOIN concepts c ON c.id=item.source_concept_id WHERE seed.session_id=$1`,
    [sessionOne.id],
  );
  assert.equal(sessionSeeds.rows.length, selected.rows.length);
  assert.ok(sessionSeeds.rows.every((row) => row.mapId === imported.id));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM session_seed_concepts WHERE session_id=$1",
        [sessionOne.id],
      )
    ).rows[0]!.count,
    String(selected.rows.length),
  );
  const sensitiveTitle = structuredClone(importDocument);
  sensitiveTitle.goalMap.title = `RESEARCHER-${researcher}`;
  const beforeSensitive = await counts();
  await api("/research/goal-maps/import", 400, "POST", sensitiveTitle);
  const learnerCredential = structuredClone(importDocument);
  learnerCredential.goalMap.title = `LEARNER-${sessionOne.learnerAccessToken}`;
  await api("/research/goal-maps/import", 400, "POST", learnerCredential);
  assert.deepEqual(await counts(), beforeSensitive);
  await api(
    "/research/goal-maps/import",
    403,
    "POST",
    {
      ...importDocument,
      goalMap: {
        ...importDocument.goalMap,
        title: `LEARNER blocked ${randomUUID()}`,
      },
    },
    sessionOne.learnerAccessToken,
  );
  await api(
    "/research/goal-maps/import",
    403,
    "POST",
    {
      ...importDocument,
      goalMap: {
        ...importDocument.goalMap,
        title: `SESSION blocked ${randomUUID()}`,
      },
    },
    sessionTwo.learnerAccessToken,
  );
  checkNames.push(
    "imported Kit supports new Session seed selection; both learner Sessions are denied",
  );

  console.log(
    JSON.stringify(
      {
        verification: "goal-map-json-transfer",
        passed: checkNames.length,
        checks: checkNames,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await pool
      .query(
        "DROP TRIGGER IF EXISTS stage1_mock_fail_goal_map_kit ON kit_definitions",
      )
      .catch(() => undefined);
    await pool
      .query("DROP FUNCTION IF EXISTS stage1_mock_fail_goal_map_kit()")
      .catch(() => undefined);
    if (sessionsToDelete.length) {
      const ids = sessionsToDelete;
      await pool.query(
        "DELETE FROM survey_answers WHERE session_id=ANY($1::uuid[])",
        [ids],
      );
      await pool.query(
        "DELETE FROM survey_questions WHERE session_id=ANY($1::uuid[])",
        [ids],
      );
      await pool.query(
        "DELETE FROM seeded_map_concepts WHERE session_id=ANY($1::uuid[])",
        [ids],
      );
      await pool.query(
        "DELETE FROM session_seed_concepts WHERE session_id=ANY($1::uuid[])",
        [ids],
      );
      await pool.query(
        "DELETE FROM assessment_answers WHERE session_id=ANY($1::uuid[])",
        [ids],
      );
      await pool.query(
        "DELETE FROM assessment_questions WHERE session_id=ANY($1::uuid[])",
        [ids],
      );
      await pool.query(
        "DELETE FROM research_events WHERE session_id=ANY($1::uuid[])",
        [ids],
      );
      await pool.query(
        "DELETE FROM research_event_counters WHERE session_id=ANY($1::uuid[])",
        [ids],
      );
      await pool.query(
        "DELETE FROM client_event_receipts WHERE session_id=ANY($1::uuid[])",
        [ids],
      );
      await pool.query(
        "DELETE FROM client_delivery_reports WHERE session_id=ANY($1::uuid[])",
        [ids],
      );
      await pool.query(
        "DELETE FROM maps WHERE session_stage_id IN(SELECT id FROM session_stages WHERE session_id=ANY($1::uuid[]))",
        [ids],
      );
      await pool.query(
        "DELETE FROM explanation_responses WHERE session_stage_id IN(SELECT id FROM session_stages WHERE session_id=ANY($1::uuid[]))",
        [ids],
      );
      await pool.query(
        "DELETE FROM session_stages WHERE session_id=ANY($1::uuid[])",
        [ids],
      );
      const participants = await pool.query<{ participant_id: string }>(
        "DELETE FROM research_identity.membership WHERE session_id=ANY($1::uuid[]) RETURNING participant_id",
        [ids],
      );
      await pool.query("DELETE FROM sessions WHERE id=ANY($1::uuid[])", [ids]);
      if (participants.rows.length) {
        await pool.query(
          "DELETE FROM research_identity.participants p WHERE id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM research_identity.membership m WHERE m.participant_id=p.id)",
          [participants.rows.map((row) => row.participant_id)],
        );
      }
    }
    if (kitsToDelete.length)
      await pool.query("DELETE FROM kit_definitions WHERE id=ANY($1::uuid[])", [
        kitsToDelete,
      ]);
    if (mapsToDelete.length)
      await pool.query("DELETE FROM maps WHERE id=ANY($1::uuid[])", [
        mapsToDelete,
      ]);
  } finally {
    await pool.end();
  }
}
