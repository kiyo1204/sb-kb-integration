import {verifyMockTestUrl} from "./mock-db.js";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Pool } from "pg";
const url = process.env.DATABASE_URL!;
assert.ok(
  /^postgres:\/\/stage1mock:[a-f0-9]{64}@127\.0\.0\.1:[0-9]+\/stage1_mock_[a-z0-9_]+$/.test(
    url,
  ),
);
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool = new Pool({ connectionString: url });
const guard = (
  await pool.query(
    "SELECT purpose FROM stage1_mock_guard.marker WHERE singleton",
  )
).rows[0];
assert.equal(guard.purpose, "ONLY_SYNTHETIC");
assert.equal(
  (await pool.query("SELECT count(*)::int n FROM map_operation_logs")).rows[0]
    .n,
  0,
  "New-format verification requires an empty legacy stream",
);
assert.equal(
  (await pool.query("SELECT count(*)::int n FROM research_events")).rows[0].n,
  0,
  "Reset/seed before running this fresh-stream check",
);
const free = createServer();
await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
const address = free.address();
assert.ok(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((r) => free.close(() => r()));
const server = spawn(process.execPath, ["dist/index.js"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
// Do not forward server exception bodies or credentials to test output.
server.stdout?.resume();
server.stderr?.resume();
const base = "http://127.0.0.1:" + port,
  researcher = process.env.RESEARCHER_API_TOKEN!;
async function api(
  path: string,
  method = "GET",
  body?: unknown,
  token = researcher,
) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(r.ok, `${method} ${path} status ${r.status}`);
  const data = await r.json();
  assert.ok(r.ok, `${method} ${path} status ${r.status}`);
  return data;
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) {
        ready = true;
        break;
      }
    } catch {
      /*not ready*/
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ready, "Mock API failed to start");
  await api("/research/stage1/settings", "PUT", { minutes: 1 });
  const s = await api("/research/stage1/sessions", "POST", {
    participantCode: "MOCK-ISSUE12-NEW-STREAM",
    videoUrl: "/dummy.mp4",
    kitDefinitionId: "66666666-6666-4666-8666-666666666662",
    studyGroup: "CONTROL",
  });
  const token = s.learnerAccessToken as string;
  // Configure required questions without changing the existing activity order.
  await api(
    "/research/stage1/sessions/" + s.id + "/assessment/questions",
    "PUT",
    {
      questions: [
        { category: "DESCRIPTION", prompt: "MOCK question 1" },
        { category: "DESCRIPTION", prompt: "MOCK question 2" },
      ],
    },
  );
  await api("/sessions/" + s.id + "/start", "POST", {}, token);
  const lesson = s.stages.find(
    (x: { stageType: string }) => x.stageType === "LESSON",
  );
  await api("/session-stages/" + lesson.id + "/start", "POST", {}, token);
  await api("/session-stages/" + lesson.id + "/complete", "POST", {}, token);
  const prior = s.stages.find(
    (x: { stageType: string }) => x.stageType === "PRIOR_MAP",
  );
  await api("/session-stages/" + prior.id + "/start", "POST", {}, token);
  const map = await api(
    "/session-stages/" + prior.id + "/prior-map",
    "POST",
    {},
    token,
  );
  const concept = await api(
    "/maps/" + map.id + "/concepts",
    "POST",
    { label: "MOCK concept", positionX: 100, positionY: 100 },
    token,
  );
  for (const action of ["UNDO", "REDO"]) {
    const current = await api(
      "/maps/" + map.id + "/undo-redo",
      "GET",
      undefined,
      token,
    );
    await api(
      "/maps/" + map.id + "/undo-redo",
      "POST",
      {
        action,
        expectedSequenceNumber: current.sequenceNumber,
        idempotencyKey: randomUUID(),
      },
      token,
    );
  }
  assert.ok(
    (await api("/maps/" + map.id, "GET", undefined, token)).concepts.some(
      (x: { id: string }) => x.id === concept.id,
    ),
  );
  const replay = await api(
    "/research/sessions/" + s.id + "/maps/" + map.id + "/mixed-history",
  );
  assert.ok(JSON.stringify(replay).includes("REPLAYABLE"));
  await api("/maps/" + map.id + "/submit", "POST", {}, token);
  const stage = (type: string) =>
    s.stages.find((x: { stageType: string }) => x.stageType === type);
  const kit = "66666666-6666-4666-8666-666666666662";
  await api(
    "/session-stages/" + stage("KB_MAP").id + "/start",
    "POST",
    {},
    token,
  );
  const kb = await api(
    "/kits/" + kit + "/kb-map",
    "POST",
    { sessionStageId: stage("KB_MAP").id },
    token,
  );
  const parts = (
    await pool.query(
      "SELECT id,source_concept_id FROM kit_concept_items WHERE kit_definition_id=$1 ORDER BY id",
      [kit],
    )
  ).rows;
  const imported = new Map<string, string>();
  for (const [i, item] of parts.entries()) {
    const concept = await api(
      "/maps/" + kb.id + "/kit-concepts/" + item.id + "/import",
      "POST",
      { positionX: 100 + i * 180, positionY: 100 },
      token,
    );
    imported.set(item.source_concept_id, concept.id);
  }
  const links = (
    await pool.query(
      "SELECT k.id,l.source_concept_id,l.target_concept_id FROM kit_link_items k JOIN links l ON l.id=k.source_link_id WHERE k.kit_definition_id=$1 ORDER BY k.id",
      [kit],
    )
  ).rows;
  for (const item of links)
    await api(
      "/maps/" + kb.id + "/kit-links/" + item.id,
      "POST",
      {
        sourceConceptId: imported.get(item.source_concept_id),
        targetConceptId: imported.get(item.target_concept_id),
      },
      token,
    );
  await api("/maps/" + kb.id + "/submit", "POST", {}, token);
  for (const type of ["PRE_ASSESSMENT", "POST_ASSESSMENT"]) {
    if (type === "POST_ASSESSMENT") {
      const group = stage("SELF_STUDY");
      await api("/session-stages/" + group.id + "/start", "POST", {}, token);
      // Accelerate only this mock fixture's timestamp to exercise the server deadline gate.
      await pool.query(
        "UPDATE session_stages SET started_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",
        [group.id],
      );
      await api("/session-stages/" + group.id + "/complete", "POST", {}, token);
    }
    const st = stage(type);
    await api("/session-stages/" + st.id + "/start", "POST", {}, token);
    const questions = (
      await api(
        "/session-stages/" + st.id + "/assessment",
        "GET",
        undefined,
        token,
      )
    ).questions;
    await api(
      "/session-stages/" + st.id + "/assessment/submit",
      "POST",
      {
        answers: questions.map((q: { id: string }) => ({
          questionId: q.id,
          answer: "MOCK answer",
        })),
      },
      token,
    );
  }
  await api("/research/stage1/sessions/" + s.id + "/analysis");
  const raw = await api("/research/sessions/" + s.id + "/export");
  assert.equal(raw.exportVersion, 2);

  const exportResult = await api("/research/event-views", "POST", {
    filters: { sessionIds: [s.id] },
  });
  assert.ok(exportResult.eventCount > 0);
  const page = await api("/research/event-views/" + exportResult.exportId);
  assert.ok(page.events.length > 0);
  const json = await fetch(
    base +
      "/api/research/event-exports/" +
      exportResult.exportId +
      "/events.json",
    { headers: { Authorization: "Bearer " + researcher } },
  );
  assert.ok(json.ok);
  const exported = await json.json();
  assert.equal(exported.event_count, exportResult.eventCount);
  assert.ok(
    exported.events.some(
      (e: { event_type: string }) => e.event_type === "ADD_CONCEPT",
    ),
  );
  const denied = await fetch(
    base + "/api/research/event-views/" + exportResult.exportId,
    { headers: { Authorization: "Bearer " + token } },
  );
  assert.equal(denied.status, 403);
  const csv = await fetch(
    base +
      "/api/research/event-exports/" +
      exportResult.exportId +
      "/events.csv",
    { headers: { Authorization: "Bearer " + researcher } },
  );
  assert.ok(csv.ok);
  assert.ok((await csv.text()).includes("ADD_CONCEPT"));
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM map_operation_logs")).rows[0]
      .n,
    0,
  );
  const boundary = (
    await pool.query(
      "SELECT legacy_count::int n FROM map_history_boundaries WHERE map_id=$1",
      [map.id],
    )
  ).rows[0];
  assert.equal(boundary.n, 0);
  assert.ok(
    (
      await pool.query(
        "SELECT count(*)::int n FROM research_events WHERE map_id=$1 AND schema_version IN (2,5) AND event_type IN('ADD_CONCEPT','UNDO','REDO')",
        [map.id],
      )
    ).rows[0].n >= 3,
  );
  console.log(
    "Fresh mock DB: real API stage/map v2, empty legacy boundary, Undo/Redo, replay, researcher timeline and CSV: PASS",
  );
} finally {
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.once("exit", () => resolve());
    setTimeout(() => {
      server.kill();
      resolve();
    }, 5000).unref();
  });
  await pool.end();
}
