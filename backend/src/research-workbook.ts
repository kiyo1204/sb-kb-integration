/**
 * Research workbook for SBKB_INTEGRATION_V1. The input must come from the
 * researcher-only, redacted, REPEATABLE READ export path. No database writes.
 *
 * IDs, sequence numbers, timestamps and text use inline strings (never Excel
 * formulas). Safe numeric metrics remain numbers for Excel analysis.
 */
import type { PoolClient } from "pg";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { SessionRawExport } from "./research-export.js";
import { commonColumns, detailColumns, csvRows, type ExportEvent, type ExportFilters } from "./event-export-contract.js";
import { extractionQuery, normaliseEvent, type RawExportRow } from "./event-export-query.js";

const MAX_EVENTS = 20000;
const MAX_WORKBOOK_XML_BYTES = 128 * 1024 * 1024;
const MAX_CELL_CHARS = 32767;
const MAX_ROWS_PER_SHEET = 1048576;
const MAX_COLUMNS_PER_SHEET = 16384;

export class ResearchWorkbookLimitError extends Error {
  constructor() { super("research_workbook_limit"); }
}

/** Use the SAME caller-owned read-only transaction and the same safety validator as events.json. */
export async function loadWorkbookEvents(client: PoolClient, sessionIds: string[]): Promise<ExportEvent[]> {
  if (!sessionIds.length) return []; // Empty run must never become an unfiltered global export.
  const filters: ExportFilters = {
    sessionIds, learnerIds: [], groups: [], activities: [], eventTypes: [],
    outcomes: [], from: null, to: null,
  };
  const query = extractionQuery(filters);
  const events: ExportEvent[] = [];
  await client.query("DECLARE sbkb_workbook_events NO SCROLL CURSOR FOR " + query.text, query.values);
  try {
    for (;;) {
      const batch = await client.query<RawExportRow>("FETCH FORWARD 100 FROM sbkb_workbook_events");
      if (!batch.rowCount) break;
      if (events.length + batch.rows.length > MAX_EVENTS) throw new ResearchWorkbookLimitError();
      for (const row of batch.rows) events.push(await normaliseEvent(row, client));
    }
  } finally {
    await client.query("CLOSE sbkb_workbook_events");
  }
  return events;
}

const mapStateColumns = [
  "outputContract", "protocolKey", "runId", "materialVersionId", "sessionId",
  "pseudonym", "sessionStatus", "exportedAt", "mapId", "mapType", "point",
  "status", "reason", "recordedAt", "submissionEventId", "state", "mapStatus", "mapSubmittedAt",
] as const;
const operationColumns = [
  "sessionId", "participantCode", "mapId", "mapType", "researchRole", "sessionStageId",
  "id", "sequenceNumber", "operationType", "relatedOperationLogId", "targetType", "targetId",
  "serverTimestamp", "clientTimestamp", "elapsedMs", "before", "after", "historySource",
  "eventId", "schemaVersion", "eventType", "actorType", "outcome", "eventSequenceNumber",
  "relatedEventId", "relatedLegacyOperationLogId", "protocolKey",
] as const;
const analysisColumns = [
  "session_id", "learner_id", "stage_id", "map_id", "event_id", "event_type",
  "actor_type", "outcome", "sequence_number", "sequence_scope", "server_timestamp",
  "client_timestamp", "client_time_quality", "elapsed_from_stage_start_ms", "elapsed_quality",
  "feedback_match", "payload_status", "boundary_status", "structure_status",
  "active_concepts_before", "active_concepts_after", "hidden_merge_sources_before",
  "hidden_merge_sources_after", "links_before", "links_after", "changed_concept_ids",
  "changed_link_ids", "connection_before", "connection_after",
  "provenance_changed_concept_ids", "provenance_changed_link_ids", "related_event_id",
] as const;

export const researchWorkbookSheetNames = [
  "Overview", "Events", "Map_Operations", "Activity_Times", "Map_States", "Operations",
  "System_Events", "Researcher_Events", "SB_Analysis", "KB_Analysis", "Integration_Analysis",
] as const;

