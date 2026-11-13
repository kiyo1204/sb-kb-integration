import type { Pool, PoolClient } from "pg";
import { isUuid, digest } from "./delivery-reliability.js";
import { loadResearchTextSafety } from "./research-output-safety.js";
export class R05StorageError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
type Actor = { role: string };
const requireResearcher = (a: Actor) => {
  if (a.role !== "researcher") throw new R05StorageError("forbidden", 403);
};
// Internal storage service only: not a learner bypass or a public execution API.
export async function readR05Test(pool: Pool, actor: Actor, id: string) {
  requireResearcher(actor);
  if (!isUuid(id)) throw new R05StorageError("not_found", 404);
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const run = (await c.query("SELECT * FROM r05_test_runs WHERE id=$1", [id]))
      .rows[0];
    if (!run) throw new R05StorageError("not_found", 404);
    const maps = (
      await c.query(
        "SELECT * FROM r05_test_maps WHERE test_run_id=$1 ORDER BY map_kind",
        [id],
      )
    ).rows;
    const history = (
      await c.query(
        "SELECT h.* FROM r05_test_history h JOIN r05_test_maps m ON m.id=h.test_map_id WHERE m.test_run_id=$1 ORDER BY h.test_map_id,h.sequence_number",
        [id],
      )
    ).rows;
    const output = (await loadResearchTextSafety(c)).redact({
      run,
      maps,
      history,
      confirmation: digest({ id, maps, history }),
    });
    await c.query("COMMIT");
    return output;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
export async function mutateR05Storage(
  pool: Pool,
  actor: Actor,
  action: "CREATE" | "DELETE",
  key: string,
  versionId: string,
  input: { runId?: string; confirmation?: string; executionId?:string } = {},
  initialize?: (client:PoolClient,id:string)=>Promise<void>,
) {
  requireResearcher(actor);
  if (
    !isUuid(key) ||
    !isUuid(versionId) ||
    (action === "DELETE" && !isUuid(input.runId))
  )
    throw new R05StorageError("invalid_request", 400);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "r05-request:" + key.toLowerCase(),
    ]);
    const hash = digest({ action, versionId: versionId.toLowerCase(), input });
    const previous = (
      await c.query("SELECT * FROM r05_storage_requests WHERE request_key=$1", [
        key,
      ])
    ).rows[0];
    if (previous) {
      if (previous.request_hash !== hash)
        throw new R05StorageError("request_conflict", 409);
      await c.query("COMMIT");
      return previous.result as { id: string; deleted: boolean };
    }
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "r05-version:" + versionId.toLowerCase(),
    ]);
    const material = (
      await c.query(
        "SELECT id FROM material_catalog_versions WHERE id=$1 AND state='PUBLISHED' FOR SHARE",
        [versionId],
      )
    ).rows[0];
    if (!material)
      throw new R05StorageError("published_material_required", 409);
    let id: string;
    if (action === "CREATE") {
      if (
        (
          await c.query(
            "SELECT 1 FROM r05_submission_acceptances WHERE material_version_id=$1 UNION ALL SELECT 1 FROM r05_test_runs WHERE material_version_id=$1",
            [versionId],
          )
        ).rowCount
      )
        throw new R05StorageError("test_already_exists_or_completed", 409);
      id = (
        await c.query(
          "INSERT INTO r05_test_runs(material_version_id) VALUES($1) RETURNING id",
          [versionId],
        )
      ).rows[0].id;
    } else {
      id = input.runId!;
      if (
        !(
          await c.query(
            "SELECT 1 FROM r05_test_runs WHERE id=$1 AND material_version_id=$2 FOR UPDATE",
            [id, versionId],
          )
        ).rowCount
      )
        throw new R05StorageError("not_found", 404);
      const maps = (
        await c.query(
          "SELECT * FROM r05_test_maps WHERE test_run_id=$1 ORDER BY map_kind",
          [id],
        )
      ).rows;
      const history = (
        await c.query(
          "SELECT h.* FROM r05_test_history h JOIN r05_test_maps m ON m.id=h.test_map_id WHERE m.test_run_id=$1 ORDER BY h.test_map_id,h.sequence_number",
          [id],
        )
      ).rows;
      if (input.confirmation !== digest({ id, maps, history }))
        throw new R05StorageError("confirmation_changed", 409);
      await c.query("DELETE FROM r05_test_runs WHERE id=$1", [id]);
    }
    if(action === "CREATE" && initialize) await initialize(c,id);
    const result = { id, deleted: action === "DELETE" };
    await c.query(
      "INSERT INTO r05_storage_audit(action,test_run_id,material_version_id) VALUES($1,$2,$3)",
      [action, id, versionId],
    );
    await c.query(
      "INSERT INTO r05_storage_requests(request_key,request_hash,result) VALUES($1,$2,$3)",
      [key, hash, result],
    );
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
