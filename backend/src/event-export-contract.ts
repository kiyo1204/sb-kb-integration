import { eventTargets } from "./research-event-catalog.js";
import { isUuid } from "./delivery-reliability.js";
export const EXPORT_VERSION = 2;
export const activities = [
  "LESSON",
  "PRIOR_MAP",
  "KB_MAP",
  "PRE_ASSESSMENT",
  "INTEGRATION_MAP",
  "SELF_STUDY",
  "POST_ASSESSMENT",
  "UNASSIGNED",
] as const;
export const groups = ["EXPERIMENTAL", "CONTROL", "UNASSIGNED"] as const;
export const learnerId = (sessionId: string | null) =>
  sessionId ? "L-" + sessionId : null;
export type ExportFilters = {
  sessionIds: string[];
  learnerIds: string[];
  groups: string[];
  activities: string[];
  eventTypes: string[];
  outcomes?: string[];
  from: string | null;
  to: string | null;
};
export function parseInstant(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(
      value,
    )
  )
    return null;
  const year = Number(value.slice(0, 4)),
    month = Number(value.slice(5, 7)),
    day = Number(value.slice(8, 10));
  if (
    year < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    !Number.isFinite(Date.parse(value))
  )
    return null;
  const iso = new Date(value).toISOString();
  return iso.length === 24 ? iso : null;
}
export function parseFilters(value: unknown): ExportFilters | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) =>
        ![
          "sessionIds",
          "learnerIds",
          "groups",
          "activities",
          "eventTypes",
          "outcomes",
          "from",
          "to",
        ].includes(k),
    )
  )
    return null;
  const list = (key: string, valid: (s: string) => boolean) => {
    const a = v[key] ?? [];
    return Array.isArray(a) &&
      a.length <= 100 &&
      a.every((x) => typeof x === "string" && valid(x))
      ? [...new Set(a as string[])].sort()
      : null;
  };
  const sessionIds = list("sessionIds", isUuid),
    learnerIds = list(
      "learnerIds",
      (s) => /^[LP]-/.test(s) && isUuid(s.slice(2)),
    ),
    g = list("groups", (s) => (groups as readonly string[]).includes(s)),
    a = list("activities", (s) =>
      (activities as readonly string[]).includes(s),
    ),
    types = list("eventTypes", (s) => Object.hasOwn(eventTargets, s));
  const outcomes = list("outcomes", s => ["SUCCESS","FAILURE","REJECTED","CANCELLED","UNKNOWN"].includes(s));
  const from = v.from == null ? null : parseInstant(v.from),
    to = v.to == null ? null : parseInstant(v.to);
  if (
    !outcomes ||
    !sessionIds ||
    !learnerIds ||
    !g ||
    !a ||
    !types ||
    (v.from != null && !from) ||
    (v.to != null && !to) ||
    (from && to && from >= to)
  )
    return null;
  return {
    sessionIds: [...new Set(sessionIds.map((x) => x.toLowerCase()))].sort(),
    learnerIds: [
      ...new Set(learnerIds.map((x) => x.slice(0,2) + x.slice(2).toLowerCase())),
    ].sort(),
    groups: g,
    activities: a,
    eventTypes: types,
    ...(outcomes.length ? {outcomes} : {}),
    from,
    to,
  };
}
export const commonColumns = [
  "event_id",
  "source_format",
  "schema_version",
  "session_id",
  "learner_id",
  "study_group",
  "activity",
  "stage_id",
  "map_id",
  "actor_type",
  "event_type",
  "target_type",
  "target_id",
  "outcome",
  "reason_code",
  "sequence_number",
  "sequence_scope",
  "client_timestamp",
  "client_time_quality",
  "server_timestamp",
  "related_event_id",
  "related_legacy_operation_log_id",
  "before_quality",
  "after_quality",
  "payload_status",
  "boundary_status",
  "legacy_boundary_count",
  "legacy_boundary_last_id",
  "feedback_match",
] as const;
export type ExportEvent = {
  feedback_match?: boolean | null;
  event_id: string;
  source_format: "LEGACY" | "EVENT";
  schema_version: number | null;
  session_id: string | null;
  learner_id: string | null;
  study_group: string | null;
  activity: string | null;
  stage_id: string | null;
  map_id: string | null;
  actor_type: string;
  event_type: string;
  target_type: string;
  target_id: string | null;
  outcome: string;
  reason_code: string | null;
  sequence_number: string;
  sequence_scope: string;
  client_timestamp: string | null;
  client_time_quality: string;
  server_timestamp: string;
  related_event_id: string | null;
  related_legacy_operation_log_id: string | null;
  before_quality: string;
  after_quality: string;
  payload_status: string;
  boundary_status: string;
  legacy_boundary_count: string | null;
  legacy_boundary_last_id: string | null;
  before: unknown;
  after: unknown;
  details: Record<string, number | boolean>;
  stage_started_at: string | null;
  server_elapsed_ms: number | null;
  elapsed_quality: string;
};
export const detailColumns = {
  "map_operations.csv": [
    ...commonColumns,
    "before_json",
    "after_json",
    "details_json",
  ],
  "activity_times.csv": [
    ...commonColumns,
    "stage_started_at",
    "server_elapsed_ms",
    "elapsed_quality",
    "recorded_duration_ms",
    "from_seconds",
    "to_seconds",
  ],
  "assessment_events.csv": [
    ...commonColumns,
    "timepoint",
    "question_id",
    "before_answer",
    "after_answer",
    "before_json",
    "after_json",
  ],
  "system_events.csv": [...commonColumns, "details_json"],
  "researcher_events.csv": [...commonColumns, "details_json"],
} as const;
export const exportFiles = [
  "events.json",
  "events.csv",
  ...Object.keys(detailColumns),
  "manifest.json",
  "data-dictionary.md",
  "bundle.zip",
];
export function csvRows(
  event: ExportEvent,
): Record<string, Record<string, unknown>> {
  const e = { ...event },
    rows: Record<string, Record<string, unknown>> = { "events.csv": e };
  if (["MAP", "CONCEPT", "LINK"].includes(e.target_type))
    rows["map_operations.csv"] = {
      ...e,
      before_json: e.before,
      after_json: e.after,
      details_json: e.details,
    };
  if (
    /^(?:SESSION_(?:START|COMPLETE)|STAGE_|SCREEN_|VIDEO_|FEEDBACK_)/.test(
      e.event_type,
    )
  )
    rows["activity_times.csv"] = {
      ...e,
      recorded_duration_ms: e.details.durationMs ?? null,
      from_seconds: e.details.fromSeconds ?? null,
      to_seconds: e.details.toSeconds ?? null,
    };
  if (e.target_type === "ASSESSMENT") {
    const before = e.before as {
        questionId?: string;
        answer?: string | null;
      } | null,
      after = e.after as { questionId?: string; answer?: string | null } | null;
    rows["assessment_events.csv"] = {
      ...e,
      timepoint:
        e.activity === "PRE_ASSESSMENT"
          ? "PRE"
          : e.activity === "POST_ASSESSMENT"
            ? "POST"
            : null,
      question_id:
        e.schema_version === 3 && e.event_type === "ASSESSMENT_EDIT"
          ? (after?.questionId ??
            before?.questionId ??
            (e.outcome === "SUCCESS" ? e.target_id : null))
          : null,
      before_answer: before?.answer ?? null,
      after_answer: after?.answer ?? null,
      before_json: e.before,
      after_json: e.after,
    };
  }
  if (e.actor_type === "SYSTEM")
    rows["system_events.csv"] = { ...e, details_json: e.details };
  if (e.actor_type === "RESEARCHER")
    rows["researcher_events.csv"] = { ...e, details_json: e.details };
  return rows;
}