type Sheet = { name: string; columns: readonly string[]; rows: Array<Record<string, unknown>> };
type Item = { id: string; provenance?: unknown; [key: string]: unknown };
type Snapshot = { mapId: string; concepts: Item[]; links: Item[] };
function snapshot(value: unknown, mapId: string | null): Snapshot | null {
  if (!mapId || !value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (s.snapshotVersion !== 1 || s.mapId !== mapId || !Array.isArray(s.concepts) || !Array.isArray(s.links)) return null;
  for (const list of [s.concepts, s.links]) {
    if (!list.every((x) => x && typeof x === "object" && typeof (x as Item).id === "string")) return null;
  }
  return s as unknown as Snapshot;
}
function changedIds(before: Item[], after: Item[], field?: "provenance") {
  const a = new Map(before.map((x) => [x.id, x]));
  const b = new Map(after.map((x) => [x.id, x]));
  return [...new Set([...a.keys(), ...b.keys()])].filter((id) => {
    const left = a.get(id), right = b.get(id);
    return JSON.stringify(field ? left?.[field] ?? [] : left ?? null) !==
      JSON.stringify(field ? right?.[field] ?? [] : right ?? null);
  }).sort();
}
function connection(state: Snapshot, linkId: string | null): unknown {
  const link = state.links.find((x) => x.id === linkId);
  return link ? {
    sourceConceptId: link.sourceConceptId ?? null,
    targetConceptId: link.targetConceptId ?? null,
  } : null;
}
function structuralAnalysis(event: ExportEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    session_id: event.session_id, learner_id: event.learner_id, stage_id: event.stage_id,
    map_id: event.map_id, event_id: event.event_id, event_type: event.event_type,
    actor_type: event.actor_type, outcome: event.outcome, sequence_number: event.sequence_number,
    sequence_scope: event.sequence_scope, server_timestamp: event.server_timestamp,
    client_timestamp: event.client_timestamp, client_time_quality: event.client_time_quality,
    elapsed_from_stage_start_ms: event.server_elapsed_ms,
    elapsed_quality: event.elapsed_quality, feedback_match: event.feedback_match,
    payload_status: event.payload_status, boundary_status: event.boundary_status,
    related_event_id: event.related_event_id,
  };
  if (event.outcome !== "SUCCESS") return {...base, structure_status: "NOT_SUCCESS"};
  if (![2, 5].includes(event.schema_version ?? 0)) return {...base, structure_status: "NOT_MAP_CHANGE"};
  if (event.payload_status !== "EXPORTED") return {...base, structure_status: "PAYLOAD_UNAVAILABLE"};
  const before = snapshot(event.before, event.map_id);
  const after = snapshot(event.after, event.map_id);
  if (!before || !after) return {...base, structure_status: "SNAPSHOT_UNAVAILABLE"};
  const beforeActive = before.concepts.filter((x) => x.mergedIntoConceptId == null).length;
  const afterActive = after.concepts.filter((x) => x.mergedIntoConceptId == null).length;
  return {
    ...base, structure_status: "AVAILABLE",
    active_concepts_before: beforeActive, active_concepts_after: afterActive,
    hidden_merge_sources_before: before.concepts.length - beforeActive,
    hidden_merge_sources_after: after.concepts.length - afterActive,
    links_before: before.links.length, links_after: after.links.length,
    changed_concept_ids: changedIds(before.concepts, after.concepts),
    changed_link_ids: changedIds(before.links, after.links),
    connection_before: event.target_type === "LINK" ? connection(before, event.target_id) : null,
    connection_after: event.target_type === "LINK" ? connection(after, event.target_id) : null,
    provenance_changed_concept_ids: changedIds(before.concepts, after.concepts, "provenance"),
    provenance_changed_link_ids: changedIds(before.links, after.links, "provenance"),
  };
}

