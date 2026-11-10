import type { Pool, PoolClient } from "pg";
import type { principalOf } from "./access-control.js";
import { digest } from "./delivery-reliability.js";
import { validMapLabel } from "./research-event-map-v2.js";
import {
  ResearchSafetyError,
  loadResearchTextSafety,
} from "./research-output-safety.js";

export const EXPERIMENT_PROTOCOL = "SBKB_INTEGRATION_V1";
type Actor = ReturnType<typeof principalOf>;
type Database = Pool | PoolClient;
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
export class FoundationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new FoundationError(code);
};
const researcher = (actor: Actor) => {
  if (actor.role !== "researcher") fail("foundation_forbidden");
};
async function transaction<T>(
  pool: Database,
  work: (c: PoolClient) => Promise<T>,
): Promise<T> {
  if ("release" in pool) return work(pool);
  const c = await pool
    .connect()
    .catch(() => fail("foundation_storage_unavailable"));
  try {
    await c.query("BEGIN");
    const value = await work(c);
    await c.query("COMMIT");
    return value;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    if (e instanceof FoundationError || e instanceof ResearchSafetyError)
      throw e;
    throw new FoundationError("foundation_storage_failed");
  } finally {
    c.release();
  }
}
async function receipt(
  c: PoolClient,
  table: string,
  key: string,
  input: unknown,
) {
  if (!uuid(key)) fail("foundation_invalid_request_key");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "foundation:" + table + ":" + key,
  ]);
  const hash = digest(input);
  // table is supplied only by the three internal functions below.
  const previous = (
    await c.query(`SELECT * FROM ${table} WHERE request_key=$1`, [key])
  ).rows[0];
  if (previous && previous.request_hash !== hash)
    fail("foundation_idempotency_conflict");
  return { previous, hash };
}
function text(v: unknown, max: number): v is string {
  return (
    typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= max
  );
}
export type MaterialInput = {
  requestKey: string;
  title: string;
  videoRef: string;
  sbInstructions: string;
  kbInstructions: string;
  integrationInstructions: string;
  kitId: string;
  seedConceptItemIds: string[];
  integrationSeconds: number;
};
/** Internal only: no route, token issuance, mutable draft, or default study content. */
async function publishMaterialVersionImpl(
  pool: Database,
  actor: Actor,
  input: MaterialInput,
): Promise<string> {
  researcher(actor);
  if (
    !input ||
    Object.keys(input).sort().join() !==
      [
        "requestKey",
        "title",
        "videoRef",
        "sbInstructions",
        "kbInstructions",
        "integrationInstructions",
        "kitId",
        "seedConceptItemIds",
        "integrationSeconds",
      ]
        .sort()
        .join() ||
    !text(input.title, 120) ||
    !validMapLabel(input.title) ||
    !text(input.videoRef, 2048) ||
    !/^(https?:\/\/|\/(?!\/))/.test(input.videoRef) ||
    !uuid(input.kitId) ||
    ![
      input.sbInstructions,
      input.kbInstructions,
      input.integrationInstructions,
    ].every((x) => text(x, 10000)) ||
    !Number.isInteger(input.integrationSeconds) ||
    input.integrationSeconds <= 0 ||
    input.integrationSeconds > 2147483647 ||
    !Array.isArray(input.seedConceptItemIds) ||
    !input.seedConceptItemIds.length ||
    !input.seedConceptItemIds.every(uuid) ||
    new Set(input.seedConceptItemIds).size !== input.seedConceptItemIds.length
  )
    fail("foundation_invalid_material");
  const normal = {
    ...input,
    seedConceptItemIds: [...input.seedConceptItemIds].sort(),
  };
  return transaction(pool, async (c) => {
    const { previous, hash } = await receipt(
      c,
      "experiment_material_versions",
      input.requestKey,
      normal,
    );
    if (previous) return previous.id as string;
    const kit = (
      await c.query("SELECT goal_map_id FROM kit_definitions WHERE id=$1", [
        input.kitId,
      ])
    ).rows[0];
    if (!kit) fail("foundation_invalid_kit");
    await c.query("SELECT experiment_lock_asset($1)", [kit.goal_map_id]);
    const labels = (
      await c.query(
        "SELECT label FROM concepts WHERE map_id=$1 UNION ALL SELECT label FROM links WHERE map_id=$1",
        [kit.goal_map_id],
      )
    ).rows.map((x) => x.label as string);
    if (labels.some((x) => !validMapLabel(x)))
      fail("foundation_invalid_asset_label");
    const safety = await loadResearchTextSafety(c);
    if (
      [
        input.title,
        input.videoRef,
        input.sbInstructions,
        input.kbInstructions,
        input.integrationInstructions,
        ...labels,
      ].some(safety.containsSecret)
    )
      fail("foundation_sensitive_text");
    const row = (
      await c.query(
        `INSERT INTO experiment_material_versions(request_key,request_hash,title,video_ref,sb_instructions,kb_instructions,integration_instructions,kit_id,integration_seconds)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          input.requestKey,
          hash,
          input.title,
          input.videoRef,
          input.sbInstructions,
          input.kbInstructions,
          input.integrationInstructions,
          input.kitId,
          input.integrationSeconds,
        ],
      )
    ).rows[0];
    for (const id of normal.seedConceptItemIds)
      await c.query("INSERT INTO experiment_material_seeds VALUES($1,$2)", [
        row.id,
        id,
      ]);
    return row.id as string;
  });
}
async function createExperimentRunImpl(
  pool: Database,
  actor: Actor,
  input: {
    requestKey: string;
    materialVersionId: string;
    plannedParticipants: number;
    participants?: Array<{ requestKey: string; participantLabel: string }>;
  },
  requireNew = false,
): Promise<string> {
  researcher(actor);
  if (
    !input ||
    Object.keys(input).some(
      (k) =>
        ![
          "requestKey",
          "materialVersionId",
          "plannedParticipants",
          "participants",
        ].includes(k),
    ) ||
    !uuid(input.materialVersionId) ||
    !Number.isInteger(input.plannedParticipants) ||
    input.plannedParticipants < 0 ||
    input.plannedParticipants > 2147483647
  )
    fail("foundation_invalid_run");
  if (
    input.participants !== undefined &&
    (!Array.isArray(input.participants) ||
      new Set(input.participants.map((p) => p.requestKey)).size !==
        input.participants.length)
  )
    fail("foundation_invalid_participants");
  return transaction(pool, async (c) => {
    const { previous, hash } = await receipt(
      c,
      "experiment_runs",
      input.requestKey,
      input,
    );
    if (previous) {
      if (requireNew) fail("foundation_idempotency_conflict");
      return previous.id as string;
    }
    const id = (
      await c.query(
        "INSERT INTO experiment_runs(request_key,request_hash,material_version_id,planned_participants) VALUES($1,$2,$3,$4) RETURNING id",
        [
          input.requestKey,
          hash,
          input.materialVersionId,
          input.plannedParticipants,
        ],
      )
    ).rows[0].id as string;
    for (const p of input.participants ?? [])
      await registerExperimentSessionImpl(c, actor, { ...p, runId: id });
    return id;
  });
}
async function registerExperimentSessionImpl(
  pool: Database,
  actor: Actor,
  input: { requestKey: string; runId: string; participantLabel: string },
  requireNew = false,
): Promise<string> {
  researcher(actor);
  if (
    !input ||
    Object.keys(input).sort().join() !==
      ["requestKey", "runId", "participantLabel"].sort().join() ||
    !uuid(input.runId) ||
    !text(input.participantLabel, 64) ||
    !validMapLabel(input.participantLabel)
  )
    fail("foundation_invalid_participant");
  return transaction(pool, async (c) => {
    const { previous, hash } = await receipt(
      c,
      "experiment_run_sessions",
      input.requestKey,
      input,
    );
    if (previous) {
      if (requireNew) fail("foundation_idempotency_conflict");
      return previous.session_id as string;
    }
    if (
      (await loadResearchTextSafety(c)).containsKnownSecret(
        input.participantLabel,
      )
    )
      fail("foundation_sensitive_text");
    const v = (
      await c.query(
        `SELECT v.* FROM experiment_runs r JOIN experiment_material_versions v ON v.id=r.material_version_id WHERE r.id=$1 FOR SHARE OF r`,
        [input.runId],
      )
    ).rows[0];
    if (!v) fail("foundation_run_not_found");
    const id = (
      await c.query(
        `INSERT INTO sessions(protocol_key,participant_code,lesson_video_url,research_kit_definition_id,group_activity_seconds)
      VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [
          EXPERIMENT_PROTOCOL,
          input.participantLabel,
          v.video_ref,
          v.kit_id,
          v.integration_seconds,
        ],
      )
    ).rows[0].id as string;
    await c.query(
      "INSERT INTO experiment_run_sessions(session_id,run_id,request_key,request_hash) VALUES($1,$2,$3,$4)",
      [id, input.runId, input.requestKey, hash],
    );
    for (const [index, type] of [
      "LESSON",
      "PRIOR_MAP",
      "KB_MAP",
      "INTEGRATION_MAP",
    ].entries())
      await c.query(
        "INSERT INTO session_stages(session_id,stage_type,order_index) VALUES($1,$2,$3)",
        [id, type, index],
      );
    await c.query(
      "INSERT INTO session_seed_concepts SELECT $1,kit_concept_item_id FROM experiment_material_seeds WHERE version_id=$2",
      [id, v.id],
    );
    return id;
  });
}
export async function getMaterialVersion(
  pool: Database,
  actor: Actor,
  id: string,
) {
  researcher(actor);
  if (!uuid(id)) fail("foundation_invalid_id");
  const row =
    (
      await pool.query(
        `SELECT id,title,video_ref,sb_instructions,kb_instructions,integration_instructions,kit_id,integration_seconds,created_at,
    ARRAY(SELECT kit_concept_item_id FROM experiment_material_seeds WHERE version_id=v.id ORDER BY kit_concept_item_id) AS seed_concept_item_ids FROM experiment_material_versions v WHERE id=$1`,
        [id],
      )
    ).rows[0] ?? null;
  return row ? (await loadResearchTextSafety(pool)).redact(row) : null;
}
export async function getExperimentRun(
  pool: Database,
  actor: Actor,
  id: string,
) {
  researcher(actor);
  if (!uuid(id)) fail("foundation_invalid_id");
  return (
    (
      await pool.query(
        `SELECT id,material_version_id,planned_participants,state,created_at,
    (SELECT count(*)::int FROM experiment_run_sessions WHERE run_id=r.id) AS registered_participants FROM experiment_runs r WHERE id=$1`,
        [id],
      )
    ).rows[0] ?? null
  );
}
/** Ownership comes from principal + actual FK joins, never a submitted run ID. */
export async function resolveExperimentOwnership(
  pool: Database,
  actor: Actor,
  kind: "sessions" | "session-stages" | "maps",
  id: string,
) {
  if (!uuid(id)) return null;
  const lookup = {
    sessions: "sessions s",
    "session-stages": "session_stages st JOIN sessions s ON s.id=st.session_id",
    maps: "maps m JOIN session_stages st ON st.id=m.session_stage_id JOIN sessions s ON s.id=st.session_id",
  }[kind];
  const alias = { sessions: "s", "session-stages": "st", maps: "m" }[kind];
  const row = (
    await pool.query(
      `SELECT s.id AS session_id,p.run_id,r.material_version_id FROM ${lookup} JOIN experiment_run_sessions p ON p.session_id=s.id JOIN experiment_runs r ON r.id=p.run_id
    WHERE ${alias}.id=$1 AND s.protocol_key=$2 AND ($3::uuid IS NULL OR s.id=$3)`,
      [
        id,
        EXPERIMENT_PROTOCOL,
        actor.role === "learner" ? actor.sessionId : null,
      ],
    )
  ).rows[0];
  return row ?? null;
}

