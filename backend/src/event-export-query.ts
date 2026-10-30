import type { PoolClient } from "pg";
import { isUuid } from "./delivery-reliability.js";
import { tokenHash } from "./access-control.js";
import { eventTargets, validateEvent } from "./research-events.js";
import {
  validMapLabel,
  mapStateLabels,
  type MapStateV2,
} from "./research-event-map-v2.js";
import {
  learnerId,
  type ExportFilters,
  type ExportEvent,
} from "./event-export-contract.js";

export function extractionQuery(filters: ExportFilters, chronological = false) {
  const values: unknown[] = [],
    where: string[] = [];
  const list = (column: string, value: string[], cast = "text[]") => {
    if (value.length) {
      values.push(value);
      where.push(column + "=ANY($" + values.length + "::" + cast + ")");
    }
  };
  list("session_id", filters.sessionIds, "uuid[]");
  if (filters.learnerIds.length) {
    values.push(filters.learnerIds);
    where.push("(coalesce((SELECT pseudonym FROM research_session_ids i WHERE i.session_id=source.session_id),'L-'||session_id::text)=ANY($"+values.length+"::text[]) OR ('L-'||session_id::text)=ANY($"+values.length+"::text[]))");
  }
  list("coalesce(study_group,'UNASSIGNED')", filters.groups);
  list("coalesce(activity,'UNASSIGNED')", filters.activities);
  list("event_type", filters.eventTypes);
  list("outcome", filters.outcomes ?? []);
  if (filters.from) {
    values.push(filters.from);
    where.push("server_timestamp >= $" + values.length + "::timestamptz");
  }
  if (filters.to) {
    values.push(filters.to);
    where.push("server_timestamp < $" + values.length + "::timestamptz");
  }
  const safe = (column: string) =>
    "CASE WHEN octet_length(" +
    column +
    "::text)<=8000000 THEN " +
    column +
    " END";
  return {
    values,
    text: `WITH source AS (
 SELECT 'legacy:'||l.id::text AS event_id,'LEGACY'::text AS source_format,NULL::integer AS schema_version,
 st.session_id,s.study_group,st.stage_type AS activity,st.id AS stage_id,l.map_id,
 'UNKNOWN'::text AS actor_type,l.operation_type AS event_type,l.target_type,l.target_id,
 'UNKNOWN'::text AS outcome,NULL::text AS reason_code,l.sequence_number,'MAP'::text AS sequence_scope,
 l.client_timestamp,'UNKNOWN'::text AS client_time_quality,l.server_timestamp,
 CASE WHEN l.related_operation_log_id IS NOT NULL THEN 'legacy:'||l.related_operation_log_id::text END AS related_event_id,
 l.related_operation_log_id AS related_legacy_operation_log_id,'UNKNOWN'::text AS before_quality,'UNKNOWN'::text AS after_quality,
 ${safe("l.before")} AS before_payload,${safe("l.after")} AS after_payload,'{}'::jsonb AS details,
 coalesce(octet_length(l.before::text)>8000000,false) OR coalesce(octet_length(l.after::text)>8000000,false) AS oversized,
 st.started_at AS stage_started_at,b.legacy_count AS legacy_boundary_count,b.legacy_last_id AS legacy_boundary_last_id,
 CASE WHEN b.map_id IS NULL THEN 'LEGACY_ONLY' WHEN l.sequence_number<=b.legacy_count THEN 'WITHIN_LEGACY_BOUNDARY' ELSE 'INVALID_AFTER_BOUNDARY' END AS boundary_status,0 AS stream_order
 FROM map_operation_logs l JOIN maps m ON m.id=l.map_id JOIN session_stages st ON st.id=m.session_stage_id JOIN sessions s ON s.id=st.session_id
 LEFT JOIN map_history_boundaries b ON b.map_id=l.map_id
 WHERE s.protocol_key IN ('STAGE1_4','STAGE1_6') AND m.type IN ('PRIOR','KB','INTEGRATION')
 UNION ALL
 SELECT e.event_id::text,'EVENT',e.schema_version::integer,e.session_id,e.study_group,e.activity,e.stage_id,e.map_id,e.actor_type,e.event_type,e.target_type,e.target_id,e.outcome,e.reason_code,e.sequence_number,
 CASE WHEN e.session_id IS NULL THEN 'GLOBAL' ELSE 'SESSION' END,
 e.client_timestamp,e.client_time_quality,e.server_timestamp,
 coalesce(e.related_event_id::text,CASE WHEN e.related_legacy_operation_log_id IS NOT NULL THEN 'legacy:'||e.related_legacy_operation_log_id::text END),e.related_legacy_operation_log_id,e.before_quality,e.after_quality,
 ${safe("e.before_state")},${safe("e.after_state")},CASE WHEN octet_length(e.details::text)<=65536 THEN e.details END,
 coalesce(octet_length(e.before_state::text)>8000000,false) OR coalesce(octet_length(e.after_state::text)>8000000,false) OR octet_length(e.details::text)>65536,
 st.started_at,b.legacy_count,b.legacy_last_id,
 CASE WHEN e.schema_version NOT IN (2,5) THEN 'NOT_APPLICABLE' WHEN b.map_id IS NULL THEN 'MISSING_BOUNDARY' ELSE 'AFTER_LEGACY_BOUNDARY' END,1
 FROM research_events e LEFT JOIN sessions s ON s.id=e.session_id LEFT JOIN session_stages st ON st.id=e.stage_id LEFT JOIN map_history_boundaries b ON b.map_id=e.map_id
 WHERE s.protocol_key IN ('STAGE1_4','STAGE1_6') OR e.session_id IS NULL
 ) SELECT source.*,(SELECT pseudonym FROM research_session_ids i WHERE i.session_id=source.session_id) AS pseudonym FROM source ${where.length ? "WHERE " + where.join(" AND ") : ""}
 ORDER BY ${chronological ? "server_timestamp,event_id" : "session_id ASC NULLS LAST,stream_order,CASE WHEN source_format='LEGACY' THEN map_id END ASC,sequence_number,event_id"}`,
  };
}
export type RawExportRow = Omit<
  ExportEvent,
  | "learner_id"
  | "payload_status"
  | "before"
  | "after"
  | "server_elapsed_ms"
  | "elapsed_quality"
  | "server_timestamp"
  | "client_timestamp"
  | "stage_started_at"