function operationRows(session: SessionRawExport): Array<Record<string, unknown>> {
  const stageById = new Map(session.stages.map((s) => [String(s.id), s]));
  return session.maps.flatMap((m) => {
    const stage = stageById.get(String(m.sessionStageId));
    const ops = Array.isArray(m.operationLogs) ? m.operationLogs as Array<Record<string, unknown>> : [];
    return ops.map((op) => {
      const time = Date.parse(String(op.serverTimestamp ?? ""));
      const start = Date.parse(String(stage?.startedAt ?? ""));
      return {
        sessionId: session.session.id, participantCode: session.session.participantCode,
        protocolKey: session.session.protocolKey, ...op,
        operationType: String(op.operationType), mapId: String(op.mapId), mapType: m.type,
        researchRole: m.researchRole ?? null, sessionStageId: stage?.id ?? null,
        // Matches the legacy operations.csv convention. The analysis sheets retain signed elapsed values.
        elapsedMs: Number.isFinite(time) && Number.isFinite(start) ? Math.max(0, time - start) : null,
      };
    });
  });
}

function sheetsFor(run: Record<string, unknown>, sessions: SessionRawExport[], events: ExportEvent[], sampledAt: string, stateRows: Array<Record<string, unknown>>): Sheet[] {
  const byFile: Record<string, Array<Record<string, unknown>>> = {
    "events.csv": [], "map_operations.csv": [], "activity_times.csv": [],
    "system_events.csv": [], "researcher_events.csv": [],
  };
  for (const event of events) {
    for (const [name, row] of Object.entries(csvRows(event))) {
      if (name in byFile) byFile[name]!.push(row);
    }
  }
  const overview = [
    ["outputContract", "sbkb-integration-research-v1"],
    ["protocolKey", "SBKB_INTEGRATION_V1"],
    ["runId", run.id], ["runState", run.state],
    ["materialVersionId", run.materialVersionId], ["sampledAt", sampledAt],
    ["sessionCount", sessions.length], ["eventCount", events.length],
    ["payloadWarnings", events.filter((e) => !["EXPORTED", "NO_PAYLOAD"].includes(e.payload_status)).length],
    ["boundaryWarnings", events.filter((e) => ["MISSING_BOUNDARY", "INVALID_AFTER_BOUNDARY"].includes(e.boundary_status)).length],
    ["timeSemantics", "server elapsed is elapsed to storage, not active work time"],
    ["provenance", "Derived from saved snapshots; missing values are not imputed"],
    ["eventScope", "Only Session events belonging to this experiment run"],
    ["exportSemantics", "Research-only redacted, repeatable-read snapshot"],
  ].map(([key, value]) => ({ key, value }));
  const operations = sessions.flatMap(operationRows);
  const analysis = (activity: string) => events.filter((e) => e.activity === activity).map(structuralAnalysis);
  return [
    {name: "Overview", columns: ["key", "value"], rows: overview},
    {name: "Events", columns: commonColumns, rows: byFile["events.csv"]!},
    {name: "Map_Operations", columns: detailColumns["map_operations.csv"], rows: byFile["map_operations.csv"]!},
    {name: "Activity_Times", columns: detailColumns["activity_times.csv"], rows: byFile["activity_times.csv"]!},
    {name: "Map_States", columns: mapStateColumns, rows: stateRows},
    {name: "Operations", columns: operationColumns, rows: operations},
    {name: "System_Events", columns: detailColumns["system_events.csv"], rows: byFile["system_events.csv"]!},
    {name: "Researcher_Events", columns: detailColumns["researcher_events.csv"], rows: byFile["researcher_events.csv"]!},
    {name: "SB_Analysis", columns: analysisColumns, rows: analysis("PRIOR_MAP")},
    {name: "KB_Analysis", columns: analysisColumns, rows: analysis("KB_MAP")},
    {name: "Integration_Analysis", columns: analysisColumns, rows: analysis("INTEGRATION_MAP")},
  ];
}

