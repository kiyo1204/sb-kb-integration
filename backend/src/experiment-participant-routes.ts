import { Router, type Express, type Request, type Response } from "express";
import type { Pool } from "pg";
import { principalOf } from "./access-control.js";
import { isMaterialId } from "./material-catalog.js";
import { ResearchSafetyError } from "./research-output-safety.js";
import {
  claimExperimentClient,
  mutateParticipant,
  participantView,
  participantFailure,
  writeAccessAudit,
  ParticipantAccessError,
  type AccessAction,
} from "./experiment-participant-access.js";
const messages: Record<string, string> = {
  not_found: "対象の実施・参加者・接続候補を確認できません。",
  access_invalid_request:
    "入力項目を確認してください。参加者ラベルには実名や認証情報を含めないでください。",
  access_conflict:
    "別の操作または同じ要求キーの異なる内容と競合しました。状態を更新して確認してください。",
  access_storage_unavailable:
    "保存状態を確認できません。同じ内容で再試行し、コードが表示されない場合は明示的に再発行してください。",
  access_sensitive_text: "認証情報を含むラベルは保存できません。",
  experiment_code_invalidated:
    "コードが更新されています。研究者に確認してください。",
  experiment_client_stale:
    "画面の権限が更新されています。古い画面の操作は受け付けません。",
  experiment_client_in_use:
    "別の画面が使用中です。研究者に切替を依頼してください。",
  safety_budget_exceeded:
    "安全確認の処理量上限を超えました。対象を絞るか管理者に連絡してください。",
  safety_lookup_unavailable:
    "安全確認を行えませんでした。時間をおいて再試行してください。",
};
export function registerExperimentParticipantRoutes(app: Express, pool: Pool) {
  function handle(
    action: AccessAction,
    work: (
      q: Request,
      r: Response,
    ) => Promise<{ status: number; payload: unknown }>,
    atomic = true,
  ) {
    return async (q: Request, r: Response) => {
      const actor = principalOf(r),
        run = isMaterialId(q.params.runId) ? q.params.runId : null,
        sid = isMaterialId(q.params.sessionId) ? q.params.sessionId : null;
      try {
        const out = await work(q, r);
        if (!atomic)
          await writeAccessAudit(pool, action, run, sid, out.status, "ok");
        return r
          .status(out.status)
          .set("Cache-Control", "no-store")
          .set("X-Participant-Audit-Saved", "true")
          .json(out.payload);
      } catch (error) {
        const safe = participantFailure(error),
          status =
            safe instanceof ResearchSafetyError
              ? safe.code === "safety_budget_exceeded"
                ? 422
                : 503
              : safe.status;
        let saved = false;
        try {
          await writeAccessAudit(
            pool,
            action,
            actor.role === "learner" ? (actor.experiment?.runId ?? null) : run,
            actor.role === "learner" ? actor.sessionId : sid,
            status,
            safe.code,
            actor.role === "learner" ? "LEARNER" : "RESEARCHER",
          );
          saved = true;
        } catch {
          /* No request, code or exception logging. */
        }
        return r
          .status(status)
          .set("X-Participant-Audit-Saved", String(saved))
          .json({
            error: safe.code,
            message: messages[safe.code] ?? messages.access_storage_unavailable,
          });
      }
    };
  }
  const router = Router();
  router.use((_q, r, n) =>
    principalOf(r).role === "researcher"
      ? n()
      : r.status(404).json({ error: "not_found" }),
  );
  router.get(
    "/:runId/participants",
    handle(
      "VIEW",
      async (q, r) => ({
        status: 200,
        payload: await participantView(pool, principalOf(r), q.params.runId),
      }),
      false,
    ),
  );
  router.post(
    "/:runId/participants",
    handle("REGISTER", async (q, r) => ({
      status: 201,
      payload: await mutateParticipant(
        pool,
        principalOf(r),
        "REGISTER",
        q.header("Idempotency-Key"),
        q.params.runId,
        null,
        q.body,
      ),
    })),
  );
  for (const [suffix, action] of [
    ["code", "ISSUE"],
    ["code/reissue", "REISSUE"],
    ["client-switch", "SWITCH"],
  ] as const)
    router.post(
      `/:runId/participants/:sessionId/${suffix}`,
      handle(action, async (q, r) => ({
        status: 200,
        payload: await mutateParticipant(
          pool,
          principalOf(r),
          action,
          q.header("Idempotency-Key"),
          q.params.runId,
          q.params.sessionId,
          q.body,
        ),
      })),
    );
  app.use("/api/research/experiment-runs", router);
  app.post(
    "/api/experiment-client/claim",
    handle("CLAIM", async (q, r) => {
      const p = principalOf(r);
      if (p.role !== "learner" || !p.experiment)
        throw new ParticipantAccessError("not_found", 404);
      if (
        !q.body ||
        typeof q.body !== "object" ||
        Array.isArray(q.body) ||
        Object.keys(q.body).length
      )
        throw new ParticipantAccessError("access_invalid_request", 400);
      return claimExperimentClient(
        pool,
        p.experiment,
        q.header("X-Experiment-Client"),
      );
    }),
  );
}
