import type { Pool, PoolClient } from "pg";
import type { principalOf } from "./access-control.js";
import { digest } from "./delivery-reliability.js";
import {
  FoundationError,
  publishMaterialVersionInTransaction,
} from "./experiment-foundation.js";
import {
  loadResearchTextSafety,
  ResearchSafetyError,
} from "./research-output-safety.js";
import { validMapLabel } from "./research-event-map-v2.js";

export type MaterialBody = {
  title: string;
  researcherDescription: string;
  videoRef: string;
  sbInstructions: string;
  kbInstructions: string;
  integrationInstructions: string;
  kitId: string | null;
  seedConceptItemIds: string[];
  integrationSeconds: number | null;
};
export type MaterialField = keyof MaterialBody;
export type MaterialIssue = { field: MaterialField; message: string };
export type MaterialAction =
  "CREATE" | "SAVE" | "CHECK" | "PUBLISH" | "NEXT" | "READ" | "LIST" | "ASSETS";
type Actor = ReturnType<typeof principalOf>;
type DB = Pick<PoolClient, "query">;
type Row = {
  id: string;
  series_id: string;
  version_number: number;
  edit_revision: number;
  state: "DRAFT" | "PUBLISHED";
  body: MaterialBody;
  foundation_version_id: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};
export class MaterialError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly issues?: MaterialIssue[],
  ) {
    super(code);
  }
}
export const isMaterialId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    v,
  );
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const empty = (): MaterialBody => ({
  title: "",
  researcherDescription: "",
  videoRef: "",
  sbInstructions: "",
  kbInstructions: "",
  integrationInstructions: "",
  kitId: null,
  seedConceptItemIds: [],
  integrationSeconds: null,
});
export function parseMaterialBody(value: unknown): MaterialBody {
  if (
    !object(value) ||
    Object.keys(value).sort().join() !== Object.keys(empty()).sort().join()
  )
    throw new MaterialError("material_invalid_request");
  const limits = {
    title: 120,
    researcherDescription: 10000,
    videoRef: 2048,
    sbInstructions: 10000,
    kbInstructions: 10000,
    integrationInstructions: 10000,
  };
  for (const [key, max] of Object.entries(limits))
    if (typeof value[key] !== "string" || (value[key] as string).length > max)
      throw new MaterialError("material_invalid_request");
  if (
    !(value.kitId === null || isMaterialId(value.kitId)) ||
    !Array.isArray(value.seedConceptItemIds) ||
    value.seedConceptItemIds.length > 1000 ||
    !value.seedConceptItemIds.every(isMaterialId) ||
    new Set(value.seedConceptItemIds.map((x) => x.toLowerCase())).size !==
      value.seedConceptItemIds.length ||
    !(
      value.integrationSeconds === null ||
      (Number.isInteger(value.integrationSeconds) &&
        Number(value.integrationSeconds) > 0 &&
        Number(value.integrationSeconds) <= 2147483647)
    )
  )
    throw new MaterialError("material_invalid_request");
  return {
    ...Object.fromEntries(
      Object.keys(limits).map((k) => [k, (value[k] as string).trim()]),
    ),
    kitId: typeof value.kitId === "string" ? value.kitId.toLowerCase() : null,
    seedConceptItemIds: [...value.seedConceptItemIds]
      .map((x) => x.toLowerCase())
      .sort(),
    integrationSeconds: value.integrationSeconds,
  } as MaterialBody;
}
const requireResearcher = (actor: Actor) => {
  if (actor.role !== "researcher") throw new MaterialError("not_found", 404);
};
const dto = (r: Row) => ({
  id: r.id,
  seriesId: r.series_id,
  version: r.version_number,
  editRevision: r.edit_revision,
  state: r.state,
  foundationVersionId: r.foundation_version_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
  body: r.body,
});
const result = (r: Row) => {
  const { body: _body, ...metadata } = dto(r);
  void _body;
  return metadata;
};
export function materialFailure(
  error: unknown,
): MaterialError | ResearchSafetyError {
  if (error instanceof ResearchSafetyError || error instanceof MaterialError)
    return error;
  if (error instanceof FoundationError && error.code.includes("sensitive"))
    return new MaterialError("material_sensitive_text", 422);
  if (
    error instanceof FoundationError &&
    ["foundation_invalid_kit", "foundation_invalid_asset_label"].includes(
      error.code,
    )
  )
    return new MaterialError("material_asset_conflict", 409);
  const pg = error as { code?: string; message?: string };
  if (
    ["40001", "40P01", "23503", "23505"].includes(pg?.code ?? "") ||
    [
      "experiment_asset_frozen",
      "experiment_invalid_kit",
      "experiment_invalid_seed",
      "experiment_invalid_asset_label",
    ].includes(pg?.message ?? "")
  )
    return new MaterialError("material_asset_conflict", 409);
  return new MaterialError("material_storage_unavailable", 503);
}
export async function writeMaterialAudit(
  c: DB,
  action: MaterialAction,
  target: string | null,
  status: number,
  code: string,
) {
  await c.query(
    "INSERT INTO material_catalog_audit(action,target_id,http_status,outcome,reason,reason_code) VALUES($1,$2,$3,$4,$5,$6)",
    [
      action,
      target,
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
async function safeBody(c: DB, body: MaterialBody) {
  const safety = await loadResearchTextSafety(c);
  if (
    [
      body.title,
      body.researcherDescription,
      body.videoRef,
      body.sbInstructions,
      body.kbInstructions,
      body.integrationInstructions,
    ].some(safety.containsSecret)
  )
    throw new MaterialError("material_sensitive_text", 422);
  return safety;
}
export async function materialIssues(
  c: DB,
  b: MaterialBody,
  safety: Awaited<ReturnType<typeof loadResearchTextSafety>>,
): Promise<MaterialIssue[]> {
  const issues: MaterialIssue[] = [];
  const required: Array<[MaterialField, string]> = [
    ["title", "教材名"],
    ["videoRef", "動画参照"],
    ["sbInstructions", "SB課題説明"],
    ["kbInstructions", "KB課題説明"],
    ["integrationInstructions", "統合課題説明"],
  ];
  for (const [field, label] of required)
    if (!(b[field] as string).trim())
      issues.push({ field, message: `${label}を設定してください。` });
  if (b.title && !validMapLabel(b.title))
    issues.push({
      field: "title",
      message:
        "教材名は有効な名前で入力してください。URLや認証情報は使用できません。",
    });
  if (b.videoRef && !/^(https?:\/\/|\/(?!\/))/.test(b.videoRef))
    issues.push({
      field: "videoRef",
      message:
        "動画はHTTP(S) URLまたは公開ファイルの絶対パスで指定してください。",
    });
  if (
    !b.kitId ||
    !(
      await c.query("SELECT material_catalog_kit_available($1) available", [
        b.kitId,
      ])
    ).rows[0]?.available
  )
    issues.push({
      field: "kitId",
      message: "Goal Map全体に対応する利用可能なKitを選択してください。",
    });
  if (b.kitId && !issues.some((i) => i.field === "kitId")) {
    const labels = (
      await c.query<{ label: string }>(
        "SELECT c.label FROM concepts c JOIN kit_definitions k ON k.goal_map_id=c.map_id WHERE k.id=$1 UNION ALL SELECT l.label FROM links l JOIN kit_definitions k ON k.goal_map_id=l.map_id WHERE k.id=$1",
        [b.kitId],
      )
    ).rows;
    if (
      labels.some(
        (x) => !validMapLabel(x.label) || safety.containsSecret(x.label),
      )
    )
      issues.push({
        field: "kitId",
        message:
          "資材の名前を安全に確認できません。別のGoal Map／Kitを設定してください。",
      });
  }
  if (
    !b.seedConceptItemIds.length ||
    !b.kitId ||
    (
      await c.query(
        "SELECT count(*)::int n FROM kit_concept_items WHERE kit_definition_id=$1 AND id=ANY($2::uuid[])",
        [b.kitId, b.seedConceptItemIds],
      )
    ).rows[0].n !== b.seedConceptItemIds.length
  )
    issues.push({
      field: "seedConceptItemIds",
      message: "選択したKitからSB初期概念を1件以上選んでください。",
    });
  // Required by the already approved foundation's integer/non-null contract,
  // not a recommendation of any experimental duration. No default is supplied.
  if (b.integrationSeconds === null)
    issues.push({
      field: "integrationSeconds",
      message:
        "統合制限時間を1〜2,147,483,647の整数秒で設定してください（保存形式の上限）。",
    });
  return issues;
}
async function getLocked(c: PoolClient, id: string) {
  const r = (
    await c.query<Row>(
      "SELECT * FROM material_catalog_versions WHERE id=$1 FOR UPDATE",
      [id],
    )
  ).rows[0];
  if (!r) throw new MaterialError("not_found", 404);
  return r;
}
/** Idempotent writes own the entire transaction, including foundation and audit. */
export async function mutateMaterial(
  pool: Pool,
  actor: Actor,
  action: "CREATE" | "SAVE" | "PUBLISH" | "NEXT",
  key: unknown,
  id: unknown,
  payload: unknown,
) {
  requireResearcher(actor);
  if (
    !isMaterialId(key) ||
    (action !== "CREATE" && !isMaterialId(id)) ||
    !object(payload)
  )
    throw new MaterialError("material_invalid_request");
  if (action === "CREATE" || action === "NEXT") {
    if (Object.keys(payload).length)
      throw new MaterialError("material_invalid_request");
  } else if (
    Object.keys(payload).sort().join() !==
      (action === "SAVE" ? ["body", "expectedRevision"] : ["expectedRevision"])
        .sort()
        .join() ||
    !Number.isInteger(payload.expectedRevision) ||
    Number(payload.expectedRevision) < 1
  )
    throw new MaterialError("material_invalid_request");
  const body = action === "SAVE" ? parseMaterialBody(payload.body) : undefined;
  const hash = digest({ action, id: action === "CREATE" ? null : id, payload });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "material:" + key,
    ]);
    const previous = (
      await c.query(
        "SELECT * FROM material_catalog_requests WHERE request_key=$1",
        [key],
      )
    ).rows[0];
    if (previous) {
      if (previous.action !== action || previous.request_hash !== hash)
        throw new MaterialError("material_revision_conflict", 409);
      await c.query("COMMIT");
      return previous.result;
    }
    let row: Row;
    if (action === "CREATE") {
      const series = (
        await c.query(
          "INSERT INTO material_catalog_series DEFAULT VALUES RETURNING id",
        )
      ).rows[0].id;
      row = (
        await c.query<Row>(
          "INSERT INTO material_catalog_versions(series_id,version_number,body) VALUES($1,1,$2) RETURNING *",
          [series, empty()],
        )
      ).rows[0];
    } else if (action === "NEXT") {
      // All next-version writers take the series lock before any version lock.
      const source = (
        await c.query<Row>(
          "SELECT * FROM material_catalog_versions WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!source) throw new MaterialError("not_found", 404);
      if (source.state !== "PUBLISHED")
        throw new MaterialError("material_revision_conflict", 409);
      await c.query(
        "SELECT id FROM material_catalog_series WHERE id=$1 FOR UPDATE",
        [source.series_id],
      );
      if (
        (
          await c.query(
            "SELECT 1 FROM material_catalog_versions WHERE series_id=$1 AND state='DRAFT'",
            [source.series_id],
          )
        ).rowCount
      )
        throw new MaterialError("material_draft_exists", 409);
      await safeBody(c, source.body);
      row = (
        await c.query<Row>(
          "INSERT INTO material_catalog_versions(series_id,version_number,body,base_version_id) SELECT $1,max(version_number)+1,$2,$3 FROM material_catalog_versions WHERE series_id=$1 RETURNING *",
          [source.series_id, source.body, source.id],
        )
      ).rows[0];
    } else {
      row = await getLocked(c, id as string);
      if (row.state !== "DRAFT")
        throw new MaterialError("material_immutable", 409);
      if (row.edit_revision !== payload.expectedRevision)
        throw new MaterialError("material_revision_conflict", 409);
      if (action === "SAVE") {
        await safeBody(c, body!);
        row = (
          await c.query<Row>(
            "UPDATE material_catalog_versions SET body=$2,edit_revision=edit_revision+1 WHERE id=$1 RETURNING *",
            [id, body],
          )
        ).rows[0];
      } else {
        const safety = await safeBody(c, row.body);
        const issues = await materialIssues(c, row.body, safety);
        if (issues.length)
          throw new MaterialError("material_not_ready", 422, issues);
        const b = row.body;
        const foundation = await publishMaterialVersionInTransaction(c, actor, {
          requestKey: key,
          title: b.title,
          videoRef: b.videoRef,
          sbInstructions: b.sbInstructions,
          kbInstructions: b.kbInstructions,
          integrationInstructions: b.integrationInstructions,
          kitId: b.kitId!,
          seedConceptItemIds: b.seedConceptItemIds,
          integrationSeconds: b.integrationSeconds!,
        });
        row = (
          await c.query<Row>(
            "UPDATE material_catalog_versions SET state='PUBLISHED',foundation_version_id=$2,completed_at=clock_timestamp(),edit_revision=edit_revision+1 WHERE id=$1 RETURNING *",
            [id, foundation],
          )
        ).rows[0];
      }
    }
    const output = result(row);
    await c.query(
      "INSERT INTO material_catalog_requests(request_key,action,request_hash,version_id,result) VALUES($1,$2,$3,$4,$5)",
      [key, action, hash, row.id, output],
    );
    await writeMaterialAudit(
      c,
      action,
      row.id,
      action === "CREATE" || action === "NEXT" ? 201 : 200,
      "ok",
    );
    await c.query("COMMIT");
    return output;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw materialFailure(e);
  } finally {
    c.release();
  }
}
export async function readMaterial(pool: Pool, actor: Actor, id: unknown) {
  requireResearcher(actor);
  if (!isMaterialId(id)) throw new MaterialError("not_found", 404);
  const r = (
    await pool.query<Row>(
      "SELECT * FROM material_catalog_versions WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!r) throw new MaterialError("not_found", 404);
  const testStatus = (
    await pool.query(
      `SELECT CASE WHEN EXISTS(SELECT 1 FROM r05_submission_acceptances WHERE material_version_id=$1) THEN 'COMPLETED' WHEN EXISTS(SELECT 1 FROM r05_test_runs WHERE material_version_id=$1) THEN 'IN_PROGRESS' ELSE 'NOT_TESTED' END AS status`,
      [id],
    )
  ).rows[0].status;
  return (await loadResearchTextSafety(pool)).redact({ ...dto(r), testStatus });
}
export async function listMaterials(pool: Pool, actor: Actor) {
  requireResearcher(actor);
  const rows = (
    await pool.query(
      `SELECT id,series_id AS "seriesId",version_number AS version,state,body->>'title' AS title,foundation_version_id AS "foundationVersionId",updated_at AS "updatedAt",completed_at AS "completedAt" FROM material_catalog_versions ORDER BY created_at DESC,id`,
    )
  ).rows;
  return (await loadResearchTextSafety(pool)).redact({ versions: rows });
}
export async function materialAssets(pool: Pool, actor: Actor) {
  requireResearcher(actor);
  const rows = (
    await pool.query(`SELECT k.id AS "kitId",k.name AS "kitName",m.id AS "goalMapId",m.title AS "goalTitle",material_catalog_kit_available(k.id) AS available,experiment_asset_is_frozen(m.id) AS frozen,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'label',c.label) ORDER BY c.created_at,i.id) FROM kit_concept_items i JOIN concepts c ON c.id=i.source_concept_id WHERE i.kit_definition_id=k.id),'[]'::jsonb) AS concepts FROM kit_definitions k JOIN maps m ON m.id=k.goal_map_id ORDER BY k.created_at DESC,k.id`)
  ).rows;
  return (await loadResearchTextSafety(pool)).redact({ assets: rows });
}
export async function checkMaterial(pool: Pool, actor: Actor, id: unknown) {
  requireResearcher(actor);
  if (!isMaterialId(id)) throw new MaterialError("not_found", 404);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const row = await getLocked(c, id);
    const safety = await safeBody(c, row.body);
    const issues = await materialIssues(c, row.body, safety);
    await writeMaterialAudit(c, "CHECK", row.id, 200, "ok");
    await c.query("COMMIT");
    return {
      editRevision: row.edit_revision,
      ready: issues.length === 0,
      issues,
      testRun: row.state === "PUBLISHED" ? "AVAILABLE" : "PUBLISHED_REQUIRED",
    };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw materialFailure(e);
  } finally {
    c.release();
  }
}
