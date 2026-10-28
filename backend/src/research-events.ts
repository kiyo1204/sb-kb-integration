import type { Express } from "express";
import type { Pool, PoolClient } from "pg";
import { learnerMayAccessMap, principalOf, tokenHash } from "./access-control.js";

// Names are shared with the catalog; adding a payload requires a reviewed schema version.
export const eventTargets = {
  SESSION_CREATE: "SESSION", SESSION_START: "SESSION", SESSION_COMPLETE: "SESSION", SESSION_SETTINGS_CHANGE: "SESSION",
  STAGE_START: "STAGE", STAGE_COMPLETE: "STAGE", STAGE_PAUSE: "STAGE", STAGE_RESUME: "STAGE",
  SCREEN_ENTER: "SCREEN", SCREEN_LEAVE: "SCREEN", VIDEO_PLAY: "VIDEO", VIDEO_PAUSE: "VIDEO", VIDEO_SEEK: "VIDEO", VIDEO_COMPLETE: "VIDEO",
  ADD_CONCEPT: "CONCEPT", EDIT_CONCEPT: "CONCEPT", MOVE_CONCEPT: "CONCEPT", DELETE_CONCEPT: "CONCEPT", MERGE_CONCEPT: "CONCEPT", IMPORT_KIT_CONCEPT: "CONCEPT",
  ADD_LINK: "LINK", EDIT_LINK: "LINK", DELETE_LINK: "LINK", RECONNECT_LINK: "LINK", IMPORT_KIT_LINK: "LINK",
  UNDO: "MAP", REDO: "MAP", MAP_SAVE: "MAP", MAP_SUBMIT: "MAP", MAP_AUTO_SUBMIT: "MAP",
  FEEDBACK_CHECK: "FEEDBACK", FEEDBACK_DISPLAY: "FEEDBACK", ASSESSMENT_EDIT: "ASSESSMENT", ASSESSMENT_SUBMIT: "ASSESSMENT",
  RESEARCH_ANALYSIS_VIEW: "SESSION", RESEARCH_ASSESSMENT_CHANGE: "ASSESSMENT", RESEARCH_EXPORT: "SESSION",
} as const;
export type EventType = keyof typeof eventTargets;
export type EventOutcome = "SUCCESS" | "FAILURE" | "REJECTED" | "CANCELLED" | "UNKNOWN";
export type EventActor = "LEARNER" | "RESEARCHER" | "SYSTEM";
type TimeQuality = "OBSERVED" | "ESTIMATED" | "MISSING" | "NOT_APPLICABLE" | "UNKNOWN";
type NumericState = { positionX?: number; positionY?: number };
export type EventInput = { eventType: EventType; targetType: typeof eventTargets[EventType]; stageId?: string; mapId?: string; targetId?: string; relatedEventId?: string; outcome: EventOutcome; reasonCode?: string; clientTimestamp?: string; clientTimeQuality: TimeQuality; before?: NumericState; after?: NumericState; beforeQuality?: TimeQuality; afterQuality?: TimeQuality; details?: { durationMs?: number; positionSeconds?: number; fromSeconds?: number; toSeconds?: number } };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasons = ["NOT_APPLICABLE", "UNKNOWN", "VALIDATION", "PERMISSION", "DEADLINE", "CONFLICT", "NETWORK", "SERVER", "USER_CANCELLED", "OTHER"];
const qualities = ["OBSERVED", "ESTIMATED", "MISSING", "NOT_APPLICABLE", "UNKNOWN"];
const outcomes = ["SUCCESS", "FAILURE", "REJECTED", "CANCELLED", "UNKNOWN"];
const keys = ["schemaVersion", "eventType", "targetType", "stageId", "mapId", "targetId", "relatedEventId", "outcome", "reasonCode", "clientTimestamp", "clientTimeQuality", "before", "after", "beforeQuality", "afterQuality", "details"];
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function numericState(value: unknown) {
  return object(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, item]) => ["positionX", "positionY"].includes(key) && typeof item === "number" && Number.isFinite(item));
}
export function validateEvent(value: unknown): value is EventInput {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || value.schemaVersion !== 1) return false;
  if (typeof value.eventType !== "string" || !Object.hasOwn(eventTargets, value.eventType) || value.targetType !== eventTargets[value.eventType as EventType]) return false;
  if (typeof value.outcome !== "string" || !outcomes.includes(value.outcome) || typeof value.clientTimeQuality !== "string" || !qualities.includes(value.clientTimeQuality)) return false;
  if (value.reasonCode !== undefined && (typeof value.reasonCode !== "string" || !reasons.includes(value.reasonCode))) return false;
  if (["stageId", "mapId", "targetId", "relatedEventId"].some(key => value[key] !== undefined && (typeof value[key] !== "string" || !uuid.test(value[key] as string)))) return false;
  if (["MAP", "CONCEPT", "LINK"].includes(value.targetType as string) && !value.mapId) return false;
  if (["CONCEPT", "LINK"].includes(value.targetType as string) && !value.targetId) return false;
  if (["STAGE", "VIDEO", "ASSESSMENT", "FEEDBACK"].includes(value.targetType as string) && !value.stageId && !value.mapId) return false;
  if (value.clientTimeQuality === "OBSERVED" || value.clientTimeQuality === "ESTIMATED") {
    if (typeof value.clientTimestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value.clientTimestamp) || !Number.isFinite(Date.parse(value.clientTimestamp))) return false;
  } else if (value.clientTimestamp !== undefined) return false;
  if (value.before !== undefined && !numericState(value.before) || value.after !== undefined && !numericState(value.after)) return false;
  for (const field of ["before", "after"] as const) {
    const quality = value[`${field}Quality`] ?? (value[field] === undefined ? "MISSING" : "OBSERVED");
    if (typeof quality !== "string" || !qualities.includes(quality) || (value[field] !== undefined) !== ["OBSERVED", "ESTIMATED"].includes(quality)) return false;
  }
  if (value.details !== undefined && (!object(value.details) || !Object.entries(value.details).every(([key, item]) => ["durationMs", "positionSeconds", "fromSeconds", "toSeconds"].includes(key) && typeof item === "number" && Number.isFinite(item) && item >= 0))) return false;
  return true;
}

