import {csvCell} from "./csv.js";
import { safeServerErrorCode } from "./safe-server-error.js";
import { auditCurrent, auditCommitted } from "./server-audit.js";
import type { Express } from "express";
import type { Pool, PoolClient } from "pg";
import { buildSessionRawExport, type SessionRawExport } from "./research-export.js";
import { deriveStage1Features } from "./stage1-features.js";
import { replayMapAt, type HistoryOperation, type MapHistorySnapshot } from "./map-history.js";
import { replayMixedMapHistory, type MapHistoryEventV2 } from "./map-mixed-history.js";
import { principalOf } from "./access-control.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const nonempty = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= limit;

type RawMap = Record<string, unknown> & {
  id: string;
  type: string;
  researchRole?: string;
  concepts: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
  operationLogs: Array<Record<string, unknown>>;
};

async function sessionExport(pool: Pool, sessionId: string, includeSix = false) {
  const client = await pool.connect();
  try {
    const result = await buildSessionRawExport(client, sessionId);
    if (result.kind !== "exported") return result;
    if (result.value.session.protocolKey !== "STAGE1_4" && !includeSix) {
      return { kind: "wrong_protocol" as const };
    }
    return result;
  } finally {
    client.release();
  }
}

function mapsOf(raw: SessionRawExport): RawMap[] {
  return raw.maps as RawMap[];
}
function flattenOperations(raw: SessionRawExport) {
  const stages = raw.stages as Array<Record<string, unknown>>;
  const stageById = new Map(stages.map((s) => [String(s.id), s]));
  return mapsOf(raw).flatMap((m) => {
    const stage = stageById.get(String(m.sessionStageId));
    return (m.operationLogs || []).map((operation) => {
      const time = Date.parse(String(operation.serverTimestamp ?? ""));
      const start = Date.parse(String(stage?.startedAt ?? ""));
      return {
        ...operation,
        operationType: String(operation.operationType),
        mapId: String(operation.mapId),
        mapType: m.type,
        researchRole: m.researchRole ?? null,
        sessionStageId: stage?.id ?? null,
        elapsedMs: Number.isFinite(time) && Number.isFinite(start) ? Math.max(0, time - start) : null,
      };
    });
  });
}
function csv(rows: Array<Record<string, unknown>>, cols: readonly string[]) {
  return [cols.join(","), ...rows.map((row) => cols.map((key) => csvCell(row[key])).join(","))].join("\r\n") + "\r\n";
}
async function assertSessionCompleted(client: PoolClient, id: string) {
  const check = await client.query<{ protocolKey: string; status: string }>(
    `SELECT protocol_key AS "protocolKey", status FROM sessions WHERE id = $1::uuid`,[id]);
  return check.rows[0]?.protocolKey === "STAGE1_4" && check.rows[0]?.status === "COMPLETED";
}

