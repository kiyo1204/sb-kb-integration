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

const tables = [
  // Session progress, saved graphs, and Kit/goal references.
  "sessions", "session_stages", "maps", "concepts", "links",
  "concept_provenance", "link_provenance",
  "kit_definitions", "kit_concept_items", "kit_link_items",
  // Map history and the event/receipt paths used by persisted operations.
  "map_initial_snapshots", "map_history_boundaries", "map_operation_logs",
  "research_events", "research_event_counters", "operation_receipts",
] as const;
type Table = (typeof tables)[number];
type Snapshot = Record<Table, string[]>;

async function snapshot(db: Pick<Pool, "query"> = pool): Promise<Snapshot> {
  // A single statement uses one MVCC snapshot. Compare full rows as text so
  // PostgreSQL bigint and timestamp values are not rounded by JS conversion.
  const projections = tables.map((table) => `ARRAY(
    SELECT to_jsonb(saved_row)::text FROM public.${table} AS saved_row
    ORDER BY to_jsonb(saved_row)::text COLLATE "C"
  ) AS ${table}`);
  const result = await db.query<Snapshot>(`SELECT ${projections.join(", ")}`);
  return result.rows[0]!;
}

function assertUnchanged(before: Snapshot, after: Snapshot) {
  for (const table of tables) {
    const expected = before[table];
    const actual = after[table];
    assert.equal(actual.length, expected.length, `practice DB row count changed: ${table}`);
    assert.ok(
      expected.every((row, index) => row === actual[index]),
      `practice DB row identifiers or values changed: ${table}`,
    );
  }
}

async function verifySameCountUpdateDetection() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fixture = await client.query<{ id: string }>(
      "INSERT INTO maps (type, status, title) VALUES ('GOAL', 'DRAFT', 'Synthetic invariant probe') RETURNING id",
    );
    const beforeUpdate = await snapshot(client);
    const updated = await client.query(
      "UPDATE maps SET title = 'Synthetic invariant probe updated' WHERE id = $1",
      [fixture.rows[0]!.id],
    );
    assert.equal(updated.rowCount, 1);
    const afterUpdate = await snapshot(client);
    assert.equal(afterUpdate.maps.length, beforeUpdate.maps.length);
    assert.throws(
      () => assertUnchanged(beforeUpdate, afterUpdate),
      { message: "practice DB row identifiers or values changed: maps" },
    );
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
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
  for (const invalidId of [12, ["practice-id"]]) {
    for (const body of [
      { ...partial, concepts: [ ...partial.concepts, { kitConceptItemId: parts.carbonDioxide, id: invalidId } ] },
      { ...partial, links: [{ ...partial.links[0], id: invalidId }] },
    ]) {
      assert.deepEqual(await post(body, 400), { error: "invalid_tutorial_kit_practice" });
    }
  }

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
  assertUnchanged(before, await snapshot());
  await verifySameCountUpdateDetection();
  assertUnchanged(before, await snapshot());
  console.log("Tutorial Kit practice API: PASS (partial, reversed, corrected, invalid, DB invariant, same-count update detected and rolled back)");
} finally {
  await pool.end();
}
