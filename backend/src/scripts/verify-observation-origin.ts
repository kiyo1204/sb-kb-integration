// TEST ONLY: guarded disposable PostgreSQL and product API; no normal publication.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import pg from "pg";
const { Pool } = pg;
import { verifyMockTestUrl } from "./mock-db.js";
import { digest } from "../delivery-reliability.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const listener = createServer();
await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((r) => listener.close(() => r()));
const base = `http://127.0.0.1:${port}`,
  researcher = process.env.RESEARCHER_API_TOKEN!;
const server = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    API_BIND_ADDRESS: "127.0.0.1",
    STAGE1_EXPERIMENT_LEARNER_PREVIEW: "1",
    STAGE1_EXPERIMENT_LEARNER_ENABLED: "0",
  },
  stdio: "ignore",
  windowsHide: true,
});
let auth = researcher;
const extra: Record<string, string> = {};
async function call(path: string, body?: unknown, method = "POST") {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + auth,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(r.ok, method + " " + path + " HTTP " + r.status);
  return r.json();
}
async function verifyBrowser<T>(fixture: Record<string, string>, script = "verify-observation-context-browser.ts") {
  let evidence: T | undefined;
  const child = spawn(
    process.execPath,
    ["--import", "./node_modules/tsx/dist/loader.mjs", `scripts/${script}`],
    {
      cwd: "../frontend",
      env: { ...process.env, API_BASE_URL: base, ...fixture },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      windowsHide: true,
    },
  );
  child.on("message", (message) => { evidence = message as T; });
  assert.equal((await once(child, "exit"))[0], 0, "observation browser verification");
  assert.ok(evidence);
  return evidence;
}
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) {
        ready = true;
        break;
      }
    } catch {
      /* startup */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready);
  const goal = await call("/research/goal-maps/import", {
    format: "sb-kb-goal-map",
    schemaVersion: 1,
    goalMap: {
      title: "MOCK origin diagnosis " + randomUUID(),
      concepts: [
        { id: "a", label: "MOCK A", position: { x: 80, y: 100 } },
        { id: "b", label: "MOCK B", position: { x: 650, y: 100 } },
      ],
      links: [
        {
          id: "ab",
          label: "MOCK kit relation",
          sourceId: "a",
          targetId: "b",
          labelPosition: null,
        },
      ],
    },
  });
  const parts = (
    await pool.query(
      "SELECT id,source_concept_id AS source FROM kit_concept_items WHERE kit_definition_id=$1 ORDER BY id",
      [goal.kitDefinitionId],
    )
  ).rows;
  const draft = await call("/research/materials", {});
  const saved = await call(
    `/research/materials/${draft.id}`,
    {
      expectedRevision: draft.editRevision,
      body: {
        title: "MOCK direction material",
        researcherDescription: "",
        videoRef: "/mock-only.mp4",
        sbInstructions: "MOCK SB",
        kbInstructions: "MOCK KB",
        integrationInstructions: "MOCK integration",
        kitId: goal.kitDefinitionId,
        seedConceptItemIds: [parts[0].id],
        integrationSeconds: 1800,
      },
    },
    "PUT",
  );
  const material = await call(`/research/materials/${draft.id}/publish`, {
    expectedRevision: saved.editRevision,
  });
  const run = await call("/research/experiment-runs", {
    name: "MOCK captured origin",
    catalogVersionId: material.id,
    plannedParticipants: 2,
  });
  const participants = [];
  for (const label of ["MOCK A", "MOCK B"])
    participants.push(
      await call(`/research/experiment-runs/${run.id}/participants`, {
        participantLabel: label,
      }),
    );
  await call(`/research/experiment-runs/${run.id}/start`, {});
  const fixtures = [];
  for (const p of participants) {
    auth = p.issuedCode;
    for (const k of Object.keys(extra)) delete extra[k];
    const secret = randomBytes(32).toString("base64url");
    extra["X-Experiment-Client"] = secret;
    const claim = await call("/experiment-client/claim", {});
    extra["X-Experiment-Generation"] = String(claim.deviceGeneration);
    await call(`/sessions/${p.sessionId}/start`, {});
    const flow = await call(`/sessions/${p.sessionId}/flow`, undefined, "GET");
    const stageId = flow.stages.find(
      (s: { stageType: string }) => s.stageType === "LESSON",
    ).id;
    await call(`/session-stages/${stageId}/start`, {});
    fixtures.push({
      sessionId: p.sessionId,
      code: p.issuedCode,
      stageId,
      secret,
      clientId: claim.clientId,
      generation: claim.deviceGeneration,
    });
  }
  const leaseCases = process.argv.includes("--stream-v3-lease");
  if (leaseCases || process.argv.includes("--stream-v3")) {
    const old = fixtures[0];
    const legacyStreamId = randomUUID();
    const event = { schemaVersion: 1, eventType: "SCREEN_ENTER", targetType: "SCREEN", stageId: old.stageId, outcome: "SUCCESS", clientTimeQuality: "OBSERVED", clientTimestamp: new Date().toISOString() };
    for (const sequence of [1, 2]) {
      const r = await fetch(`${base}/api/sessions/${old.sessionId}/events`, {
        method: "POST", body: JSON.stringify(event), headers: {
          Authorization: "Bearer " + old.code, "Content-Type": "application/json",
          "X-Experiment-Client": old.secret, "X-Experiment-Generation": String(old.generation),
          "X-Experiment-Origin-Client": old.clientId, "X-Experiment-Origin-Generation": String(old.generation),
          "X-Client-Stream-Id": legacyStreamId, "X-Client-Sequence": String(sequence), "Idempotency-Key": randomUUID(),
        },
      });
      assert.equal(r.status, 201, "old stream fixture must have a receipt maximum above 1");
    }
    const before = await pool.query("SELECT count(*)::int n FROM research_events WHERE session_id=$1 AND schema_version=1", [old.sessionId]);
    const v3 = await verifyBrowser<{
      accepted: { key: string; stream: string; order: string; body: unknown; eventId: string; sequenceNumber: string }[];
      unsaved: string[];
    }>({ OBSERVATION_V3_FIXTURE: JSON.stringify({ old, runId: run.id, legacyStreamId, event, leaseCases }) }, "verify-observation-stream-v3-api-browser.ts");
    const stored = (await pool.query(`SELECT r.event_key,r.client_id,r.client_sequence,r.request_hash,r.event_id,r.sequence_number
      FROM client_event_receipts r JOIN research_events e ON e.event_id=r.event_id AND e.session_id=r.session_id
      WHERE r.session_id=$1 AND e.schema_version=1 ORDER BY r.sequence_number`, [old.sessionId])).rows;
    const legacy = stored.filter(r => r.client_id === legacyStreamId);
    assert.deepEqual(legacy.map(r => r.client_sequence), ["1", "2"]);
    assert.deepEqual(stored.filter(r => r.client_id !== legacyStreamId), v3.accepted.map(r => ({
      event_key: r.key, client_id: r.stream, client_sequence: r.order,
      request_hash: digest({ event: r.body, stream: r.stream, order: r.order }), event_id: r.eventId, sequence_number: r.sequenceNumber,
    })));
    assert.equal((await pool.query("SELECT count(*)::int n FROM client_event_receipts WHERE session_id=$1 AND event_key=ANY($2::uuid[])", [old.sessionId, v3.unsaved])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM research_events WHERE session_id=$1 AND schema_version=1", [old.sessionId])).rows[0].n, before.rows[0].n + v3.accepted.length);
    console.log("PASS real DB: old receipts remain 1 and 2; current streams, receipt fingerprints, event IDs and server order match, no duplicates or receipts for unconfirmed rejections");
  } else {
  const evidence = await verifyBrowser<{ sessionId: string; keys: string[] }>({
    OBSERVATION_FIXTURES: JSON.stringify(fixtures),
  });
  const receipt = (
    await pool.query(
      "SELECT count(*)::int n FROM client_event_receipts WHERE session_id=$1 AND event_key=ANY($2::uuid[])",
      [evidence.sessionId, evidence.keys],
    )
  ).rows[0].n;
  const events = (
    await pool.query(
      "SELECT count(*)::int n FROM research_events e JOIN client_event_receipts r ON r.event_id=e.event_id WHERE r.session_id=$1 AND r.event_key=ANY($2::uuid[]) AND e.schema_version=1",
      [evidence.sessionId, evidence.keys],
    )
  ).rows[0].n;
  assert.equal(receipt, 2);
  assert.equal(events, 2);
  // Verify origin refusal with a genuinely superseded generation, using only this mock fixture.
  const a = fixtures[0],
    newSecret = randomBytes(32).toString("base64url");
  const candidate = await fetch(base + "/api/experiment-client/claim", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + a.code,
      "X-Experiment-Client": newSecret,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(candidate.status, 409);
  const pending = await candidate.json();
  auth = researcher;
  for (const k of Object.keys(extra)) delete extra[k];
  const switched = await call(
    `/research/experiment-runs/${run.id}/participants/${a.sessionId}/client-switch`,
    { clientId: pending.clientId, expectedDeviceGeneration: a.generation },
  );
  const key = randomUUID(),
    body = {
      schemaVersion: 1,
      eventType: "SCREEN_ENTER",
      targetType: "SCREEN",
      stageId: a.stageId,
      outcome: "SUCCESS",
      clientTimeQuality: "OBSERVED",
      clientTimestamp: new Date().toISOString(),
    };
  const headers = {
    Authorization: "Bearer " + a.code,
    "Content-Type": "application/json",
    "X-Experiment-Client": newSecret,
    "X-Experiment-Generation": String(switched.deviceGeneration),
    "X-Experiment-Origin-Client": a.clientId,
    "X-Experiment-Origin-Generation": String(a.generation),
    "X-Client-Stream-Id": randomUUID(),
    "X-Client-Sequence": "1",
    "Idempotency-Key": key,
  };
  const stale = await fetch(base + `/api/sessions/${a.sessionId}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "experiment_origin_stale");
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM client_event_receipts WHERE session_id=$1 AND event_key=$2",
        [a.sessionId, key],
      )
    ).rows[0].n,
    0,
  );
  const observationCount = async () => (await pool.query(
    "SELECT count(*)::int n FROM research_events WHERE session_id=$1 AND schema_version=1",
    [a.sessionId],
  )).rows[0].n;
  const beforeHold = await observationCount();
  const hold = await verifyBrowser<{ normal: string; held: string[] }>({
    OBSERVATION_SWITCHED: JSON.stringify({
      old: a,
      current: { ...a, secret: newSecret, clientId: pending.clientId, generation: switched.deviceGeneration },
    }),
  });
  assert.equal(new Set(hold.held).size, 2);
  assert.ok(!hold.held.includes(hold.normal));
  const matchingReceipts = (await pool.query(
    "SELECT event_key FROM client_event_receipts WHERE session_id=$1 AND event_key=ANY($2::uuid[])",
    [a.sessionId, [hold.normal, ...hold.held]],
  )).rows.map((row) => row.event_key);
  assert.deepEqual(matchingReceipts, [hold.normal]);
  assert.equal(await observationCount(), beforeHold + 1, "only the accepted record added a v1 event");
  await call(`/research/experiment-runs/${run.id}/end`, { confirmed: true });
  const ended = await fetch(base + `/api/sessions/${a.sessionId}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(ended.status, 409);
  assert.equal((await ended.json()).error, "experiment_ended");
  console.log(
    "PASS real DB: exact original keys replay once; receipt/v1 counts 2/2; real generation hold adds no event/receipt, valid ACK adds one, and ended observations remain rejected",
  );
  }
} finally {
  if (server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  await pool.end();
}
