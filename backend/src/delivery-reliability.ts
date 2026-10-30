import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Request, Response, Express } from "express";
import type { Pool, PoolClient } from "pg";
type Context = {
  scope: string;
  key: string;
  hash: string;
  conflict?: boolean;
  replayed?: boolean;
  recorded?: boolean;
  revoked?: boolean;
  replayAllowed?: (client: PoolClient) => Promise<boolean>;
};
const storage = new AsyncLocalStorage<Context>();
export const isUuid = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
        .join(",") +
      "}"
    );
  return JSON.stringify(v) ?? "null";
}
export const digest = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
function eligible(req: Request) {
  return (
    ["POST", "PATCH", "DELETE"].includes(req.method) &&
    (/^\/(maps|concepts|links)\//.test(req.path) ||
      /^\/session-stages\/[^/]+\/(start|complete|prior-map|integration-map|assessment\/(save|submit))$/.test(
        req.path,
      ) ||
      /^\/kits\/[^/]+\/kb-map$/.test(req.path)) &&
    !/\/(kit-feedback\/display|operation-cancellations(?:\/|$))/.test(req.path)
  );
}
export async function operationGate(
  pool: Pool,
  req: Request,
  res: Response,
  scope: string,
  conceal = false,
) {
  const key = req.header("Idempotency-Key");
  if (!key || !eligible(req)) return false;
  if (!isUuid(key)) {
    res.status(conceal ? 404 : 400).json({ error: "invalid_idempotency_key" });
    return true;
  }
  const ctx: Context = {
    scope,
    key,
    hash: digest({
      method: req.method,
      path: req.path,
      body: req.body ?? null,
    }),
  };
  res.locals.reliableOperation = ctx;
  try {
    const row = (
      await pool.query(
        "SELECT request_hash,created_at,result FROM operation_receipts WHERE principal_scope=$1 AND operation_key=$2",
        [scope, key],
      )
    ).rows[0];
    if (row && row.request_hash !== ctx.hash) {
      if (conceal) return false;
      res
        .status(409)
        .json({ error: "idempotency_conflict", operationCommitted: false });
      return true;
    }
    if (row && Date.now() - new Date(row.created_at).getTime() > 7 * 86400000) {
      res.status(410).json({
        error: "operation_result_expired",
        operationCommitted: null,
        message:
          "処理記録の再取得期限を過ぎています。セッション画面で保存状態を確認してください。",
      });
      return true;
    }
    res.locals.operationKnown = !!row;
    res.locals.operationResult = row?.result;
  } catch {
    res.status(503).json({ error: "operation_receipt_unavailable" });
    return true;
  }
  return false;
}
function receiptBody(res: Response) {
  const submitted = res.locals.operationResult?.kind === "submitted";
  return {
    error: "operation_already_committed",
    operationCommitted: submitted ? true : null,
    operationOutcome: submitted ? "SUCCESS" : "UNKNOWN",
    logSaved: submitted ? true : null,
    message:
      "この要求の処理記録があります。セッション画面を再読み込みして結果を確認してください。",
  };
}
export function committedReceipt(res: Response) {
  return res.status(409).json(receiptBody(res));
}
export function operationCommitted() {
  const ctx = storage.getStore();
  if (ctx) ctx.recorded = true;
}
export function registerOperationContext(app: Express) {
  app.use("/api", (_req, res, next) => {
    const ctx = res.locals.reliableOperation as Context | undefined;
    if (!ctx) return next();
    const original = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (ctx.recorded) {
        res.set("X-Operation-Recorded", "true");
        res.set("X-Operation-Replayed", String(ctx.replayed ?? false));
      }
      if (ctx.revoked) return original.call(res.status(409), receiptBody(res));
      if (ctx.conflict)
        return original.call(res.status(409), {
          error: "idempotency_conflict",
          operationCommitted: false,
        });
      return original(body);
    }) as Response["json"];
    storage.run(ctx, next);
  });
}
export async function reliableOperation<T>(
  client: PoolClient,
  fn: () => Promise<T>,
  phase = "operation",
): Promise<T> {
  const ctx = storage.getStore();
  if (!ctx) return fn();
  const scope = phase === "operation" ? ctx.scope : ctx.scope + ":" + phase;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    scope + ":" + ctx.key,
  ]);
  const prior = (
    await client.query(
      "SELECT request_hash,result FROM operation_receipts WHERE principal_scope=$1 AND operation_key=$2",
      [scope, ctx.key],
    )
  ).rows[0];
  if (prior) {
    if (prior.request_hash !== ctx.hash) {
      ctx.conflict = true;
      throw new Error("idempotency_conflict");
    }
    ctx.replayed = true;
    if (ctx.replayAllowed && !(await ctx.replayAllowed(client)))
      ctx.revoked = true;
    return prior.result as T;
  }
  const result = await fn();
  await client.query(
    "INSERT INTO operation_receipts(principal_scope,operation_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)",
    [scope, ctx.key, ctx.hash, JSON.stringify(result ?? null)],
  );
  return result;
}
