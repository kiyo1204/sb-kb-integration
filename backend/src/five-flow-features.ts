import type { Pool } from "pg";
import type { HistoryOperation, MapHistorySnapshot } from "./map-history.js";
import {
  replayMixedMapHistory,
  type MapHistoryBoundary,
  type MapHistoryEventV2,
} from "./map-mixed-history.js";
import { validateMapStateV5 } from "./research-event-map-v5.js";
import { historySnapshotsEqual } from "./map-undo-redo.js";
import { csvCell } from "./csv.js";

export const FIVE_FLOW_FEATURE_VERSION = "stage1-5-descriptive-v1";
const mapOperations = [
  "ADD_CONCEPT",
  "EDIT_CONCEPT",
  "MOVE_CONCEPT",
  "DELETE_CONCEPT",
  "MERGE_CONCEPT",
  "IMPORT_KIT_CONCEPT",
  "ADD_LINK",
  "EDIT_LINK",
  "MOVE_LINK",
  "DELETE_LINK",
  "RECONNECT_LINK",
  "IMPORT_KIT_LINK",
  "UNDO",
  "REDO",
  "MAP_SAVE",
  "MAP_KIT_ASSIGN",
  "MAP_SUBMIT",
  "MAP_AUTO_SUBMIT",
];
type Event = MapHistoryEventV2 & {
  actorType: string | null;
  serverTimestamp: string;
  targetId: string | null;
  targetType: string;
};
export type FeatureInput = {
  sessionId: string;
  sampledAt: string;
  mapId: string | null;
  mapStatus: string | null;
  submittedAt: string | null;
  initial: unknown;
  capturedAt: string | null;
  current: MapHistorySnapshot | null;
  boundary: MapHistoryBoundary | null;
  legacy: HistoryOperation[];
  events: Event[];
};
const missing = (reason: string) => ({
  status: "UNAVAILABLE" as const,
  reason,
  activeConcepts: null as number | null,
  hiddenMergeSources: null as number | null,
  links: null as number | null,
});
function counts(state: MapHistorySnapshot) {
  return {
    status: "AVAILABLE" as const,
    reason: null,
    activeConcepts: state.concepts.filter((c) => c.mergedIntoConceptId === null)
      .length,
    hiddenMergeSources: state.concepts.filter(
      (c) => c.mergedIntoConceptId !== null,
    ).length,
    links: state.links.length,
  };
}
export function deriveFiveFlowFeatures(input: FeatureInput) {
  const { mapId } = input;
  const start =
    mapId &&
    validateMapStateV5(input.initial, mapId) &&
    input.initial.mapType === "INTEGRATION"
      ? counts(input.initial)
      : missing(
          mapId
            ? "INITIAL_SNAPSHOT_MISSING_OR_INVALID"
            : "INTEGRATION_MAP_MISSING",
        );
  let completion: ReturnType<typeof counts> | ReturnType<typeof missing> =
    missing("NOT_SUBMITTED");
  let accepted: Event | undefined;
  if (input.mapStatus === "SUBMITTED") {
    completion = missing("SUBMISSION_STATE_UNAVAILABLE");
    const submissions = input.events.filter(
      (e) =>
        ["MAP_SUBMIT", "MAP_AUTO_SUBMIT"].includes(e.eventType) &&
        e.outcome === "SUCCESS",
    );
    const stream = input.events.filter((e) => [2, 5].includes(e.schemaVersion));
    if (
      mapId &&
      start.status === "AVAILABLE" &&
      input.capturedAt &&
      input.submittedAt &&
      submissions.length === 1 &&
      input.boundary
    ) {
      const candidate = submissions[0]!;
      const old = replayMixedMapHistory(
        input.initial as MapHistorySnapshot,
        input.boundary,
        input.legacy,
        [],
      );
      const replay = replayMixedMapHistory(
        input.initial as MapHistorySnapshot,
        input.boundary,
        input.legacy,
        stream,
      );
      if (
        old.status === "REPLAYABLE" &&
        replay.status === "REPLAYABLE" &&
        input.current &&
        historySnapshotsEqual(replay.state, input.current) &&
        candidate.targetId === mapId &&
        candidate.targetType === "MAP" &&
        Date.parse(input.submittedAt) >= Date.parse(input.capturedAt) &&
        Date.parse(candidate.serverTimestamp) >=
          Date.parse(input.submittedAt) &&
        [2, 5].includes(candidate.schemaVersion) &&
        validateMapStateV5(candidate.after, mapId) &&
        historySnapshotsEqual(candidate.after, replay.state) &&
        !stream.some(
          (e) =>
            BigInt(e.sequenceNumber) > BigInt(candidate.sequenceNumber) &&
            e.outcome === "SUCCESS",
        )
      ) {
        completion = counts(candidate.after);
        accepted = candidate;
      } else completion = missing("HISTORY_INCONSISTENT");
    }
  }
  const rows = new Map<
    string,
    { historySource: string; actorType: string; outcome: string; count: number }
  >();
  const add = (historySource: string, actorType: string, outcome: string) => {
    const key = JSON.stringify([historySource, actorType, outcome]);
    const row = rows.get(key) ?? {
      historySource,
      actorType,
      outcome,
      count: 0,
    };
    row.count++;
    rows.set(key, row);
  };
  for (const e of input.events)
    if (mapOperations.includes(e.eventType))
      add("EVENT", e.actorType ?? "UNRECORDED", e.outcome ?? "UNRECORDED");
  for (const e of input.legacy)
    if (mapOperations.includes(e.operationType))
      add("LEGACY", "UNRECORDED", "UNRECORDED");
  const delta =
    start.status === "AVAILABLE" && completion.status === "AVAILABLE"
      ? {
          status: "AVAILABLE" as const,
          reason: null,
          activeConcepts: completion.activeConcepts - start.activeConcepts,
          hiddenMergeSources:
            completion.hiddenMergeSources - start.hiddenMergeSources,
          links: completion.links - start.links,
        }
      : missing("START_OR_COMPLETION_UNAVAILABLE");
  return {
    featureVersion: FIVE_FLOW_FEATURE_VERSION,
    protocolKey: "STAGE1_5" as const,
    sessionId: input.sessionId,
    mapId,
    sampledAt: input.sampledAt,
    start: { ...start, capturedAt: input.capturedAt },
    completion: {
      ...completion,
      submittedAt: input.submittedAt,
      eventId: accepted?.eventId ?? null,
      eventType: accepted?.eventType ?? null,
      serverTimestamp: accepted?.serverTimestamp ?? null,
    },
    delta,
    operationResults: {
      scope: "SAVED_AT_READ" as const,
      rows: [...rows.values()].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
      total: [...rows.values()].reduce((n, r) => n + r.count, 0),
    },
  };
}
export type FiveFlowFeatures = ReturnType<typeof deriveFiveFlowFeatures>;
const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
/** One repeatable read: no writes, no fallback from a submitted snapshot to live edits. */
export async function loadFiveFlowFeatures(pool: Pool, sessionId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const session = (
      await client.query("SELECT protocol_key FROM sessions WHERE id=$1", [
        sessionId,
      ])
    ).rows[0];
    if (!session) return { kind: "not_found" as const };
    if (session.protocol_key !== "STAGE1_5")
      return { kind: "wrong_protocol" as const };
    const maps = (
      await client.query(
        `SELECT m.id,m.type,m.status,m.submitted_at,m.based_on_map_id,m.kit_definition_id FROM maps m JOIN session_stages st ON st.id=m.session_stage_id WHERE st.session_id=$1 AND m.type='INTEGRATION' ORDER BY m.id`,
        [sessionId],
      )
    ).rows;
    const sampledAt = iso(
      (await client.query("SELECT transaction_timestamp() AS t")).rows[0].t,
    )!;
    const input: FeatureInput = {
      sessionId,
      sampledAt,
      mapId: null,
      mapStatus: null,
      submittedAt: null,
      initial: null,
      capturedAt: null,
      current: null,
      boundary: null,
      legacy: [],
      events: [],
    };
    if (maps.length !== 1)
      return {
        kind: "features" as const,
        value: deriveFiveFlowFeatures(input),
      };
    const m = maps[0]!;
    Object.assign(input, {
      mapId: m.id,
      mapStatus: m.status,
      submittedAt: iso(m.submitted_at),
    });
    const initial = (
      await client.query(
        "SELECT snapshot,captured_at FROM map_initial_snapshots WHERE map_id=$1 AND snapshot_version=1",
        [m.id],
      )
    ).rows[0];
    input.initial = initial?.snapshot ?? null;
    input.capturedAt = iso(initial?.captured_at ?? null);
    const boundary = (
      await client.query(
        "SELECT legacy_count,legacy_last_id,boundary_snapshot FROM map_history_boundaries WHERE map_id=$1",
        [m.id],
      )
    ).rows[0];
    if (boundary)
      input.boundary = {
        legacyCount: Number(boundary.legacy_count),
        legacyLastId: boundary.legacy_last_id,
      };
    input.legacy = (
      await client.query<HistoryOperation>(
        'SELECT id,map_id AS "mapId",sequence_number AS "sequenceNumber",operation_type AS "operationType",target_type AS "targetType",target_id AS "targetId",before,after,related_operation_log_id AS "relatedOperationLogId" FROM map_operation_logs WHERE map_id=$1 ORDER BY sequence_number',
        [m.id],
      )
    ).rows;
    input.events = (
      await client.query<Event>(
        'SELECT event_id AS "eventId",map_id AS "mapId",schema_version AS "schemaVersion",event_type AS "eventType",related_event_id AS "relatedEventId",related_legacy_operation_log_id AS "relatedLegacyOperationLogId",sequence_number AS "sequenceNumber",outcome,actor_type AS "actorType",server_timestamp AS "serverTimestamp",target_id AS "targetId",target_type AS "targetType",before_state AS before,after_state AS after FROM research_events WHERE map_id=$1 AND session_id=$2 AND event_type=ANY($3::text[]) ORDER BY sequence_number',
        [m.id, sessionId, mapOperations],
      )
    ).rows.map((e) => ({ ...e, serverTimestamp: iso(e.serverTimestamp)! }));
    const concepts = (
      await client.query(
        'SELECT id,map_id AS "mapId",label,position_x AS "positionX",position_y AS "positionY",merged_into_concept_id AS "mergedIntoConceptId" FROM concepts WHERE map_id=$1 ORDER BY id',
        [m.id],
      )
    ).rows;
    const links = (
      await client.query(
        'SELECT id,map_id AS "mapId",label,source_concept_id AS "sourceConceptId",target_concept_id AS "targetConceptId",label_position_x AS "labelPositionX",label_position_y AS "labelPositionY" FROM links WHERE map_id=$1 ORDER BY id',
        [m.id],
      )
    ).rows;
    const conceptProvenance = (
      await client.query(
        'SELECT id,target_concept_id AS "targetConceptId",source_concept_id AS "sourceConceptId",relation_type AS "relationType",created_at AS "createdAt" FROM concept_provenance WHERE target_concept_id=ANY($1::uuid[]) ORDER BY created_at,id',
        [concepts.map((c) => c.id)],
      )
    ).rows.map((p) => ({ ...p, createdAt: iso(p.createdAt) }));
    const linkProvenance = (
      await client.query(
        'SELECT id,target_link_id AS "targetLinkId",source_link_id AS "sourceLinkId",relation_type AS "relationType",created_at AS "createdAt" FROM link_provenance WHERE target_link_id=ANY($1::uuid[]) ORDER BY created_at,id',
        [links.map((l) => l.id)],
      )
    ).rows.map((p) => ({ ...p, createdAt: iso(p.createdAt) }));
    for (const c of concepts)
      c.provenance = conceptProvenance.filter(
        (p) => p.targetConceptId === c.id,
      );
    for (const l of links) {
      l.provenance = linkProvenance.filter((p) => p.targetLinkId === l.id);
      if (l.labelPositionX == null) {
        delete l.labelPositionX;
        delete l.labelPositionY;
      }
    }
    input.current = {
      snapshotVersion: 1,
      mapId: m.id,
      mapType: m.type,
      basedOnMapId: m.based_on_map_id,
      kitDefinitionId: m.kit_definition_id,
      concepts,
      links,
    };
    if (input.boundary && validateMapStateV5(input.initial, m.id)) {
      const old = replayMixedMapHistory(
        input.initial,
        input.boundary,
        input.legacy,
        [],
      );
      if (
        old.status !== "REPLAYABLE" ||
        !historySnapshotsEqual(old.state, boundary.boundary_snapshot)
      )
        input.boundary = null;
    }
    return { kind: "features" as const, value: deriveFiveFlowFeatures(input) };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

export const fiveFlowCsvColumns = [
  "featureVersion",
  "protocolKey",
  "sessionId",
  "mapId",
  "sampledAt",
  "aggregationPoint",
  "status",
  "reason",
  "activeConcepts",
  "hiddenMergeSources",
  "links",
  "capturedAt",
  "submittedAt",
  "submissionEventId",
  "submissionEventType",
  "submissionEventServerTimestamp",
  "historySource",
  "actorType",
  "outcome",
  "savedEventCount",
] as const;
export function fiveFlowFeatureRows(f: FiveFlowFeatures) {
  const base = {
    featureVersion: f.featureVersion,
    protocolKey: f.protocolKey,
    sessionId: f.sessionId,
    mapId: f.mapId,
    sampledAt: f.sampledAt,
  };
  return [
    ...(["start", "completion", "delta"] as const).map((point) => ({
      ...base,
      aggregationPoint: point,
      ...f[point],
      capturedAt: f.start.capturedAt,
      submittedAt: f.completion.submittedAt,
      submissionEventId: f.completion.eventId,
      submissionEventType: f.completion.eventType,
      submissionEventServerTimestamp: f.completion.serverTimestamp,
    })),
    ...f.operationResults.rows.map((row) => ({
      ...base,
      aggregationPoint: f.operationResults.scope,
      status: "AVAILABLE",
      ...row,
      savedEventCount: row.count,
    })),
  ];
}
export function fiveFlowFeaturesCsv(f: FiveFlowFeatures) {
  return (
    "\uFEFF" +
    [
      fiveFlowCsvColumns.join(","),
      ...fiveFlowFeatureRows(f).map((row) =>
        fiveFlowCsvColumns
          .map((key) => csvCell((row as Record<string, unknown>)[key]))
          .join(","),
      ),
    ].join("\r\n") +
    "\r\n"
  );
}
