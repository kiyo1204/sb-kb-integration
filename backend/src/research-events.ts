import { validateMapEventV5 } from "./research-event-map-v5.js";
import { validateFeedbackEventV6, type FeedbackDetailsV6 } from "./research-event-feedback-v6.js";
import { digest, isUuid } from "./delivery-reliability.js";
import type { Express } from "express";
import type { Pool, PoolClient } from "pg";
import { principalOf, tokenHash } from "./access-control.js";
import { mapStateLabels, validateMapEventV2, type MapStateV2 } from "./research-event-map-v2.js";

import { validateAssessmentEventV3, type AssessmentStateV3 } from "./research-event-assessment-v3.js";

// Names are shared with the catalog; adding a payload requires a reviewed schema version.
export {eventTargets} from "./research-event-catalog.js";
export type {EventType} from "./research-event-catalog.js";
import {eventTargets,type EventType} from "./research-event-catalog.js";
export type EventOutcome = "SUCCESS" | "FAILURE" | "REJECTED" | "CANCELLED" | "UNKNOWN";
export type EventActor = "LEARNER" | "RESEARCHER" | "SYSTEM";
type TimeQuality = "OBSERVED" | "ESTIMATED" | "MISSING" | "NOT_APPLICABLE" | "UNKNOWN";
type NumericState = { positionX?: number; positionY?: number };
type EventCommon = { eventType: EventType; targetType: typeof eventTargets[EventType]; stageId?: string; mapId?: string; targetId?: string; relatedEventId?: string; relatedLegacyOperationLogId?: string; idempotencyKey?: string; outcome: EventOutcome; reasonCode?: string; clientTimestamp?: string; clientTimeQuality: TimeQuality; beforeQuality?: TimeQuality; afterQuality?: TimeQuality; details?: FeedbackDetailsV6 | { durationMs?: number; positionSeconds?: number; fromSeconds?: number; toSeconds?: number } };
export type EventInput = EventCommon & ({ schemaVersion?: 1; before?: NumericState; after?: NumericState } | { schemaVersion: 2; before?: MapStateV2; after?: MapStateV2 } | { schemaVersion: 3; before?: AssessmentStateV3; after?: AssessmentStateV3 } | { schemaVersion: 5; before?: MapStateV2; after?: MapStateV2 } | { schemaVersion: 6; before?: never; after?: never });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasons = ["NOT_APPLICABLE", "UNKNOWN", "VALIDATION", "PERMISSION", "DEADLINE", "CONFLICT", "NETWORK", "SERVER", "USER_CANCELLED", "OTHER"];
const qualities = ["OBSERVED", "ESTIMATED", "MISSING", "NOT_APPLICABLE", "UNKNOWN"];
const outcomes = ["SUCCESS", "FAILURE", "REJECTED", "CANCELLED", "UNKNOWN"];
const keys = ["schemaVersion", "eventType", "targetType", "stageId", "mapId", "targetId", "relatedEventId", "relatedLegacyOperationLogId", "idempotencyKey", "outcome", "reasonCode", "clientTimestamp", "clientTimeQuality", "before", "after", "beforeQuality", "afterQuality", "details"];
export class InvalidEventError extends Error {}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function numericState(value: unknown) {
  return object(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, item]) => ["positionX", "positionY"].includes(key) && typeof item === "number" && Number.isFinite(item));
}
export function validateEvent(value: unknown): value is EventInput {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || ![1, 2, 3, 5, 6].includes(value.schemaVersion as number)) return false;
  if (typeof value.eventType !== "string" || !Object.hasOwn(eventTargets, value.eventType) || value.targetType !== eventTargets[value.eventType as EventType]) return false;
  if (typeof value.outcome !== "string" || !outcomes.includes(value.outcome) || typeof value.clientTimeQuality !== "string" || !qualities.includes(value.clientTimeQuality)) return false;
  if (value.reasonCode !== undefined && (typeof value.reasonCode !== "string" || !reasons.includes(value.reasonCode))) return false;
  if (["stageId", "mapId", "targetId", "relatedEventId", "relatedLegacyOperationLogId", "idempotencyKey"].some(key => value[key] !== undefined && (typeof value[key] !== "string" || !uuid.test(value[key] as string)))) return false;
  if (value.relatedEventId !== undefined && value.relatedLegacyOperationLogId !== undefined || (value.relatedLegacyOperationLogId !== undefined || value.idempotencyKey !== undefined) && (![2,5].includes(value.schemaVersion as number) || !value.mapId)) return false;
  if (["MAP", "CONCEPT", "LINK"].includes(value.targetType as string) && !value.mapId) return false;
  if (["CONCEPT", "LINK"].includes(value.targetType as string) && !value.targetId && !([2,5].includes(value.schemaVersion as number) && value.outcome !== "SUCCESS")) return false;
  if (["STAGE", "VIDEO", "ASSESSMENT", "FEEDBACK"].includes(value.targetType as string) && !value.stageId && !value.mapId) return false;
  if (value.clientTimeQuality === "OBSERVED" || value.clientTimeQuality === "ESTIMATED") {
    if (typeof value.clientTimestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value.clientTimestamp) || !Number.isFinite(Date.parse(value.clientTimestamp))) return false;
  } else if (value.clientTimestamp !== undefined) return false;
  if (value.eventType === "MOVE_LINK" && value.schemaVersion !== 5) return false;
  if (value.schemaVersion === 1) {
    if (value.before !== undefined && !numericState(value.before) || value.after !== undefined && !numericState(value.after)) return false;
  } else if (value.schemaVersion === 2 ? !validateMapEventV2(value) : value.schemaVersion === 5 ? !validateMapEventV5(value) : value.schemaVersion === 6 ? !validateFeedbackEventV6(value) : !validateAssessmentEventV3(value)) return false;
  for (const field of ["before", "after"] as const) {
    const quality = value[`${field}Quality`] ?? (value[field] === undefined ? "MISSING" : "OBSERVED");
    if (typeof quality !== "string" || !qualities.includes(quality) || (value[field] !== undefined) !== ["OBSERVED", "ESTIMATED"].includes(quality)) return false;
  }
  if (value.schemaVersion !== 6 && value.details !== undefined && (!object(value.details) || !Object.entries(value.details).every(([key, item]) => ["durationMs", "positionSeconds", "fromSeconds", "toSeconds"].includes(key) && typeof item === "number" && Number.isFinite(item) && item >= 0))) return false;
  return true;
}

