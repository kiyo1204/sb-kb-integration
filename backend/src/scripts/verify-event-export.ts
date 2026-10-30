import {verifyMockTestUrl} from "./mock-db.js";
import assert from "node:assert/strict";
import express from "express";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { fromBuffer, type ZipFile } from "yauzl";
import {
  accessControl,
  createLearnerToken,
  storeLearnerToken,
} from "../access-control.js";
import { createStage1Session } from "../sessions.js";
import { insertResearchEvent, type EventInput } from "../research-events.js";
import { insertAudit, registerAudit } from "../server-audit.js";
import { registerEventExportRoutes } from "../event-export-routes.js";
import {
  EventExportService,
  ExportLimitError,
  type ExportMetadata,
} from "../event-export-service.js";
import {
  parseFilters,
  parseInstant,
  commonColumns,
  detailColumns,
  csvRows,
  learnerId,
  type ExportEvent,
} from "../event-export-contract.js";
import { csvCell } from "../csv.js";
const url = process.env.DATABASE_URL!;
await verifyMockTestUrl(url);
const pool = new Pool({ connectionString: url }),
  root = await mkdtemp(join(tmpdir(), "stage1-issue9-check-")),
  researcher = process.env.RESEARCHER_API_TOKEN!;
const service = new EventExportService(pool, { root });
const app = express();
app.use(express.json());
app.use("/api", accessControl(pool));
registerAudit(app, pool);
registerEventExportRoutes(app, pool, service);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = "http://127.0.0.1:" + address.port + "/api";
async function api(
  path: string,
  body?: unknown,
  token = researcher,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}
