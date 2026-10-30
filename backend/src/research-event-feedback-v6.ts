export type FeedbackDetailsV6 = {
  matched: boolean;
  durationMs?: never;
  positionSeconds?: never;
  fromSeconds?: never;
  toSeconds?: never;
};
export function validateFeedbackEventV6(e: Record<string, unknown>) {
  const id = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (
    e.eventType !== "FEEDBACK_CHECK" ||
    e.targetType !== "FEEDBACK" ||
    typeof e.mapId !== "string" ||
    !id.test(e.mapId) ||
    typeof e.stageId !== "string" ||
    !id.test(e.stageId) ||
    e.targetId !== e.mapId ||
    e.before !== undefined ||
    e.after !== undefined ||
    e.relatedEventId !== undefined ||
    e.relatedLegacyOperationLogId !== undefined ||
    e.idempotencyKey !== undefined ||
    e.clientTimeQuality !== "NOT_APPLICABLE" ||
    e.clientTimestamp !== undefined ||
    e.beforeQuality !== "NOT_APPLICABLE" ||
    e.afterQuality !== "NOT_APPLICABLE"
  )
    return false;
  if (e.outcome === "SUCCESS")
    return (
      e.reasonCode === undefined &&
      !!e.details &&
      typeof e.details === "object" &&
      !Array.isArray(e.details) &&
      Object.keys(e.details).length === 1 &&
      typeof (e.details as FeedbackDetailsV6).matched === "boolean"
    );
  return (
    ["REJECTED", "FAILURE"].includes(String(e.outcome)) &&
    ["VALIDATION", "PERMISSION", "DEADLINE", "CONFLICT", "SERVER"].includes(
      String(e.reasonCode),
    ) &&
    e.details === undefined
  );
}