export async function insertResearchEvent(client: PoolClient, sessionId: string, actor: EventActor, event: EventInput) {
  if (!uuid.test(sessionId) || !["LEARNER", "RESEARCHER", "SYSTEM"].includes(actor) || !validateEvent({ ...event, schemaVersion: 1 })) throw new Error("Invalid event");
  const session = await client.query<{ participantCode: string; studyGroup: string | null }>(`SELECT participant_code AS "participantCode", study_group AS "studyGroup" FROM sessions WHERE id=$1::uuid AND protocol_key IN ('STAGE1_4','STAGE1_6')`, [sessionId]);
  if (!session.rowCount) return null;
  const participantCode = session.rows[0]!.participantCode;
  if (participantCode === process.env.RESEARCHER_API_TOKEN || (await client.query("SELECT 1 FROM sessions WHERE learner_access_token_hash=$1 LIMIT 1", [tokenHash(participantCode)])).rowCount) return null;
  let stageId = event.stageId ?? null;
  if (event.mapId) {
    const map = await client.query<{ stageId: string }>(`SELECT st.id AS "stageId" FROM maps m JOIN session_stages st ON st.id=m.session_stage_id WHERE m.id=$1::uuid AND st.session_id=$2::uuid`, [event.mapId, sessionId]);
    if (!map.rowCount || (stageId && map.rows[0]!.stageId !== stageId)) return null;
    stageId = map.rows[0]!.stageId;
  }
  const stage = stageId ? await client.query<{ stageType: string }>(`SELECT stage_type AS "stageType" FROM session_stages WHERE id=$1::uuid AND session_id=$2::uuid`, [stageId, sessionId]) : null;
  if (stage && !stage.rowCount) return null;
  if (event.relatedEventId && !(await client.query(`SELECT 1 FROM research_events WHERE event_id=$1::uuid AND session_id=$2::uuid`, [event.relatedEventId, sessionId])).rowCount) return null;
  if (event.targetType === "SESSION" && event.targetId && event.targetId !== sessionId || event.targetType === "STAGE" && event.targetId && event.targetId !== stageId || event.targetType === "MAP" && event.targetId && event.targetId !== event.mapId) return null;
  const sequence = await client.query<{ sequence: string }>(`INSERT INTO research_event_counters(session_id,next_sequence) VALUES($1::uuid,2) ON CONFLICT(session_id) DO UPDATE SET next_sequence=research_event_counters.next_sequence+1 RETURNING next_sequence-1 AS sequence`, [sessionId]);
  const inserted = await client.query<{ eventId: string; sequenceNumber: string }>(`INSERT INTO research_events(event_id,schema_version,session_id,stage_id,map_id,participant_code,study_group,activity,actor_type,event_type,target_type,target_id,outcome,reason_code,sequence_number,client_timestamp,client_time_quality,related_event_id,before_state,after_state,before_quality,after_quality,details)
    VALUES(gen_random_uuid(),1,$1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::uuid,$11,$12,$13::bigint,$14::timestamptz,$15,$16::uuid,$17::jsonb,$18::jsonb,$19,$20,$21::jsonb) RETURNING event_id AS "eventId", sequence_number AS "sequenceNumber"`,
    [sessionId, stageId, event.mapId ?? null, session.rows[0]!.participantCode, session.rows[0]!.studyGroup, stage?.rows[0]?.stageType ?? null, actor, event.eventType, event.targetType, event.targetId ?? (event.targetType === "SESSION" ? sessionId : event.targetType === "STAGE" ? stageId : event.targetType === "MAP" ? event.mapId : null), event.outcome, event.reasonCode ?? null, sequence.rows[0]!.sequence, event.clientTimestamp ?? null, event.clientTimeQuality, event.relatedEventId ?? null, event.before ? JSON.stringify(event.before) : null, event.after ? JSON.stringify(event.after) : null, event.beforeQuality ?? (event.before ? "OBSERVED" : "MISSING"), event.afterQuality ?? (event.after ? "OBSERVED" : "MISSING"), JSON.stringify(event.details ?? {})]);
  return inserted.rows[0]!;
}
export function registerResearchEventRoutes(app: Express, pool: Pool) {
  app.post("/api/sessions/:sessionId/events", async (req, res) => {
    const sessionId = req.params.sessionId;
    if (!uuid.test(sessionId)) return res.status(404).json({ error: "not_found" });
    if (!validateEvent(req.body)) return res.status(400).json({ error: "invalid_event" });
    const principal = principalOf(res);
    const event = req.body;
    if (principal.role === "learner") {
      if (principal.sessionId !== sessionId) return res.status(404).json({ error: "not_found" });
      if (["SESSION_CREATE", "SESSION_SETTINGS_CHANGE", "MAP_AUTO_SUBMIT", "RESEARCH_ANALYSIS_VIEW", "RESEARCH_ASSESSMENT_CHANGE", "RESEARCH_EXPORT"].includes(event.eventType)) return res.status(403).json({ error: "forbidden" });
      if (event.mapId && !(await learnerMayAccessMap(pool, "maps", event.mapId, sessionId, "GET"))) return res.status(404).json({ error: "not_found" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await insertResearchEvent(client, sessionId, principal.role === "learner" ? "LEARNER" : "RESEARCHER", event);
      if (!result) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      await client.query("COMMIT");
      return res.status(201).json({ ...result, logSaved: true });
    } catch { await client.query("ROLLBACK"); return res.status(500).json({ error: "event_save_failed", logSaved: false }); }
    finally { client.release(); }
  });
  app.get("/api/research/sessions/:sessionId/events", async (req, res) => {
    if (principalOf(res).role !== "researcher" || !uuid.test(req.params.sessionId)) return res.status(404).json({ error: "not_found" });
    const after = typeof req.query.after === "string" ? req.query.after : "0";
    if (!/^(0|[1-9]\d{0,17})$/.test(after)) return res.status(400).json({ error: "invalid_cursor" });
    try {
      if (!(await pool.query("SELECT 1 FROM sessions WHERE id=$1::uuid AND protocol_key IN ('STAGE1_4','STAGE1_6')", [req.params.sessionId])).rowCount) return res.status(404).json({ error: "not_found" });
      const result = await pool.query(`SELECT event_id AS "eventId",schema_version AS "schemaVersion",session_id AS "sessionId",stage_id AS "stageId",map_id AS "mapId",participant_code AS "participantCode",study_group AS "studyGroup",activity,actor_type AS "actorType",event_type AS "eventType",target_type AS "targetType",target_id AS "targetId",outcome,reason_code AS "reasonCode",sequence_number AS "sequenceNumber",client_timestamp AS "clientTimestamp",client_time_quality AS "clientTimeQuality",server_timestamp AS "serverTimestamp",related_event_id AS "relatedEventId",before_state AS "before",after_state AS "after",before_quality AS "beforeQuality",after_quality AS "afterQuality",details FROM research_events WHERE session_id=$1::uuid AND sequence_number>$2::bigint ORDER BY sequence_number LIMIT 200`, [req.params.sessionId, after]);
      return res.json({ events: result.rows });
    } catch { return res.status(500).json({ error: "event_fetch_failed" }); }
  });
}
