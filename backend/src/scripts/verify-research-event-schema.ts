import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateEvent } from "../research-events.js";

const valid = { schemaVersion: 1, eventType: "MOVE_CONCEPT", targetType: "CONCEPT", mapId: randomUUID(), targetId: randomUUID(), outcome: "SUCCESS", clientTimeQuality: "MISSING", before: { positionX: 12 }, after: { positionX: 13 } };
assert.equal(validateEvent(valid), true);
for (const invalid of [
  { ...valid, schemaVersion: 2 }, { ...valid, targetType: "LINK" }, { ...valid, mapId: undefined },
  { ...valid, actorType: "SYSTEM" }, { ...valid, details: { token: "secret" } },
  { ...valid, before: { label: "secret" } }, { ...valid, outcome: "SAVED" },
  { ...valid, clientTimeQuality: "OBSERVED" }, { ...valid, clientTimestamp: "2026-01-01T00:00:00Z" },
  { ...valid, clientTimeQuality: "ESTIMATED", clientTimestamp: "bad" },
  { ...valid, beforeQuality: "MISSING" }, { ...valid, after: undefined, afterQuality: "OBSERVED" },
]) assert.equal(validateEvent(invalid), false);
assert.equal(validateEvent({ ...valid, clientTimeQuality: "ESTIMATED", clientTimestamp: "2026-01-01T00:00:00Z" }), true);
console.log("Research event input validation: OK");
