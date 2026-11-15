import { experimentPreviewEnabled } from "./experiment-execution.js";
import type { Pool, PoolClient } from "pg";
import {
  createLearnerToken,
  tokenHash,
  type principalOf,
} from "./access-control.js";
import {
  registerExperimentSessionInTransaction,
  FoundationError,
  EXPERIMENT_PROTOCOL,
} from "./experiment-foundation.js";
import {
  getManagedRun,
  RunManagementError,
} from "./experiment-run-management.js";
import { isMaterialId } from "./material-catalog.js";
import { digest } from "./delivery-reliability.js";
import {
  loadResearchTextSafety,
  ResearchSafetyError,
} from "./research-output-safety.js";
import { validMapLabel } from "./research-event-map-v2.js";
type Actor = ReturnType<typeof principalOf>;
type DB = Pick<PoolClient, "query">;
export type ExperimentProof = {
  sessionId: string;
  runId: string;
  kitId: string;
  credentialHash: string;
  credentialGeneration: number;
};
export type AccessAction =
  "REGISTER" | "ISSUE" | "REISSUE" | "SWITCH" | "CLAIM" | "VIEW";
export class ParticipantAccessError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
const fail = (code: string, status: number): never => {
  throw new ParticipantAccessError(code, status);
};
export const experimentFlowMessage =
  "新しい学習者フローは未公開です。研究者の模擬検証用です。実参加者へのコード配布・実施開始はできません。";
