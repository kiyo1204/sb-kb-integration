import assert from "node:assert/strict";
import { Pool } from "pg";
import { verifyMockTestUrl } from "./mock-db.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
await verifyMockTestUrl(databaseUrl);

const base = process.env.API_BASE_URL ?? "http://127.0.0.1:3015";
const pool = new Pool({ connectionString: databaseUrl });
const path = "/api/tutorial/kit-practice/check";
const parts = {
  plant: "77777777-7777-4777-8777-777777777781",
  photosynthesis: "77777777-7777-4777-8777-777777777782",
  carbonDioxide: "77777777-7777-4777-8777-777777777783",
  perform: "88888888-8888-4888-8888-888888888882",
  require: "88888888-8888-4888-8888-888888888883",
};

async function snapshot() {
  const result = await pool.query<{
    sessions: string;
    stages: string;
    maps: string;
    concepts: string;
    links: string;
    researchEvents: string;
    operationLogs: string;
    historyBoundaries: string;
  }>(`SELECT
      (SELECT count(*)::text FROM sessions) AS sessions,
      (SELECT count(*)::text FROM session_stages) AS stages,
      (SELECT count(*)::text FROM maps) AS maps,
      (SELECT count(*)::text FROM concepts) AS concepts,
      (SELECT count(*)::text FROM links) AS links,
      (SELECT count(*)::text FROM research_events) AS "researchEvents",
      (SELECT count(*)::text FROM map_operation_logs) AS "operationLogs",
      (SELECT count(*)::text FROM map_history_boundaries) AS "historyBoundaries"`);
  return result.rows[0];
}

async function post(body: unknown, status: number) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, status, `practice check returned ${response.status}`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json() as Promise<unknown>;
}

function assertCounts(value: unknown, matched: boolean, concepts: number, relations: number) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const result = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(result).sort(), ["concepts", "matched", "relations"]);
  assert.equal(result.matched, matched);
  assert.deepEqual(result.concepts, { matched: concepts, total: 3 });
  assert.deepEqual(result.relations, { matched: relations, total: 2 });
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes("55555555-"), "response contains no goal concept identifiers");
  assert.ok(!serialized.includes("99999999-"), "response contains no goal link identifiers");
  assert.ok(!serialized.includes("sourceConceptId"), "response contains no goal endpoint structure");
}

try {
  const before = await snapshot();
  const partial = {
    concepts: [
      { kitConceptItemId: parts.plant, id: "practice-plant" },
      { kitConceptItemId: parts.photosynthesis, id: "practice-photosynthesis" },
    ],
    links: [
      {
        kitLinkItemId: parts.perform,
        id: "practice-perform",
        sourceConceptId: "practice-plant",
        targetConceptId: "practice-photosynthesis",
      },
    ],
  };
  assertCounts(await post(partial, 200), false, 2, 1);

  const reversed = {
    concepts: [
      ...partial.concepts,
      { kitConceptItemId: parts.carbonDioxide, id: "practice-carbon-dioxide" },
    ],
    links: [
      ...partial.links,
      {
        kitLinkItemId: parts.require,
        id: "practice-require",
        sourceConceptId: "practice-carbon-dioxide",
        targetConceptId: "practice-photosynthesis",
      },
    ],
  };
  assertCounts(await post(reversed, 200), false, 3, 1);
  assertCounts(
    await post({
      ...reversed,
      links: reversed.links.map((link) =>
        link.kitLinkItemId === parts.require
          ? {
              ...link,
              sourceConceptId: "practice-photosynthesis",
              targetConceptId: "practice-carbon-dioxide",
            }
          : link,
      ),
    }, 200),
    true,
    3,
    2,
  );

  assert.deepEqual(
    await post({ ...partial, goal: { concepts: ["must-not-be-accepted"] } }, 400),
    { error: "invalid_tutorial_kit_practice" },
  );
  const unauthorized = await fetch(base + "/api/me");
  assert.equal(unauthorized.status, 401, "existing learner API authentication remains required");
  const after = await snapshot();
  assert.deepEqual(after, before, "practice checks do not modify experimental DB state or research events");
  console.log("Tutorial Kit practice API: PASS (partial, reversed, corrected, invalid, DB invariant)");
} finally {
  await pool.end();
}
