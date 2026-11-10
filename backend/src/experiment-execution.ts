import {loadResearchTextSafety,ResearchSafetyError} from "./research-output-safety.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Express, Request, Response, NextFunction } from "express";
import type { Pool, PoolClient } from "pg";
import { principalOf } from "./access-control.js";
import {
  lockCurrentExperimentClient,
  ParticipantAccessError,
  type ExperimentProof,
} from "./experiment-participant-access.js";
import { isUuid } from "./delivery-reliability.js";
// Configuration capability only, never a per-run fictitious readiness flag.
let preview = false;
export const experimentPreviewEnabled = () => preview;
export async function initializeExperimentPreview(pool: Pool) {
  if (process.env.STAGE1_EXPERIMENT_LEARNER_PREVIEW !== "1") return;
  const url = new URL(process.env.DATABASE_URL!);
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.STAGE1_MOCK_DATA !== "ONLY_SYNTHETIC" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/stage1_mock_[a-z0-9_]+$/.test(url.pathname)
  )
    throw new Error("experiment_preview_requires_isolated_mock");
  const r = (
    await pool.query(
      "SELECT purpose,nonce FROM stage1_mock_guard.marker WHERE singleton",
    )
  ).rows[0];
  if (r?.purpose !== "ONLY_SYNTHETIC" || !/^[a-f0-9]{64}$/.test(r.nonce))
    throw new Error("experiment_preview_requires_isolated_mock");
  preview = true;
}
type Context = {
  proof: ExperimentProof;
  secret: string | undefined;
  generation: number;
};
const context = new AsyncLocalStorage<Context>();
export function experimentRequestContext(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const p = principalOf(res);
  if (p.role !== "learner" || !p.experiment) return next();
  return context.run(
    {
      proof: p.experiment,
      secret: req.header("X-Experiment-Client"),
      generation: Number(req.header("X-Experiment-Generation")),
    },
    next,
  );
}
export async function guardExperimentTransaction(c: PoolClient) {
  const x = context.getStore();
  if (!x) return;
  const row = await lockCurrentExperimentClient(
    c,
    x.proof,
    x.secret,
    x.generation,
  );
  if (!preview || row.state !== "RUNNING")
    throw new Error("experiment_not_running");
}
export async function guardExperimentSystemMap(c: PoolClient, mapId: string) {
  const r = (
    await c.query(
      "SELECT s.id FROM maps m JOIN session_stages st ON st.id=m.session_stage_id JOIN sessions s ON s.id=st.session_id WHERE m.id=$1 AND s.protocol_key='SBKB_INTEGRATION_V1'",
      [mapId],
    )
  ).rows[0];
  if (!r) return;
  if (!preview) throw new Error("experiment_unpublished");
  const row = (
    await c.query(
      "SELECT r.state FROM experiment_participant_access a JOIN experiment_run_sessions p ON p.session_id=a.session_id JOIN experiment_runs r ON r.id=p.run_id WHERE a.session_id=$1 FOR UPDATE OF a FOR SHARE OF r",
      [r.id],
    )
  ).rows[0];
  if (row?.state !== "RUNNING") throw new Error("experiment_not_running");
}
export async function validateExperimentRequest(
  pool: Pool,
  req: Request,
  res: Response,
) {
  const p = principalOf(res);
  if (p.role !== "learner" || !p.experiment) return true;
  if (!preview) {
    res.status(409).json({ error: "experiment_learner_flow_unavailable" });
    return false;
  }
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const row = await lockCurrentExperimentClient(
      c,
      p.experiment,
      req.header("X-Experiment-Client"),
      Number(req.header("X-Experiment-Generation")),
    );
    if (row.state !== "RUNNING") throw new ParticipantAccessError("experiment_not_running",409);
    if (
      req.method === "POST" &&
      /^\/sessions\/[^/]+\/events$/.test(req.path) &&
      (req.header("X-Experiment-Origin-Client") !== row.active_client_id ||
        Number(req.header("X-Experiment-Origin-Generation")) !==
          row.device_generation)
    ) {
      await c.query("ROLLBACK");
      res
        .status(409)
        .json({
          error: "experiment_origin_stale",
          message:
            "以前の利用画面の送信待ちは再適用しません。研究者に確認してください。",
        });
      return false;
    }
    await c.query("COMMIT");
    return true;
  } catch(error) {
    await c.query("ROLLBACK").catch(()=>undefined);
    const status=error instanceof ParticipantAccessError ? error.status : 503;
    res.status(status).json({error:error instanceof ParticipantAccessError ? error.code : "experiment_access_unavailable",message:"実施・コード・利用画面を確認できません。時間をおいて研究者に確認してください。"});
    return false;
  } finally {
    c.release();
  }
}
export function registerExperimentExecutionRoutes(app: Express, pool: Pool) {
  app.get("/api/experiment-material", async (_req, res) => {
    const p = principalOf(res);
    if (p.role !== "learner" || !p.experiment || !preview)
      return res.status(404).json({ error: "not_found" });
    try {
      const row = (
        await pool.query(
          `SELECT v.sb_instructions AS "sbInstructions",v.kb_instructions AS "kbInstructions",v.integration_instructions AS "integrationInstructions" FROM experiment_run_sessions p JOIN experiment_runs r ON r.id=p.run_id JOIN experiment_material_versions v ON v.id=r.material_version_id WHERE p.session_id=$1`,
          [p.sessionId],
        )
      ).rows[0];
      return res.json((await loadResearchTextSafety(pool)).redact(row));
    } catch(error) {
      if(error instanceof ResearchSafetyError)return res.status(error.code==="safety_budget_exceeded"?422:503).json({error:error.code,message:"安全確認が完了しません。対象を短くするか時間をおいて研究者へ確認してください。"});
      return res.status(503).json({ error: "material_unavailable" });
    }
  });
  app.post("/api/research/experiment-runs/:runId/start", async (req, res) => {
    if (principalOf(res).role !== "researcher")
      return res.status(403).json({ error: "forbidden" });
    if (!preview)
      return res
        .status(409)
        .json({
          error: "experiment_learner_flow_unavailable",
          message:
            "新フローの通常利用は未公開です。専用模擬環境でのみ検証できます。",
        });
    const id = req.params.runId,
      key = req.header("Idempotency-Key");
    if (!isUuid(id) || !isUuid(key) || Object.keys(req.body ?? {}).length)
      return res.status(400).json({ error: "invalid_start" });
    const c = await pool.connect();
    let status = 200,
      code = "ok";
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "experiment-start:" + key.toLowerCase(),
      ]);
      const previous = (
        await c.query(
          "SELECT run_id,started_at FROM experiment_start_receipts WHERE request_key=$1",
          [key],
        )
      ).rows[0];
      if (previous) {
        if (previous.run_id !== id.toLowerCase()) {
          status = 409;
          code = "request_conflict";
        } else {
          await c.query("COMMIT");
          return res.json({
            id: previous.run_id,
            state: "RUNNING",
            startedAt: previous.started_at,
          });
        }
      }
      const run = (
        await c.query(
          "SELECT r.* FROM experiment_runs r JOIN experiment_run_catalog x ON x.run_id=r.id WHERE r.id=$1 FOR UPDATE OF r",
          [id],
        )
      ).rows[0];
      if (!run) {
        status = 404;
        code = "not_found";
      } else if (run.state !== "PREPARING") {
        status = 409;
        code = "already_running";
      } else if (
        !(
          await c.query(
            "SELECT 1 FROM experiment_run_sessions WHERE run_id=$1 LIMIT 1",
            [id],
          )
        ).rowCount
      ) {
        status = 409;
        code = "participants_required";
      }
      if (status !== 200) {
        await c.query("ROLLBACK");
        await pool.query(
          "INSERT INTO experiment_start_audit(run_id,http_status,outcome,reason_code) VALUES($1,$2,'REJECTED',$3)",
          [id, status, code],
        );
        return res
          .status(status)
          .json({
            error: code,
            message: "実施状態と参加者登録を確認してください。",
          });
      }
      const result = (
        await c.query(
          "UPDATE experiment_runs SET state='RUNNING',started_at=clock_timestamp() WHERE id=$1 RETURNING id,state,started_at AS \"startedAt\"",
          [id],
        )
      ).rows[0];
      await c.query("INSERT INTO experiment_start_receipts VALUES($1,$2,$3)", [
        key,
        id,
        result.startedAt,
      ]);
      await c.query(
        "INSERT INTO experiment_start_audit(run_id,http_status,outcome,reason_code) VALUES($1,200,'SUCCESS','ok')",
        [id],
      );
      await c.query("COMMIT");
      return res.json(result);
    } catch {
      await c.query("ROLLBACK").catch(() => undefined);
      await pool
        .query(
          "INSERT INTO experiment_start_audit(run_id,http_status,outcome,reason_code) VALUES($1,503,'FAILURE','start_unavailable')",
          [id],
        )
        .catch(() => undefined);
      return res
        .status(503)
        .json({
          error: "start_unavailable",
          message: "開始状態を確認できません。同じ要求で再試行してください。",
        });
    } finally {
      c.release();
    }
  });
}