> & {
  pseudonym?: string;
  before_payload: unknown;
  after_payload: unknown;
  oversized: boolean;
  server_timestamp: string | Date;
  client_timestamp: string | Date | null;
  stage_started_at: string | Date | null;
  stream_order: number;
};
const timestamp = (v: unknown) =>
  v == null ? null : new Date(v as string | Date).toISOString();
const labelsFromLegacy = (
  value: unknown,
  labels: string[],
  depth = 0,
  key = "",
  mapId?: string,
): boolean => {
  if (depth > 12) return false;
  const nullable = ["mergedIntoConceptId", "basedOnMapId", "kitDefinitionId"];
  const ids = [
    "id",
    "sourceConceptId",
    "targetConceptId",
    "targetLinkId",
    "sourceLinkId",
    "relatedOperationLogId",
    ...nullable,
  ];
  if (key === "label") {
    if (!validMapLabel(value)) return false;
    labels.push(value as string);
    return true;
  }
  if (key === "mapId") return value === mapId;
  if (ids.includes(key))
    return value === null ? nullable.includes(key) : isUuid(value);
  if (["positionX", "positionY"].includes(key))
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= 10000000
    );
  if (key === "snapshotVersion") return value === 1;
  if (key === "createdAt")
    return (
      typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
        value,
      ) &&
      Number.isFinite(Date.parse(value))
    );
  if (key === "mapType")
    return (
      typeof value === "string" &&
      ["PRIOR", "KB", "INTEGRATION"].includes(value)
    );
  if (key === "relatedOperationType")
    return typeof value === "string" && Object.hasOwn(eventTargets, value);
  if (key === "relationType")
    return [
      "CLONED_FROM",
      "IMPORTED_FROM",
      "MERGED_FROM",
      "RECONSTRUCTED_FROM",
    ].includes(typeof value === "string" ? value : "");
  if (["affectedConceptIds", "affectedLinkIds"].includes(key))
    return Array.isArray(value) && value.length <= 3000 && value.every(isUuid);
  if (["provenance", "concepts", "links", "incidentLinks"].includes(key))
    return (
      Array.isArray(value) &&
      value.length <= 3000 &&
      value.every((x) => labelsFromLegacy(x, labels, depth + 1, "", mapId))
    );
  if (key !== "" && key !== "concept") return false;
  if (value === null) return key === "";
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = [
    ...ids,
    "mapId",
    "label",
    "positionX",
    "positionY",
    "provenance",
    "relationType",
    "createdAt",
    "concept",
    "concepts",
    "links",
    "incidentLinks",
    "affectedConceptIds",
    "affectedLinkIds",
    "relatedOperationType",
    "snapshotVersion",
    "mapType",
  ];
  return Object.entries(value).every(
    ([k, v]) =>
      allowed.includes(k) && labelsFromLegacy(v, labels, depth + 1, k, mapId),
  );
};
export async function normaliseEvent(
  row: RawExportRow,
  client?: PoolClient,
): Promise<ExportEvent> {
  const server = timestamp(row.server_timestamp)!,
    start = timestamp(row.stage_started_at),
    elapsed = start ? Date.parse(server) - Date.parse(start) : null;
  let before = row.before_payload,
    after = row.after_payload,
    details = row.details ?? {},
    status = row.oversized ? "OVERSIZE" : "EXPORTED";
  if (
    !Object.hasOwn(eventTargets, row.event_type) ||
    ![
      "SESSION",
      "STAGE",
      "MAP",
      "CONCEPT",
      "LINK",
      "ASSESSMENT",
      "VIDEO",
      "FEEDBACK",
      "SCREEN",
    ].includes(row.target_type)
  )
    status = "REDACTED_OR_UNSUPPORTED";
  // PostgreSQL jsonb::text adds separator spaces; cap the actual contract payload after decoding.
  if (
    [before, after].some(
      (x) =>
        x !== null && Buffer.byteLength(JSON.stringify(x), "utf8") > 4000000,
    )
  )
    status = "OVERSIZE";
  const labels: string[] = [];
  if (status !== "OVERSIZE") {
    if (row.source_format === "LEGACY") {
      if (
        !labelsFromLegacy(before, labels, 0, "", row.map_id ?? undefined) ||
        !labelsFromLegacy(after, labels, 0, "", row.map_id ?? undefined)
      )
        status = "REDACTED_OR_UNSUPPORTED";
    } else if (row.schema_version === 4) {
      if (before !== null || after !== null || Object.keys(details).length)
        status = "REDACTED_OR_UNSUPPORTED";
    } else {
      const input = {
        schemaVersion: row.schema_version,
        eventType: row.event_type,
        targetType: row.target_type,
        ...(row.stage_id ? { stageId: row.stage_id } : {}),
        ...(row.map_id ? { mapId: row.map_id } : {}),
        ...(row.target_id ? { targetId: row.target_id } : {}),
        outcome: row.outcome,
        ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
        clientTimeQuality: row.client_time_quality,
        ...(row.client_timestamp
          ? { clientTimestamp: timestamp(row.client_timestamp) }
          : {}),
        beforeQuality: row.before_quality,
        afterQuality: row.after_quality,
        ...(before !== null ? { before } : {}),
        ...(after !== null ? { after } : {}),
        ...(row.related_legacy_operation_log_id
          ? { relatedLegacyOperationLogId: row.related_legacy_operation_log_id }
          : row.related_event_id
            ? { relatedEventId: row.related_event_id }
            : {}),
        ...(Object.keys(details).length ? { details } : {}),
      };
      if (!validateEvent(input)) status = "REDACTED_OR_UNSUPPORTED";
      else if ((row.schema_version === 2 || row.schema_version === 5)) {
        for (const state of [before, after])
          if (state) labels.push(...mapStateLabels(state as MapStateV2));
      } else if (row.schema_version === 3) {
        for (const state of [before, after])
          if (
            state &&
            typeof state === "object" &&
            "answer" in state &&
            typeof state.answer === "string"
          )
            labels.push(state.answer);
      }
    }
  }
  if (status === "EXPORTED" && labels.length) {
    const token = process.env.RESEARCHER_API_TOKEN;
    if (token && labels.some((x) => x.includes(token)))
      status = "REDACTED_OR_UNSUPPORTED";
    if (status === "EXPORTED" && client) {
      const hashes = [
        ...new Set(
          labels.flatMap((x) => [x, ...x.split(/\s+/)]).map(tokenHash),
        ),
      ];
      if (
        (
          await client.query(
            "SELECT 1 FROM sessions WHERE learner_access_token_hash=ANY($1::text[]) LIMIT 1",
            [hashes],
          )
        ).rowCount
      )
        status = "REDACTED_OR_UNSUPPORTED";
    }
  }
  if (status !== "EXPORTED") {
    before = null;
    after = null;
    details = {};
  }
  if (
    status === "EXPORTED" &&
    before === null &&
    after === null &&
    !Object.keys(details).length
  )
    status = "NO_PAYLOAD";
  return {
    event_id: row.event_id,
    source_format: row.source_format,
    schema_version: row.schema_version,
    session_id: row.session_id,
    learner_id: row.pseudonym ?? learnerId(row.session_id),
    study_group: row.study_group,
    activity: row.activity,
    stage_id: row.stage_id,
    map_id: row.map_id,
    actor_type: row.actor_type,
    event_type: Object.hasOwn(eventTargets, row.event_type)
      ? row.event_type
      : "UNKNOWN_EVENT_TYPE",
    target_type: [
      "SESSION",
      "STAGE",
      "MAP",
      "CONCEPT",
      "LINK",
      "ASSESSMENT",
      "VIDEO",
      "FEEDBACK",
      "SCREEN",
    ].includes(row.target_type)
      ? row.target_type
      : "UNKNOWN",
    target_id: row.target_id,
    outcome: row.outcome,
    reason_code: row.reason_code,
    sequence_number: String(row.sequence_number),
    sequence_scope: row.sequence_scope,
    client_timestamp: timestamp(row.client_timestamp),
    client_time_quality: row.client_time_quality,
    server_timestamp: server,
    related_event_id: row.related_event_id,
    related_legacy_operation_log_id: row.related_legacy_operation_log_id,
    before_quality: row.before_quality,
    after_quality: row.after_quality,
    payload_status: status,
    boundary_status: row.boundary_status,
    legacy_boundary_count:
      row.legacy_boundary_count == null
        ? null
        : String(row.legacy_boundary_count),
    legacy_boundary_last_id: row.legacy_boundary_last_id,
    before,
    after,
    details,
    feedback_match: row.schema_version===6 && row.outcome==="SUCCESS" && typeof details.matched==="boolean" ? details.matched : null,
    stage_started_at: start,
    server_elapsed_ms: elapsed,
    elapsed_quality:
      elapsed === null
        ? "MISSING"
        : elapsed < 0
          ? "INCONSISTENT_ORDER"
          : "COMPUTED_SERVER_DIFFERENCE",
  };
}