function escapeXml(text: string): string {
  // eslint-disable-next-line no-control-regex -- XLSX XMLで禁止される制御文字を検出するため、意図的に使用する。
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(text))
    throw new ResearchWorkbookLimitError(); // Do not silently remove data.
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function excelColumn(column: number) {
  let out = "", index = column + 1;
  while (index) { index--; out = String.fromCharCode(65 + index % 26) + out; index = Math.floor(index / 26); }
  return out;
}
function cellValue(value: unknown): { kind: "text" | "number" | "boolean"; value: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
      throw new ResearchWorkbookLimitError();
    return { kind: "number", value: String(value) };
  }
  if (typeof value === "boolean") return { kind: "boolean", value: value ? "1" : "0" };
  const text = typeof value === "string" ? value : value instanceof Date ? value.toISOString() :
    typeof value === "object" ? JSON.stringify(value) : String(value);
  if (text.length > MAX_CELL_CHARS) throw new ResearchWorkbookLimitError();
  return { kind: "text", value: escapeXml(text) };
}
function sheetXml(sheet: Sheet): string {
  if (sheet.rows.length + 1 > MAX_ROWS_PER_SHEET || sheet.columns.length > MAX_COLUMNS_PER_SHEET)
    throw new ResearchWorkbookLimitError();
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    '<sheetFormatPr defaultColWidth="18" defaultRowHeight="15"/>',
    '<sheetData>',
  ];
  let bytes = parts.reduce((sum, x) => sum + Buffer.byteLength(x), 0);
  const append = (value: string) => {
    bytes += Buffer.byteLength(value);
    if (bytes > MAX_WORKBOOK_XML_BYTES) throw new ResearchWorkbookLimitError();
    parts.push(value);
  };
  const row = (values: unknown[], index: number) => {
    append(`<row r="${index}">`);
    values.forEach((value, col) => {
      const cell = cellValue(value);
      if (cell === null) return;
      const address = `${excelColumn(col)}${index}`;
      const style = index === 1 ? ' s="1"' : "";
      if (cell.kind === "text")
        append(`<c r="${address}" t="inlineStr"${style}><is><t xml:space="preserve">${cell.value}</t></is></c>`);
      else
        append(`<c r="${address}" t="${cell.kind === "number" ? "n" : "b"}"${style}><v>${cell.value}</v></c>`);
    });
    append('</row>');
  };
  row([...sheet.columns], 1);
  sheet.rows.forEach((item, i) => row(sheet.columns.map((column) => item[column]), i + 2));
  append('</sheetData>');
  append(`<autoFilter ref="A1:${excelColumn(sheet.columns.length - 1)}${sheet.rows.length + 1}"/>`);
  append('</worksheet>');
  return parts.join("");
}

/** Produces a complete XLSX in memory before any HTTP response is sent. */
export async function buildResearchWorkbook(input: {
  run: Record<string, unknown>;
  sessions: SessionRawExport[];
  events: ExportEvent[];
  sampledAt: string;
  stateRows: Array<Record<string, unknown>>;
}): Promise<Buffer> {
  const sheets = sheetsFor(input.run, input.sessions, input.events, input.sampledAt, input.stateRows);
  if (sheets.map((s) => s.name).join("|") !== researchWorkbookSheetNames.join("|"))
    throw new Error("Invalid research workbook sheet contract");
  const xml = sheets.map(sheetXml); // Preflight ALL sheets before creating a downloadable artifact.
  if (xml.reduce((n, s) => n + Buffer.byteLength(s), 0) > MAX_WORKBOOK_XML_BYTES)
    throw new ResearchWorkbookLimitError();
  const zip = new ZipFile();
  const add = (name: string, contents: string) => zip.addBuffer(Buffer.from(contents, "utf8"), name);
  const ns = 'http://schemas.openxmlformats.org/';
  add('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") + '</Types>');
  add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Relationships xmlns="${ns}package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?>' +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${ns}officeDocument/2006/relationships"><sheets>` +
    sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    '</sheets></workbook>');
  add('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Relationships xmlns="${ns}package/2006/relationships">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="${ns}officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>');
  add('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF28516A"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
    '</styleSheet>');
  xml.forEach((value, i) => add(`xl/worksheets/sheet${i + 1}.xml`, value));
  zip.end();
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const part of zip.outputStream as Readable) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
    byteCount += buffer.length;
    if (byteCount > MAX_WORKBOOK_XML_BYTES) throw new ResearchWorkbookLimitError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