export async function insertResearchEvent(client: PoolClient, sessionId: string, actor: EventActor, event: EventInput) {
  if (!uuid.test(sessionId) || !["LEARNER", "RESEARCHER", "SYSTEM"].includes(actor) || !validateEvent({ ...event, schemaVersion: event.schemaVersion ?? 1 })) throw new InvalidEventError("Invalid event");
  const session = await client.query<{ participantCode: string; studyGroup: string | null }>(`SELECT participant_code AS "participantCode", study_group AS "studyGroup" FROM sessions WHERE id=$1::uuid AND protocol_key IN ('STAGE1_4','STAGE1_6')`, [sessionId]);
  if (!session.rowCount) return null;
  const participantCode = session.rows[0]!.participantCode;
  if (participantCode === process.env.RESEARCHER_API_TOKEN || (await client.query("SELECT 1 FROM sessions WHERE learner_access_token_hash=$1 LIMIT 1", [tokenHash(participantCode)])).rowCount) return null;
  if (event.schemaVersion === 2 || event.schemaVersion === 5 || event.schemaVersion === 3) {
    const labels = (event.schemaVersion === 2 || event.schemaVersion === 5) ? [event.before, event.after].flatMap(state => state ? mapStateLabels(state) : []) : [event.before?.answer, event.after?.answer].filter((text): text is string => typeof text === "string");
    const researcherToken = process.env.RESEARCHER_API_TOKEN;
    if (researcherToken && labels.some(text => text.includes(researcherToken))) throw new InvalidEventError("Invalid event");
    const hashes = labels.flatMap(text => [text, ...text.split(/\s+/)]).map(tokenHash);
    if (hashes.length && (await client.query("SELECT 1 FROM sessions WHERE learner_access_token_hash = ANY($1::text[]) LIMIT 1", [hashes])).rowCount) throw new InvalidEventError("Invalid event");
  }
  let stageId = event.stageId ?? null;
  if (event.mapId) {
    const map = await client.query<{ stageId: string; mapType: string }>(`SELECT st.id AS "stageId", m.type AS "mapType" FROM maps m JOIN session_stages st ON st.id=m.session_stage_id WHERE m.id=$1::uuid AND st.session_id=$2::uuid`, [event.mapId, sessionId]);
    if (!map.rowCount || (stageId && map.rows[0]!.stageId !== stageId)) return null;
    if ((event.schemaVersion === 2 || event.schemaVersion === 5) && [event.before, event.after].some(state => state && state.mapType !== map.rows[0]!.mapType)) return null;
    stageId = map.rows[0]!.stageId;
  }
  const stage = stageId ? await client.query<{ stageType: string }>(`SELECT stage_type AS "stageType" FROM session_stages WHERE id=$1::uuid AND session_id=$2::uuid`, [stageId, sessionId]) : null;
  if (stage && !stage.rowCount) return null;
  if (event.schemaVersion === 3) {
    if (!stage || !["PRE_ASSESSMENT", "POST_ASSESSMENT"].includes(stage.rows[0]!.stageType)) return null;
    if (event.eventType === "ASSESSMENT_EDIT" && event.outcome === "SUCCESS" && !(await client.query("SELECT 1 FROM assessment_questions WHERE id=$1::uuid AND session_id=$2::uuid", [event.targetId, sessionId])).rowCount) return null;
  }
  if (event.relatedEventId && !(await client.query(`SELECT 1 FROM research_events WHERE event_id=$1::uuid AND session_id=$2::uuid AND ($3::uuid IS NULL OR map_id=$3::uuid)`, [event.relatedEventId, sessionId, (event.schemaVersion === 2 || event.schemaVersion === 5) ? event.mapId ?? null : null])).rowCount) return null;
  if (event.relatedLegacyOperationLogId && !(await client.query(`SELECT 1 FROM map_operation_logs WHERE id=$1::uuid AND map_id=$2::uuid`, [event.relatedLegacyOperationLogId, event.mapId])).rowCount) return null;
  if (event.targetType === "SESSION" && event.targetId && event.targetId !== sessionId || event.targetType === "STAGE" && event.targetId && event.targetId !== stageId || event.targetType === "MAP" && event.targetId && event.targetId !== event.mapId) return null;
  const sequence = await client.query<{ sequence: string }>(`INSERT INTO research_event_counters(session_id,next_sequence) VALUES($1::uuid,2) ON CONFLICT(session_id) DO UPDATE SET next_sequence=research_event_counters.next_sequence+1 RETURNING next_sequence-1 AS sequence`, [sessionId]);
  const inserted = await client.query<{ eventId: string; sequenceNumber: string }>(`INSERT INTO research_events(event_id,schema_version,session_id,stage_id,map_id,participant_code,study_group,activity,actor_type,event_type,target_type,target_id,outcome,reason_code,sequence_number,client_timestamp,client_time_quality,related_event_id,before_state,after_state,before_quality,after_quality,details,related_legacy_operation_log_id,idempotency_key)
    VALUES(gen_random_uuid(),$22,$1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::uuid,$11,$12,$13::bigint,$14::timestamptz,$15,$16::uuid,$17::jsonb,$18::jsonb,$19,$20,$21::jsonb,$23::uuid,$24::uuid) RETURNING event_id AS "eventId", sequence_number AS "sequenceNumber"`,
    [sessionId, stageId, event.mapId ?? null, session.rows[0]!.participantCode, session.rows[0]!.studyGroup, stage?.rows[0]?.stageType ?? null, actor, event.eventType, event.targetType, event.targetId ?? (event.targetType === "SESSION" ? sessionId : event.targetType === "STAGE" ? stageId : event.targetType === "MAP" ? event.mapId : null), event.outcome, event.reasonCode ?? null, sequence.rows[0]!.sequence, event.clientTimestamp ?? null, event.clientTimeQuality, event.relatedEventId ?? null, event.before ? JSON.stringify(event.before) : null, event.after ? JSON.stringify(event.after) : null, event.beforeQuality ?? (event.before ? "OBSERVED" : "MISSING"), event.afterQuality ?? (event.after ? "OBSERVED" : "MISSING"), JSON.stringify(event.details ?? {}), event.schemaVersion ?? 1,event.relatedLegacyOperationLogId ?? null,event.idempotencyKey ?? null]);
  return inserted.rows[0]!;
}

