/**
 * TEST ONLY: inspect the actual researcher XLSX HTTP response from a guarded
 * synthetic experiment. This never connects to a DB or changes research data.
 *
 * The prior JSON and this XLSX are separate READ snapshots. Researcher audit
 * events may be inserted between them, so event counts are checked WITHIN
 * the workbook; saved map states and operation identities are compared to JSON.
 */
import assert from "node:assert/strict";
import { fromBuffer, type Entry } from "yauzl";
import type { SessionRawExport } from "../research-export.js";
import { experimentStateRows } from "../experiment-research.js";
import { researchWorkbookSheetNames } from "../research-workbook.js";

type Row = Record<string, string>;

async function unzip(buffer: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("workbook_zip_unavailable"));
      const entries = new Map<string, string>();
      let totalBytes = 0;
      let settled = false;
      const fail = (reason: Error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(reason);
      };
      zip.on("error", fail);
      zip.on("end", () => { if (!settled) { settled = true; resolve(entries); } });
      zip.on("entry", (entry: Entry) => {
        if (entries.size >= 32 || entry.uncompressedSize > 128 * 1024 * 1024 ||
            totalBytes + entry.uncompressedSize > 256 * 1024 * 1024)
          return fail(new Error("workbook_zip_limit"));
        if (entry.fileName.includes("..") || entry.fileName.startsWith("/"))
          return fail(new Error("invalid_workbook_entry"));
        totalBytes += entry.uncompressedSize;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError ?? new Error("workbook_entry_unavailable"));
          const chunks: Buffer[] = [];
          stream.on("error", fail);
          stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          stream.on("end", () => {
            if (settled) return;
            entries.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

// Read the actual XLSX worksheets; ZIP bytes cannot be searched as plain text.
export async function assertPracticeLabelsAbsentFromWorkbook(
  workbook: Buffer,
  markers: readonly string[],
): Promise<void> {
  const entries = await unzip(workbook);
  for (const [path, xml] of entries) {
    if (!path.startsWith("xl/worksheets/") || !path.endsWith(".xml")) continue;
    for (const marker of markers) {
      assert.equal(xml.includes(marker), false, `practice-only text in XLSX ${path}`);
    }
  }
}

function decodeXml(value: string): string {
  const entities: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  };
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => entities[name]!);
}
function columnIndex(letters: string): number {
  let result = 0;
  for (const char of letters) result = result * 26 + char.charCodeAt(0) - 64;
  return result - 1;
}
function parseSheet(xml: string): {columns: string[]; rows: Row[]; types: Map<string, string>[]} {
  const cellsByRow: Array<Map<number, {value: string; kind: string}>> = [];
  for (const match of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = new Map<number, {value: string; kind: string}>();
    for (const cell of match[1]!.matchAll(/<c\b([^>]+)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1]!;
      const ref = /\br="([A-Z]+)[0-9]+"/.exec(attrs);
      const type = /\bt="(inlineStr|n|b)"/.exec(attrs);
      assert.ok(ref && type, "expected inline, number or boolean Excel cell");
      const inner = type[1] === "inlineStr"
        ? /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cell[2]!)
        : /<v>([\s\S]*?)<\/v>/.exec(cell[2]!);
      assert.ok(inner, "missing Excel cell value");
      const column = columnIndex(ref[1]!);
      assert.ok(!row.has(column), "duplicate Excel cell");
      row.set(column, { value: decodeXml(inner[1]!), kind: type[1]! });
    }
    cellsByRow.push(row);
  }
  assert.ok(cellsByRow.length > 0, "sheet header missing");
  const headers = cellsByRow[0]!;
  const columns = [...headers.keys()].sort((a, b) => a - b).map((index) => headers.get(index)!.value);
  assert.equal(headers.size, columns.length, "missing header cell");
  assert.equal(new Set(columns).size, columns.length, "duplicate sheet column");
  assert.ok(columns.every(Boolean), "empty sheet column");
  const values = cellsByRow.slice(1).map((cells) => Object.fromEntries(
    columns.map((column, index) => [column, cells.get(index)?.value ?? ""]),
  ));
  const types = cellsByRow.slice(1).map((cells) => new Map(
    columns.map((column, index) => [column, cells.get(index)?.kind ?? "blank"]),
  ));
  return { columns, rows: values, types };
}

