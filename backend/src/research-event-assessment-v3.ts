export const ANSWER_MAX_LENGTH = 100000;
export type AssessmentStateV3 = { questionId: string; answer: string | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validAnswerText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= ANSWER_MAX_LENGTH && !value.includes(String.fromCharCode(0)) &&
    !/(?:bearer\s+[A-Za-z0-9._~+/-]{8,})|(?:(?:password|passwd|api[_-]?key|access[_-]?token|authorization|cookie|set-cookie)\s*[:=]\s*\S+)|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value);
}
function state(value: unknown, targetId: unknown): value is AssessmentStateV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 2 && Object.keys(item).every(k => ["questionId", "answer"].includes(k)) &&
    typeof item.questionId === "string" && uuid.test(item.questionId) && item.questionId === targetId &&
    (item.answer === null || validAnswerText(item.answer));
}
export function validateAssessmentEventV3(value: Record<string, unknown>) {
  if (!["ASSESSMENT_EDIT", "ASSESSMENT_SUBMIT"].includes(value.eventType as string) ||
      value.targetType !== "ASSESSMENT" || typeof value.stageId !== "string" || !uuid.test(value.stageId) ||
      typeof value.targetId !== "string" || !uuid.test(value.targetId) || value.mapId !== undefined ||
      value.details !== undefined || value.relatedEventId !== undefined) return false;
  if (value.eventType === "ASSESSMENT_SUBMIT") return value.targetId === value.stageId && value.before === undefined && value.after === undefined;
  if (value.outcome !== "SUCCESS") return value.before === undefined && value.after === undefined;
  return state(value.before, value.targetId) && state(value.after, value.targetId) &&
    value.before.answer !== value.after.answer;
}

