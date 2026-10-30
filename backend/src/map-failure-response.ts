import type { Response } from "express";

type FailureOutcome = "REJECTED" | "FAILURE";
type FailureRecord = {
  operationOutcome: FailureOutcome;
  logSaved: boolean;
  eventId?: string;
};

/** Logging is secondary to the original failure response, including connection acquisition. */
export async function respondToMapFailure(
  response: Response,
  send: (body: unknown) => Response,
  body: unknown,
  record: (outcome: FailureOutcome) => Promise<FailureRecord | null>,
): Promise<void> {
  const status = response.statusCode;
  const payload = body && typeof body === "object" ? body : {};
  const historySaveFailed =
    "message" in payload &&
    typeof payload.message === "string" &&
    payload.message.includes("履歴を保存できません");
  const outcome: FailureOutcome =
    status >= 500 || historySaveFailed ? "FAILURE" : "REJECTED";
  let result: FailureRecord | null = {
    operationOutcome: outcome,
    logSaved: false,
  };
  try {
    // The callback includes pool.connect(), the transaction, rollback and release.
    result = await record(outcome);
  } catch {
    // Never copy a DB error, stack, request body or credentials into the response.
  }
  if (response.destroyed || response.headersSent) return;
  try {
    response.status(status);
    send(result === null ? body : { ...payload, ...result });
  } catch {
    // A disconnected/failed response writer must not become an unhandled rejection.
    response.destroy();
  }
}
