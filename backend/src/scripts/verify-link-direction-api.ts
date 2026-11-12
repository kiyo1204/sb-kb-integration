// TEST ONLY: guarded disposable PostgreSQL and product API; no normal publication.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { Pool } from "pg";
import { verifyMockTestUrl } from "./mock-db.js";
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
      title: "MOCK link direction " + randomUUID(),
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
    name: "MOCK link direction",
    catalogVersionId: material.id,
    plannedParticipants: 1,
  });
  const p = await call(`/research/experiment-runs/${run.id}/participants`, {
    participantLabel: "MOCK participant",
  });
  await call(`/research/experiment-runs/${run.id}/start`, {});
  auth = p.issuedCode;
  extra["X-Experiment-Client"] = randomBytes(32).toString("base64url");
  const claim = await call("/experiment-client/claim", {});
  extra["X-Experiment-Generation"] = String(claim.deviceGeneration);
  await call(`/sessions/${p.sessionId}/start`, {});
  const flow = await call(`/sessions/${p.sessionId}/flow`, undefined, "GET");
  const stage = (type: string) =>
    flow.stages.find((s: { stageType: string }) => s.stageType === type).id;
  await call(`/session-stages/${stage("LESSON")}/start`, {});
  Object.assign(extra, {
    "X-Experiment-Origin-Client": claim.clientId,
    "X-Experiment-Origin-Generation": String(claim.deviceGeneration),
    "X-Client-Stream-Id": randomUUID(),
    "X-Client-Sequence": "1",
  });
  await call(`/sessions/${p.sessionId}/events`, {
    schemaVersion: 1,
    eventType: "VIDEO_COMPLETE",
    targetType: "VIDEO",
    stageId: stage("LESSON"),
    outcome: "SUCCESS",
    clientTimeQuality: "NOT_APPLICABLE",
  });
  delete extra["X-Client-Stream-Id"];
  delete extra["X-Client-Sequence"];
  await call(`/session-stages/${stage("LESSON")}/complete`, {});
  await call(`/session-stages/${stage("PRIOR_MAP")}/start`, {});
  const sb = await call(`/session-stages/${stage("PRIOR_MAP")}/prior-map`, {});
  await call(`/maps/${sb.id}/submit`, {});
  await call(`/session-stages/${stage("KB_MAP")}/start`, {});
  const kb = await call(`/kits/${goal.kitDefinitionId}/kb-map`, {
    sessionStageId: stage("KB_MAP"),
  });
  const nodes = new Map<string, string>();
  for (const part of parts) {
    const c = await call(`/maps/${kb.id}/kit-concepts/${part.id}/import`, {
      positionX: 80 + nodes.size * 550,
      positionY: 100,
    });
    nodes.set(part.source, c.id);
  }
  const link = (
    await pool.query(
      "SELECT i.id,l.source_concept_id AS source,l.target_concept_id AS target FROM kit_link_items i JOIN links l ON l.id=i.source_link_id WHERE i.kit_definition_id=$1",
      [goal.kitDefinitionId],
    )
  ).rows[0];
  await call(`/maps/${kb.id}/kit-links/${link.id}`, {
    sourceConceptId: nodes.get(link.source),
    targetConceptId: nodes.get(link.target),
  });
  await call(`/maps/${kb.id}/submit`, {});
  await call(`/session-stages/${stage("INTEGRATION_MAP")}/start`, {});
  const map = await call(
    `/session-stages/${stage("INTEGRATION_MAP")}/integration-map`,
    {},
  );
  const ids: string[] = [];
  for (const [i, label] of [
    "MOCK source",
    "MOCK target",
    "MOCK replacement",
  ].entries()) {
    const c = await call(`/maps/${map.id}/concepts`, {
      label,
      positionX: 80 + i * 310,
      positionY: 350,
    });
    ids.push(c.id);
  }
  const child = spawn(
    process.execPath,
    [
      "node_modules/tsx/dist/cli.mjs",
      "scripts/verify-link-direction-real-browser.ts",
    ],
    {
      cwd: "../frontend",
      env: {
        ...process.env,
        API_BASE_URL: base,
        DIRECTION_SESSION: p.sessionId,
        DIRECTION_RUN: run.id,
        DIRECTION_MAP: map.id,
        DIRECTION_CONCEPTS: JSON.stringify(ids),
        DIRECTION_CODE: p.issuedCode,
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  assert.equal((await once(child, "exit"))[0], 0, "real browser assertions");
  const links = (
    await pool.query(
      "SELECT source_concept_id AS source,target_concept_id AS target FROM links WHERE map_id=$1 AND label='MOCK direction new'",
      [map.id],
    )
  ).rows;
  assert.deepEqual(links, [{ source: ids[0], target: ids[2] }]);
  const history = (
    await pool.query(
      "SELECT event_type,outcome FROM research_events WHERE map_id=$1 AND event_type IN ('ADD_LINK','RECONNECT_LINK') ORDER BY sequence_number",
      [map.id],
    )
  ).rows;
  assert.equal(
    history.filter(
      (e) => e.event_type === "ADD_LINK" && e.outcome === "SUCCESS",
    ).length,
    1,
  );
  assert.equal(
    history.filter(
      (e) => e.event_type === "RECONNECT_LINK" && e.outcome === "SUCCESS",
    ).length,
    1,
  );
  assert.ok(
    history.some(
      (e) => e.event_type === "ADD_LINK" && e.outcome === "CANCELLED",
    ),
  );
  console.log(
    JSON.stringify({
      result: "PASS",
      database: "guarded disposable PostgreSQL",
      protocol: "SBKB_INTEGRATION_V1",
      mapType: "INTEGRATION",
      dbDirection: true,
      successfulCreates: 1,
      successfulReconnects: 1,
      cancellationEvents: history.filter((e) => e.outcome === "CANCELLED")
        .length,
    }),
  );
} finally {
  server.kill();
  await once(server, "exit").catch(() => undefined);
  await pool.end();
}
