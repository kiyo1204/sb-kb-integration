// Per-session, per-access-code UI completion marker; no learning API or DB writes.
// Practice map progress is stored separately in this tab's sessionStorage.
import { getAccessToken } from "./auth-client";
import { requestDigest } from "./client-identity";
import {
  createInitialIntegrationPracticeProgress,
  createInitialKitPracticeProgress,
  createInitialSbPracticeProgress,
  isPracticeStepComplete,
  isValidIntegrationPracticeProgress,
  isValidKitPracticeProgress,
  isValidSbPracticeProgress,
  readPracticeRecord,
} from "./practice-progress";

const prefix = "sbkb-practice-complete-v1:";
function completionKey(sessionId: string) {
  try {
    const token = getAccessToken();
    return token ? `${prefix}${sessionId}:${requestDigest(token)}` : null;
  } catch {
    return null;
  }
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

export function hasCompletedPracticeProgress(sessionId: string): boolean {
  if (!hasCompletedPractice(sessionId)) return false;
  const sb = readPracticeRecord(sessionId, "PRIOR", createInitialSbPracticeProgress, isValidSbPracticeProgress);
  const kb = readPracticeRecord(sessionId, "KB", createInitialKitPracticeProgress, isValidKitPracticeProgress);
  const integration = readPracticeRecord(sessionId, "INTEGRATION", createInitialIntegrationPracticeProgress, isValidIntegrationPracticeProgress);
  if ([sb, kb, integration].every((record) => record.status === "ready" && !record.stored)) {
    return true;
  }
  return sb.status === "ready" && isPracticeStepComplete("PRIOR", sb.value) &&
    kb.status === "ready" && isPracticeStepComplete("KB", kb.value) &&
    integration.status === "ready" && isPracticeStepComplete("INTEGRATION", integration.value);
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

export function clearPracticeCompleted(sessionId: string): boolean {
  const key = completionKey(sessionId);
  if (!key) return false;
  try {
    sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
