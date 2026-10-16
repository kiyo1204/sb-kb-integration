import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Pool, PoolClient } from "pg";

type Principal = { role: "researcher" } | { role: "learner"; sessionId: string; kitId: string };
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
    "UPDATE sessions SET learner_access_token_hash=$2 WHERE id=$1::uuid AND protocol_key='STAGE1_4'",
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

export function accessControl(pool: Pool) {
  return async (request: Request, response: Response, next: NextFunction) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.path === "/health") return next();
    const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.header("authorization") ?? "");
    if (!match) return response.status(401).json({ error: "authentication_required" });
    const hash = tokenHash(match[1]);
    let principal: Principal;
    if (timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(researcherHash, "hex"))) {
      principal = { role: "researcher" };
    } else {
      try {
        const result = await pool.query<{ id: string; kitId: string }>(
          `SELECT id, research_kit_definition_id AS "kitId" FROM sessions
           WHERE learner_access_token_hash=$1 AND protocol_key='STAGE1_4'`,
          [hash],
        );
        const session = result.rows[0];
        if (!session) return response.status(401).json({ error: "authentication_required" });
        principal = { role: "learner", sessionId: session.id, kitId: session.kitId };
      } catch (error) { return next(error); }
    }
    response.locals.principal = principal;
    if (principal.role === "researcher") return next();

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
          if (owner?.id === principal.sessionId) return next();
        } catch (error) { return next(error); }
      }
      return response.status(404).json({ error: "not_found" });
    }
    if (["sessions", "session-stages", "maps", "concepts", "links"].includes(kind) && id) {
      try {
        const owner = await ownerFor(pool, kind, id);
        if (owner?.id === principal.sessionId && owner.protocolKey === "STAGE1_4") return next();
      } catch (error) { return next(error); }
      return response.status(404).json({ error: "not_found" });
    }
    return response.status(403).json({ error: "forbidden" });
  };
}
