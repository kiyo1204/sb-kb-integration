import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler, Response } from "express";

type SafetyBudget = { remaining: number; closed: boolean; exactHashes: Map<string, string> };
export const MAX_SAFETY_HASHES = 20_000;
const budgets = new AsyncLocalStorage<SafetyBudget>();
export class ResearchSafetyError extends Error {
  constructor(readonly code: "safety_budget_exceeded" | "safety_lookup_unavailable") {
    super(code);
    this.name = "ResearchSafetyError";
  }
}

// Set the final response BEFORE server-audit's send wrapper observes it. Never
// intercept send/json here: doing so could turn an audited success into a rejection.
export function respondResearchSafetyError(response: Response, error: unknown): boolean {
  if (!(error instanceof ResearchSafetyError)) return false;
  const exceeded = error.code === "safety_budget_exceeded";
  response.removeHeader("Content-Disposition");
  response.status(exceeded ? 422 : 503).type("application/json").json({
    error: error.code,
    message: exceeded
      ? "安全確認の処理量上限を超えました。入力を短くするか出力範囲を絞ってください。範囲を変更できない場合は管理者に連絡してください。"
      : "安全確認を行えませんでした。時間をおいて再度お試しください。改善しない場合は管理者に連絡してください。",
  });
  return true;
}

export const researchSafetyBudget: RequestHandler = (_request, response, next) => {
  const budget: SafetyBudget = { remaining: MAX_SAFETY_HASHES, closed: false, exactHashes: new Map<string, string>() };
  // Detached work cannot keep spending a completed request's allowance. Current
  // background jobs are started outside request contexts and have their own budget.
  const close = () => { budget.closed = true; };
  response.once("finish", close);
  response.once("close", close);
  budgets.run(budget, next);
};

import type { PoolClient } from "pg";
import { tokenHash } from "./access-control.js";

// Shared by input rejection and output redaction. Never recover or retain plaintext
// learner codes; only compare candidates with hashes already kept by the system.
export async function loadResearchTextSafety(
  client: Pick<PoolClient, "query">,
) {
  const budget = budgets.getStore() ?? { remaining: MAX_SAFETY_HASHES, closed: false, exactHashes: new Map<string, string>() };
  if (budget.closed) throw new ResearchSafetyError("safety_lookup_unavailable");
  let result;
  try {
    result = await client.query<{ hash: string }>(
      `SELECT learner_access_token_hash AS hash FROM sessions WHERE learner_access_token_hash IS NOT NULL
       UNION SELECT token_hash AS hash FROM research_identity.revocations`,
    );
  } catch {
    throw new ResearchSafetyError("safety_lookup_unavailable");
  }
  const hashes = new Set(result.rows.map((row) => row.hash));
  const researcher = process.env.RESEARCHER_API_TOKEN;
  const pattern =
    /(?:bearer\s+[A-Za-z0-9._~+/-]{8,})|(?:(?:password|passwd|api[_-]?key|access[_-]?(?:token|code)|authorization|cookie|set-cookie|token|secret|アクセスコード|パスワード|トークン|認証情報)\s*[:=：]\s*\S+)|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
  const matches = (text: string) => {
    if (budget.closed) throw new ResearchSafetyError("safety_lookup_unavailable");
    if (budget.remaining <= 0) throw new ResearchSafetyError("safety_budget_exceeded");
    budget.remaining--;
    return hashes.has(tokenHash(text));
  };
  // Deduplicate whole values (UUIDs, timestamps and repeated text) without
  // skipping any field or candidate. Recompare cached digests with THIS lookup's
  // hash set, so newly revoked credentials are still detected by later loads.
  const matchesExact = (text: string) => {
    if (budget.closed) throw new ResearchSafetyError("safety_lookup_unavailable");
    let digest = budget.exactHashes.get(text);
    if (digest === undefined) {
      if (budget.remaining <= 0) throw new ResearchSafetyError("safety_budget_exceeded");
      budget.remaining--;
      digest = tokenHash(text);
      budget.exactHashes.set(text, digest);
    }
    return hashes.has(digest);
  };
  const knownCache = new Map<string, boolean>();
  function containsKnownSecret(text: string): boolean {
    if (budget.closed) throw new ResearchSafetyError("safety_lookup_unavailable");
    const cached = knownCache.get(text);
    if (cached !== undefined) return cached;
    const remember = (found: boolean) => {
      knownCache.set(text, found);
      return found;
    };
    if (researcher && text.includes(researcher)) return remember(true);
    if (!hashes.size) return remember(false);
    if (matchesExact(text) || text.split(/\s+/).some(matchesExact)) return remember(true);
    for (const run of text.match(/[A-Za-z0-9_-]{32,}/g) ?? []) {
      if (matchesExact(run)) return remember(true);
      // Issued codes are 32 random bytes / 43 base64url characters. Preserve the
      // Goal Map export check for codes embedded in older unvalidated labels.
      for (let i = 0; i + 43 <= run.length; i++)
        if ((run.length === 43 ? matchesExact : matches)(run.slice(i, i + 43))) return remember(true);
      // Authentication also accepts older 32..128 character codes. Hashes do
      // not encode their length, so check that bounded range without guessing
      // or persisting plaintext. The cache is local to this request/export.
      for (let length = 32; length <= Math.min(128, run.length); length++) {
        if (length === 43) continue;
        for (let i = 0; i + length <= run.length; i++)
          if ((run.length === length ? matchesExact : matches)(run.slice(i, i + length))) return remember(true);
      }
    }
    return remember(false);
  }
  const containsSecret = (text: string) => {
    if (budget.closed) throw new ResearchSafetyError("safety_lookup_unavailable");
    return pattern.test(text) || containsKnownSecret(text);
  };
  function redact<T>(value: T): T {
    function visit(x: unknown): unknown {
      if (typeof x === "string") return containsSecret(x) ? "[REDACTED]" : x;
      if (Array.isArray(x)) return x.map(visit);
      if (x && typeof x === "object" && !(x instanceof Date))
        return Object.fromEntries(
          Object.entries(x).map(([k, v]) => [
            k,
            /^(?:authorization|cookie|password|accessToken|learnerAccessToken|participantId|participant_id)$/i.test(
              k,
            )
              ? "[REDACTED]"
              : visit(v),
          ]),
        );
      return x;
    }
    return visit(value) as T;
  }
  return { containsKnownSecret, containsSecret, redact };
}

export async function redactResearchOutput<T>(
  value: T,
  client: Pick<PoolClient, "query">,
): Promise<T> {
  return (await loadResearchTextSafety(client)).redact(value);
}