export async function insertResearchEventBestEffort(client: PoolClient, sessionId: string, actor: EventActor, event: EventInput) {
  await client.query("SAVEPOINT research_event_best_effort");
  try {
    const inserted = await insertResearchEvent(client, sessionId, actor, event);
    if (!inserted) {
      await client.query("ROLLBACK TO SAVEPOINT research_event_best_effort");
      await client.query("RELEASE SAVEPOINT research_event_best_effort");
      return { logSaved: false as const };
    }
    await client.query("RELEASE SAVEPOINT research_event_best_effort");
    return { logSaved: true as const, eventId: inserted.eventId, sequenceNumber: inserted.sequenceNumber };
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT research_event_best_effort");
    await client.query("RELEASE SAVEPOINT research_event_best_effort");
    return { logSaved: false as const };
  }
}

const learnerObservedEventTypes = new Set<EventType>([
  "SCREEN_ENTER", "SCREEN_LEAVE", "STAGE_PAUSE", "STAGE_RESUME",
  "VIDEO_PLAY", "VIDEO_PAUSE", "VIDEO_SEEK", "VIDEO_COMPLETE", "FEEDBACK_DISPLAY",
]);

export function registerResearchEventRoutes(app: Express, pool: Pool) {
  app.post("/api/sessions/:sessionId/events", async (req, res) => {
    const sessionId = req.params.sessionId;
    if (!uuid.test(sessionId)) return res.status(404).json({ error: "not_found" });
    if (!validateEvent(req.body)) return res.status(400).json({ error: "invalid_event" });
    const principal = principalOf(res);
    const event = req.body;
    // Full Map snapshots used by the future replay stream must originate from
    // the transaction that changes the Map, never from an HTTP caller.
    if (event.schemaVersion === 2 || event.schemaVersion === 5 || event.schemaVersion === 6) return res.status(403).json({ error: "forbidden" });
    if (event.schemaVersion === 3 || ["ASSESSMENT_EDIT", "ASSESSMENT_SUBMIT"].includes(event.eventType)) return res.status(403).json({ error: "forbidden" });
    if (["STAGE_DEADLINE","SESSION_CREATE","SESSION_SETTINGS_CHANGE","RESEARCH_ANALYSIS_VIEW","RESEARCH_EXPORT","RESEARCH_ASSESSMENT_CHANGE","MAP_AUTO_SUBMIT"].includes(event.eventType)) return res.status(403).json({error:"server_event_only"});
    const deliveryKey=req.header("Idempotency-Key"), stream=req.header("X-Client-Stream-Id"), order=req.header("X-Client-Sequence");
    if(deliveryKey && (!isUuid(deliveryKey)||!isUuid(stream)||!order||!(/^[1-9][0-9]{0,14}$/).test(order)))return res.status(400).json({error:"invalid_delivery"});
    const fingerprint=digest({event,stream,order});
    if(deliveryKey && principal.role==="learner" && principal.sessionId===sessionId){
      try {
        const receipt=(await pool.query("SELECT request_hash,event_id,sequence_number FROM client_event_receipts WHERE session_id=$1 AND event_key=$2",[sessionId,deliveryKey])).rows[0];
        if(receipt)return receipt.request_hash===fingerprint?res.status(201).json({eventId:receipt.event_id,sequenceNumber:receipt.sequence_number,logSaved:true}):res.status(409).json({error:"delivery_conflict"});
      } catch { return res.status(503).json({error:"delivery_receipt_unavailable",logSaved:false}); }
    }
    if (principal.role === "learner") {
      if (principal.sessionId !== sessionId) return res.status(404).json({ error: "not_found" });
      if (!learnerObservedEventTypes.has(event.eventType)) return res.status(403).json({ error: "forbidden" });
      if (!event.stageId || event.before !== undefined || event.after !== undefined || event.relatedEventId !== undefined) {
        return res.status(400).json({ error: "invalid_observed_event" });
      }
      const isFeedback=event.eventType==="FEEDBACK_DISPLAY";
      if(isFeedback&&(!deliveryKey||!event.mapId||event.targetType!=="FEEDBACK"))return res.status(400).json({error:"invalid_observed_event"});
      const isScreen = event.eventType === "SCREEN_ENTER" || event.eventType === "SCREEN_LEAVE";
      const isPauseResume = event.eventType === "STAGE_PAUSE" || event.eventType === "STAGE_RESUME";
      const isVideo = event.eventType.startsWith("VIDEO_");
      if (isPauseResume) {
        if (event.outcome !== "UNKNOWN" || event.reasonCode !== "UNKNOWN" || event.details !== undefined) {
          return res.status(400).json({ error: "invalid_observed_event" });
        }
      } else if (event.outcome !== "SUCCESS" || event.reasonCode !== undefined || event.targetId !== undefined) {
        return res.status(400).json({ error: "invalid_observed_event" });
      }
      if ((isScreen && event.targetType !== "SCREEN") || (isPauseResume && event.targetType !== "STAGE") || (isVideo && event.targetType !== "VIDEO")) {
        return res.status(400).json({ error: "invalid_observed_event" });
      }
      if (isVideo && event.mapId !== undefined) return res.status(400).json({ error: "invalid_observed_event" });
      if (isVideo && event.eventType === "VIDEO_SEEK") {
        if (!event.details || typeof event.details.fromSeconds !== "number" || typeof event.details.toSeconds !== "number" ||
            Object.keys(event.details).some(key => !["fromSeconds", "toSeconds"].includes(key))) {
          return res.status(400).json({ error: "invalid_observed_event" });
        }
      } else if (event.details !== undefined) {
        return res.status(400).json({ error: "invalid_observed_event" });
      }
      try {
        const stage = await pool.query<{ stageType: string; status: string; sessionStatus: string; startedAt: Date | null; currentStageId: string | null }>(
          `SELECT st.stage_type AS "stageType", st.status, st.started_at AS "startedAt", s.status AS "sessionStatus", current_stage.id AS "currentStageId"
           FROM session_stages st JOIN sessions s ON s.id=st.session_id
           LEFT JOIN LATERAL (
             SELECT id FROM session_stages WHERE session_id=s.id AND status <> 'COMPLETED' ORDER BY order_index LIMIT 1
           ) current_stage ON true
           WHERE st.id=$1::uuid AND s.id=$2::uuid AND s.protocol_key IN ('STAGE1_4','STAGE1_6')`,
          [event.stageId, sessionId],
        );
        const row = stage.rows[0];
        if(isFeedback&&(row?.stageType!=="KB_MAP"||!row.startedAt))return res.status(404).json({error:"not_found"});
        if (!row || deliveryKey && !row.startedAt && row.currentStageId !== event.stageId) return res.status(404).json({ error: "not_found" });
        if (isVideo && (row.stageType !== "LESSON" || (deliveryKey ? !row.startedAt : row.status !== "IN_PROGRESS" || row.currentStageId !== event.stageId))) {
          return res.status(404).json({ error: "not_found" });
        }
        if (isPauseResume && (deliveryKey ? !row.startedAt : row.status !== "IN_PROGRESS" || row.currentStageId !== event.stageId)) {
          return res.status(404).json({ error: "not_found" });
        }
        if (!deliveryKey && event.eventType === "SCREEN_ENTER" &&
            (row.currentStageId !== event.stageId || row.status === "COMPLETED" || !["NOT_STARTED", "IN_PROGRESS"].includes(row.sessionStatus))) {
          return res.status(404).json({ error: "not_found" });
        }
        if (event.eventType === "SCREEN_LEAVE" &&
            row.currentStageId !== event.stageId && !(row.status === "COMPLETED" && row.startedAt !== null)) {
          return res.status(404).json({ error: "not_found" });
        }
        if (event.mapId) {
          const map = await pool.query<{ stageType: string; mapType: string; status: string }>(
            `SELECT st.stage_type AS "stageType", m.type AS "mapType", m.status
             FROM maps m JOIN session_stages st ON st.id=m.session_stage_id
             WHERE m.id=$1::uuid AND st.id=$2::uuid AND st.session_id=$3::uuid`,
            [event.mapId, event.stageId, sessionId],
          );
          const mapRow = map.rows[0];
          const expectedType = row.stageType === "PRIOR_MAP" ? "PRIOR" : row.stageType === "KB_MAP" ? "KB" : row.stageType === "INTEGRATION_MAP" ? "INTEGRATION" : null;
          if ((!isScreen&&!isFeedback) || !mapRow || !expectedType || mapRow.mapType !== expectedType ||
              (!deliveryKey && event.eventType === "SCREEN_ENTER" && (mapRow.status !== "DRAFT" || row.status !== "IN_PROGRESS" || row.currentStageId !== event.stageId))) {
            return res.status(404).json({ error: "not_found" });
          }
        }
      } catch {
        return res.status(500).json({ error: "event_authorization_failed", logSaved: false });
      }
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if(deliveryKey){
        if(principal.role!=="learner") {await client.query("ROLLBACK");return res.status(403).json({error:"forbidden"});}
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[sessionId+":"+deliveryKey]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[sessionId+":"+stream]);
        const prior=(await client.query("SELECT request_hash,event_id,sequence_number FROM client_event_receipts WHERE session_id=$1 AND event_key=$2",[sessionId,deliveryKey])).rows[0];
        if(prior){await client.query("COMMIT");return prior.request_hash===fingerprint?res.status(201).json({eventId:prior.event_id,sequenceNumber:prior.sequence_number,logSaved:true}):res.status(409).json({error:"delivery_conflict"});}
        const last=(await client.query("SELECT max(client_sequence) AS n FROM client_event_receipts WHERE session_id=$1 AND client_id=$2",[sessionId,stream])).rows[0].n;
        if(last&&BigInt(order!)<=BigInt(last)){await client.query("ROLLBACK");return res.status(409).json({error:"delivery_order_conflict"});}
      }
      const result = await insertResearchEvent(client, sessionId, principal.role === "learner" ? "LEARNER" : "RESEARCHER", event);
      if(result&&deliveryKey)await client.query("INSERT INTO client_event_receipts(session_id,client_id,event_key,client_sequence,request_hash,event_id,sequence_number) VALUES($1,$2,$3,$4,$5,$6,$7)",[sessionId,stream,deliveryKey,order,fingerprint,result.eventId,result.sequenceNumber]);
      if (!result) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      await client.query("COMMIT");
      return res.status(201).json({ ...result, logSaved: true });
    } catch (error) { await client.query("ROLLBACK"); return error instanceof InvalidEventError ? res.status(400).json({ error: "invalid_event", logSaved: false }) : res.status(500).json({ error: "event_save_failed", logSaved: false }); }
    finally { client.release(); }
  });
  app.get("/api/research/sessions/:sessionId/events", async (req, res) => {
    if (principalOf(res).role !== "researcher" || !uuid.test(req.params.sessionId)) return res.status(404).json({ error: "not_found" });
    const after = typeof req.query.after === "string" ? req.query.after : "0";
    if (!/^(0|[1-9]\d{0,17})$/.test(after)) return res.status(400).json({ error: "invalid_cursor" });
    try {
      if (!(await pool.query("SELECT 1 FROM sessions WHERE id=$1::uuid AND protocol_key IN ('STAGE1_4','STAGE1_6')", [req.params.sessionId])).rowCount) return res.status(404).json({ error: "not_found" });
      const result = await pool.query(`SELECT event_id AS "eventId",schema_version AS "schemaVersion",session_id AS "sessionId",stage_id AS "stageId",map_id AS "mapId",(SELECT pseudonym FROM research_session_ids i WHERE i.session_id=research_events.session_id) AS "participantCode",study_group AS "studyGroup",activity,actor_type AS "actorType",event_type AS "eventType",target_type AS "targetType",target_id AS "targetId",outcome,reason_code AS "reasonCode",sequence_number AS "sequenceNumber",client_timestamp AS "clientTimestamp",client_time_quality AS "clientTimeQuality",server_timestamp AS "serverTimestamp",related_event_id AS "relatedEventId",related_legacy_operation_log_id AS "relatedLegacyOperationLogId",before_state AS "before",after_state AS "after",before_quality AS "beforeQuality",after_quality AS "afterQuality",details FROM research_events WHERE session_id=$1::uuid AND sequence_number>$2::bigint ORDER BY sequence_number LIMIT 200`, [req.params.sessionId, after]);
      return res.json({ events: result.rows });
    } catch { return res.status(500).json({ error: "event_fetch_failed" }); }
  });
}
