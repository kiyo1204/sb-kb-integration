// Per-session, per-access-code UI completion marker; no learning API or DB writes.
// Local practice maps and operations are never persisted here.
import { getAccessToken } from "./auth-client";
import { requestDigest } from "./client-identity";

const prefix = "sbkb-practice-complete-v1:";
function completionKey(sessionId: string) {
  const token = getAccessToken();
  return token ? `${prefix}${sessionId}:${requestDigest(token)}` : null;
}

export function hasCompletedPractice(sessionId: string): boolean {
  const key = completionKey(sessionId);
  if (!key) return false;
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function markPracticeCompleted(sessionId: string): boolean {
  const key = completionKey(sessionId);
  if (!key) return false;
  try {
    sessionStorage.setItem(key, "1");
    return true;
  } catch {
    // The current page can still continue when sessionStorage is unavailable.
    return false;
  }
}
