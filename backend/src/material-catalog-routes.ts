import { Router, type Express, type Request, type Response } from "express";
import type { Pool } from "pg";
import { principalOf } from "./access-control.js";
import { ResearchSafetyError } from "./research-output-safety.js";
import {
  checkMaterial,
  isMaterialId,
  listMaterials,
  materialAssets,
  materialFailure,
  MaterialError,
  mutateMaterial,
  readMaterial,
  writeMaterialAudit,
  type MaterialAction,
} from "./material-catalog.js";

const messages: Record<string, string> = {
  not_found: "教材が見つかりません。",
  material_invalid_request:
    "入力形式と文字数を確認してください。統合時間は整数秒で入力してください。",
  material_not_ready: "不足項目を確認し、該当する編集欄を設定してください。",
  material_sensitive_text:
    "認証情報に該当する内容は保存できません。入力を確認してください。",
  material_revision_conflict:
    "別の保存または更新が行われました。入力を控えたうえで再読み込みしてください。",
  material_immutable:
    "完成済み版は変更・削除できません。次版の下書きを作成してください。",
  material_draft_exists:
    "この教材には編集中の下書きがあります。教材一覧からその下書きを開いてください。",
  material_asset_conflict:
    "資材の状態が変わりました。Goal Map・Kit・初期概念を再確認して完成チェックを行ってください。",
  material_storage_unavailable:
    "教材の保存状態を確認できません。時間をおいて再試行してください。",
  safety_budget_exceeded:
    "安全確認の処理量上限を超えました。入力を短くするか対象を絞ってください。改善しない場合は管理者に連絡してください。",
  safety_lookup_unavailable:
    "安全確認を行えませんでした。時間をおいて再試行してください。",
};
/** Final status/code are resolved before audit and send. Never intercept responses. */
export function registerMaterialCatalogRoutes(app: Express, pool: Pool) {
  const router = Router();
  router.use((_q, r, n) =>
    principalOf(r).role === "researcher"
      ? n()
      : r.status(404).json({ error: "not_found" }),
  );
  function handle(
    action: MaterialAction,
    work: (q: Request, r: Response) => Promise<unknown>,
    status = 200,
    transactionAudited = false,
  ) {
    return async (q: Request, r: Response) => {
      let target = isMaterialId(q.params.id) ? q.params.id : null;
      try {
        const output = await work(q, r);
        if (!transactionAudited)
          await writeMaterialAudit(pool, action, target, status, "ok");
        if (
          output &&
          typeof output === "object" &&
          "id" in output &&
          isMaterialId(output.id)
        )
          target = output.id;
        return r
          .status(status)
          .set("X-Material-Audit-Saved", "true")
          .json(output);
      } catch (error) {
        const safe = materialFailure(error);
        const code = safe.code;
        const status =
          safe instanceof ResearchSafetyError
            ? code === "safety_budget_exceeded"
              ? 422
              : 503
            : safe.status;
        let saved = false;
        try {
          await writeMaterialAudit(pool, action, target, status, code);
          saved = true;
        } catch {
          /* Never log input or exception details. */
        }
        return r
          .status(status)
          .set("X-Material-Audit-Saved", String(saved))
          .json({
            error: code,
            message: messages[code] ?? messages.material_storage_unavailable,
            ...(safe instanceof MaterialError && safe.issues
              ? { issues: safe.issues }
              : {}),
          });
      }
    };
  }
  router.get(
    "/",
    handle("LIST", (_q, r) => listMaterials(pool, principalOf(r))),
  );
  router.get(
    "/assets",
    handle("ASSETS", (_q, r) => materialAssets(pool, principalOf(r))),
  );
  router.get(
    "/:id",
    handle("READ", (q, r) => readMaterial(pool, principalOf(r), q.params.id)),
  );
  router.post(
    "/",
    handle(
      "CREATE",
      (q, r) =>
        mutateMaterial(
          pool,
          principalOf(r),
          "CREATE",
          q.header("Idempotency-Key"),
          null,
          q.body,
        ),
      201,
      true,
    ),
  );
  router.put(
    "/:id",
    handle(
      "SAVE",
      (q, r) =>
        mutateMaterial(
          pool,
          principalOf(r),
          "SAVE",
          q.header("Idempotency-Key"),
          q.params.id,
          q.body,
        ),
      200,
      true,
    ),
  );
  router.post(
    "/:id/check",
    handle(
      "CHECK",
      (q, r) => checkMaterial(pool, principalOf(r), q.params.id),
      200,
      true,
    ),
  );
  router.post(
    "/:id/publish",
    handle(
      "PUBLISH",
      (q, r) =>
        mutateMaterial(
          pool,
          principalOf(r),
          "PUBLISH",
          q.header("Idempotency-Key"),
          q.params.id,
          q.body,
        ),
      200,
      true,
    ),
  );
  router.post(
    "/:id/next-draft",
    handle(
      "NEXT",
      (q, r) =>
        mutateMaterial(
          pool,
          principalOf(r),
          "NEXT",
          q.header("Idempotency-Key"),
          q.params.id,
          q.body,
        ),
      201,
      true,
    ),
  );
  router.delete(
    "/:id",
    handle("SAVE", async (q, r) => {
      await readMaterial(pool, principalOf(r), q.params.id);
      throw new MaterialError("material_immutable", 409);
    }),
  );
  app.use("/api/research/materials", router);
}
