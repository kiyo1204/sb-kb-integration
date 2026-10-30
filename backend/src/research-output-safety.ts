import type { PoolClient } from "pg";
import { tokenHash } from "./access-control.js";
export async function redactResearchOutput<T>(
  value: T,
  client: PoolClient,
): Promise<T> {
  const hashes = new Set(
    (
      await client.query(
        "SELECT learner_access_token_hash FROM sessions WHERE learner_access_token_hash IS NOT NULL",
      )
    ).rows.map((x) => x.learner_access_token_hash),
  );
  const researcher = process.env.RESEARCHER_API_TOKEN;
  const pattern =
    /(?:bearer\s+[A-Za-z0-9._~+/-]{8,})|(?:(?:password|passwd|api[_-]?key|access[_-]?token|authorization|cookie|set-cookie)\s*[:=]\s*\S+)|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
  function visit(x: unknown): unknown {
    if (typeof x === "string") {
      if (
        pattern.test(x) ||
        (researcher && x.includes(researcher)) ||
        (x.match(/[A-Za-z0-9_-]{32,128}/g) ?? []).some((t) =>
          hashes.has(tokenHash(t)),
        )
      )
        return "[REDACTED]";
      return x;
    }
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
