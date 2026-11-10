import type { Express, Request, Response } from "express";
import type { Pool } from "pg";
import { principalOf } from "./access-control.js";
import { isUuid } from "./delivery-reliability.js";
import { R05StorageError } from "./r05-storage.js";
import {
  ResearchSafetyError,
  respondResearchSafetyError,
} from "./research-output-safety.js";
import {
  startR05,
  viewR05,
  operateR05,
  deleteR05,
  deletionR05,
} from "./r05-execution.js";
export function registerR05Routes(app: Express, pool: Pool) {
  const base = "/api/research/materials/:version/r05";
  const handle =
    (work: (q: Request, r: Response) => Promise<unknown>) =>
    async (q: Request, r: Response) => {
      if (principalOf(r).role !== "researcher")
        return r.status(403).json({ error: "forbidden" });
      if (!isUuid(q.params.version as string))
        return r.status(404).json({ error: "not_found" });
      try {
        return r.json(await work(q, r));
      } catch (e) {
        const status =
          e instanceof R05StorageError
            ? e.status
            : e instanceof ResearchSafetyError
              ? e.code === "safety_budget_exceeded"
                ? 422
                : 503
              : 503;
        const code =
          e instanceof R05StorageError || e instanceof ResearchSafetyError
            ? e.code
            : "r05_unavailable";
        let auditSaved = false;
        try {
          await pool.query(
            "INSERT INTO r05_execution_audit(test_run_id,action,http_status,outcome,reason_code) VALUES($1,$2,$3,$4,$5)",
            [
              isUuid(q.params.id as string) ? q.params.id : null,
              q.method,
              status,
              status >= 500 ? "FAILURE" : "REJECTED",
              code,
            ],
          );
          auditSaved = true;
        } catch {
          /* No exception or input is logged. */
        }
        r.set("X-R05-Audit-Saved", String(auditSaved));
        if (respondResearchSafetyError(r, e)) return;
        return r.status(status).json({
          error: code,
          message:
            "テスト操作を完了できませんでした。最新の状態を確認し、操作をやり直してください。",
        });
      }
    };
  app.get(
    base,
    handle((q, r) => viewR05(pool, principalOf(r), q.params.version as string)),
  );
  app.post(
    base,
    handle((q, r) => {
      if (
        !q.body ||
        Object.keys(q.body).length !== 1 ||
        !isUuid(q.body.executionId)
      )
        throw new R05StorageError("invalid_request", 400);
      return startR05(
        pool,
        principalOf(r),
        q.params.version as string,
        q.header("Idempotency-Key") ?? "",
        q.body.executionId,
      );
    }),
  );
  app.post(
    base + "/:id/operations",
    handle((q, r) =>
      operateR05(
        pool,
        principalOf(r),
        q.params.version as string,
        q.params.id as string,
        q.header("Idempotency-Key") ?? "",
        q.body ?? {},
      ),
    ),
  );
  app.get(
    base + "/:id/deletion-preview",
    handle(async (q, r) => {
      const value = await deletionR05(
        pool,
        principalOf(r),
        q.params.id as string,
      );
      if (value.run.material_version_id !== (q.params.version as string))
        throw new R05StorageError("not_found", 404);
      return {
        id: q.params.id as string,
        mapCount: value.maps.length,
        historyCount: value.history.length,
        confirmation: value.confirmation,
      };
    }),
  );
  app.delete(
    base + "/:id",
    handle((q, r) => {
      if (
        !q.body ||
        Object.keys(q.body).sort().join(",") !== "confirmation,confirmed" ||
        q.body.confirmed !== true ||
        typeof q.body.confirmation !== "string"
      )
        throw new R05StorageError("deletion_confirmation_required", 400);
      return deleteR05(
        pool,
        principalOf(r),
        q.params.version as string,
        q.params.id as string,
        q.header("Idempotency-Key") ?? "",
        q.body.confirmation,
      );
    }),
  );
}
