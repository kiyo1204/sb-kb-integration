import { requestDigest } from "./client-identity";
const deletedScopes = new Set<string>();
const prefix = "stage1-assessment-draft-v2:";
export function assessmentDraftKey(sessionId: string, stageId: string) {
  return prefix + requestDigest(sessionId) + ":" + stageId;
}
// Server authorization still precedes recovery. Unscoped legacy drafts are quarantined.
export function recoverAssessmentDraft(sessionId:string,stageId:string) {
  if(deletedScopes.has(requestDigest(sessionId)))return null;
  return localStorage.getItem(assessmentDraftKey(sessionId,stageId));
}
/** Count only: never read unknown owners' answer values or expose Stage IDs. */
export function quarantinedDraftCount() {
 let count=0;for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith("stage1-assessment-draft-")&&!key.startsWith(prefix))count++;}
 return count;
}
export function writeAssessmentDraft(
  sessionId: string,
  stageId: string,
  value: string,
) {
  if (deletedScopes.has(requestDigest(sessionId)))
    throw new Error("assessment_deleted");
  const credential = sessionStorage.getItem("stage1-access-token");
  if (
    (credential && value.includes(credential)) ||
    /(?:bearer\s+[A-Za-z0-9._~+/-]{8,})|(?:(?:password|passwd|api[_-]?key|access[_-]?token|authorization|cookie|set-cookie)\s*[:=]\s*\S+)|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(
      value,
    )
  )
    throw new Error("unsafe_draft_text");
  localStorage.setItem(assessmentDraftKey(sessionId, stageId), value);
}
export function discardAssessmentDrafts(queueKey: string) {
  if (!/^[a-f0-9]{64}$/.test(queueKey))
    throw new Error("invalid_deletion_scope");
  deletedScopes.add(queueKey);
  window.dispatchEvent(
    new CustomEvent("stage1-assessment-deleted", { detail: queueKey }),
  );
  const match = prefix + queueKey + ":";
  const remove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(match)) remove.push(k);
  }
  for (const key of remove) localStorage.removeItem(key);
}
