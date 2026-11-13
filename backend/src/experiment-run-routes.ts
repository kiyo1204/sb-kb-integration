import { Router, type Express, type Request, type Response } from "express";
import type { Pool } from "pg";
import { principalOf } from "./access-control.js";
import { isMaterialId } from "./material-catalog.js";
import { ResearchSafetyError } from "./research-output-safety.js";
import {
  createManagedRun,
  getManagedRun,
  listManagedRuns,
  listRunMaterials,
  runManagementFailure,
  writeRunAudit,
  type RunAction,
} from "./experiment-run-management.js";
const messages: Record<string, string> = {
  not_found: "実施が見つかりません。",
  run_invalid_request:
    "実施名、完成教材版、予定人数を確認してください。予定人数は非負の整数で、保存形式は32bit整数です。登録人数の上限には使いません。",
  run_material_unavailable: "完成登録された教材版を選び直してください。",
  run_sensitive_text:
    "実施名に認証情報を含めることはできません。入力を確認してください。",
  run_request_conflict:
    "同じ要求キーで異なる内容が送信されたか、処理が競合しました。一覧で保存状態を確認してください。",
  run_storage_unavailable:
    "実施の保存状態を確認できません。入力を保持して再試行するか、一覧を確認してください。",
  safety_budget_exceeded:
    "安全確認の処理量上限を超えました。入力を短くするか対象を絞ってください。改善しない場合は管理者に連絡してください。",
  safety_lookup_unavailable:
    "安全確認を行えませんでした。時間をおいて再試行してください。",
};
export function registerExperimentRunRoutes(app: Express, pool: Pool) {
  const router = Router();
  router.use((_q, r, n) =>
    principalOf(r).role === "researcher"
      ? n()
      : r.status(404).json({ error: "not_found" }),
  );
  function handle(
    action: RunAction,
    work: (q: Request, r: Response) => Promise<unknown>,
    status = 200,
    atomic = false,
  ) {
    return async (q: Request, r: Response) => {
      const target = isMaterialId(q.params.id) ? q.params.id : null;
      try {
        const out = await work(q, r);
        if (!atomic) await writeRunAudit(pool, action, target, status, "ok");
        return r.status(status).set("X-Run-Audit-Saved", "true").json(out);
      } catch (error) {
        const safe = runManagementFailure(error),
          status =
            safe instanceof ResearchSafetyError
              ? safe.code === "safety_budget_exceeded"
                ? 422
                : 503
              : safe.status;
        let saved = false;
        try {
          await writeRunAudit(pool, action, target, status, safe.code);
          saved = true;
        } catch {
          /* No free text, credential or exception logging. */
        }
        return r
          .status(status)
          .set("X-Run-Audit-Saved", String(saved))
          .json({
            error: safe.code,
            message: messages[safe.code] ?? messages.run_storage_unavailable,
          });
      }
    };
  }
  router.get(
    "/",
    handle("LIST", (_q, r) => listManagedRuns(pool, principalOf(r))),
  );
  router.get(
    "/material-versions",
    handle("MATERIALS", (_q, r) => listRunMaterials(pool, principalOf(r))),
  );
  router.get(
    "/:id",
    handle("READ", (q, r) => getManagedRun(pool, principalOf(r), q.params.id)),
  );
  router.post(
    "/",
    handle(
      "CREATE",
      (q, r) =>
        createManagedRun(
          pool,
          principalOf(r),
          q.header("Idempotency-Key"),
          q.body,
        ),
      201,
      true,
    ),
  );
  app.use("/api/research/experiment-runs", router);
}
