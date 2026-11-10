import { experimentPreviewEnabled, validateExperimentRequest, experimentRequestContext } from "./experiment-execution.js";
import { operationGate, committedReceipt } from "./delivery-reliability.js";
import {authenticateExperimentToken,ParticipantAccessError,experimentFlowMessage,type ExperimentProof} from "./experiment-participant-access.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Pool, PoolClient } from "pg";

type Principal = { role: "researcher" } | { role: "learner"; sessionId: string; kitId: string; experiment?:ExperimentProof };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const configuredResearcherToken = process.env.RESEARCHER_API_TOKEN;
if (!configuredResearcherToken || configuredResearcherToken.length < 32) {
  throw new Error("RESEARCHER_API_TOKEN must be a secret of at least 32 characters");
}
const researcherHash = tokenHash(configuredResearcherToken);

export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createLearnerToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: tokenHash(token) };
}

export async function storeLearnerToken(client: PoolClient, sessionId: string, hash: string) {
  await client.query(
    "UPDATE sessions SET learner_access_token_hash=$2 WHERE id=$1::uuid AND protocol_key IN ('STAGE1_4','STAGE1_6','STAGE1_5', 'SBKB_INTEGRATION_V1')",
    [sessionId, hash],
  );
}

export function principalOf(response: Response): Principal {
  return response.locals.principal as Principal;
}

async function ownerFor(pool: Pool, kind: string, id: string) {
  if (!uuid.test(id)) return null;
  const joins: Record<string, string> = {
    sessions: "sessions s",
    "session-stages": "session_stages x JOIN sessions s ON s.id=x.session_id",
    maps: "maps x JOIN session_stages st ON st.id=x.session_stage_id JOIN sessions s ON s.id=st.session_id",
    concepts: "concepts x JOIN maps m ON m.id=x.map_id JOIN session_stages st ON st.id=m.session_stage_id JOIN sessions s ON s.id=st.session_id",
    links: "links x JOIN maps m ON m.id=x.map_id JOIN session_stages st ON st.id=m.session_stage_id JOIN sessions s ON s.id=st.session_id",
  };
  const from = joins[kind];
  if (!from) return null;
  const alias = kind === "sessions" ? "s" : "x";
  const result = await pool.query<{ id: string; protocolKey: string }>(
    `SELECT s.id, s.protocol_key AS "protocolKey" FROM ${from} WHERE ${alias}.id=$1::uuid`,
    [id],
  );
  return result.rows[0] ?? null;
}