async function fixture(group: "CONTROL" | "EXPERIMENTAL") {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const s = await createStage1Session(c, {
      participantCode: "not-for-new-export-" + randomUUID(),
      lessonVideoUrl: "/dummy.mp4",
      kitDefinitionId: "66666666-6666-4666-8666-666666666662",
      studyGroup: group,
      groupActivitySeconds: 60,
    });
    const token = createLearnerToken();
    await storeLearnerToken(c, s.id, token.hash);
    await c.query(
      "UPDATE session_stages SET status='COMPLETED',started_at='2026-04-01T00:00:05Z',completed_at='2026-04-01T00:05:00Z' WHERE session_id=$1",
      [s.id],
    );
    const q = (
      await c.query(
        "INSERT INTO assessment_questions(session_id,category,prompt,display_order) VALUES($1,'DESCRIPTION','Mock prompt',0) RETURNING id",
        [s.id],
      )
    ).rows[0].id;
    await c.query("COMMIT");
    return { ...s, token: token.token, question: q };
  } finally {
    c.release();
  }
}
async function create(filters: unknown) {
  const r = await api("/research/event-exports", { filters });
  assert.equal(r.status, 201, r.text);
  return JSON.parse(r.text) as ExportMetadata;
}
async function file(job: ExportMetadata, name: string) {
  const r = await api("/research/event-exports/" + job.exportId + "/" + name);
  assert.equal(r.status, 200, r.text);
  return r.text;
}
async function release(job: ExportMetadata) {
  assert.equal(
    (
      await api(
        "/research/event-exports/" + job.exportId,
        undefined,
        researcher,
        "DELETE",
      )
    ).status,
    200,
  );
}
async function data(job: ExportMetadata) {
  return JSON.parse(await file(job, "events.json")) as {
    events: ExportEvent[];
    event_count: number;
  };
}
async function unzip(buffer: Buffer) {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    fromBuffer(buffer, { lazyEntries: true }, (e, z) =>
      e ? reject(e) : resolve(z!),
    ),
  );
  const files: Record<string, string> = {};
  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", resolve);
    zip.on("entry", (entry) => {
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks: Buffer[] = [];
        stream!.on("data", (chunk) => chunks.push(chunk));
        stream!.on("error", reject);
        stream!.on("end", () => {
          files[entry.fileName] = Buffer.concat(chunks).toString("utf8");
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
  return files;
}
try {
  const control = await fixture("CONTROL"),
    experimental = await fixture("EXPERIMENTAL"),
    legacySession = randomUUID(),
    legacyStage = randomUUID();
  await pool.query(
    "INSERT INTO sessions(id,protocol_key,participant_code,lesson_video_url,research_kit_definition_id) VALUES($1,'STAGE1_4','old-code-do-not-export','/dummy.mp4','66666666-6666-4666-8666-666666666662')",
    [legacySession],
  );
  await pool.query(
    "INSERT INTO session_stages(id,session_id,stage_type,order_index) VALUES($1,$2,'PRIOR_MAP',0)",
    [legacyStage, legacySession],
  );
  const prior = control.stages.find((x) => x.stageType === "PRIOR_MAP")!,
    lesson = control.stages.find((x) => x.stageType === "LESSON")!,
    assessment = control.stages.find((x) => x.stageType === "PRE_ASSESSMENT")!,
    integration = experimental.stages.find(
      (x) => x.stageType === "INTEGRATION_MAP",
    )!;
  const mapId = (
      await pool.query(
        "INSERT INTO maps(type,session_stage_id) VALUES('PRIOR',$1) RETURNING id",
        [prior.id],
      )
    ).rows[0].id,
    oldId = randomUUID(),
    conceptId = randomUUID();
  const concept = {
    id: conceptId,
    mapId,
    label: "=2+2",
    positionX: 1,
    positionY: 2,
  };
  await pool.query(
    "INSERT INTO map_operation_logs(id,map_id,operation_type,target_type,target_id,after,sequence_number,server_timestamp) VALUES($1,$2,'ADD_CONCEPT','CONCEPT',$3,$4,1,'2030-01-01T00:00:00Z')",
    [oldId, mapId, conceptId, concept],
  );
  const before = {
    snapshotVersion: 1 as const,
    mapId,
    mapType: "PRIOR",
    basedOnMapId: null,
    kitDefinitionId: null,
    concepts: [{ ...concept, mergedIntoConceptId: null, provenance: [] }],
    links: [],
  };
  await pool.query(
    "INSERT INTO map_history_boundaries(map_id,legacy_count,legacy_last_id,boundary_snapshot) VALUES($1,1,$2,$3)",
    [mapId, oldId, before],
  );
  const c = await pool.connect();
  let ordinal = 0;
  const add = async (sid: string, event: EventInput) => {
    const e = await insertResearchEvent(c, sid, "LEARNER", event);
    assert.ok(e);
    await c.query(
      "UPDATE research_events SET server_timestamp=$2 WHERE event_id=$1",
      [
        e.eventId,
        new Date(Date.parse("2026-04-01T00:00:00Z") + ordinal++ * 1000),
      ],
    );
    return e.eventId;
  };
  try {
    await c.query("BEGIN");
    await add(control.id, {
      schemaVersion: 1,
      eventType: "VIDEO_SEEK",
      targetType: "VIDEO",
      stageId: lesson.id,
      outcome: "SUCCESS",
      clientTimeQuality: "OBSERVED",
      clientTimestamp: "2026-04-01T09:00:00+09:00",
      details: { fromSeconds: 3, toSeconds: 8 },
    });
    await add(control.id, {
      schemaVersion: 2,
      eventType: "UNDO",
      targetType: "MAP",
      targetId: mapId,
      mapId,
      outcome: "SUCCESS",
      clientTimeQuality: "NOT_APPLICABLE",
      relatedLegacyOperationLogId: oldId,
      before,
      after: { ...before, concepts: [] },
    });
    await add(control.id, {
      schemaVersion: 2,
      eventType: "MAP_SUBMIT",
      targetType: "MAP",
      targetId: mapId,
      mapId,
      outcome: "SUCCESS",
      clientTimeQuality: "NOT_APPLICABLE",
      before: { ...before, concepts: [] },
      after: { ...before, concepts: [] },
    });
    await c.query(
      "UPDATE maps SET status='SUBMITTED',submitted_at='2026-04-01T00:00:02Z' WHERE id=$1",
      [mapId],
    );
    for (const outcome of ["REJECTED", "FAILURE", "CANCELLED"] as const)
      await add(control.id, {
        schemaVersion: 2,
        eventType: "ADD_CONCEPT",
        targetType: "CONCEPT",
        mapId,
        outcome,
        reasonCode: outcome === "CANCELLED" ? "USER_CANCELLED" : "VALIDATION",
        clientTimeQuality: "NOT_APPLICABLE",
      });
    await add(control.id, {
      schemaVersion: 3,
      eventType: "ASSESSMENT_EDIT",
      targetType: "ASSESSMENT",
      stageId: assessment.id,
      targetId: control.question,
      outcome: "SUCCESS",
      clientTimeQuality: "NOT_APPLICABLE",
      before: { questionId: control.question, answer: null },
      after: { questionId: control.question, answer: "=SUM(1,2)\n説明,続き" },
    });
    await add(control.id, {
      schemaVersion: 1,
      eventType: "STAGE_PAUSE",
      targetType: "STAGE",
      stageId: lesson.id,
      outcome: "UNKNOWN",
      reasonCode: "UNKNOWN",
      clientTimeQuality: "MISSING",
    });
    const im = (
      await c.query(
        "INSERT INTO maps(type,session_stage_id) VALUES('INTEGRATION',$1) RETURNING id",
        [integration.id],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO map_history_boundaries(map_id,legacy_count,boundary_snapshot) VALUES($1,0,$2)",
      [im, { ...before, mapId: im, mapType: "INTEGRATION", concepts: [] }],
    );
    const state = {
      ...before,
      mapId: im,
      mapType: "INTEGRATION",
      concepts: [],
    };
    const auto = await insertResearchEvent(c, experimental.id, "SYSTEM", {
      schemaVersion: 2,
      eventType: "MAP_AUTO_SUBMIT",
      targetType: "MAP",
      targetId: im,
      mapId: im,
      outcome: "SUCCESS",
      clientTimeQuality: "NOT_APPLICABLE",
      before: state,
      after: state,
    });
    assert.ok(auto);
    await c.query(
      "UPDATE maps SET status='SUBMITTED',submitted_at='2026-04-01T00:00:20Z',auto_submitted_at='2026-04-01T00:00:20Z' WHERE id=$1",
      [im],
    );
    await c.query(
      "UPDATE research_events SET server_timestamp='2026-04-01T00:00:20Z' WHERE event_id=$1",
      [auto.eventId],
    );
    await insertAudit(
      c,
      { eventType: "RESEARCH_ANALYSIS_VIEW", sessionId: control.id },
      "RESEARCHER",
    );
    await insertAudit(
      c,
      { eventType: "SESSION_SETTINGS_CHANGE" },
      "RESEARCHER",
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  const unsafeMap = (
    await pool.query(
      "INSERT INTO maps(type,session_stage_id) VALUES('PRIOR',$1) RETURNING id",
      [legacyStage],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO map_operation_logs(map_id,operation_type,target_type,target_id,after,sequence_number) VALUES($1,'ADD_CONCEPT','CONCEPT',$2,$3,1)",
    [
      unsafeMap,
      randomUUID(),
      { label: "password=must-not-appear", authorization: researcher },
    ],
  );
  const sessionIds = [control.id, experimental.id, legacySession],
    eventTypes = [
      "ADD_CONCEPT",
      "VIDEO_SEEK",
      "MAP_SUBMIT",
      "UNDO",
      "MAP_AUTO_SUBMIT",
      "ASSESSMENT_EDIT",
      "STAGE_PAUSE",
      "RESEARCH_ANALYSIS_VIEW",
    ];
  const filters = { sessionIds, eventTypes };
  const job = await create(filters),
    json = await data(job);
  assert.equal(json.event_count, 12);
  assert.equal(json.event_count, job.eventCount);
  const all = json.events;
  assert.deepEqual(
    [
      ...new Set(
        all
          .filter((e) => e.source_format === "EVENT")
          .map((e) => e.schema_version),
      ),
    ].sort(),
    [1, 2, 3, 4],
  );
  assert.ok(
    !JSON.stringify(json).includes(researcher) &&
      !JSON.stringify(json).includes(control.token) &&
      !JSON.stringify(json).includes("password=") &&
      !JSON.stringify(json).includes("old-code-do-not-export"),
  );
  assert.ok(
    all.some(
      (e) =>
        e.source_format === "LEGACY" &&
        e.outcome === "UNKNOWN" &&
        e.actor_type === "UNKNOWN",
    ),
  );
  assert.ok(all.some((e) => e.payload_status === "REDACTED_OR_UNSUPPORTED"));
  assert.ok(
    all.some(
      (e) =>
        e.server_elapsed_ms !== null &&
        e.server_elapsed_ms < 0 &&
        e.elapsed_quality === "INCONSISTENT_ORDER",
    ),
  );
  assert.ok(
    all.findIndex((e) => e.event_id === "legacy:" + oldId) <
      all.findIndex((e) => e.map_id === mapId && e.source_format === "EVENT"),
    "Boundary order must beat clock order",
  );
  const bytes: Record<string, string> = {
    "events.json": await file(job, "events.json"),
  };
  for (const [name, cols] of Object.entries({
    "events.csv": commonColumns,
    ...detailColumns,
  })) {
    const text = await file(job, name);
    bytes[name] = text;
    const parsed = parse(text, { columns: true, bom: true }) as Record<
      string,
      string
    >[];
    assert.deepEqual(
      text
        .replace(/^\uFEFF/, "")
        .split("\r\n")[0]
        .split(","),
      [...cols],
    );
    const expected = all.filter((e) => Object.hasOwn(csvRows(e), name));
    assert.equal(parsed.length, expected.length);
    assert.deepEqual(
      parsed.map((x) => x.event_id),
      expected.map((e) => e.event_id),
    );
    for (const [i, row] of parsed.entries())
      for (const key of commonColumns)
        assert.equal(
          row[key],
          expected[i][key] == null ? "" : String(expected[i][key]),
          name + ":" + key,
        );
    if (name === "assessment_events.csv")
      assert.ok(
        parsed.some(
          (r) =>
            r.after_answer.startsWith("'=SUM") &&
            r.after_answer.includes("\n説明"),
        ),
      );
  }
  const archive = await fetch(
    base + "/research/event-exports/" + job.exportId + "/bundle.zip",
    { headers: { Authorization: "Bearer " + researcher } },
  );
  assert.equal(archive.status, 200);
  const unpacked = await unzip(Buffer.from(await archive.arrayBuffer()));
  for (const [name, text] of Object.entries(bytes))
    assert.equal(
      unpacked[name].replace(/^\uFEFF/, ""),
      text.replace(/^\uFEFF/, ""),
    );
  assert.equal(JSON.parse(unpacked["manifest.json"]).eventCount, 12);
  assert.ok(unpacked["data-dictionary.md"].includes("before_answer"));
  assert.equal(
    (await api("/research/event-exports", { filters }, control.token)).status,
    403,
  );
  assert.equal(
    (
      await api(
        "/research/event-exports/" + job.exportId + "/events.json",
        undefined,
        control.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await api(
        "/research/event-exports/" + job.exportId,
        undefined,
        control.token,
        "DELETE",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await api(
        "/research/event-exports/" + job.exportId + "/events.json",
        undefined,
        "invalid",
      )
    ).status,
    401,
  );
  assert.equal(
    (await api("/research/event-exports/" + job.exportId + "/not-allowed.txt"))
      .status,
    404,
  );
  await release(job);
  const cases = [
    { sessionIds: [control.id] },
    { learnerIds: [learnerId(experimental.id)] },
    { groups: ["CONTROL"] },
    { groups: ["UNASSIGNED"] },
    { activities: ["PRE_ASSESSMENT"] },
    { eventTypes: ["MAP_SUBMIT", "MAP_AUTO_SUBMIT"] },
    { eventTypes: ["UNDO"] },
    { from: "2026-04-01T09:00:00+09:00", to: "2026-04-01T09:00:02+09:00" },
    { sessionIds: [control.id], learnerIds: [learnerId(experimental.id)] },
    { sessionIds: [randomUUID()] },
  ];
  for (const condition of cases) {
    const f = parseFilters({ ...filters, ...condition });
    assert.ok(f);
    const j = await create(f),
      subset = (await data(j)).events;
    const expected = all.filter(
      (e) =>
        (!f.sessionIds.length || f.sessionIds.includes(e.session_id!)) &&
        (!f.learnerIds.length || f.learnerIds.includes(e.learner_id!) || f.learnerIds.includes("L-"+e.session_id)) &&
        (!f.groups.length ||
          f.groups.includes(e.study_group ?? "UNASSIGNED")) &&
        (!f.activities.length ||
          f.activities.includes(e.activity ?? "UNASSIGNED")) &&
        (!f.eventTypes.length || f.eventTypes.includes(e.event_type)) &&
        (!f.from || e.server_timestamp >= f.from) &&
        (!f.to || e.server_timestamp < f.to),
    );
    assert.deepEqual(
      subset.map((e) => e.event_id),
      expected.map((e) => e.event_id),
      JSON.stringify(f),
    );
    if (!subset.length) {
      assert.equal(
        parse(await file(j, "events.csv"), { columns: true, bom: true }).length,
        0,
      );
    }
    await release(j);
  }
  const global = await create({
    eventTypes: ["SESSION_SETTINGS_CHANGE"],
    groups: ["UNASSIGNED"],
  });
  const globals = (await data(global)).events;
  assert.ok(
    globals.some(
      (e) =>
        e.session_id === null &&
        e.learner_id === null &&
        e.sequence_scope === "GLOBAL",
    ),
  );
  await release(global);
  for (const bad of [
    { from: "2026-02-30T00:00:00Z" },
    { from: "2026-04-01T00:00:00" },
    { from: "2026-04-02T00:00:00Z", to: "2026-04-01T00:00:00Z" },
    { groups: ["bad"] },
    { sessionIds: ["SQL; DROP TABLE sessions"] },
    { token: "private-input" },
  ]) {
    const r = await api("/research/event-exports", { filters: bad });
    assert.equal(r.status, 400);
    assert.ok(!r.text.includes("private-input"));
  }
  assert.equal(
    parseInstant("2026-04-01T09:00:00+09:00"),
    "2026-04-01T00:00:00.000Z",
  );
  for (const v of [
    "=1",
    " +2",
    "-cmd",
    "@SUM",
    "\tformula",
    "\r\n=1",
    "\uFEFF=1",
    "＝1",
  ])
    assert.ok(csvCell(v).startsWith("\"'"));
  assert.equal(csvCell(-2), '"-2"');
  const tainted = await fixture("CONTROL"),
    taintedStage = tainted.stages.find(
      (x) => x.stageType === "PRE_ASSESSMENT",
    )!;
  await pool.query(
    `INSERT INTO research_events(schema_version,session_id,stage_id,participant_code,study_group,activity,actor_type,event_type,target_type,target_id,outcome,sequence_number,client_time_quality,before_state,after_state,before_quality,after_quality)
   VALUES(3,$1,$2,'mock','CONTROL','PRE_ASSESSMENT','LEARNER','ASSESSMENT_EDIT','ASSESSMENT',$3,'SUCCESS',1,'NOT_APPLICABLE',$4,$5,'OBSERVED','OBSERVED')`,
    [
      tainted.id,
      taintedStage.id,
      tainted.question,
      { questionId: tainted.question, answer: null },
      { questionId: tainted.question, answer: control.token },
    ],
  );
  await pool.query(
    "INSERT INTO research_event_counters(session_id,next_sequence) VALUES($1,2)",
    [tainted.id],
  );
  const masked = await create({
    sessionIds: [tainted.id],
    eventTypes: ["ASSESSMENT_EDIT"],
  });
  const maskedData = await data(masked);
  assert.equal(maskedData.events[0].payload_status, "REDACTED_OR_UNSUPPORTED");
  assert.equal(maskedData.events[0].after, null);
  assert.ok(!JSON.stringify(maskedData).includes(control.token));
  await release(masked);
  // Generation limits discard all partial output; expiry and downloads never mutate research rows.
  const small = new EventExportService(pool, {
    root: join(root, "small"),
    maxBytes: 300,
  });
  await assert.rejects(
    () => small.create(parseFilters(filters)!),
    ExportLimitError,
  );
  assert.equal((await readdir(small.root)).length, 0);
  await small.dispose();
  const short = new EventExportService(pool, {
    root: join(root, "short"),
    ttlMs: 20,
  });
  const expired = await short.create(
    parseFilters({ sessionIds: [randomUUID()] })!,
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(short.get(expired.exportId), null);
  await short.sweep();
  assert.equal((await readdir(short.root)).length, 0);
  await short.dispose();

  // Large extraction uses the same SQL cursor and writer, not a whole-result in-memory JSON array.
  const bulk = await fixture("CONTROL"),
    bulkLesson = bulk.stages.find((x) => x.stageType === "LESSON")!;
  await pool.query(
    `INSERT INTO research_events(schema_version,session_id,stage_id,participant_code,study_group,activity,actor_type,event_type,target_type,outcome,sequence_number,client_time_quality,before_quality,after_quality)
 SELECT 1,$1,$2,'bulk-mock','CONTROL','LESSON','LEARNER','VIDEO_PLAY','VIDEO','SUCCESS',n,'NOT_APPLICABLE','MISSING','MISSING' FROM generate_series(1,3000) n`,
    [bulk.id, bulkLesson.id],
  );
  await pool.query(
    "INSERT INTO research_event_counters(session_id,next_sequence) VALUES($1,3001)",
    [bulk.id],
  );
  const large = await create({
    sessionIds: [bulk.id],
    eventTypes: ["VIDEO_PLAY"],
  });
  assert.equal(large.eventCount, 3000);
  assert.equal((await data(large)).events.length, 3000);
  assert.equal(
    parse(await file(large, "events.csv"), { columns: true, bom: true }).length,
    3000,
  );
  // Issue #10: real researcher HTTP view uses the exact downloadable snapshot.
  const viewed = await api("/research/event-views", {filters:{sessionIds:[bulk.id],eventTypes:["VIDEO_PLAY"],outcomes:["SUCCESS"]}});
  assert.equal(viewed.status,201,viewed.text);
  const view = JSON.parse(viewed.text) as ExportMetadata;
  const pages: string[] = [];
  let cursor: number|null = 0;
  while(cursor !== null) {
    const response = await api(`/research/event-views/${view.exportId}?offset=${cursor}`);
    assert.equal(response.status,200);
    const page = JSON.parse(response.text);
    assert.ok(page.events.length<=25);
    for (const e of page.events) { assert.equal(e.before,undefined); pages.push(e.event_id); }
    cursor=page.next;
  }
  const expected=(await data(view)).events;
  assert.deepEqual(pages,expected.map(e=>e.event_id));
  assert.equal(new Set(pages).size,3000);
  for(let i=1;i<expected.length;i++) assert.ok(expected[i-1].server_timestamp<=expected[i].server_timestamp);
  const detail=JSON.parse((await api(`/research/event-views/${view.exportId}?offset=0&detail=1`)).text);
  assert.deepEqual(detail.events[0],expected[0]);
  assert.equal((await api(`/research/event-views/${view.exportId}`,undefined,control.token)).status,403);
  assert.equal((await api("/research/event-views",{filters:{}},control.token)).status,403);
  assert.equal((await api(`/research/event-views/${view.exportId}`,undefined,"invalid")).status,401);
  assert.equal((await api(`/research/event-views/${view.exportId}?offset=-1`)).status,400);
  assert.equal((await api(`/research/event-views/${view.exportId}?detail=2`)).status,400);
  assert.equal(parseFilters({outcomes:["invented"]}),null);
  await release(view);
  assert.equal((await api(`/research/event-views/${view.exportId}`)).status,404);
  for (const outcome of ["SUCCESS","FAILURE","REJECTED","CANCELLED","UNKNOWN"]) {
    const filtered = await create({sessionIds:[control.id,experimental.id],outcomes:[outcome]});
    assert.ok((await data(filtered)).events.every(e=>e.outcome===outcome));
    await release(filtered);
  }
  console.log("Issue 10 snapshot paging/details/export/filters/auth: PASS");
  await release(large);
  let injected = false;
  const intercepted = new Proxy(pool, {
    get(target, key) {
      if (key === "connect")
        return async () => {
          const connection = await target.connect();
          return new Proxy(connection, {
            get(c, property) {
              if (property === "query")
                return async (text: string, values?: unknown[]) => {
                  const result = await c.query(text, values);
                  if (text.startsWith("FETCH FORWARD") && !injected) {
                    injected = true;
                    const writer = await pool.connect();
                    try {
                      await writer.query("BEGIN");
                      await insertResearchEvent(writer, bulk.id, "LEARNER", {
                        eventType: "VIDEO_PLAY",
                        targetType: "VIDEO",
                        stageId: bulkLesson.id,
                        outcome: "SUCCESS",
                        clientTimeQuality: "NOT_APPLICABLE",
                      });
                      await writer.query("COMMIT");
                    } finally {
                      writer.release();
                    }
                  }
                  return result;
                };
              const value = Reflect.get(c, property);
              return typeof value === "function" ? value.bind(c) : value;
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const concurrent = new EventExportService(intercepted, {
    root: join(root, "concurrent"),
  });
  const stable = await concurrent.create(
    parseFilters({ sessionIds: [bulk.id], eventTypes: ["VIDEO_PLAY"] })!,
  );
  assert.equal(stable.eventCount, 3000);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM research_events WHERE session_id=$1 AND event_type='VIDEO_PLAY'",
        [bulk.id],
      )
    ).rows[0].n,
    3001,
  );
  assert.equal(
    parse(
      await readFile(
        join(concurrent.get(stable.exportId)!.directory, "events.csv"),
        "utf8",
      ),
      { columns: true, bom: true },
    ).length,
    3000,
  );
  await concurrent.dispose();
  const held = new EventExportService(pool, {
    root: join(root, "held"),
    maxJobs: 1,
  });
  const first = await held.create(
    parseFilters({ sessionIds: [randomUUID()] })!,
  );
  await assert.rejects(() => held.create(parseFilters({})!), ExportLimitError);
  const active = held.get(first.exportId)!;
  active.readers++;
  await held.delete(first.exportId);
  assert.equal(held.get(first.exportId), null);
  await held.release(first.exportId);
  assert.equal((await readdir(held.root)).length, 0);
  await held.dispose();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM map_operation_logs WHERE map_id=$1",
        [mapId],
      )
    ).rows[0].n,
    1,
  );
  console.log(
    "Filtered event Export: v1-v4/legacy, every filter/AND/OR/empty/UTC bounds, CSV joins/ZIP consistency, formula protection, secrets/roles, caps/TTL: PASS",
  );
} finally {
  await service.dispose();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  assert.ok(
    resolve(root).startsWith(join(resolve(tmpdir()), "stage1-issue9-check-")),
  );
  await rm(root, { recursive: true, force: true });
}
