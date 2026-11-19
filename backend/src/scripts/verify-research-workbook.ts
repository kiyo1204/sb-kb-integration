// TEST ONLY: synthetic input, no API, no DB connection, no research records.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fromBuffer, type Entry } from "yauzl";
import { buildResearchWorkbook, researchWorkbookSheetNames, ResearchWorkbookLimitError } from "../research-workbook.js";
import type { ExportEvent } from "../event-export-contract.js";
import type { SessionRawExport } from "../research-export.js";

async function unzip(buffer: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("zip_unavailable"));
      const files = new Map<string, string>();
      zip.on("error", reject);
      zip.on("end", () => resolve(files));
      zip.on("entry", (entry: Entry) => {
        zip.openReadStream(entry, (openError, stream) => {
          if (openError || !stream) return reject(openError ?? new Error("zip_entry_unavailable"));
          const pieces: Buffer[] = [];
          stream.on("error", reject);
          stream.on("data", (part: Buffer) => pieces.push(Buffer.from(part)));
          stream.on("end", () => {
            files.set(entry.fileName, Buffer.concat(pieces).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

const sessionId = randomUUID(), stageId = randomUUID(), mapId = randomUUID();
const concept1 = randomUUID(), concept2 = randomUUID(), eventId = randomUUID();
const before = {
  snapshotVersion: 1, mapId, mapType: "PRIOR", basedOnMapId: null, kitDefinitionId: null,
  concepts: [{id: concept1, mapId, label: "A & B", positionX: 0, positionY: 0, mergedIntoConceptId: null, provenance: []}],
  links: [],
};
const after = {
  ...before,
  concepts: [...before.concepts, {id: concept2, mapId, label: "=1+1", positionX: 1, positionY: 1, mergedIntoConceptId: null, provenance: []}],
};
const event: ExportEvent = {
  protocol_key: "SBKB_INTEGRATION_V1", feedback_match: null,
  event_id: eventId, source_format: "EVENT", schema_version: 5,
  session_id: sessionId, learner_id: `P-${randomUUID()}`, study_group: null,
  activity: "PRIOR_MAP", stage_id: stageId, map_id: mapId,
  actor_type: "LEARNER", event_type: "ADD_CONCEPT", target_type: "CONCEPT", target_id: concept2,
  outcome: "SUCCESS", reason_code: null, sequence_number: "90071992547409931234",
  sequence_scope: "SESSION", client_timestamp: "2026-11-19T00:00:02.000Z",
  client_time_quality: "OBSERVED", server_timestamp: "2026-11-19T00:00:03.000Z",
  related_event_id: null, related_legacy_operation_log_id: null,
  before_quality: "OBSERVED", after_quality: "OBSERVED", payload_status: "EXPORTED",
  boundary_status: "AFTER_LEGACY_BOUNDARY", legacy_boundary_count: "0",
  legacy_boundary_last_id: null, before, after, details: {},
  stage_started_at: "2026-11-19T00:00:00.000Z", server_elapsed_ms: 3000,
  elapsed_quality: "COMPUTED_SERVER_DIFFERENCE",
};
const session = {
  exportVersion: 4, exportedAt: "2026-11-19T00:00:03.000Z",
  session: {id: sessionId, participantCode: event.learner_id, status: "IN_PROGRESS", protocolKey: "SBKB_INTEGRATION_V1"},
  stages: [{id: stageId, stageType: "PRIOR_MAP", startedAt: "2026-11-19T00:00:00.000Z"}],
  maps: [{id: mapId, type: "PRIOR", sessionStageId: stageId, operationLogs: [{
    id: eventId, eventId, mapId, sequenceNumber: "1", operationType: "ADD_CONCEPT",
    serverTimestamp: event.server_timestamp, before, after, historySource: "EVENT",
  }]}],
} as unknown as SessionRawExport;
const input = {
  run: {id: randomUUID(), state: "=1+1", materialVersionId: randomUUID()},
  sessions: [session], events: [event], sampledAt: "2026-11-19T00:00:03.000Z",
  stateRows: [{sessionId, mapId, mapType: "PRIOR", point: "SAVED_AT_READ", state: after}],
};
const workbook = await buildResearchWorkbook(input);
assert.equal(workbook.subarray(0, 2).toString(), "PK");
const entries = await unzip(workbook);
assert.equal(entries.size, 16); // content types, rels, workbook, styles, workbook rels, 11 sheets
const definition = entries.get("xl/workbook.xml")!;
assert.ok(definition);
assert.deepEqual(
  [...definition.matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1]),
  [...researchWorkbookSheetNames],
);
for (let i = 1; i <= 11; i++) assert.ok(entries.has(`xl/worksheets/sheet${i}.xml`));
assert.ok(entries.get("xl/worksheets/sheet2.xml")!.includes("90071992547409931234"), "Large sequence retained as a string");
assert.ok(entries.get("xl/worksheets/sheet3.xml")!.includes("&amp;"), "JSON/XML text escaped");
assert.ok(entries.get("xl/worksheets/sheet9.xml")!.includes("active_concepts_before"));
assert.ok(entries.get("xl/worksheets/sheet9.xml")!.includes("changed_concept_ids"));
assert.ok(entries.get("xl/worksheets/sheet9.xml")!.includes(concept2));
assert.ok(entries.get("xl/worksheets/sheet1.xml")!.includes("=1+1"), "Formula-shaped input preserved as text");
assert.ok(![...entries.values()].some((value) => /<f(?:\s|>)/.test(value)), "No formulas executed");
await assert.rejects(
  buildResearchWorkbook({ ...input, run: {...input.run, state: "a".repeat(32768)} }),
  ResearchWorkbookLimitError,
);
const empty = await unzip(await buildResearchWorkbook({
  run: input.run, sessions: [], events: [], sampledAt: input.sampledAt, stateRows: [],
}));
assert.ok(empty.get("xl/worksheets/sheet11.xml")!.includes("event_id"), "Empty run has the headers of all 11 sheets");
console.log("Synthetic 11-sheet research workbook, text safety and hard limits: PASS");
