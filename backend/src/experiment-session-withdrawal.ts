import type { Express } from "express";
import type { Pool, PoolClient } from "pg";
import { principalOf } from "./access-control.js";
import { isMaterialId } from "./material-catalog.js";

type Result = { sessionId: string; withdrawn: true; withdrawnAt: string };
class WithdrawalError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}
function reject(code: string, status: number): never {
  throw new WithdrawalError(code, status);
}
async function audit(
  c: Pick<PoolClient, "query">,
  runId: string | null,
  sessionId: string | null,
  status: number,
  code: string,
) {
  await c.query(
    "INSERT INTO experiment_session_withdrawal_audit(run_id,session_id,http_status,outcome,reason_code) VALUES($1,$2,$3,$4,$5)",
    [runId, sessionId, status, status >= 500 ? "FAILURE" : status >= 400 ? "REJECTED" : "SUCCESS", code],
  );
}
/**
 * Registration withdrawal, NOT erasure. Immutable membership/access/identity and
 * history remain in PostgreSQL. Only a never-started, unclaimed registration in
 * a PREPARING run can be withdrawn. Run lock serializes with start/registration.
 */
export function registerExperimentSessionWithdrawalRoutes(app: Express, pool: Pool) {
  app.post("/api/research/experiment-runs/:runId/participants/:sessionId/withdraw", async (req, res) => {
    if (principalOf(res).role !== "researcher")
      return res.status(404).json({ error: "not_found" });

    const validRun = isMaterialId(req.params.runId);
    const validSession = isMaterialId(req.params.sessionId);
    const runId = validRun ? req.params.runId.toLowerCase() : null;
    const sessionId = validSession ? req.params.sessionId.toLowerCase() : null;
    const key = req.header("Idempotency-Key");
    const body = req.body;
    let c: PoolClient | null = null;
    try {
      if (
        !runId || !sessionId || !isMaterialId(key) ||
        !body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).sort().join() !== ["confirmed","expectedCredentialGeneration"].sort().join() ||
        body.confirmed !== true ||
        !Number.isInteger(body.expectedCredentialGeneration) ||
        body.expectedCredentialGeneration < 1
      ) reject("invalid_confirmation", 400);

      c = await pool.connect();
      await c.query("BEGIN");
      const run = (await c.query(
        "SELECT r.state FROM experiment_runs r JOIN experiment_run_catalog x ON x.run_id=r.id WHERE r.id=$1 FOR UPDATE OF r",
        [runId],
      )).rows[0];
      if (!run) reject("not_found", 404);

      const previous = (await c.query(
        `SELECT w.session_id,p.run_id,w.withdrawn_at AS "withdrawnAt"
         FROM experiment_session_withdrawals w JOIN experiment_run_sessions p ON p.session_id=w.session_id
         WHERE w.request_key=$1`,
        [key.toLowerCase()],
      )).rows[0];
      if (previous) {
        if (previous.session_id !== sessionId || previous.run_id !== runId)
          reject("request_conflict", 409);
        await audit(c, runId, sessionId, 200, "ok");
        await c.query("COMMIT");
        return res.status(200).set("Cache-Control", "no-store").json({
          sessionId, withdrawn: true, withdrawnAt: previous.withdrawnAt,
        } satisfies Result);
      }
      if (run.state !== "PREPARING") reject("not_eligible", 409);

      const target = (await c.query(
        `SELECT s.status,s.started_at,s.completed_at
         FROM experiment_run_sessions p JOIN sessions s ON s.id=p.session_id
         WHERE p.run_id=$1 AND s.id=$2 AND s.protocol_key='SBKB_INTEGRATION_V1'
         FOR UPDATE OF s`,
        [runId, sessionId],
      )).rows[0];
      if (!target) reject("not_found", 404);
      if (target.status !== "NOT_STARTED" || target.started_at || target.completed_at)
        reject("not_eligible", 409);

      const withdrawn = await c.query(
        "SELECT 1 FROM experiment_session_withdrawals WHERE session_id=$1",
        [sessionId],
      );
      if (withdrawn.rowCount) reject("already_withdrawn", 409);

      const access = (await c.query(
        "SELECT credential_generation,active_client_id FROM experiment_participant_access WHERE session_id=$1 FOR UPDATE",
        [sessionId],
      )).rows[0];
      if (
        !access || access.credential_generation !== body.expectedCredentialGeneration ||
        access.active_client_id
      ) reject("not_eligible", 409);

      // Both the API and the immutable DB trigger reject any recorded learner activity.
      const row = (await c.query(
        `INSERT INTO experiment_session_withdrawals(session_id,request_key)
         VALUES($1,$2) RETURNING withdrawn_at AS "withdrawnAt"`,
        [sessionId, key.toLowerCase()],
      )).rows[0];
      await audit(c, runId, sessionId, 200, "ok");
      await c.query("COMMIT");
      return res.status(200).set("Cache-Control", "no-store").json({
        sessionId, withdrawn: true, withdrawnAt: row.withdrawnAt,
      } satisfies Result);
    } catch (error) {
      if (c) await c.query("ROLLBACK").catch(() => undefined);
      const pg = (error as { code?: string })?.code;
      const safe = error instanceof WithdrawalError
        ? error
        : pg === "23514" || pg === "23503"
          ? new WithdrawalError("not_eligible", 409)
          : pg === "23505" || pg === "40001" || pg === "40P01"
            ? new WithdrawalError("request_conflict", 409)
            : new WithdrawalError("withdrawal_unavailable", 503);
      const saved = await pool.query(
        "INSERT INTO experiment_session_withdrawal_audit(run_id,session_id,http_status,outcome,reason_code) VALUES($1,$2,$3,$4,$5)",
        [runId, sessionId, safe.status, safe.status >= 500 ? "FAILURE" : "REJECTED", safe.code],
      ).then(() => true, () => false);
      const messages: Record<string, string> = {
        invalid_confirmation: "確認内容を更新してから操作してください。",
        not_found: "対象の参加者Sessionを確認できません。",
        not_eligible: "未開始・未接続・学習記録なしの準備中Sessionのみ取り消せます。状態を更新してください。",
        already_withdrawn: "この参加者Sessionは登録取消済みです。",
        request_conflict: "別の操作と競合しました。一覧を更新してください。",
        withdrawal_unavailable: "登録取消を確定できませんでした。同じ要求で再試行してください。",
      };
      return res.status(safe.status)
        .set("Cache-Control", "no-store")
        .set("X-Withdrawal-Audit-Saved", String(saved))
        .json({ error: safe.code, message: messages[safe.code] });
    } finally {
      c?.release();
    }
  });
}
