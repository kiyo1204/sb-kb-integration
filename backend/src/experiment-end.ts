import type { Express } from "express";
import type { Pool, PoolClient } from "pg";
import { principalOf } from "./access-control.js";
import { isUuid } from "./delivery-reliability.js";
export function registerExperimentEndRoutes(app: Express, pool: Pool) {
  app.post("/api/research/experiment-runs/:runId/end", async (req, res) => {
    if (principalOf(res).role !== "researcher")
      return res.status(403).json({ error: "forbidden" });
    const id = req.params.runId,
      key = req.header("Idempotency-Key");
    if (
      !isUuid(id) ||
      !isUuid(key) ||
      req.body?.confirmed !== true ||
      Object.keys(req.body).join() !== "confirmed"
    )
      return res.status(400).json({ error: "end_confirmation_required" });
    let c: PoolClient | null = null;
    const release = async () => {
      if (!c) return;
      const held = c;
      c = null;
      try {
        await held.query("ROLLBACK");
        held.release();
      } catch {
        held.release(true);
      }
    };
    let status = 503,
      code = "end_unavailable";
    try {
      c = await pool.connect();
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "experiment-end:" + key.toLowerCase(),
      ]);
      const old = (
        await c.query(
          "SELECT * FROM experiment_end_receipts WHERE request_key=$1",
          [key],
        )
      ).rows[0];
      if (old && old.run_id !== id.toLowerCase()) {
        status = 409;
        code = "request_conflict";
        throw new Error(code);
      }
      if (old) {
        await c.query("COMMIT");
        return res.json({
          id: old.run_id,
          state: "ENDED",
          endedAt: old.ended_at,
        });
      }
      const r = (
        await c.query(
          "SELECT r.* FROM experiment_runs r JOIN experiment_run_catalog x ON x.run_id=r.id WHERE r.id=$1 FOR UPDATE OF r",
          [id],
        )
      ).rows[0];
      if (!r) {
        status = 404;
        code = "not_found";
        throw new Error(code);
      }
      if (r.state !== "RUNNING") {
        status = 409;
        code = "experiment_not_running";
        throw new Error(code);
      }
      const result = (
        await c.query(
          "UPDATE experiment_runs SET state='ENDED',ended_at=clock_timestamp() WHERE id=$1 RETURNING id,state,ended_at AS \"endedAt\"",
          [id],
        )
      ).rows[0];
      await c.query("INSERT INTO experiment_end_receipts VALUES($1,$2,$3)", [
        key,
        id,
        result.endedAt,
      ]);
      await c.query(
        "INSERT INTO experiment_end_audit(run_id,http_status,outcome,reason_code) VALUES($1,200,'SUCCESS','ok')",
        [id],
      );
      await c.query("COMMIT");
      return res.json(result);
    } catch {
      await release();
      const saved = await pool
        .query(
          "INSERT INTO experiment_end_audit(run_id,http_status,outcome,reason_code) VALUES($1,$2,$3,$4)",
          [id, status, status >= 500 ? "FAILURE" : "REJECTED", code],
        )
        .then(
          () => true,
          () => false,
        );
      return res
        .status(status)
        .set("X-Experiment-End-Audit-Saved", String(saved))
        .json({
          error: code,
          message: "終了状態を確認できません。同じ要求で再試行してください。",
        });
    } finally {
      c?.release();
    }
  });
}
