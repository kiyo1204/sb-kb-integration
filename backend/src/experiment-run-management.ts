import type { Pool, PoolClient } from "pg";
import type { principalOf } from "./access-control.js";
import {
  createExperimentRunInTransaction,
  FoundationError,
} from "./experiment-foundation.js";
import { isMaterialId } from "./material-catalog.js";
import { digest } from "./delivery-reliability.js";
import {
  loadResearchTextSafety,
  ResearchSafetyError,
} from "./research-output-safety.js";
type Actor = ReturnType<typeof principalOf>;
type DB = Pick<PoolClient, "query">;
export type RunAction = "CREATE" | "LIST" | "READ" | "MATERIALS";
export class RunManagementError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
const researcher = (actor: Actor) => {
  if (actor.role !== "researcher")
    throw new RunManagementError("not_found", 404);
};
export function runManagementFailure(error: unknown) {
  if (
    error instanceof ResearchSafetyError ||
    error instanceof RunManagementError
  )
    return error;
  if (
    error instanceof FoundationError &&
    error.code === "foundation_idempotency_conflict"
  )
    return new RunManagementError("run_request_conflict", 409);
  if (
    ["23505", "40001", "40P01"].includes(
      (error as { code?: string })?.code ?? "",
    )
  )
    return new RunManagementError("run_request_conflict", 409);
  return new RunManagementError("run_storage_unavailable", 503);
}
export async function writeRunAudit(
  c: DB,
  action: RunAction,
  id: string | null,
  status: number,
  code: string,
) {
  await c.query(
    "INSERT INTO experiment_run_audit(action,target_id,http_status,outcome,reason,reason_code) VALUES($1,$2,$3,$4,$5,$6)",
    [
      action,
      id,
      status,
      status >= 500 ? "FAILURE" : status >= 400 ? "REJECTED" : "SUCCESS",
      status >= 500
        ? "SERVER"
        : status === 409
          ? "CONFLICT"
          : status >= 400
            ? "VALIDATION"
            : null,
      code,
    ],
  );
}
// Time is read via the immutable pinned-version FK, never via the latest catalog
// version or editable settings. No competing copy of its duration is maintained.
const select = `SELECT r.id,x.name,x.catalog_version_id AS "catalogVersionId",r.material_version_id AS "materialVersionId",c.series_id AS "seriesId",c.version_number AS "materialVersion",v.title AS "materialTitle",v.integration_seconds AS "integrationSeconds",r.planned_participants AS "plannedParticipants",(SELECT count(*)::int FROM experiment_run_sessions p WHERE p.run_id=r.id) AS "registeredSessions",r.state,r.created_at AS "createdAt"
FROM experiment_runs r JOIN experiment_run_catalog x ON x.run_id=r.id JOIN material_catalog_versions c ON c.id=x.catalog_version_id JOIN experiment_material_versions v ON v.id=r.material_version_id`;
async function read(c: DB, id: string) {
  return (await c.query(select + " WHERE r.id=$1", [id])).rows[0] ?? null;
}
export async function listManagedRuns(pool: Pool, actor: Actor) {
  researcher(actor);
  const rows = (await pool.query(select + " ORDER BY r.created_at DESC,r.id"))
    .rows;
  return (await loadResearchTextSafety(pool)).redact({ runs: rows });
}
export async function getManagedRun(pool: Pool, actor: Actor, id: unknown) {
  researcher(actor);
  if (!isMaterialId(id)) throw new RunManagementError("not_found", 404);
  const row = await read(pool, id);
  if (!row) throw new RunManagementError("not_found", 404);
  return (await loadResearchTextSafety(pool)).redact(row);
}
export async function listRunMaterials(pool: Pool, actor: Actor) {
  researcher(actor);
  const rows = (
    await pool.query(
      `SELECT c.id,c.series_id AS "seriesId",c.version_number AS version,v.title,v.id AS "materialVersionId",v.integration_seconds AS "integrationSeconds" FROM material_catalog_versions c JOIN experiment_material_versions v ON v.id=c.foundation_version_id WHERE c.state='PUBLISHED' ORDER BY c.completed_at DESC,c.id`,
    )
  ).rows;
  return (await loadResearchTextSafety(pool)).redact({ versions: rows });
}
export async function createManagedRun(
  pool: Pool,
  actor: Actor,
  key: unknown,
  value: unknown,
) {
  researcher(actor);
  if (
    !isMaterialId(key) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new RunManagementError("run_invalid_request", 400);
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join() !==
      ["name", "catalogVersionId", "plannedParticipants"].sort().join() ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 120 ||
    !isMaterialId(input.catalogVersionId) ||
    !Number.isInteger(input.plannedParticipants) ||
    Number(input.plannedParticipants) < 0 ||
    Number(input.plannedParticipants) > 2147483647
  )
    throw new RunManagementError("run_invalid_request", 400);
  const normal = {
      name: input.name.trim(),
      catalogVersionId: input.catalogVersionId.toLowerCase(),
      plannedParticipants: input.plannedParticipants as number,
    },
    hash = digest(normal);
  const requestKey = key.toLowerCase();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // Same lock as the existing service, also excluding adoption of an existing
    // standalone run if both creation paths receive the same key concurrently.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "foundation:experiment_runs:" + requestKey,
    ]);
    const previous = (
      await c.query(
        "SELECT r.id,x.request_hash FROM experiment_runs r LEFT JOIN experiment_run_catalog x ON x.run_id=r.id WHERE r.request_key=$1",
        [requestKey],
      )
    ).rows[0];
    if (previous) {
      if (previous.request_hash !== hash)
        throw new RunManagementError("run_request_conflict", 409);
      const out = (await loadResearchTextSafety(c)).redact(
        await read(c, previous.id),
      );
      await c.query("COMMIT");
      return out;
    }
    const safety = await loadResearchTextSafety(c);
    if (safety.containsSecret(normal.name))
      throw new RunManagementError("run_sensitive_text", 422);
    const material = (
      await c.query(
        "SELECT foundation_version_id FROM material_catalog_versions WHERE id=$1 AND state='PUBLISHED' FOR SHARE",
        [normal.catalogVersionId],
      )
    ).rows[0];
    if (!material)
      throw new RunManagementError("run_material_unavailable", 422);
    const id = await createExperimentRunInTransaction(c, actor, {
      requestKey,
      materialVersionId: material.foundation_version_id,
      plannedParticipants: normal.plannedParticipants,
    });
    await c.query(
      "INSERT INTO experiment_run_catalog(run_id,catalog_version_id,name,request_hash) VALUES($1,$2,$3,$4)",
      [id, normal.catalogVersionId, normal.name, hash],
    );
    const out = safety.redact(await read(c, id));
    await writeRunAudit(c, "CREATE", id, 201, "ok");
    await c.query("COMMIT");
    return out;
  } catch (error) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw runManagementFailure(error);
  } finally {
    c.release();
  }
}
