import type { PoolClient } from "pg";
import { tokenHash } from "./access-control.js";

// Shared by input rejection and output redaction. Never recover or retain plaintext
// learner codes; only compare candidates with hashes already kept by the system.
export async function loadResearchTextSafety(
  client: Pick<PoolClient, "query">,
) {
  const result = await client.query<{ hash: string }>(
    `SELECT learner_access_token_hash AS hash FROM sessions WHERE learner_access_token_hash IS NOT NULL
     UNION SELECT token_hash AS hash FROM research_identity.revocations`,
  );
  const hashes = new Set(result.rows.map((row) => row.hash));
  const researcher = process.env.RESEARCHER_API_TOKEN;
  const pattern =
    /(?:bearer\s+[A-Za-z0-9._~+/-]{8,})|(?:(?:password|passwd|api[_-]?key|access[_-]?(?:token|code)|authorization|cookie|set-cookie|token|secret|アクセスコード|パスワード|トークン|認証情報)\s*[:=：]\s*\S+)|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
  const matches = (text: string) => hashes.has(tokenHash(text));
  const knownCache = new Map<string, boolean>();
  function containsKnownSecret(text: string): boolean {
    const cached = knownCache.get(text);
    if (cached !== undefined) return cached;
    const remember = (found: boolean) => {
      knownCache.set(text, found);
      return found;
    };
    if (researcher && text.includes(researcher)) return remember(true);
    if (!hashes.size) return remember(false);
    if (matches(text) || text.split(/\s+/).some(matches)) return remember(true);
    for (const run of text.match(/[A-Za-z0-9_-]{32,}/g) ?? []) {
      if (matches(run)) return remember(true);
      // Issued codes are 32 random bytes / 43 base64url characters. Preserve the
      // Goal Map export check for codes embedded in older unvalidated labels.
      for (let i = 0; i + 43 <= run.length; i++)
        if (matches(run.slice(i, i + 43))) return remember(true);
      // Authentication also accepts older 32..128 character codes. Hashes do
      // not encode their length, so check that bounded range without guessing
      // or persisting plaintext. The cache is local to this request/export.
      for (let length = 32; length <= Math.min(128, run.length); length++) {
        if (length === 43) continue;
        for (let i = 0; i + length <= run.length; i++)
          if (matches(run.slice(i, i + length))) return remember(true);
      }
    }
    return remember(false);
  }
  const containsSecret = (text: string) =>
    pattern.test(text) || containsKnownSecret(text);
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
