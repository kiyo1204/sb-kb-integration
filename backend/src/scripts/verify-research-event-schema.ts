import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateEvent } from "../research-events.js";
import { validMapLabel } from "../research-event-map-v2.js";

const valid = { schemaVersion: 1, eventType: "MOVE_CONCEPT", targetType: "CONCEPT", mapId: randomUUID(), targetId: randomUUID(), outcome: "SUCCESS", clientTimeQuality: "MISSING", before: { positionX: 12 }, after: { positionX: 13 } };
assert.equal(validMapLabel("パスワード"), true);
assert.equal(validMapLabel("password"), true);
assert.equal(validMapLabel("password=example"), false);
assert.equal(validMapLabel("https://example.com"), false);
assert.equal(validMapLabel("概".repeat(513)), false);
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
const state = { snapshotVersion: 1, mapId: valid.mapId, mapType: "PRIOR", basedOnMapId: null, kitDefinitionId: null, concepts: [{ id: valid.targetId, mapId: valid.mapId, label: "概念", positionX: 12, positionY: 0, mergedIntoConceptId: null, provenance: [] }], links: [] };
const v2 = { ...valid, schemaVersion: 2, before: state, after: { ...state, concepts: [{ ...state.concepts[0], positionX: 13 }] } };
assert.equal(validateEvent(v2), true);
const otherConcept = { ...state.concepts[0], id: randomUUID(), label: "別の概念" };
const linkId = randomUUID();
const linked = { ...state, concepts: [...state.concepts, otherConcept], links: [{ id: linkId, mapId: valid.mapId, label: "関係", sourceConceptId: valid.targetId, targetConceptId: otherConcept.id, provenance: [{ id: randomUUID(), targetLinkId: linkId, sourceLinkId: randomUUID(), relationType: "IMPORTED_FROM", createdAt: "2026-01-01T00:00:00Z" }] }] };
const combinedId = randomUUID();
const combined = { ...linked, concepts: [...linked.concepts.map(item => ({ ...item, mergedIntoConceptId: combinedId })), { ...state.concepts[0], id: combinedId, label: "統合", mergedIntoConceptId: null, provenance: [{ id: randomUUID(), targetConceptId: combinedId, sourceConceptId: valid.targetId, relationType: "MERGED_FROM", createdAt: "2026-01-01T00:00:00Z" }] }], links: linked.links.map(item => ({ ...item, sourceConceptId: combinedId, targetConceptId: combinedId })) };
assert.equal(validateEvent({ ...v2, eventType: "MERGE_CONCEPT", targetId: combinedId, before: linked, after: combined }), true);
assert.equal(validateEvent({ ...v2, eventType: "UNDO", targetType: "MAP", targetId: valid.mapId, relatedEventId: randomUUID(), before: combined, after: linked }), true);
assert.equal(validateEvent({ ...v2, eventType: "UNDO", targetType: "MAP", targetId: valid.mapId, relatedLegacyOperationLogId: randomUUID(), idempotencyKey: randomUUID(), before: combined, after: linked }), true);
assert.equal(validateEvent({ ...v2, eventType: "UNDO", targetType: "MAP", targetId: valid.mapId, relatedLegacyOperationLogId: randomUUID(), relatedEventId: randomUUID(), before: combined, after: linked }), false);
assert.equal(validateEvent({ ...v2, eventType: "UNDO", targetType: "MAP", targetId: valid.mapId, before: combined, after: linked }), false);
for (const bad of [
  { ...v2, after: { ...state, extra: "bad" } },
  { ...v2, after: { ...state, concepts: [{ ...state.concepts[0], label: "password: sample" }] } },
  { ...v2, after: { ...state, concepts: [{ ...state.concepts[0], label: "https://example.com" }] } },
  { ...v2, after: { ...state, concepts: [{ ...state.concepts[0], label: "A".repeat(513) }] } },
  { ...v2, after: { ...state, concepts: [{ ...state.concepts[0], positionX: Infinity }] } },
  { ...v2, after: { ...state, concepts: [{ ...state.concepts[0], provenance: [{ id: randomUUID(), targetConceptId: randomUUID(), sourceConceptId: randomUUID(), relationType: "CLONED_FROM", createdAt: "2026-01-01T00:00:00Z" }] }] } },
  { ...v2, eventType: "RECONNECT_LINK", targetType: "LINK" },
]) assert.equal(validateEvent(bad), false);
console.log("Research event input validation: OK");