function json(text: string): unknown {
  return text === "" ? null : JSON.parse(text);
}
function uniqueBy(rows: Row[], key: string): Map<string, Row> {
  const result = new Map<string, Row>();
  for (const row of rows) {
    const id = row[key];
    assert.ok(id, `missing ${key}`);
    assert.ok(!result.has(id), `duplicate ${key}`);
    result.set(id, row);
  }
  return result;
}
function changed(before: Array<Record<string, unknown>>, after: Array<Record<string, unknown>>, field?: "provenance"): string[] {
  const left = new Map(before.map((item) => [String(item.id), item]));
  const right = new Map(after.map((item) => [String(item.id), item]));
  return [...new Set([...left.keys(), ...right.keys()])].filter((id) =>
    JSON.stringify(field ? (left.get(id)?.provenance ?? []) : (left.get(id) ?? null)) !==
    JSON.stringify(field ? (right.get(id)?.provenance ?? []) : (right.get(id) ?? null)),
  ).sort();
}
function connection(state: {links: Array<Record<string, unknown>>}, linkId: string): unknown {
  const link = state.links.find((item) => item.id === linkId);
  return link ? { sourceConceptId: link.sourceConceptId ?? null, targetConceptId: link.targetConceptId ?? null } : null;
}
function assertStructure(row: Row, operation: Row | undefined) {
  if (row.outcome !== "SUCCESS") return assert.equal(row.structure_status, "NOT_SUCCESS");
  if (![2, 5].includes(Number(operation?.schema_version ?? "")))
    return assert.equal(row.structure_status, "NOT_MAP_CHANGE");
  if (row.payload_status !== "EXPORTED") return assert.equal(row.structure_status, "PAYLOAD_UNAVAILABLE");
  const before = json(operation?.before_json ?? "") as Record<string, unknown> | null;
  const after = json(operation?.after_json ?? "") as Record<string, unknown> | null;
  const valid = (value: Record<string, unknown> | null): value is {mapId: string; snapshotVersion: number; concepts: Array<Record<string, unknown>>; links: Array<Record<string, unknown>>} =>
    !!value && value.snapshotVersion === 1 && value.mapId === row.map_id && Array.isArray(value.concepts) && Array.isArray(value.links);
  if (!valid(before) || !valid(after)) return assert.equal(row.structure_status, "SNAPSHOT_UNAVAILABLE");
  assert.equal(row.structure_status, "AVAILABLE");
  const active = (state: typeof before) => state.concepts.filter((item) => item.mergedIntoConceptId == null).length;
  const n = active(before), m = active(after);
  assert.equal(Number(row.active_concepts_before), n);
  assert.equal(Number(row.active_concepts_after), m);
  assert.equal(Number(row.hidden_merge_sources_before), before.concepts.length - n);
  assert.equal(Number(row.hidden_merge_sources_after), after.concepts.length - m);
  assert.equal(Number(row.links_before), before.links.length);
  assert.equal(Number(row.links_after), after.links.length);
  assert.deepEqual(json(row.changed_concept_ids), changed(before.concepts, after.concepts));
  assert.deepEqual(json(row.changed_link_ids), changed(before.links, after.links));
  assert.deepEqual(json(row.provenance_changed_concept_ids), changed(before.concepts, after.concepts, "provenance"));
  assert.deepEqual(json(row.provenance_changed_link_ids), changed(before.links, after.links, "provenance"));
  if (operation?.target_type === "LINK") {
    assert.deepEqual(json(row.connection_before), connection(before, operation.target_id!));
    assert.deepEqual(json(row.connection_after), connection(after, operation.target_id!));
  }
}

