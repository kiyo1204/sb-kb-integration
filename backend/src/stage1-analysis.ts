import type { Express } from "express";
import type { Pool, PoolClient } from "pg";
import { buildSessionRawExport, type SessionRawExport } from "./research-export.js";
import { deriveStage1Features } from "./stage1-features.js";
import { replayMapAt, type HistoryOperation, type MapHistorySnapshot } from "./map-history.js";

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

async function sessionExport(pool: Pool, sessionId: string) {
  const client = await pool.connect();
  try {
    const result = await buildSessionRawExport(client, sessionId);
    if (result.kind !== "exported") return result;
    if (result.value.session.protocolKey !== "STAGE1_4") {
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
function csvEscape(value: unknown) {
  const v = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return '"' + v.replaceAll('"','""') + '"';
}
function csv(rows: Array<Record<string, unknown>>, cols: readonly string[]) {
  return [cols.join(","), ...rows.map((row) => cols.map((key) => csvEscape(row[key])).join(","))].join("\r\n") + "\r\n";
}
async function assertSessionCompleted(client: PoolClient, id: string) {
  const check = await client.query<{ protocolKey: string; status: string }>(
    `SELECT protocol_key AS "protocolKey", status FROM sessions WHERE id = $1::uuid`,[id]);
  return check.rows[0]?.protocolKey === "STAGE1_4" && check.rows[0]?.status === "COMPLETED";
}

export function registerStage1AnalysisRoutes(app: Express, pool: Pool) {
  app.get("/api/research/stage1/sessions/:sessionId/analysis", async (req,res) => {
    if (!isUuid(req.params.sessionId)) return res.status(400).json({error:"invalid_session_id"});
    try {
      const result = await sessionExport(pool,req.params.sessionId);
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
                operation_log_id AS "operationLogId", snapshot_side AS "snapshotSide",
                subject_snapshot AS "subjectSnapshot", evaluator_code AS "evaluatorCode",
                category, rationale, created_at AS "createdAt"
         FROM research_proposition_evaluations WHERE session_id=$1::uuid
         ORDER BY created_at, id`,[req.params.sessionId]);
      const notes = await pool.query(
        `SELECT id, session_id AS "sessionId", map_id AS "mapId", operation_log_id AS "operationLogId",
                link_id AS "linkId", reported_by_code AS "reportedByCode", note_text AS "noteText",
                created_at AS "createdAt"
         FROM research_reflection_notes WHERE session_id=$1::uuid ORDER BY created_at,id`,[req.params.sessionId]);
      return res.json({
        session: raw.session, stages: raw.stages,
        features: deriveStage1Features(raw),
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
      console.error("Stage1 analysis failed",error);
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
          completedSession.rows[0]?.protocolKey !== "STAGE1_4" ||
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
             AND session.protocol_key = 'STAGE1_4'
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
        const operations = operationResult.rows;
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
        console.error("Stage1 map history replay failed", error);
        return res.status(500).json({ error: "stage1_map_history_failed" });
      }
    },
  );

  app.get("/api/research/stage1/sessions/:sessionId/operations.csv", async (req,res) => {
    if (!isUuid(req.params.sessionId)) return res.status(400).json({error:"invalid_session_id"});
    try {
      const result=await sessionExport(pool,req.params.sessionId);
      if(result.kind!=="exported") return res.status(result.kind==="not_found"?404:409).json({error:result.kind});
      const operations=flattenOperations(result.value).map(op=>({
        sessionId:req.params.sessionId, participantCode:result.value.session.participantCode,
        ...op,
      }));
      const columns=["sessionId","participantCode","mapId","mapType","researchRole","sessionStageId",
        "id","sequenceNumber","operationType","relatedOperationLogId","targetType","targetId","serverTimestamp",
        "clientTimestamp","elapsedMs","before","after"];
      res.setHeader("Content-Type","text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",`attachment; filename="stage1-${req.params.sessionId}-operations.csv"`);
      return res.send("\uFEFF"+csv(operations,columns));
    } catch(error) {
      console.error("Stage1 CSV export failed",error);
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
                operation_log_id AS "operationLogId", snapshot_side AS "snapshotSide",
                subject_snapshot AS "subjectSnapshot",
                evaluator_code AS "evaluatorCode", category, rationale,
                created_at AS "createdAt"
         FROM research_proposition_evaluations WHERE session_id=$1::uuid
         ORDER BY created_at,id`,[req.params.sessionId]);
      const cols=["id","sessionId","mapId","linkId","operationLogId","snapshotSide",
        "subjectSnapshot","evaluatorCode","category","rationale","createdAt"];
      res.setHeader("Content-Type","text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",`attachment; filename="stage1-${req.params.sessionId}-evaluations.csv"`);
      return res.send("\uFEFF"+csv(rows.rows,cols));
    } catch(error) {
      console.error("Stage1 evaluation CSV failed",error);
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
                operation_log_id AS "operationLogId", link_id AS "linkId",
                reported_by_code AS "reportedByCode",
                note_text AS "noteText", created_at AS "createdAt"
         FROM research_reflection_notes WHERE session_id=$1::uuid ORDER BY created_at,id`,
        [req.params.sessionId]);
      const cols=["id","sessionId","mapId","operationLogId","linkId",
        "reportedByCode","noteText","createdAt"];
      res.setHeader("Content-Type","text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",`attachment; filename="stage1-${req.params.sessionId}-reflections.csv"`);
      return res.send("\uFEFF"+csv(rows.rows,cols));
    } catch(error) {
      console.error("Stage1 reflection CSV failed",error);
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
      console.error("Stage1 feature export failed",error);
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
      (b.snapshotSide!=="CURRENT" && !isUuid(b.operationLogId)))
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
          session_id,map_id,link_id,operation_log_id,snapshot_side,
          subject_snapshot,evaluator_code,category,rationale)
          VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb,$7,$8,$9)
          RETURNING id,category,created_at AS "createdAt"`,
        [id,b.mapId,b.linkId,b.snapshotSide==="CURRENT"?null:b.operationLogId,
          b.snapshotSide,JSON.stringify(snapshot),(b.evaluatorCode as string).trim(),b.category,b.rationale]);
      await client.query("COMMIT");
      return res.status(201).json(result.rows[0]);
    } catch(error) {
      await client.query("ROLLBACK").catch(()=>undefined);
      console.error("Evaluation save failed",error);
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
      const result=await client.query(
        `INSERT INTO research_reflection_notes
           (session_id,map_id,operation_log_id,link_id,reported_by_code,note_text)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6)
         RETURNING id,created_at AS "createdAt"`,
        [id,b.mapId??null,b.operationLogId??null,b.linkId??null,
          (b.reportedByCode as string).trim(),b.noteText]);
      await client.query("COMMIT");
      return res.status(201).json(result.rows[0]);
    } catch(error) {
      await client.query("ROLLBACK").catch(()=>undefined);
      console.error("Reflection save failed",error);
      return res.status(500).json({error:"reflection_save_failed"});
    } finally {client.release();}
  });
}