// Map and entity URLs share the same policy, including direct API requests.
export async function learnerMayAccessMap(
  pool: Pool | PoolClient,
  kind: "maps" | "concepts" | "links",
  id: string,
  sessionId: string,
  method: string,
) {
  if (!uuid.test(id)) return false;
  const lookup = {
    maps: { join: "", id: "m.id" },
    concepts: { join: "JOIN concepts item ON item.map_id = m.id", id: "item.id" },
    links: { join: "JOIN links item ON item.map_id = m.id", id: "item.id" },
  }[kind];
  const result = await pool.query(
    `SELECT 1 FROM maps m
     ${lookup.join}
     JOIN session_stages st ON st.id = m.session_stage_id
     JOIN sessions s ON s.id = st.session_id
     JOIN LATERAL (
       SELECT id, stage_type, status, started_at FROM session_stages
       WHERE session_id = s.id AND status <> 'COMPLETED'
       ORDER BY order_index LIMIT 1
     ) current_stage ON true
     WHERE ${lookup.id} = $1::uuid AND s.id = $2::uuid
       AND s.protocol_key IN ('STAGE1_4', 'STAGE1_6', 'STAGE1_5', 'SBKB_INTEGRATION_V1')
       AND s.status = 'IN_PROGRESS'
       AND (
         (m.status = 'DRAFT' AND st.id = current_stage.id
          AND st.status = 'IN_PROGRESS'
          AND ((m.type = 'PRIOR' AND st.stage_type = 'PRIOR_MAP')
            OR (m.type = 'KB' AND st.stage_type = 'KB_MAP')
            OR (m.type = 'INTEGRATION' AND st.stage_type = 'INTEGRATION_MAP'))
          AND (s.protocol_key NOT IN ('STAGE1_6','STAGE1_5','SBKB_INTEGRATION_V1') OR st.stage_type <> 'INTEGRATION_MAP'
            OR ((s.protocol_key IN ('STAGE1_5','SBKB_INTEGRATION_V1') OR s.study_group = 'EXPERIMENTAL') AND clock_timestamp() < st.started_at + s.group_activity_seconds * interval '1 second')))
         OR ($3::boolean AND m.status = 'SUBMITTED'
          AND s.protocol_key = 'STAGE1_6' AND s.study_group = 'CONTROL'
          AND current_stage.stage_type = 'SELF_STUDY'
          AND current_stage.status = 'IN_PROGRESS' AND st.status = 'COMPLETED'
          AND clock_timestamp() < current_stage.started_at + s.group_activity_seconds * interval '1 second'
          AND ((m.type = 'PRIOR' AND st.stage_type = 'PRIOR_MAP')
            OR (m.type = 'KB' AND st.stage_type = 'KB_MAP')))
       )`,
    [id, sessionId, method === "GET" || method === "HEAD"],
  );
  return result.rowCount === 1;
}