export async function assertWorkbookApiConsistency(
  workbook: Buffer,
  runId: string,
  sessions: SessionRawExport[],
) {
  const entries = await unzip(workbook);
  assert.equal(entries.size, 16, "11-sheet XLSX package size");
  const manifest = entries.get("xl/workbook.xml") ?? "";
  assert.deepEqual(
    [...manifest.matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1]),
    [...researchWorkbookSheetNames],
    "11 sheet names and order",
  );
  const sheets = new Map(researchWorkbookSheetNames.map((name, index) => {
    const data = entries.get(`xl/worksheets/sheet${index + 1}.xml`);
    assert.ok(data, `missing ${name}`);
    return [name, parseSheet(data)] as const;
  }));
  const rows = (name: typeof researchWorkbookSheetNames[number]) => sheets.get(name)!.rows;
  const overview = Object.fromEntries(rows("Overview").map((row) => [row.key, row.value]));
  assert.equal(overview.runId, runId);
  assert.equal(overview.protocolKey, "SBKB_INTEGRATION_V1");
  assert.equal(Number(overview.sessionCount), sessions.length);

  const events = rows("Events");
  uniqueBy(events, "event_id");
  assert.equal(Number(overview.eventCount), events.length);
  assert.equal(Number(overview.payloadWarnings), events.filter((e) => !["EXPORTED", "NO_PAYLOAD"].includes(e.payload_status)).length);
  assert.equal(Number(overview.boundaryWarnings), events.filter((e) => ["MISSING_BOUNDARY", "INVALID_AFTER_BOUNDARY"].includes(e.boundary_status)).length);
  const sessionIds = new Set(sessions.map((s) => s.session.id));
  for (const e of events) {
    assert.ok(sessionIds.has(e.session_id), "event belongs to exported run");
    assert.equal(e.protocol_key, "SBKB_INTEGRATION_V1");
  }
  const eventTypes = sheets.get("Events")!.types;
  for (const types of eventTypes) {
    assert.equal(types.get("event_id"), "inlineStr");
    assert.equal(types.get("sequence_number"), "inlineStr", "sequence number must not lose digits");
    assert.equal(types.get("server_timestamp"), "inlineStr");
  }

  for (const [name, predicate] of [
    ["Map_Operations", (e: Row) => ["MAP", "CONCEPT", "LINK"].includes(e.target_type)],
    ["Activity_Times", (e: Row) => /^(?:SESSION_(?:START|COMPLETE)|STAGE_|SCREEN_|VIDEO_|FEEDBACK_)/.test(e.event_type)],
    ["System_Events", (e: Row) => e.actor_type === "SYSTEM"],
    ["Researcher_Events", (e: Row) => e.actor_type === "RESEARCHER"],
  ] as const) {
    const detail = rows(name);
    const expected = events.filter(predicate);
    assert.equal(detail.length, expected.length, `${name} event count`);
    const byId = uniqueBy(detail, "event_id");
    for (const e of expected) {
      const actual = byId.get(e.event_id);
      assert.ok(actual, `${name} missing event_id`);
      for (const key of ["session_id", "map_id", "event_type", "outcome", "server_timestamp", "sequence_number", "payload_status"])
        assert.equal(actual[key], e[key], `${name}: ${key}`);
    }
  }
  const mapOps = uniqueBy(rows("Map_Operations"), "event_id");

  const stageById = new Map(sessions.flatMap((s) => s.stages.map((stage) => [String(stage.id), stage])));
  for (const [name, activity] of [
    ["SB_Analysis", "PRIOR_MAP"], ["KB_Analysis", "KB_MAP"], ["Integration_Analysis", "INTEGRATION_MAP"],
  ] as const) {
    const analysis = rows(name);
    const expected = events.filter((e) => e.activity === activity);
    assert.equal(analysis.length, expected.length, `${name} count`);
    const byId = uniqueBy(analysis, "event_id");
    for (const e of expected) {
      const actual = byId.get(e.event_id)!;
      assert.ok(actual, `${name} missing event`);
      for (const key of [
        "session_id",
        "learner_id",
        "stage_id",
        "map_id",
        "event_type",
        "outcome",
        "sequence_number",
        "server_timestamp",
        "payload_status",
        "client_time_quality",
      ]) {
        assert.equal(actual[key], e[key], `${name}: ${key}`);
      }

      const startedAt = stageById.get(e.stage_id)?.startedAt;

      const start =
        typeof startedAt === "string"
          ? Date.parse(startedAt)
          : startedAt instanceof Date
            ? startedAt.getTime()
            : NaN;

      const at = Date.parse(e.server_timestamp);

      const elapsedMs =
        Number.isFinite(start) && Number.isFinite(at)
          ? at - start
          : null;

      assert.equal(
        actual.elapsed_from_stage_start_ms,
        elapsedMs === null ? "" : String(elapsedMs),
        `${name}: elapsed`,
      );

      const expectedElapsedQuality =
        elapsedMs === null
          ? "MISSING"
          : elapsedMs < 0
            ? "INCONSISTENT_ORDER"
            : "COMPUTED_SERVER_DIFFERENCE";

      assert.equal(
        actual.elapsed_quality,
        expectedElapsedQuality,
        `${name}: elapsed_quality`,
      );
      assertStructure(actual, mapOps.get(e.event_id));
    }
  }

  const expectedOps = sessions.flatMap((s) => s.maps.flatMap((map) =>
    (Array.isArray(map.operationLogs) ? map.operationLogs : []).map((op) => ({
      session: s, map, operation: op as Record<string, unknown>,
    })),
  ));
  const operations = rows("Operations");
  assert.equal(operations.length, expectedOps.length, "operation row count");
  const operationById = uniqueBy(operations, "id");
  for (const {session, map, operation} of expectedOps) {
    const actual = operationById.get(String(operation.id));
    assert.ok(actual, "missing stored map operation");
    assert.equal(actual.sessionId, session.session.id);
    assert.equal(actual.participantCode, session.session.participantCode ?? "");
    assert.equal(actual.mapId, map.id);
    assert.equal(actual.mapType, map.type);
    assert.equal(actual.operationType, operation.operationType);
    assert.equal(actual.serverTimestamp, operation.serverTimestamp);
    assert.deepEqual(json(actual.before), operation.before ?? null);
    assert.deepEqual(json(actual.after), operation.after ?? null);
  }

  const expectedStates = sessions.flatMap(experimentStateRows);
  const stateRows = rows("Map_States");
  assert.equal(stateRows.length, expectedStates.length, "Map_States row count");
  const stateKey = (state: Record<string, unknown>) => `${state.sessionId}|${state.mapId ?? ""}|${state.point}`;
  const actualStates = new Map(stateRows.map((row) => [stateKey(row), row]));
  assert.equal(actualStates.size, stateRows.length, "unique Map state points");
  for (const expected of expectedStates) {
    const actual = actualStates.get(stateKey(expected));
    assert.ok(actual, "missing Map_States snapshot");
    for (const key of ["sessionId", "mapId", "mapType", "point", "status", "reason", "mapStatus", "submissionEventId"])
      assert.equal(actual[key], expected[key] == null ? "" : String(expected[key]), `Map_States: ${key}`);
    assert.deepEqual(json(actual.state), expected.state ?? null);
  }
  console.log("Synthetic research XLSX: 11-sheet API contents and saved-history consistency PASS");
}
