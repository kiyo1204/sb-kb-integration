import { experimentPreviewEnabled } from "./experiment-execution.js";
import { principalOf } from "./access-control.js";
import type { RequestHandler } from "express";
import type { Pool } from "pg";
import { EXPERIMENT_PROTOCOL } from "./experiment-foundation.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Storage-only resources must never enter legacy public execution handlers. */
export function experimentStorageGuard(pool: Pool): RequestHandler {
  return async (req, res, next) => {
    try {
      const parts = req.path.split("/").filter(Boolean);
      const token = /^\/research\/stage1\/sessions\/([^/]+)/.exec(req.path);
      let kind = parts[0],
        id = parts[1];
      if (token) {
        kind = "sessions";
        id = token[1];
      }
      const lookups: Record<string, string> = {
        sessions:
          "SELECT id AS session_id,NULL::uuid AS map_id FROM sessions WHERE id=$1",
        "session-stages":
          "SELECT session_id,NULL::uuid AS map_id FROM session_stages WHERE id=$1",
        maps: "SELECT st.session_id,m.id AS map_id FROM maps m LEFT JOIN session_stages st ON st.id=m.session_stage_id WHERE m.id=$1",
        concepts:
          "SELECT st.session_id,m.id AS map_id FROM concepts x JOIN maps m ON m.id=x.map_id LEFT JOIN session_stages st ON st.id=m.session_stage_id WHERE x.id=$1",
        links:
          "SELECT st.session_id,m.id AS map_id FROM links x JOIN maps m ON m.id=x.map_id LEFT JOIN session_stages st ON st.id=m.session_stage_id WHERE x.id=$1",
      };
      if(uuid.test(req.body?.sessionStageId ?? "")) {
        const bodyOwner=(await pool.query("SELECT session_id FROM session_stages WHERE id=$1",[req.body.sessionStageId])).rows[0];
        if(bodyOwner && (await pool.query("SELECT 1 FROM sessions WHERE id=$1 AND protocol_key=$2",[bodyOwner.session_id,EXPERIMENT_PROTOCOL])).rowCount){
          const actor=principalOf(res);
          if(!experimentPreviewEnabled()||actor.role!=="learner"||!actor.experiment||actor.sessionId!==bodyOwner.session_id)return res.status(409).json({error:"experiment_storage_only"});
        }
      }
      if (uuid.test(id ?? "") && lookups[kind]) {
        const row = (await pool.query(lookups[kind], [id])).rows[0];
        if (
          row?.session_id &&
          (
            await pool.query(
              "SELECT 1 FROM sessions WHERE id=$1 AND protocol_key=$2",
              [row.session_id, EXPERIMENT_PROTOCOL],
            )
          ).rowCount
        ) {
          const actor=principalOf(res);
          // Read-only researcher analysis is independent of learner publication.
          // Each whitelisted handler validates real Session/Map ownership again.
          if(actor.role==="researcher" && req.method==="GET" && /^\/research\/stage1\/sessions\/[0-9a-f-]{36}\/(analysis|operations\.csv|map-states\.csv|maps\/[0-9a-f-]{36}\/history)$/.test(req.path))return next();
          if(experimentPreviewEnabled() && actor.role==="learner" && actor.experiment && actor.sessionId===row.session_id && !token) return next();
          return res
            .status(409)
            .json({
              error: "experiment_storage_only",
              message:
                "新実験の保存基盤のみ利用可能です。開始・編集・提出・コード発行はまだ公開されていません。",
            });
        }
        if (
          row?.map_id &&
          !["GET", "HEAD"].includes(req.method) &&
          (
            await pool.query(
              "SELECT experiment_asset_is_frozen($1) AS frozen",
              [row.map_id],
            )
          ).rows[0]?.frozen
        )
          return res
            .status(409)
            .json({
              error: "experiment_asset_frozen",
              message:
                "完成教材版の資材は変更できません。変更には新しい教材版と資材を使用してください。",
            });
      }
      if (
        req.path.startsWith("/research/data-management") &&
        req.method !== "GET"
      ) {
        const { sessionId, pseudonym } = req.body ?? {};
        if (
          (typeof sessionId === "string" && uuid.test(sessionId)) ||
          typeof pseudonym === "string"
        ) {
          const x = await pool.query(
            `SELECT 1 FROM sessions s JOIN research_session_ids i ON i.session_id=s.id WHERE s.protocol_key=$1 AND (s.id=$2::uuid OR i.pseudonym=$3) LIMIT 1`,
            [
              EXPERIMENT_PROTOCOL,
              typeof sessionId === "string" && uuid.test(sessionId)
                ? sessionId
                : null,
              typeof pseudonym === "string" ? pseudonym : null,
            ],
          );
          if (x.rowCount)
            return res
              .status(409)
              .json({
                error: "experiment_storage_only",
                message:
                  "新実験の参加データは、この管理操作では変更・削除できません。",
              });
        }
      }
      return next();
    } catch {
      return res
        .status(503)
        .json({
          error: "experiment_guard_unavailable",
          message:
            "保存基盤の確認に失敗しました。操作は実行していません。再試行してください。",
        });
    }
  };
}
