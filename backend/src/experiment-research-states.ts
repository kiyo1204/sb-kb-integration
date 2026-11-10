import type { PoolClient } from "pg";
import type { HistoryOperation, MapHistorySnapshot } from "./map-history.js";
import {
  replayMixedMapHistory,
  type MapHistoryEventV2,
} from "./map-mixed-history.js";
import { validateMapStateV5 } from "./research-event-map-v5.js";
import { historySnapshotsEqual } from "./map-undo-redo.js";

type SavedMap = Record<string, unknown> & {
  id: string;
  type: string;
  status: string;
  submittedAt: string | null;
  initialSnapshot: unknown;
  initialSnapshotCapturedAt: string | null;
  concepts: unknown[];
  links: unknown[];
};
const unavailable = (reason: string) => ({
  status: "UNAVAILABLE" as const,
  reason,
  state: null as MapHistorySnapshot | null,
});
/** Shape the saved DB graph, without treating a live graph as a submitted state. */
export function savedMapState(map: Record<string, unknown>) {
  return {
    snapshotVersion: 1,
    mapId: map.id,
    mapType: map.type,
    basedOnMapId: map.basedOnMapId,
    kitDefinitionId: map.kitDefinitionId,
    concepts: (map.concepts as Record<string, unknown>[]).map((c) => ({
      id: c.id,
      mapId: c.mapId,
      label: c.label,
      positionX: c.positionX,
      positionY: c.positionY,
      mergedIntoConceptId: c.mergedIntoConceptId,
      provenance: c.provenance,
    })),
    links: (map.links as Record<string, unknown>[]).map((l) => ({
      id: l.id,
      mapId: l.mapId,
      label: l.label,
      sourceConceptId: l.sourceConceptId,
      targetConceptId: l.targetConceptId,
      provenance: l.provenance,
      ...(l.labelPositionX == null
        ? {}
        : {
            labelPositionX: l.labelPositionX,
            labelPositionY: l.labelPositionY,
          }),
    })),
  };
}
/** Uses stored initial/event states and the existing replay contract; no new metric. */
export async function integrationResearchStates(
  client: PoolClient,
  sessionId: string,
  maps: SavedMap[],
) {
  const integration = maps.filter((m) => m.type === "INTEGRATION");
  const map = integration.length === 1 ? integration[0] : undefined;
  const start =
    map &&
    validateMapStateV5(map.initialSnapshot, map.id) &&
    map.initialSnapshot.mapType === "INTEGRATION"
      ? {
          status: "AVAILABLE" as const,
          reason: null,
          state: map.initialSnapshot,
        }
      : unavailable(
          integration.length > 1
            ? "MULTIPLE_INTEGRATION_MAPS"
            : map
              ? "INITIAL_SNAPSHOT_MISSING_OR_INVALID"
              : "INTEGRATION_MAP_MISSING",
        );
  let submission: ReturnType<typeof unavailable> | typeof start =
    unavailable("NOT_SUBMITTED");
  let accepted:
    | { eventId: string; eventType: string; serverTimestamp: Date | string }
    | undefined;
  if (map?.status === "SUBMITTED") {
    submission = unavailable("SUBMISSION_STATE_UNAVAILABLE");
    const legacy = (
      await client.query<HistoryOperation>(
        `SELECT id,map_id AS "mapId",sequence_number AS "sequenceNumber",operation_type AS "operationType",target_type AS "targetType",target_id AS "targetId",before,after,related_operation_log_id AS "relatedOperationLogId" FROM map_operation_logs WHERE map_id=$1 ORDER BY sequence_number`,
        [map.id],
      )
    ).rows;
    const events = (
      await client.query<
        MapHistoryEventV2 & {
          serverTimestamp: Date | string;
          targetType: string;
          targetId: string;
        }
      >(
        `SELECT event_id AS "eventId",map_id AS "mapId",schema_version AS "schemaVersion",event_type AS "eventType",sequence_number AS "sequenceNumber",outcome,before_state AS before,after_state AS after,related_event_id AS "relatedEventId",related_legacy_operation_log_id AS "relatedLegacyOperationLogId",server_timestamp AS "serverTimestamp",target_type AS "targetType",target_id AS "targetId" FROM research_events WHERE session_id=$1 AND map_id=$2 AND schema_version IN (2,5) ORDER BY sequence_number`,
        [sessionId, map.id],
      )
    ).rows;
    const b = (
      await client.query(
        `SELECT legacy_count,legacy_last_id,boundary_snapshot FROM map_history_boundaries WHERE map_id=$1`,
        [map.id],
      )
    ).rows[0];
    const candidates = events.filter(
      (e) =>
        ["MAP_SUBMIT", "MAP_AUTO_SUBMIT"].includes(e.eventType) &&
        e.outcome === "SUCCESS",
    );
    if (
      start.state &&
      b &&
      candidates.length === 1 &&
      map.submittedAt &&
      map.initialSnapshotCapturedAt
    ) {
      const boundary = {
        legacyCount: Number(b.legacy_count),
        legacyLastId: b.legacy_last_id,
      };
      const old = replayMixedMapHistory(start.state, boundary, legacy, []);
      const replay = replayMixedMapHistory(
        start.state,
        boundary,
        legacy,
        events,
      );
      const candidate = candidates[0]!;
      const current = savedMapState(map);
      if (
        old.status === "REPLAYABLE" &&
        historySnapshotsEqual(old.state, b.boundary_snapshot) &&
        replay.status === "REPLAYABLE" &&
        validateMapStateV5(current, map.id) &&
        historySnapshotsEqual(current, replay.state) &&
        candidate.targetType === "MAP" &&
        candidate.targetId === map.id &&
        validateMapStateV5(candidate.after, map.id) &&
        historySnapshotsEqual(candidate.after, replay.state) &&
        Date.parse(map.submittedAt) >=
          Date.parse(map.initialSnapshotCapturedAt) &&
        new Date(candidate.serverTimestamp).getTime() >=
          Date.parse(map.submittedAt) &&
        !events.some(
          (e) =>
            BigInt(e.sequenceNumber) > BigInt(candidate.sequenceNumber) &&
            e.outcome === "SUCCESS",
        )
      ) {
        submission = {
          status: "AVAILABLE",
          reason: null,
          state: candidate.after,
        };
        accepted = candidate;
      } else submission = unavailable("HISTORY_INCONSISTENT");
    } else if (!start.state)
      submission = unavailable("INITIAL_SNAPSHOT_MISSING_OR_INVALID");
  }
  return {
    mapId: map?.id ?? null,
    start: { ...start, capturedAt: map?.initialSnapshotCapturedAt ?? null },
    submission: {
      ...submission,
      submittedAt: map?.submittedAt ?? null,
      eventId: accepted?.eventId ?? null,
      eventType: accepted?.eventType ?? null,
      serverTimestamp: accepted
        ? new Date(accepted.serverTimestamp).toISOString()
        : null,
    },
  };
}
