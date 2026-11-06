import { validAnswerText } from "./research-event-assessment-v3.js";
export type SurveyStateV7 = {
  questionId: string;
  kind: "TEXT" | "CHOICE" | "RATING";
  value: string | number | null;
};
export function validSurveyState(
  value: unknown,
  target: unknown,
): value is SurveyStateV7 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 3 &&
    Object.keys(v).every((k) => ["questionId", "kind", "value"].includes(k)) &&
    v.questionId === target &&
    typeof target === "string" &&
    /^[0-9a-f-]{36}$/i.test(target) &&
    ["TEXT", "CHOICE", "RATING"].includes(String(v.kind)) &&
    (v.value === null ||
      (v.kind === "RATING"
        ? Number.isInteger(v.value) &&
          Number(v.value) >= -100 &&
          Number(v.value) <= 1000
        : validAnswerText(v.value)))
  );
}
export function validateSurveyEventV7(v: Record<string, unknown>) {
  if (
    !["SURVEY_EDIT", "SURVEY_SUBMIT"].includes(String(v.eventType)) ||
    v.targetType !== "ASSESSMENT" ||
    typeof v.stageId !== "string" ||
    typeof v.targetId !== "string" ||
    v.mapId !== undefined ||
    v.details !== undefined ||
    v.relatedEventId !== undefined
  )
    return false;
  if (v.eventType === "SURVEY_SUBMIT")
    return (
      v.stageId === v.targetId &&
      v.before === undefined &&
      v.after === undefined
    );
  if (v.outcome !== "SUCCESS")
    return v.before === undefined && v.after === undefined;
  return (
    validSurveyState(v.before, v.targetId) &&
    validSurveyState(v.after, v.targetId) &&
    v.before.kind === v.after.kind &&
    v.before.value !== v.after.value
  );
}