export function participantFailure(error: unknown) {
  if (
    error instanceof ParticipantAccessError ||
    error instanceof ResearchSafetyError
  )
    return error;
  if (error instanceof RunManagementError && error.code === "not_found")
    return new ParticipantAccessError("not_found", 404);
  if (error instanceof FoundationError && error.code.includes("sensitive"))
    return new ParticipantAccessError("access_sensitive_text", 422);
  if (
    (error instanceof FoundationError && error.code.includes("idempotency")) ||
    ["23505", "40001", "40P01"].includes(
      (error as { code?: string })?.code ?? "",
    )
  )
    return new ParticipantAccessError("access_conflict", 409);
  return new ParticipantAccessError("access_storage_unavailable", 503);
}
export async function writeAccessAudit(
  c: DB,
  action: AccessAction,
  run: string | null,
  session: string | null,
  status: number,
  code: string,
  actor = "RESEARCHER",
) {
  await c.query(
    "INSERT INTO experiment_access_audit(action,run_id,session_id,actor_type,http_status,outcome,reason,reason_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      action,
      run,
      session,
      actor,
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
export async function authenticateExperimentToken(
  pool: Pool,
  hash: string,
): Promise<ExperimentProof | null> {
  const row = (
    await pool.query(
      `SELECT s.id AS "sessionId",p.run_id AS "runId",s.research_kit_definition_id AS "kitId",a.code_hash AS "credentialHash",a.credential_generation AS "credentialGeneration" FROM experiment_participant_access a JOIN sessions s ON s.id=a.session_id JOIN experiment_run_sessions p ON p.session_id=s.id JOIN experiment_run_catalog x ON x.run_id=p.run_id JOIN experiment_runs r ON r.id=p.run_id JOIN experiment_material_versions v ON v.id=r.material_version_id WHERE a.code_hash=$1 AND s.protocol_key=$2 AND s.research_kit_definition_id=v.kit_id AND s.group_activity_seconds=v.integration_seconds`,
      [hash, EXPERIMENT_PROTOCOL],
    )
  ).rows[0];
  if (row) return row;
  if (
    (
      await pool.query(
        "SELECT 1 FROM experiment_retired_credentials WHERE token_hash=$1",
        [hash],
      )
    ).rowCount
  )
    fail("experiment_code_invalidated", 401);
  return null;
}
/** Lock held through commit; reissue and switch use the same access row. Future
 * learning handlers must call this in their own transaction, never trust auth alone. */
export async function lockExperimentProof(
  c: PoolClient,
  proof: ExperimentProof,
) {
  const row = (
    await c.query(
      `SELECT a.*,p.run_id,r.state FROM experiment_participant_access a JOIN sessions s ON s.id=a.session_id JOIN experiment_run_sessions p ON p.session_id=s.id JOIN experiment_run_catalog x ON x.run_id=p.run_id JOIN experiment_runs r ON r.id=p.run_id WHERE a.session_id=$1 AND p.run_id=$2 AND s.protocol_key=$3 FOR UPDATE OF a FOR SHARE OF r,s`,
      [proof.sessionId, proof.runId, EXPERIMENT_PROTOCOL],
    )
  ).rows[0];
  if (
    !row ||
    row.code_hash !== proof.credentialHash ||
    row.credential_generation !== proof.credentialGeneration
  )
    fail("experiment_code_invalidated", 401);
  return row;
}
export async function lockCurrentExperimentClient(
  c: PoolClient,
  proof: ExperimentProof,
  secret: unknown,
  generation: unknown,
) {
  const row = await lockExperimentProof(c, proof);
  if (
    typeof secret !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
    !Number.isInteger(generation) ||
    generation !== row.device_generation
  )
    fail("experiment_client_stale", 409);
  const client = (
    await c.query(
      "SELECT 1 FROM experiment_client_candidates WHERE id=$1 AND session_id=$2 AND credential_generation=$3 AND client_hash=$4",
      [
        row.active_client_id,
        proof.sessionId,
        proof.credentialGeneration,
        tokenHash(secret as string),
      ],
    )
  ).rowCount;
  if (!client) fail("experiment_client_stale", 409);
  return row;
}
export async function claimExperimentClient(
  pool: Pool,
  proof: ExperimentProof,
  secret: unknown,
) {
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret))
    fail("access_invalid_request", 400);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const row = await lockExperimentProof(c, proof),
      hash = tokenHash(secret as string);
    let client = (
      await c.query(
        "SELECT id FROM experiment_client_candidates WHERE session_id=$1 AND credential_generation=$2 AND client_hash=$3",
        [proof.sessionId, proof.credentialGeneration, hash],
      )
    ).rows[0];
    if (!client)
      client = (
        await c.query(
          "INSERT INTO experiment_client_candidates(session_id,credential_generation,client_hash) VALUES($1,$2,$3) RETURNING id",
          [proof.sessionId, proof.credentialGeneration, hash],
        )
      ).rows[0];
    if (!row.active_client_id) {
      await c.query(
        "UPDATE experiment_participant_access SET active_client_id=$2 WHERE session_id=$1",
        [proof.sessionId, client.id],
      );
      row.active_client_id = client.id;
    }
    const own = row.active_client_id === client.id,
      status = own ? 200 : 409;
    await writeAccessAudit(
      c,
      "CLAIM",
      proof.runId,
      proof.sessionId,
      status,
      own ? "ok" : "experiment_client_in_use",
      "LEARNER",
    );
    await c.query("COMMIT");
    return {
      status,
      payload: {
        clientId: client.id,
        deviceGeneration: own ? row.device_generation : null,
        ownership: own ? "OWNED" : "PENDING",
        flowAvailable: false,
        ...(!own ? { error: "experiment_client_in_use" } : {}),
        message: own
          ? experimentFlowMessage
          : "別の画面が使用中です。この画面識別子を研究者に伝え、切替を依頼してください。",
      },
    };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw participantFailure(e);
  } finally {
    c.release();
  }
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export async function mutateParticipant(
  pool: Pool,
  actor: Actor,
  action: "REGISTER" | "ISSUE" | "REISSUE" | "SWITCH",
  key: unknown,
  runId: unknown,
  sessionId: unknown,
  input: unknown,
) {
  if (actor.role !== "researcher") fail("not_found", 404);
  if (
    !isMaterialId(key) ||
    !isMaterialId(runId) ||
    !object(input) ||
    (action !== "REGISTER" && !isMaterialId(sessionId))
  )
    fail("access_invalid_request", 400);
  const b = input as Record<string, unknown>,
    fields =
      action === "REGISTER"
        ? ["participantLabel"]
        : action === "SWITCH"
          ? ["clientId", "expectedDeviceGeneration"]
          : ["expectedCredentialGeneration"];
  if (Object.keys(b).sort().join() !== fields.sort().join())
    fail("access_invalid_request", 400);
  if (
    action === "REGISTER" &&
    (typeof b.participantLabel !== "string" ||
      !b.participantLabel.trim() ||
      b.participantLabel.length > 64 ||
      !validMapLabel(b.participantLabel))
  )
    fail("access_invalid_request", 400);
  if (
    action === "SWITCH" &&
    (!isMaterialId(b.clientId) ||
      !Number.isInteger(b.expectedDeviceGeneration) ||
      Number(b.expectedDeviceGeneration) < 1)
  )
    fail("access_invalid_request", 400);
  if (
    (action === "ISSUE" || action === "REISSUE") &&
    (!Number.isInteger(b.expectedCredentialGeneration) ||
      Number(b.expectedCredentialGeneration) < 0 ||
      (action === "ISSUE"
        ? b.expectedCredentialGeneration !== 0
        : b.expectedCredentialGeneration === 0))
  )
    fail("access_invalid_request", 400);
  const requestKey = (key as string).toLowerCase(),
    run = (runId as string).toLowerCase(),
    hash = digest({
      action,
      run,
      session: action === "REGISTER" ? null : sessionId,
      input,
    });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "experiment-access:" + requestKey,
    ]);
    const previous = (
      await c.query(
        "SELECT * FROM experiment_access_operations WHERE request_key=$1",
        [requestKey],
      )
    ).rows[0];
    if (previous) {
      if (previous.request_hash !== hash || previous.action !== action)
        fail("access_conflict", 409);
      await c.query("COMMIT");
      return {
        ...previous.result,
        issuedCode: null,
        codeDelivery: "NOT_REPLAYED",
      };
    }
    if (
      !(
        await c.query(
          "SELECT 1 FROM experiment_runs r JOIN experiment_run_catalog x ON x.run_id=r.id WHERE r.id=$1 AND r.state IN ('PREPARING','RUNNING') FOR SHARE OF r",
          [run],
        )
      ).rowCount
    )
      fail("not_found", 404);
    let sid = sessionId as string;
    if (action === "REGISTER") {
      const safety = await loadResearchTextSafety(c);
      if (safety.containsSecret(b.participantLabel as string))
        fail("access_sensitive_text", 422);
      sid = await registerExperimentSessionInTransaction(c, actor, {
        requestKey,
        runId: run,
        participantLabel: (b.participantLabel as string).trim(),
      });
    } else if (
      !(
        await c.query(
          "SELECT 1 FROM sessions s JOIN experiment_run_sessions p ON p.session_id=s.id WHERE s.id=$1 AND p.run_id=$2 AND s.protocol_key=$3",
          [sid, run, EXPERIMENT_PROTOCOL],
        )
      ).rowCount
    )
      fail("not_found", 404);
    // Also serializes first issuance where no access row exists yet.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "experiment-session:" + sid,
    ]);
    let access = (
      await c.query(
        "SELECT * FROM experiment_participant_access WHERE session_id=$1 FOR UPDATE",
        [sid],
      )
    ).rows[0];
    let issuedCode: string | null = null;
    if (action === "REGISTER" || action === "ISSUE") {
      if (access) fail("access_conflict", 409);
      const code = createLearnerToken();
      issuedCode = code.token;
      access = (
        await c.query(
          "INSERT INTO experiment_participant_access(session_id,code_hash) VALUES($1,$2) RETURNING *",
          [sid, code.hash],
        )
      ).rows[0];
    } else {
      if (!access) fail("access_conflict", 409);
      if (action === "REISSUE") {
        if (access.credential_generation !== b.expectedCredentialGeneration)
          fail("access_conflict", 409);
        const code = createLearnerToken();
        issuedCode = code.token;
        await c.query(
          "INSERT INTO experiment_retired_credentials(token_hash,session_id,credential_generation) VALUES($1,$2,$3)",
          [access.code_hash, sid, access.credential_generation],
        );
        access = (
          await c.query(
            "UPDATE experiment_participant_access SET code_hash=$2,credential_generation=credential_generation+1,device_generation=device_generation+1,active_client_id=NULL WHERE session_id=$1 RETURNING *",
            [sid, code.hash],
          )
        ).rows[0];
      } else {
        const targetClient = (b.clientId as string).toLowerCase();
        if (
          access.device_generation !== b.expectedDeviceGeneration ||
          access.active_client_id === targetClient
        )
          fail("access_conflict", 409);
        if (
          !(
            await c.query(
              "SELECT 1 FROM experiment_client_candidates WHERE id=$1 AND session_id=$2 AND credential_generation=$3",
              [targetClient, sid, access.credential_generation],
            )
          ).rowCount
        )
          fail("not_found", 404);
        access = (
          await c.query(
            "UPDATE experiment_participant_access SET active_client_id=$2,device_generation=device_generation+1 WHERE session_id=$1 RETURNING *",
            [sid, targetClient],
          )
        ).rows[0];
      }
    }
    const result = {
      sessionId: sid,
      runId: run,
      credentialGeneration: access.credential_generation,
      deviceGeneration: access.device_generation,
      activeClientId: access.active_client_id,
    };
    await c.query(
      "INSERT INTO experiment_access_operations(request_key,action,run_id,session_id,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)",
      [requestKey, action, run, sid, hash, result],
    );
    await writeAccessAudit(
      c,
      action,
      run,
      sid,
      action === "REGISTER" ? 201 : 200,
      "ok",
    );
    await c.query("COMMIT");
    return {
      ...result,
      issuedCode,
      codeDelivery: issuedCode ? "ISSUED_ONCE" : "NOT_APPLICABLE",
    };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw participantFailure(e);
  } finally {
    c.release();
  }
}
export async function participantView(
  pool: Pool,
  actor: Actor,
  runId: unknown,
) {
  if (actor.role !== "researcher") fail("not_found", 404);
  if (!isMaterialId(runId)) fail("not_found", 404);
  const run = await getManagedRun(pool, actor, runId);
  const participants = (
    await pool.query(
      `SELECT s.id,s.participant_code AS label,s.status,p.registered_at AS "registeredAt",coalesce(a.credential_generation,0) AS "credentialGeneration",coalesce(a.device_generation,0) AS "deviceGeneration",a.active_client_id AS "activeClientId",(SELECT count(*)::int FROM session_stages st WHERE st.session_id=s.id AND st.status='COMPLETED') AS "completedStages",active.active_stage_count AS "activeStageCount",active.current_stage_type AS "currentStageType",
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'createdAt',c.created_at) ORDER BY c.created_at,c.id) FROM experiment_client_candidates c WHERE c.session_id=s.id AND c.credential_generation=a.credential_generation),'[]'::jsonb) AS clients
 FROM experiment_run_sessions p JOIN sessions s ON s.id=p.session_id LEFT JOIN experiment_participant_access a ON a.session_id=s.id
 LEFT JOIN LATERAL (SELECT count(*)::int AS active_stage_count,CASE WHEN count(*)=1 THEN (array_agg(st.stage_type ORDER BY st.order_index))[1] END AS current_stage_type FROM session_stages st WHERE st.session_id=s.id AND st.status='IN_PROGRESS') active ON true
 WHERE p.run_id=$1 AND s.protocol_key=$2 ORDER BY p.registered_at,s.id`,
      [runId, EXPERIMENT_PROTOCOL],
    )
  ).rows;
  return (await loadResearchTextSafety(pool)).redact({
    run,
    participants,
    learnerFlowAvailable: experimentPreviewEnabled(),
    startAvailable: experimentPreviewEnabled(),
    message: experimentFlowMessage,
  });
}