// Standalone internal-service entry points own their transaction. The named
// composition boundary below is only for a caller-owned catalog transaction.
/** Composition boundary for catalog publication. Caller owns BEGIN/COMMIT and
 * must roll back catalog metadata, version, seeds and audit as one operation. */
export function publishMaterialVersionInTransaction(
  client: PoolClient,
  actor: Actor,
  input: MaterialInput,
) {
  return publishMaterialVersionImpl(client, actor, input);
}
export function publishMaterialVersion(
  pool: Pool,
  actor: Actor,
  input: MaterialInput,
) {
  if ("release" in pool) fail("foundation_pool_required");
  return publishMaterialVersionImpl(pool, actor, input);
}
export function createExperimentRun(
  pool: Pool,
  actor: Actor,
  input: Parameters<typeof createExperimentRunImpl>[2],
) {
  if ("release" in pool) fail("foundation_pool_required");
  return createExperimentRunImpl(pool, actor, input);
}
/** R06 composition: the caller owns the full run/name/audit transaction.
 * Existing standalone requests are never silently adopted as managed runs. */
export function createExperimentRunInTransaction(
  client: PoolClient,
  actor: Actor,
  input: { requestKey: string; materialVersionId: string; plannedParticipants: number },
) {
  return createExperimentRunImpl(client, actor, input, true);
}
export function registerExperimentSession(
  pool: Pool,
  actor: Actor,
  input: Parameters<typeof registerExperimentSessionImpl>[2],
) {
  if ("release" in pool) fail("foundation_pool_required");
  return registerExperimentSessionImpl(pool, actor, input);
}
/** Caller owns Session/Stage/membership/access/receipt/audit transaction. */
export function registerExperimentSessionInTransaction(
  client: PoolClient, actor: Actor,
  input: {requestKey:string;runId:string;participantLabel:string},
) { return registerExperimentSessionImpl(client,actor,input,true); }
export async function getExperimentSession(
  pool: Pool,
  actor: Actor,
  id: string,
) {
  researcher(actor);
  if (!uuid(id)) fail("foundation_invalid_id");
  return (
    (
      await pool.query(
        `SELECT s.id,p.run_id,r.material_version_id,s.protocol_key,s.status,s.lesson_video_url,s.research_kit_definition_id,s.group_activity_seconds,
    (SELECT jsonb_agg(jsonb_build_object('id',st.id,'type',st.stage_type,'status',st.status,'order',st.order_index) ORDER BY st.order_index) FROM session_stages st WHERE st.session_id=s.id) AS stages
    FROM sessions s JOIN experiment_run_sessions p ON p.session_id=s.id JOIN experiment_runs r ON r.id=p.run_id WHERE s.id=$1 AND s.protocol_key=$2`,
        [id, EXPERIMENT_PROTOCOL],
      )
    ).rows[0] ?? null
  );
}
