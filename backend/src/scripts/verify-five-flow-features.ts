// TEST-ONLY synthetic states, not experiment material.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import {
  deriveFiveFlowFeatures,
  fiveFlowFeaturesCsv,
  type FeatureInput,
} from "../five-flow-features.js";
import type { MapHistorySnapshot } from "../map-history.js";
const mapId = randomUUID(),
  a = randomUUID(),
  b = randomUUID(),
  c = randomUUID(),
  m = randomUUID(),
  n = randomUUID();
const concept = (id: string, mergedIntoConceptId: string | null = null) => ({
  id,
  mapId,
  label: "TEST-ONLY feature",
  positionX: 0,
  positionY: 0,
  mergedIntoConceptId,
  provenance: [],
});
const initial: MapHistorySnapshot = {
  snapshotVersion: 1,
  mapId,
  mapType: "INTEGRATION",
  basedOnMapId: null,
  kitDefinitionId: null,
  concepts: [concept(a), concept(b), concept(c)],
  links: [1, 2].map(() => ({
    id: randomUUID(),
    mapId,
    label: "TEST-ONLY link",
    sourceConceptId: a,
    targetConceptId: b,
    provenance: [],
  })),
};
const nested: MapHistorySnapshot = {
  ...initial,
  links: initial.links.map((l) => ({
    ...l,
    sourceConceptId: n,
    targetConceptId: n,
  })),
  concepts: [
    concept(a, m),
    concept(b, m),
    concept(m, n),
    concept(c, n),
    concept(n),
  ],
};
const released: MapHistorySnapshot = {
  ...initial,
  links: initial.links.map((l) => ({
    ...l,
    sourceConceptId: m,
    targetConceptId: m,
  })),
  concepts: [concept(a, m), concept(b, m), concept(m), concept(c)],
};
const event = (
  eventType: string,
  before: unknown,
  after: unknown,
  sequenceNumber: string,
  outcome = "SUCCESS",
  actorType = "LEARNER",
): FeatureInput["events"][number] => ({
  eventId: randomUUID(),
  mapId,
  schemaVersion: 5,
  eventType,
  relatedEventId: null,
  sequenceNumber,
  outcome,
  actorType,
  before,
  after,
  targetId: mapId,
  targetType: "MAP",
  serverTimestamp: "2026-11-06T00:00:01.000Z",
});
const input: FeatureInput = {
  sessionId: randomUUID(),
  sampledAt: "2026-11-06T00:00:02.000Z",
  mapId,
  mapStatus: "SUBMITTED",
  submittedAt: "2026-11-06T00:00:01.000Z",
  initial,
  capturedAt: "2026-11-06T00:00:00.000Z",
  current: nested,
  boundary: { legacyCount: 0, legacyLastId: null },
  legacy: [],
  events: [
    event("MERGE_CONCEPT", initial, nested, "1"),
    event("MAP_SUBMIT", nested, nested, "2"),
  ],
};
let f = deriveFiveFlowFeatures(input);
assert.deepEqual(
  [f.start.activeConcepts, f.start.hiddenMergeSources, f.start.links],
  [3, 0, 2],
);
assert.deepEqual(
  [
    f.completion.activeConcepts,
    f.completion.hiddenMergeSources,
    f.completion.links,
  ],
  [1, 4, 2],
);
assert.deepEqual(
  [f.delta.activeConcepts, f.delta.hiddenMergeSources, f.delta.links],
  [-2, 4, 0],
);
f = deriveFiveFlowFeatures({
  ...input,
  current: released,
  events: [
    input.events[0]!,
    event("DELETE_CONCEPT", nested, released, "2"),
    event("MAP_SUBMIT", released, released, "3"),
  ],
});
assert.deepEqual(
  [f.completion.activeConcepts, f.completion.hiddenMergeSources],
  [2, 2],
);
const auto = deriveFiveFlowFeatures({
  ...input,
  events: [
    input.events[0]!,
    event("MAP_AUTO_SUBMIT", nested, nested, "2", "SUCCESS", "SYSTEM"),
  ],
});
assert.deepEqual(auto.delta, deriveFiveFlowFeatures(input).delta);
assert.equal(auto.completion.eventType, "MAP_AUTO_SUBMIT");
for (const patch of [
  { initial: null },
  { mapStatus: "DRAFT", submittedAt: null },
  { current: initial },
  { boundary: null },
]) {
  const missing = deriveFiveFlowFeatures({ ...input, ...patch });
  assert.equal(missing.completion.status, "UNAVAILABLE");
  assert.equal(missing.completion.activeConcepts, null);
  assert.equal(missing.delta.links, null);
}
const outcomes = ["SUCCESS", "FAILURE", "REJECTED", "CANCELLED", "UNKNOWN"];
const grouped = deriveFiveFlowFeatures({
  ...input,
  legacy: [
    {
      id: randomUUID(),
      mapId,
      sequenceNumber: "1",
      operationType: "ADD_CONCEPT",
      targetType: "CONCEPT",
      targetId: a,
      before: null,
      after: null,
      relatedOperationLogId: null,
    },
  ],
  events: outcomes.map((o, i) =>
    event(
      "ADD_CONCEPT",
      null,
      null,
      String(i + 1),
      o,
      i === 0 ? "SYSTEM" : "LEARNER",
    ),
  ),
});
assert.equal(grouped.operationResults.total, 6);
for (const outcome of [...outcomes, "UNRECORDED"])
  assert.equal(
    grouped.operationResults.rows
      .filter((r) => r.outcome === outcome)
      .reduce((sum, r) => sum + r.count, 0),
    1,
  );
assert.ok(
  grouped.operationResults.rows.some(
    (r) => r.historySource === "LEGACY" && r.actorType === "UNRECORDED",
  ),
);
const rows = parse(fiveFlowFeaturesCsv(grouped), {
  columns: true,
  bom: true,
}) as Record<string, string>[];
assert.equal(
  rows.find((r) => r.aggregationPoint === "completion")!.activeConcepts,
  "",
);
assert.ok(
  rows.every(
    (r) =>
      r.protocolKey === "STAGE1_5" &&
      r.featureVersion === "stage1-5-descriptive-v1",
  ),
);
console.log(
  "Five-flow features: nested/released states, manual/auto, null missingness, outcome/actor/legacy separation and CSV: PASS",
);
