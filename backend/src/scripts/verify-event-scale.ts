import type { ExportEvent } from "../event-export-contract.js";
import assert from "node:assert/strict";
import express from "express";
import { Pool } from "pg";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, platform, release, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parse } from "csv-parse/sync";
import { verifyMockTestUrl, verificationReportPath } from "./mock-db.js";
import { createStage1Session } from "../sessions.js";
import { accessControl } from "../access-control.js";
import { EventExportService } from "../event-export-service.js";
import { registerEventExportRoutes } from "../event-export-routes.js";
const url = process.env.DATABASE_URL!;
await verifyMockTestUrl(url);
const pool = new Pool({ connectionString: url }),
  root = await mkdtemp(join(tmpdir(), "stage1-scale-")),
  service = new EventExportService(pool, { root });
const app = express();
app.use(express.json());
app.use("/api", accessControl(pool));
registerEventExportRoutes(app, pool, service);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const addr = server.address();
assert.ok(addr && typeof addr !== "string");
const base = "http://127.0.0.1:" + addr.port + "/api/research/",
  token = process.env.RESEARCHER_API_TOKEN!,
  headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
try {
  const ids: string[] = [];
  const fixtureStart = performance.now();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (let i = 0; i < 20; i++) {
      const s = await createStage1Session(c, {
        participantCode: "MOCK-SCALE-" + i,
        lessonVideoUrl: "/dummy.mp4",
        kitDefinitionId: "66666666-6666-4666-8666-666666666662",
        studyGroup: i % 2 ? "CONTROL" : "EXPERIMENTAL",
        groupActivitySeconds: 60,
      });
      ids.push(s.id);
      const stage = s.stages.find((x) => x.stageType === "LESSON")!;
      await c.query(
        `INSERT INTO research_events(schema_version,session_id,stage_id,participant_code,study_group,activity,actor_type,event_type,target_type,outcome,sequence_number,client_time_quality,before_quality,after_quality) SELECT 1,$1,$2,'MOCK-SCALE',$3,'LESSON','LEARNER','VIDEO_PLAY','VIDEO','SUCCESS',n,'MISSING','MISSING','MISSING' FROM generate_series(1,200)n`,
        [s.id, stage.id, i % 2 ? "CONTROL" : "EXPERIMENTAL"],
      );
      await c.query("INSERT INTO research_event_counters VALUES($1,201)", [
        s.id,
      ]);
    }
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  const databaseTotalsAtMeasurement=(await pool.query("SELECT (SELECT count(*)::int FROM sessions) sessions,(SELECT count(*)::int FROM research_events) events,(SELECT count(*)::int FROM map_operation_logs) legacy_logs")).rows[0];
  const fixtureMs = performance.now() - fixtureStart,
    start = performance.now();
  const prepared = await fetch(base + "event-views", {
    method: "POST",
    headers,
    body: JSON.stringify({
      filters: { sessionIds: ids, eventTypes: ["VIDEO_PLAY"] },
    }),
  });
  assert.equal(prepared.status, 201);
  const metadata = await prepared.json();
  const prepareMs = performance.now() - start;
  assert.equal(metadata.eventCount, 4000);
  let offset: number | null = 0;
  const seen: string[] = [],
    pageMs: number[] = [];
  while (offset !== null) {
    const t = performance.now();
    const response: Response = await fetch(
      base + "event-views/" + metadata.exportId + "?offset=" + offset,
      { headers },
    );
    assert.equal(response.status, 200);
    const p = (await response.json()) as {
      events: ExportEvent[];
      next: number | null;
    };
    pageMs.push(performance.now() - t);
    seen.push(...p.events.map((e: { event_id: string }) => e.event_id));
    offset = p.next;
  }
  assert.equal(seen.length, 4000);
  assert.equal(new Set(seen).size, 4000);
  const download = performance.now();
  const jsonResponse = await fetch(
    base + "event-exports/" + metadata.exportId + "/events.json",
    { headers },
  );
  const text = await jsonResponse.text();
  const events = JSON.parse(text).events as ExportEvent[];
  const csvResponse = await fetch(
    base + "event-exports/" + metadata.exportId + "/events.csv",
    { headers },
  );
  const csvText = await csvResponse.text(),
    csv = parse(csvText, { bom: true, columns: true }) as Record<
      string,
      string
    >[];
  assert.deepEqual(
    events.map((e: { event_id: string }) => e.event_id),
    seen,
  );
  assert.deepEqual(
    csv.map((e) => e.event_id),
    seen,
  );
  for (let i = 0; i < 4000; i++)
    for (const k of [
      "server_timestamp",
      "outcome",
      "learner_id",
      "session_id",
    ] as const)
      assert.equal(csv[i][k], events[i][k]);
  assert.ok(events.every((e) => e.learner_id?.startsWith("P-")));
  const sorted = [...pageMs].sort((a, b) => a - b);
  const result = {
    fixture:
      "synthetic SQL fixture for loading measurement; not an end-to-end acquisition benchmark",
    databaseTotalsAtMeasurement,
    participants: 20,
    sessions: 20,
    events: 4000,
    pageSize: 25,
    pages: pageMs.length,
    fixtureMs,
    prepareJsonCsvZipMs: prepareMs,
    pageMedianMs: sorted[Math.floor(sorted.length * 0.5)],
    pageP95Ms: sorted[Math.floor(sorted.length * 0.95)],
    downloadAndValidateMs: performance.now() - download,
    jsonBytes: Buffer.byteLength(text),
    csvBytes: Buffer.byteLength(csvText),
    environment: {
      os: platform(),
      release: release(),
      node: process.version,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemory: totalmem(),
      postgres: (await pool.query("SHOW server_version")).rows[0]
        .server_version,
    },
    guarantees:
      "Single machine mock run only; not a production performance guarantee; 20 sessions are populated, not 20 concurrent browsers",
  };
  await writeFile(
    verificationReportPath("scale-results"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await service.dispose();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  await rm(root, { recursive: true, force: true });
}