export function registerStage1AnalysisRoutes(app: Express, pool: Pool) {
  app.get("/api/research/stage1/sessions", async (_req, res) => {
    if (principalOf(res).role !== "researcher") return res.status(403).json({ error: "forbidden" });
    try {
      const result = await pool.query(`SELECT s.id, (SELECT pseudonym FROM research_session_ids WHERE session_id=s.id) AS "participantCode", (SELECT pseudonym FROM research_session_ids WHERE session_id=s.id) AS pseudonym, s.study_group AS "studyGroup",
        s.status, s.protocol_key AS "protocolKey", s.started_at AS "startedAt", s.completed_at AS "completedAt",
        current_stage.stage_type AS "currentStageType", current_stage.order_index AS "currentStageOrder"
        FROM sessions s LEFT JOIN LATERAL (SELECT stage_type, order_index FROM session_stages
          WHERE session_id=s.id AND status <> 'COMPLETED' ORDER BY order_index LIMIT 1) current_stage ON s.status='IN_PROGRESS'
        WHERE s.protocol_key IN ('STAGE1_4','STAGE1_6') ORDER BY s.created_at DESC, s.id DESC`);
      return res.json({ sessions: result.rows });
    } catch (error) {
      console.error("Stage1 session list failed", safeServerErrorCode(error));
      return res.status(500).json({ error: "session_list_failed" });
    }
  });
  app.get("/api/research/stage1/sessions/:sessionId/analysis", async (req,res) => {
    if (!isUuid(req.params.sessionId)) return res.status(400).json({error:"invalid_session_id"});
    try {
      const result = await sessionExport(pool,req.params.sessionId,true);
      if (result.kind !== "exported") return res.status(result.kind === "not_found" ? 404 : 409).json({error:result.kind});
      const raw = result.value;
      const operations = flattenOperations(raw);
      const analysisMaps = mapsOf(raw).map((map) => ({
        ...map,
        historyReplayStatus:
          map.type === "GOAL"
            ? "EXCLUDED"
            : map.initialSnapshot && map.historySnapshotVersion === 1
              ? "AVAILABLE"
              : "UNAVAILABLE",
      }));
      const counts: Record<string,number> = {};
      for (const op of operations) {
        const key = String(op.operationType);
        counts[key] = (counts[key] || 0) + 1;
      }
      const evals = await pool.query(
        `SELECT id, session_id AS "sessionId", map_id AS "mapId", link_id AS "linkId",
                operation_log_id AS "operationLogId", event_id AS "eventId", snapshot_side AS "snapshotSide",
                subject_snapshot AS "subjectSnapshot", evaluator_code AS "evaluatorCode",
                category, rationale, created_at AS "createdAt"
         FROM research_proposition_evaluations WHERE session_id=$1::uuid
         ORDER BY created_at, id`,[req.params.sessionId]);
      const notes = await pool.query(
        `SELECT id, session_id AS "sessionId", map_id AS "mapId", operation_log_id AS "operationLogId", event_id AS "eventId",
                link_id AS "linkId", reported_by_code AS "reportedByCode", note_text AS "noteText",
                created_at AS "createdAt"
         FROM research_reflection_notes WHERE session_id=$1::uuid ORDER BY created_at,id`,[req.params.sessionId]);
      return res.json({
        session: raw.session, stages: raw.stages,
        features: raw.session.protocolKey === "STAGE1_4" ? deriveStage1Features(raw) : {},
        maps: analysisMaps,
        operations, operationCounts: counts,
        propositionEvaluations: evals.rows,
        reflectionNotes: notes.rows,
        limitations: [
          "Counts indicate operations, not learning quality.",
          "Kit usage in other non-import events requires provenance-specific analysis.",
          "Prior/lesson origin reflects observed map stages, not genuine pre-lesson knowledge.",
          "Maps without a supported initial snapshot cannot be replayed; sequence gaps or incomplete events produce partial replay.",
        ],
      });
    } catch(error) {
      console.error("Stage1 analysis failed", safeServerErrorCode(error));
      return res.status(500).json({error:"stage1_analysis_failed"});
    }
  });

  app.get(
    "/api/research/stage1/sessions/:sessionId/maps/:mapId/history",
    async (req, res) => {
      const { sessionId, mapId } = req.params;
      if (!isUuid(sessionId) || !isUuid(mapId)) {
        return res.status(400).json({ error: "invalid_history_resource_id" });
      }
      const sequenceText = req.query.sequenceNumber;
      if (typeof sequenceText !== "string" || !/^(0|[1-9][0-9]*)$/.test(sequenceText)) {
        return res.status(400).json({ error: "invalid_sequence_number" });
      }
      const sequenceNumber = Number(sequenceText);
      if (!Number.isSafeInteger(sequenceNumber)) {
        return res.status(400).json({ error: "invalid_sequence_number" });
      }
      try {
        const completedSession = await pool.query<{ protocolKey: string; status: string }>(
          `SELECT protocol_key AS "protocolKey", status
           FROM sessions WHERE id = $1::uuid`,
          [sessionId],
        );
        if (
          !["STAGE1_4", "STAGE1_6"].includes(completedSession.rows[0]?.protocolKey ?? "") ||
          completedSession.rows[0]?.status !== "COMPLETED"
        ) {
          return res.status(409).json({ error: "session_not_completed" });
        }
        const mapResult = await pool.query<{ id: string; type: string }>(
          `SELECT map.id, map.type
           FROM maps AS map
           INNER JOIN session_stages AS stage ON stage.id = map.session_stage_id
           INNER JOIN sessions AS session ON session.id = stage.session_id
           WHERE map.id = $1::uuid AND stage.session_id = $2::uuid
             AND session.protocol_key IN ('STAGE1_4','STAGE1_6')
             AND map.type IN ('PRIOR', 'KB', 'INTEGRATION')`,
          [mapId, sessionId],
        );
        const map = mapResult.rows[0];
        if (!map) return res.status(404).json({ error: "map_not_found" });

        const historyResult = await pool.query<{
          snapshotVersion: number;
          snapshot: MapHistorySnapshot;
          capturedAt: Date;
        }>(
          `SELECT snapshot_version AS "snapshotVersion", snapshot,
                  captured_at AS "capturedAt"
           FROM map_initial_snapshots WHERE map_id = $1::uuid`,
          [mapId],
        );
        const operationResult = await pool.query<
          HistoryOperation & {
            clientTimestamp: Date | null;
            serverTimestamp: Date;
          }
        >(
          `SELECT id, map_id AS "mapId", sequence_number AS "sequenceNumber",
                  operation_type AS "operationType", target_type AS "targetType",
                  target_id AS "targetId", before, after,
                  related_operation_log_id AS "relatedOperationLogId",
                  client_timestamp AS "clientTimestamp",
                  server_timestamp AS "serverTimestamp"
           FROM map_operation_logs WHERE map_id = $1::uuid
           ORDER BY sequence_number, id`,
          [mapId],
        );
        const newResult=await pool.query<MapHistoryEventV2 & {targetType:string;targetId:string;clientTimestamp:Date|null;serverTimestamp:Date}>(
          `SELECT event_id AS "eventId",map_id AS "mapId",schema_version AS "schemaVersion",
            event_type AS "eventType",target_type AS "targetType",target_id AS "targetId",related_event_id AS "relatedEventId",
            related_legacy_operation_log_id AS "relatedLegacyOperationLogId",
            sequence_number AS "sequenceNumber",outcome,before_state AS before,after_state AS after,
            client_timestamp AS "clientTimestamp",server_timestamp AS "serverTimestamp"
           FROM research_events WHERE session_id=$1::uuid AND map_id=$2::uuid AND schema_version IN (2,5)
           ORDER BY sequence_number`,[sessionId,mapId]);
        const operations:HistoryOperation[]=[...operationResult.rows,...newResult.rows.map((event,index)=>({
          id:event.eventId,mapId,sequenceNumber:String(operationResult.rows.length+index+1),
          operationType:event.eventType,targetType:event.targetType,targetId:event.targetId,
          before:event.before,after:event.after,historyFormat:(event.schemaVersion===5?"V5":"V2") as "V2"|"V5",
          outcome:event.outcome,
          relatedOperationLogId:event.relatedEventId??event.relatedLegacyOperationLogId,
        }))];
        if (sequenceNumber > operations.length) {
          return res.status(400).json({ error: "sequence_number_out_of_range" });
        }
        const operation = sequenceNumber === 0 ? null : operations[sequenceNumber - 1];
        const history = historyResult.rows[0];
        if (!history) {
          return res.json({
            status: "UNAVAILABLE",
            reason: "編集開始前の初期スナップショットがありません。過去状態を推測して復元しません。",
            mapId,
            mapType: map.type,
            sequenceNumber,
            operation,
            beforeState: null,
            afterState: null,
          });
        }
        if (history.snapshotVersion !== 1 || history.snapshot.snapshotVersion !== 1) {
          return res.json({
            status: "UNAVAILABLE",
            reason: `未対応の初期スナップショット形式です (DB version ${history.snapshotVersion})。`,
            mapId,
            mapType: map.type,
            sequenceNumber,
            operation,
            beforeState: null,
            afterState: null,
          });
        }
        if (newResult.rows.length) {
          const boundary=await pool.query<{legacyCount:string;legacyLastId:string|null;snapshot:MapHistorySnapshot}>(
            `SELECT legacy_count AS "legacyCount",legacy_last_id AS "legacyLastId",boundary_snapshot AS snapshot
             FROM map_history_boundaries WHERE map_id=$1::uuid`,[mapId]);
          const item=boundary.rows[0];
          if(!item) return res.json({status:"PARTIAL",reason:"旧・新履歴の切替境界がありません。",mapId,mapType:map.type,sequenceNumber,operation,beforeState:null,afterState:null});
          const checked=replayMixedMapHistory(history.snapshot,{legacyCount:Number(item.legacyCount),legacyLastId:item.legacyLastId},operationResult.rows,newResult.rows);
          if(checked.status!=="REPLAYABLE") return res.json({status:"PARTIAL",reason:checked.reason,mapId,mapType:map.type,sequenceNumber,operation,beforeState:null,afterState:null});
        }
        const before = replayMapAt(
          history.snapshot,
          operations,
          sequenceNumber === 0 ? 0 : sequenceNumber - 1,
        );
        const after = replayMapAt(history.snapshot, operations, sequenceNumber);
        if (before.status !== "REPLAYABLE" || after.status !== "REPLAYABLE") {
          return res.json({
            status: "PARTIAL",
            reason:
              before.status === "PARTIAL"
                ? before.reason
                : after.status === "PARTIAL"
                  ? after.reason
                  : "操作列を完全に適用できません。",
            mapId,
            mapType: map.type,
            sequenceNumber,
            operation,
            beforeState: null,
            afterState: null,
          });
        }
        return res.json({
          status: "REPLAYABLE",
          reason: null,
          mapId,
          mapType: map.type,
          sequenceNumber,
          operation,
          beforeState: before.state,
          afterState: after.state,
        });
      } catch (error) {
        console.error("Stage1 map history replay failed", safeServerErrorCode(error));
        return res.status(500).json({ error: "stage1_map_history_failed" });
      }
    },
  );

  app.get("/api/research/stage1/sessions/:sessionId/operations.csv", async (req,res) => {
    if (!isUuid(req.params.sessionId)) return res.status(400).json({error:"invalid_session_id"});
    try {
      const result=await sessionExport(pool,req.params.sessionId,true);
      if(result.kind!=="exported") return res.status(result.kind==="not_found"?404:409).json({error:result.kind});
      const operations=flattenOperations(result.value).map(op=>({
        sessionId:req.params.sessionId, participantCode:result.value.session.participantCode,
        ...op,
      }));
      const columns=["sessionId","participantCode","mapId","mapType","researchRole","sessionStageId",
        "id","sequenceNumber","operationType","relatedOperationLogId","targetType","targetId","serverTimestamp",
        "clientTimestamp","elapsedMs","before","after","historySource","eventId","schemaVersion","eventType","actorType","outcome","eventSequenceNumber","relatedEventId","relatedLegacyOperationLogId"];
      res.setHeader("Content-Type","text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",`attachment; filename="stage1-${req.params.sessionId}-operations.csv"`);
      return res.send("\uFEFF"+csv(operations,columns));
    } catch(error) {
      console.error("Stage1 CSV export failed", safeServerErrorCode(error));
      return res.status(500).json({error:"stage1_csv_failed"});
    }
  });

  app.get("/api/research/stage1/sessions/:sessionId/evaluations.csv",async(req,res)=>{
    if(!isUuid(req.params.sessionId)) return res.status(400).json({error:"invalid_session_id"});
    try {
      const snapshot=await sessionExport(pool,req.params.sessionId);
      if(snapshot.kind!=="exported") return res.status(snapshot.kind==="not_found"?404:409).json({error:snapshot.kind});
      const rows=await pool.query<Record<string,unknown>>(
        `SELECT id, session_id AS "sessionId", map_id AS "mapId", link_id AS "linkId",
                operation_log_id AS "operationLogId", event_id AS "eventId", snapshot_side AS "snapshotSide",
                subject_snapshot AS "subjectSnapshot",
                evaluator_code AS "evaluatorCode", category, rationale,
                created_at AS "createdAt"
         FROM research_proposition_evaluations WHERE session_id=$1::uuid
         ORDER BY created_at,id`,[req.params.sessionId]);
      const cols=["id","sessionId","mapId","linkId","operationLogId","snapshotSide",
        "subjectSnapshot","evaluatorCode","category","rationale","createdAt","eventId"];
      res.setHeader("Content-Type","text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",`attachment; filename="stage1-${req.params.sessionId}-evaluations.csv"`);
      return res.send("\uFEFF"+csv(rows.rows,cols));
    } catch(error) {
      console.error("Stage1 evaluation CSV failed", safeServerErrorCode(error));
      return res.status(500).json({error:"stage1_evaluations_csv_failed"});
    }
  });

  app.get("/api/research/stage1/sessions/:sessionId/reflections.csv",async(req,res)=>{
    if(!isUuid(req.params.sessionId)) return res.status(400).json({error:"invalid_session_id"});
    try {
      const snapshot=await sessionExport(pool,req.params.sessionId);
      if(snapshot.kind!=="exported") return res.status(snapshot.kind==="not_found"?404:409).json({error:snapshot.kind});
      const rows=await pool.query<Record<string,unknown>>(
        `SELECT id, session_id AS "sessionId", map_id AS "mapId",
                operation_log_id AS "operationLogId", event_id AS "eventId", link_id AS "linkId",
                reported_by_code AS "reportedByCode",
                note_text AS "noteText", created_at AS "createdAt"
         FROM research_reflection_notes WHERE session_id=$1::uuid ORDER BY created_at,id`,
        [req.params.sessionId]);
      const cols=["id","sessionId","mapId","operationLogId","linkId",
        "reportedByCode","noteText","createdAt","eventId"];
      res.setHeader("Content-Type","text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",`attachment; filename="stage1-${req.params.sessionId}-reflections.csv"`);
      return res.send("\uFEFF"+csv(rows.rows,cols));
    } catch(error) {
      console.error("Stage1 reflection CSV failed", safeServerErrorCode(error));
      return res.status(500).json({error:"stage1_reflections_csv_failed"});
    }
  });


  app.get("/api/research/stage1/sessions/:sessionId/features.csv", async(req,res) => {
    if(!isUuid(req.params.sessionId))return res.status(400).json({error:"invalid_session_id"});
    try{
      const result=await sessionExport(pool,req.params.sessionId);
      if(result.kind!=="exported")return res.status(result.kind==="not_found"?404:409).json({error:result.kind});
      const features=deriveStage1Features(result.value);
      const row: Record<string,unknown>={sessionId:req.params.sessionId,
        participantCode:result.value.session.participantCode,...features};
      res.setHeader("Content-Type","text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",`attachment; filename="stage1-${req.params.sessionId}-features.csv"`);
      return res.send("\uFEFF"+csv([row],Object.keys(row)));
    }catch(error){
      console.error("Stage1 feature export failed", safeServerErrorCode(error));
      return res.status(500).json({error:"stage1_features_csv_failed"});
    }
  });

  app.post("/api/research/stage1/sessions/:sessionId/evaluations", async(req,res)=>{
    const id=req.params.sessionId;
    const body: unknown = req.body;
    if(!isUuid(id)||!body||typeof body!=="object"||Array.isArray(body)) return res.status(400).json({error:"invalid_request"});
    const b=body as Record<string,unknown>;
    if(!isUuid(b.mapId)||!isUuid(b.linkId)||
      !nonempty(b.evaluatorCode,64)||!nonempty(b.rationale,5000)||
      !["U","I","P","V"].includes(String(b.category))||
      !["CURRENT","BEFORE","AFTER"].includes(String(b.snapshotSide))||
      (b.operationLogId != null && b.eventId != null) ||
      (b.snapshotSide!=="CURRENT" && !isUuid(b.operationLogId) && !isUuid(b.eventId)) ||
      (b.snapshotSide==="CURRENT" && (b.operationLogId != null || b.eventId != null)))
      return res.status(400).json({error:"invalid_evaluation"});
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      if(!await assertSessionCompleted(client,id)) {await client.query("ROLLBACK");return res.status(409).json({error:"session_not_completed"});}
      const belongs=await client.query(
        `SELECT 1 FROM maps m JOIN session_stages ss ON ss.id=m.session_stage_id
         WHERE m.id=$1::uuid AND ss.session_id=$2::uuid AND m.status='SUBMITTED'`,[b.mapId,id]);
      if(!belongs.rowCount) {await client.query("ROLLBACK");return res.status(404).json({error:"map_not_found"});}
      let snapshot:Record<string,unknown>|null=null;
      if(b.snapshotSide==="CURRENT") {
        const current=await client.query(
          `SELECT link.id, link.map_id AS "mapId",
                  link.source_concept_id AS "sourceConceptId",
                  link.target_concept_id AS "targetConceptId", link.label,
                  source.label AS "sourceLabel", target.label AS "targetLabel"
           FROM links link
           JOIN concepts source ON source.id=link.source_concept_id
           JOIN concepts target ON target.id=link.target_concept_id
           WHERE link.id=$1::uuid AND link.map_id=$2::uuid`,[b.linkId,b.mapId]);
        snapshot=current.rows[0]??null;
      } else if (isUuid(b.eventId)) {
        const events=await client.query<{state:MapHistorySnapshot}>(
          `SELECT ${b.snapshotSide==="BEFORE" ? "before_state" : "after_state"} AS state
           FROM research_events WHERE event_id=$1::uuid AND session_id=$2::uuid AND map_id=$3::uuid
             AND schema_version IN (2,5) AND outcome='SUCCESS'`,[b.eventId,id,b.mapId]);
        if(!events.rowCount) {await client.query("ROLLBACK");return res.status(404).json({error:"operation_not_found"});}
        const state=events.rows[0]?.state;
        const item=state?.links.find(link=>link.id===b.linkId);
        if(item) snapshot=item as unknown as Record<string,unknown>;
      } else {
        const logs=await client.query<{before:unknown;after:unknown;targetType:string;targetId:string}>(
          `SELECT before,after,target_type AS "targetType",target_id AS "targetId"
           FROM map_operation_logs WHERE id=$1::uuid AND map_id=$2::uuid`,
          [b.operationLogId,b.mapId]);
        const data=b.snapshotSide==="BEFORE"?logs.rows[0]?.before:logs.rows[0]?.after;
        const log=logs.rows[0];
        if(data&&typeof data==="object"&&!Array.isArray(data)) {
          const record=data as Record<string,unknown>;
          if(log?.targetType==="LINK" && log.targetId===b.linkId && record.id===b.linkId) {
            snapshot=record;
          } else if(log?.targetType==="CONCEPT" && Array.isArray(record.incidentLinks)) {
            const link=record.incidentLinks.find((item:unknown)=>
              item!==null && typeof item==="object" && !Array.isArray(item) &&
              (item as Record<string,unknown>).id===b.linkId);
            if(link) snapshot=link as Record<string,unknown>;
          }
        }
      }
      if(!snapshot) {await client.query("ROLLBACK");return res.status(422).json({error:"proposition_snapshot_missing"});}
      const result=await client.query(
        `INSERT INTO research_proposition_evaluations (
          session_id,map_id,link_id,operation_log_id,event_id,snapshot_side,
          subject_snapshot,evaluator_code,category,rationale)
          VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::jsonb,$8,$9,$10)
          RETURNING id,category,created_at AS "createdAt"`,
        [id,b.mapId,b.linkId,b.snapshotSide==="CURRENT"?null:b.operationLogId,
          b.snapshotSide==="CURRENT"?null:b.eventId??null,
          b.snapshotSide,JSON.stringify(snapshot),(b.evaluatorCode as string).trim(),b.category,b.rationale]);
      await auditCurrent(client, { targetId: result.rows[0]!.id });
      await client.query("COMMIT");
      auditCommitted();
      return res.status(201).json(result.rows[0]);
    } catch {
      await client.query("ROLLBACK").catch(()=>undefined);
      console.error("evaluation_save_failed");
      return res.status(500).json({error:"evaluation_save_failed"});
    } finally {client.release();}
  });

  app.post("/api/research/stage1/sessions/:sessionId/reflections",async(req,res)=>{
    const id=req.params.sessionId;
    const body: unknown=req.body;
    if(!isUuid(id)||!body||typeof body!=="object"||Array.isArray(body)) return res.status(400).json({error:"invalid_request"});
    const b=body as Record<string,unknown>;
    if(!nonempty(b.reportedByCode,64)||!nonempty(b.noteText,10000)||
      (b.mapId!=null&&!isUuid(b.mapId))||
      (b.operationLogId!=null&&!isUuid(b.operationLogId))||
      (b.eventId!=null&&!isUuid(b.eventId))||
      (b.operationLogId!=null&&b.eventId!=null)||
      (b.eventId!=null&&b.mapId==null)||
      (b.linkId!=null&&!isUuid(b.linkId)))
      return res.status(400).json({error:"invalid_reflection"});
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      if(!await assertSessionCompleted(client,id)) {await client.query("ROLLBACK");return res.status(409).json({error:"session_not_completed"});}
      if(b.mapId!=null) {
        const map=await client.query(
          `SELECT 1 FROM maps m JOIN session_stages ss ON ss.id=m.session_stage_id
           WHERE m.id=$1::uuid AND ss.session_id=$2::uuid`,[b.mapId,id]);
        if(!map.rowCount) {await client.query("ROLLBACK");return res.status(404).json({error:"map_not_found"});}
      }
      if(b.operationLogId!=null) {
        const log=await client.query(
          `SELECT 1 FROM map_operation_logs op JOIN maps m ON m.id=op.map_id
           JOIN session_stages ss ON ss.id=m.session_stage_id
           WHERE op.id=$1::uuid AND ss.session_id=$2::uuid
             AND ($3::uuid IS NULL OR op.map_id=$3::uuid)`,
          [b.operationLogId,id,b.mapId??null]);
        if(!log.rowCount) {await client.query("ROLLBACK");return res.status(404).json({error:"operation_not_found"});}
      }
      if(b.eventId!=null) {
        const event=await client.query(`SELECT 1 FROM research_events
          WHERE event_id=$1::uuid AND session_id=$2::uuid AND schema_version IN (2,5)
            AND ($3::uuid IS NULL OR map_id=$3::uuid)`,[b.eventId,id,b.mapId??null]);
        if(!event.rowCount) {await client.query("ROLLBACK");return res.status(404).json({error:"operation_not_found"});}
      }
      const result=await client.query(
        `INSERT INTO research_reflection_notes
           (session_id,map_id,operation_log_id,event_id,link_id,reported_by_code,note_text)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7)
         RETURNING id,created_at AS "createdAt"`,
        [id,b.mapId??null,b.operationLogId??null,b.eventId??null,b.linkId??null,
          (b.reportedByCode as string).trim(),b.noteText]);
      await auditCurrent(client, { targetId: result.rows[0]!.id });
      await client.query("COMMIT");
      auditCommitted();
      return res.status(201).json(result.rows[0]);
    } catch {
      await client.query("ROLLBACK").catch(()=>undefined);
      console.error("reflection_save_failed");
      return res.status(500).json({error:"reflection_save_failed"});
    } finally {client.release();}
  });
}
