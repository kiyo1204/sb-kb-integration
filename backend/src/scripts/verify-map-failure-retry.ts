import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { verifyMockTestUrl } from "./mock-db.js";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";

await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const base = process.env.API_BASE_URL!;
const researcher = process.env.RESEARCHER_API_TOKEN!;
const secret = "MOCK_PRIVATE_DATABASE_PASSWORD_DO_NOT_EXPOSE";
let child: ChildProcess | undefined;
let childLog = "";
const checks: string[] = [];
const timeout = () => AbortSignal.timeout(10000);
async function api(
  path: string,
  token: string,
  status: number,
  method = "GET",
  body?: unknown,
  key?: string,
  origin = base,
) {
  const response = await fetch(origin + "/api" + path, {
    method,
    signal: timeout(),
    headers: {
      Authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(!text.includes("MOCK_PRIVATE"), "internal error in response");
  assert.equal(response.status, status, method + " " + path + " " + text);
  return JSON.parse(text);
}
async function fixture() {
  const token = createLearnerToken(),
    session = randomUUID(),
    stage = randomUUID(),
    map = randomUUID();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "INSERT INTO sessions(id,protocol_key,participant_code,lesson_video_url,research_kit_definition_id,status,started_at) VALUES($1,'STAGE1_4','MOCK-P1','/mock.mp4','66666666-6666-4666-8666-666666666662','IN_PROGRESS',clock_timestamp())",
      [session],
    );
    await storeLearnerToken(c, session, token.hash);
    await c.query(
      "INSERT INTO session_stages(id,session_id,stage_type,order_index,status,started_at) VALUES($1,$2,'PRIOR_MAP',0,'IN_PROGRESS',clock_timestamp())",
      [stage, session],
    );
    await c.query(
      "INSERT INTO maps(id,type,session_stage_id) VALUES($1,'PRIOR',$2)",
      [map, stage],
    );
    await c.query(
      "INSERT INTO map_initial_snapshots(map_id,snapshot_version,snapshot) VALUES($1,1,$2)",
      [
        map,
        {
          snapshotVersion: 1,
          mapId: map,
          mapType: "PRIOR",
          basedOnMapId: null,
          kitDefinitionId: null,
          concepts: [],
          links: [],
        },
      ],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  const a = await api(`/maps/${map}/concepts`, token.token, 201, "POST", {
    label: "MOCK A",
    positionX: 0,
    positionY: 0,
  });
  const b = await api(`/maps/${map}/concepts`, token.token, 201, "POST", {
    label: "MOCK B",
    positionX: 100,
    positionY: 0,
  });
  const link = await api(`/maps/${map}/links`, token.token, 201, "POST", {
    label: "MOCK R",
    sourceConceptId: a.id,
    targetConceptId: b.id,
  });
  return { session, stage, map, link: link.id as string, token: token.token };
}
async function failEvents(map: string, type: string, outcomes: string[]) {
  await pool.query(
    `CREATE TRIGGER pr16_fail_event BEFORE INSERT ON research_events FOR EACH ROW WHEN (NEW.map_id='${map}'::uuid AND NEW.event_type='${type}' AND NEW.outcome IN (${outcomes.map((x) => "'" + x + "'").join(",")})) EXECUTE FUNCTION pr16_fail()`,
  );
}
async function clearFaults() {
  await pool.query(
    "DROP TRIGGER IF EXISTS pr16_fail_event ON research_events; DROP TRIGGER IF EXISTS pr16_fail_link ON links",
  );
}
async function eventRows(map: string, key: string) {
  return (
    await pool.query(
      "SELECT event_id,event_type,outcome,reason_code,before_state,after_state,sequence_number FROM research_events WHERE map_id=$1 AND idempotency_key=$2 ORDER BY sequence_number",
      [map, key],
    )
  ).rows;
}
async function replay(s: Awaited<ReturnType<typeof fixture>>) {
  const result = await api(
    `/research/sessions/${s.session}/maps/${s.map}/mixed-history`,
    researcher,
    200,
  );
  assert.equal(result.status, "REPLAYABLE", JSON.stringify(result));
  return result;
}
try {
  // Run the actual additional migration against transaction-local legacy-shaped rows.
  // Temporary names shadow public tables/indexes; rollback removes every test object.
  const migrationClient = await pool.connect();
  try {
    await migrationClient.query("BEGIN");
    await migrationClient.query(
      "CREATE TEMP TABLE research_events(event_id uuid PRIMARY KEY,map_id uuid NOT NULL,idempotency_key uuid,outcome text NOT NULL,reason_code text) ON COMMIT DROP",
    );
    await migrationClient.query(
      "CREATE UNIQUE INDEX research_events_map_idempotency_uq ON research_events(map_id,idempotency_key) WHERE idempotency_key IS NOT NULL",
    );
    const mapId = randomUUID(),
      key = randomUUID(),
      eventId = randomUUID();
    await migrationClient.query(
      "INSERT INTO research_events VALUES($1,$2,$3,'FAILURE','SERVER')",
      [eventId, mapId, key],
    );
    const oldRows = (
      await migrationClient.query("SELECT * FROM research_events")
    ).rows;
    const migration = await import(
      new URL(
        "../../migrations/1791040000000_separate_map_attempt_idempotency.js",
        import.meta.url,
      ).href
    );
    await migration.up({ sql: (text: string) => migrationClient.query(text) });
    assert.deepEqual(
      (await migrationClient.query("SELECT * FROM research_events")).rows,
      oldRows,
    );
    await migrationClient.query(
      "INSERT INTO research_events VALUES($1,$2,$3,'SUCCESS',NULL)",
      [randomUUID(), mapId, key],
    );
    for (const outcome of ["SUCCESS", "FAILURE"]) {
      await migrationClient.query("SAVEPOINT duplicate_attempt");
      await assert.rejects(
        migrationClient.query(
          "INSERT INTO research_events VALUES($1,$2,$3,$4,NULL)",
          [randomUUID(), mapId, key, outcome],
        ),
        (e: unknown) =>
          !!e && typeof e === "object" && "code" in e && e.code === "23505",
      );
      await migrationClient.query("ROLLBACK TO SAVEPOINT duplicate_attempt");
    }
    assert.equal(
      (
        await migrationClient.query(
          "SELECT count(*)::int n FROM research_events",
        )
      ).rows[0].n,
      2,
    );
    checks.push(
      "179104 actual migration preserves existing FAILURE rows and uniquely separates success/attempt slots",
    );
  } finally {
    await migrationClient.query("ROLLBACK");
    migrationClient.release();
  }
  await pool.query(
    `CREATE FUNCTION pr16_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${secret}'; END $$`,
  );
  const s = await fixture();
  const linkPath = `/links/${s.link}/position`;
  // A real API process with only its failure-logging connection acquisition rejected.
  const listener = createServer();
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((r) => listener.close(() => r()));
  child = spawn(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "--import",
      "./dist/scripts/fixtures/map-failure-connect.js",
      "dist/index.js",
    ],
    {
      env: {
        ...process.env,
        PORT: String(port),
        API_BIND_ADDRESS: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout!.on("data", (b) => {
    childLog += String(b);
  });
  child.stderr!.on("data", (b) => {
    childLog += String(b);
  });
  const origin = "http://127.0.0.1:" + port;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (
      await fetch(origin + "/api/health", { signal: timeout() })
        .then((r) => r.ok)
        .catch(() => false)
    ) {
      ready = true;
      break;
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, "fault process not ready");
  const invalid = await api(
    linkPath,
    s.token,
    400,
    "PATCH",
    { labelPositionX: "invalid", labelPositionY: 0 },
    randomUUID(),
    origin,
  );
  assert.equal(invalid.operationOutcome, "REJECTED");
  assert.equal(invalid.logSaved, false);
  const before = await api(`/maps/${s.map}`, s.token, 200);
  await pool.query(
    `CREATE TRIGGER pr16_fail_link BEFORE UPDATE ON links FOR EACH ROW WHEN (OLD.id='${s.link}'::uuid) EXECUTE FUNCTION pr16_fail()`,
  );
  try {
    const failure = await api(
      linkPath,
      s.token,
      500,
      "PATCH",
      { labelPositionX: 30, labelPositionY: 40 },
      randomUUID(),
      origin,
    );
    assert.equal(failure.operationOutcome, "FAILURE");
    assert.equal(failure.logSaved, false);
  } finally {
    await clearFaults();
  }
  assert.deepEqual(await api(`/maps/${s.map}`, s.token, 200), before);
  assert.equal(child.exitCode, null);
  assert.equal(
    (await fetch(origin + "/api/health", { signal: timeout() })).status,
    200,
  );
  assert.ok(
    (childLog.match(/MOCK_MAP_LOG_CONNECTION_REJECTED/g) ?? []).length >= 2,
  );
  assert.ok(
    !/MOCK_PRIVATE|unhandledRejection|UnhandledPromiseRejection/.test(childLog),
    "internal error or unhandled rejection in process output",
  );
  checks.push(
    "actual API connect rejection: original 400/500, safe outcome/logSaved=false, health and process survive",
  );
  const ended = once(child, "exit");
  child.kill();
  await ended;
  child = undefined;
  // Connection succeeds, but both the mutation and failure event INSERT fail.
  await pool.query(
    `CREATE TRIGGER pr16_fail_link BEFORE UPDATE ON links FOR EACH ROW WHEN (OLD.id='${s.link}'::uuid) EXECUTE FUNCTION pr16_fail()`,
  );
  await failEvents(s.map, "MOVE_LINK", ["FAILURE"]);
  try {
    const failure = await api(
      linkPath,
      s.token,
      500,
      "PATCH",
      { labelPositionX: 30, labelPositionY: 40 },
      randomUUID(),
    );
    assert.equal(failure.operationOutcome, "FAILURE");
    assert.equal(failure.logSaved, false);
    assert.deepEqual(await api(`/maps/${s.map}`, s.token, 200), before);
  } finally {
    await clearFaults();
  }
  checks.push(
    "connected failure-event INSERT failure: original 500 retained, no partial Map write or internal error",
  );
  // Keep a genuine FAILURE event and retry the exact request with the same key.
  const moveKey = randomUUID(),
    move = { labelPositionX: 30, labelPositionY: 40 };
  await pool.query(
    `CREATE TRIGGER pr16_fail_link BEFORE UPDATE ON links FOR EACH ROW WHEN (OLD.id='${s.link}'::uuid) EXECUTE FUNCTION pr16_fail()`,
  );
  try {
    for (let i = 0; i < 2; i++) {
      const failure = await api(linkPath, s.token, 500, "PATCH", move, moveKey);
      assert.equal(failure.operationOutcome, "FAILURE");
      assert.equal(failure.logSaved, true);
    }
  } finally {
    await clearFaults();
  }
  const attempts = await eventRows(s.map, moveKey);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, "FAILURE");
  assert.deepEqual(await api(`/maps/${s.map}`, s.token, 200), before);
  const moves = await Promise.all(
    Array.from({ length: 4 }, () =>
      api(linkPath, s.token, 200, "PATCH", move, moveKey),
    ),
  );
  for (const result of moves) assert.deepEqual(result, moves[0]);
  assert.deepEqual(
    await api(linkPath, s.token, 200, "PATCH", move, moveKey),
    moves[0],
  );
  let rows = await eventRows(s.map, moveKey);
  assert.deepEqual(
    rows.map((x) => x.outcome),
    ["FAILURE", "SUCCESS"],
  );
  assert.equal(rows[0].event_id, attempts[0].event_id);
  assert.equal(rows[1].event_type, "MOVE_LINK");
  assert.equal(
    rows[1].before_state.links.find((x: { id: string }) => x.id === s.link)
      .labelPositionX,
    undefined,
  );
  assert.equal(
    rows[1].after_state.links.find((x: { id: string }) => x.id === s.link)
      .labelPositionX,
    30,
  );
  await replay(s);
  checks.push(
    "MOVE_LINK: retained/deduplicated FAILURE, exact-key concurrent retry and duplicate success ACK, DB/replay match",
  );
  // Exercise both Undo and Redo, using matching header and body keys.
  for (const action of ["UNDO", "REDO"] as const) {
    const current = await api(`/maps/${s.map}/undo-redo`, s.token, 200),
      key = randomUUID();
    const body = {
      action,
      expectedSequenceNumber: current.sequenceNumber,
      idempotencyKey: key,
    };
    const start = await api(`/maps/${s.map}`, s.token, 200);
    await failEvents(s.map, action, ["SUCCESS"]);
    try {
      const failure = await api(
        `/maps/${s.map}/undo-redo`,
        s.token,
        409,
        "POST",
        body,
        key,
      );
      assert.equal(failure.operationOutcome, "FAILURE");
      assert.equal(failure.logSaved, true);
    } finally {
      await clearFaults();
    }
    const failed = await eventRows(s.map, key);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].outcome, "FAILURE");
    assert.deepEqual(await api(`/maps/${s.map}`, s.token, 200), start);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        api(`/maps/${s.map}/undo-redo`, s.token, 200, "POST", body, key),
      ),
    );
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal(results[0].kind, "applied");
    assert.ok(results[0].relatedOperationLogId);
    assert.deepEqual(
      await api(`/maps/${s.map}/undo-redo`, s.token, 200, "POST", body, key),
      results[0],
    );
    rows = await eventRows(s.map, key);
    assert.deepEqual(
      rows.map((x) => x.outcome),
      ["FAILURE", "SUCCESS"],
    );
    assert.equal(rows[0].event_id, failed[0].event_id);
    assert.equal(results[0].operationId, rows[1].event_id);
    const saved = await api(`/maps/${s.map}`, s.token, 200);
    assert.equal(
      saved.links.find((x: { id: string }) => x.id === s.link).labelPositionX,
      action === "UNDO" ? null : 30,
    );
    await replay(s);
    checks.push(
      action +
        ": FAILURE never applied, exact-key concurrent retry/duplicate ACK, one SUCCESS and preserved failure, DB/replay match",
    );
  }
  // The same valid request was initially refused because its own Stage was not active.
  const key = randomUUID(),
    payload = { labelPositionX: 80, labelPositionY: 90 };
  await pool.query(
    "UPDATE session_stages SET status='PENDING',started_at=NULL WHERE id=$1",
    [s.stage],
  );
  const rejected = await api(linkPath, s.token, 404, "PATCH", payload, key);
  assert.equal(rejected.operationOutcome, "REJECTED");
  assert.equal(rejected.logSaved, true);
  const rejection = await eventRows(s.map, key);
  assert.equal(rejection.length, 1);
  assert.equal(rejection[0].outcome, "REJECTED");
  await pool.query(
    "UPDATE session_stages SET status='IN_PROGRESS',started_at=clock_timestamp() WHERE id=$1",
    [s.stage],
  );
  const accepted = await Promise.all(
    Array.from({ length: 4 }, () =>
      api(linkPath, s.token, 200, "PATCH", payload, key),
    ),
  );
  for (const result of accepted) assert.deepEqual(result, accepted[0]);
  rows = await eventRows(s.map, key);
  assert.deepEqual(
    rows.map((x) => x.outcome),
    ["REJECTED", "SUCCESS"],
  );
  assert.equal(rows[0].event_id, rejection[0].event_id);
  await replay(s);
  checks.push(
    "REJECTED keeps its audit row and does not block the same request after Stage access recovers",
  );
  const exportView = await api(
    "/research/event-exports",
    researcher,
    201,
    "POST",
    { filters: { sessionIds: [s.session] } },
  );
  const exported = await fetch(
    base + `/api/research/event-exports/${exportView.exportId}/events.json`,
    { headers: { Authorization: "Bearer " + researcher }, signal: timeout() },
  );
  const json = await exported.json();
  assert.ok(!JSON.stringify(json).includes("MOCK_PRIVATE"));
  assert.ok(
    json.events.some((x: { outcome: string }) => x.outcome === "FAILURE"),
  );
  assert.ok(
    json.events.some((x: { outcome: string }) => x.outcome === "REJECTED"),
  );
  assert.ok(
    json.events.some(
      (x: { event_type: string; outcome: string }) =>
        x.event_type === "MOVE_LINK" && x.outcome === "SUCCESS",
    ),
  );
  await api(
    `/research/event-exports/${exportView.exportId}`,
    researcher,
    200,
    "DELETE",
  );
  await replay(s);
  checks.push(
    "FAILURE/REJECTED/SUCCESS remain distinct in mixed replay and researcher JSON Export; no injected error text",
  );
  console.log(
    JSON.stringify({
      verification: "PR16 P1 failure logging and same-key recovery",
      checks,
      passed: checks.length,
    }),
  );
} finally {
  await clearFaults().catch(() => undefined);
  await pool
    .query("DROP FUNCTION IF EXISTS pr16_fail()")
    .catch(() => undefined);
  if (child && child.exitCode === null) {
    const ended = once(child, "exit");
    child.kill();
    await ended;
  }
  await pool.end();
}