export function accessControl(pool: Pool) {
  return async (request: Request, response: Response, next: NextFunction) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.path === "/health") return next();
    const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.header("authorization") ?? "");
    if (!match) return response.status(401).json({ error: "authentication_required" });
    const hash = tokenHash(match[1]);
    let principal: Principal = {role:"learner",sessionId:"",kitId:""};
    if (timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(researcherHash, "hex"))) {
      principal = { role: "researcher" };
    } else {
      try {
        const result = await pool.query<{ id: string; kitId: string }>(
          `SELECT id, research_kit_definition_id AS "kitId" FROM sessions
           WHERE learner_access_token_hash=$1 AND protocol_key IN ('STAGE1_4','STAGE1_6','STAGE1_5')`,
          [hash],
        );
        const session = result.rows[0];
        if (!session) {
          const deleted = await pool.query("SELECT queue_key FROM research_identity.revocations WHERE token_hash=$1",[hash]);
          if (deleted.rowCount) {
            if (request.path === "/deletion-ack" && request.method === "POST" && typeof request.body?.clientId === "string" && uuid.test(request.body.clientId) && Object.keys(request.body).length===1) {
              await pool.query("UPDATE research_identity.device_deletions SET acknowledged=true WHERE token_hash=$1 AND client_hash=$2",[hash,tokenHash(request.body.clientId)]);
              return response.json({acknowledged:true});
            }
            return response.status(410).json({error:"research_data_deleted",discardObservationQueue:true,queueKey:deleted.rows[0].queue_key});
          }
          try {
            const proof=await authenticateExperimentToken(pool,hash);
            if(proof){
              principal={role:"learner",sessionId:proof.sessionId,kitId:proof.kitId,experiment:proof};
              response.locals.principal=principal;
              if(request.path==="/me"&&request.method==="GET")return response.json({role:"learner",sessionId:proof.sessionId,protocolKey:"SBKB_INTEGRATION_V1",flowAvailable:experimentPreviewEnabled()});
              if(request.path==="/experiment-client/claim"&&request.method==="POST")return next();
              if(request.path.startsWith("/research/"))return response.status(403).json({error:"forbidden"});
              if(!experimentPreviewEnabled())return response.status(409).json({error:"experiment_learner_flow_unavailable",message:experimentFlowMessage});
              if(!(await validateExperimentRequest(pool,request,response)))return;
              if(request.path==="/experiment-material"&&request.method==="GET")return next();

            }
          }catch(error){return response.status(error instanceof ParticipantAccessError?error.status:503).json({error:error instanceof ParticipantAccessError?error.code:"access_storage_unavailable",message:"アクセス状態を確認できません。研究者に確認してください。"});}
          if(principal.role!=="learner"||!principal.experiment)return response.status(401).json({ error: "authentication_required" });
        }
        if(session)principal = { role: "learner", sessionId: session.id, kitId: session.kitId };
      } catch (error) { return next(error); }
    }
    response.locals.principal = principal;
    const scope=principal.role==="learner"?"LEARNER:"+principal.sessionId:"RESEARCHER";
    const permit=async(replayAllowed?: (client:PoolClient)=>Promise<boolean>)=>{if(await operationGate(pool,request,response,scope))return;if(response.locals.reliableOperation)response.locals.reliableOperation.replayAllowed=replayAllowed;return experimentRequestContext(request,response,next);};
    const stageMapReplay=(stageId:string)=>async(client:PoolClient)=>{
      if(principal.role!=="learner")return true;
      const map=(await client.query("SELECT id FROM maps WHERE session_stage_id=$1 LIMIT 1",[stageId])).rows[0];
      return !!map&&learnerMayAccessMap(client,"maps",map.id,principal.sessionId,"POST");
    };
    if (principal.role === "researcher") return permit();

    const parts = request.path.split("/").filter(Boolean);
    const kind = parts[0];
    const id = parts[1];
    if (kind === "me" && request.method === "GET") return next();
    if (kind === "kits") {
      if (request.method === "GET" && !id) return next();
      if (request.method === "GET" && id === principal.kitId) return next();
      if (request.method === "POST" && parts[2] === "kb-map" && id === principal.kitId) {
        const stageId = (request.body as Record<string, unknown> | undefined)?.sessionStageId;
        if (typeof stageId !== "string") return response.status(404).json({ error: "not_found" });
        try {
          const owner = await ownerFor(pool, "session-stages", stageId);
          if (owner?.id === principal.sessionId) return permit(stageMapReplay(stageId));
        } catch (error) { return next(error); }
      }
      return response.status(404).json({ error: "not_found" });
    }
    if ((kind === "maps" || kind === "concepts" || kind === "links") && id) {
      try {
        if (await learnerMayAccessMap(pool, kind, id, principal.sessionId, request.method)) return permit(client=>learnerMayAccessMap(client,kind,id,principal.sessionId,request.method));
      } catch (error) { return next(error); }
      if(await operationGate(pool,request,response,scope,true))return;
      const receipt = response.locals.operationResult;
      // A released result no longer has a Concept row. Replay only this exact
      // committed request, still authorized against its live owning Map/Session.
      if (kind === "concepts" && request.method === "DELETE" && receipt?.mergeReleased === true && receipt.id === id && typeof receipt.mapId === "string") {
        try {
          if (await learnerMayAccessMap(pool,"maps",receipt.mapId,principal.sessionId,request.method)) return permit(client=>learnerMayAccessMap(client,"maps",receipt.mapId,principal.sessionId,request.method));
        } catch (error) { return next(error); }
      }
      if(response.locals.operationKnown)return committedReceipt(response);
      return response.status(404).json({ error: "not_found" });
    }
    if (["sessions", "session-stages"].includes(kind) && id) {
      try {
        const owner = await ownerFor(pool, kind, id);
        if (owner?.id === principal.sessionId && ["STAGE1_4", "STAGE1_6", "STAGE1_5","SBKB_INTEGRATION_V1"].includes(owner.protocolKey)) return permit(kind==="session-stages"&&["prior-map","integration-map"].includes(parts[2])?stageMapReplay(id):undefined);
      } catch (error) { return next(error); }
      return response.status(404).json({ error: "not_found" });
    }
    return response.status(403).json({ error: "forbidden" });
  };
}
