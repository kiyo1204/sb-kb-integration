// TEST-ONLY synthetic states; no experiment content or database connection.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  releaseMerge,
  MergeReleaseUnavailableError,
} from "../merge-release.js";
import type { HistoryOperation, MapHistorySnapshot } from "../map-history.js";
const mapId = randomUUID(),
  a = randomUUID(),
  b = randomUUID(),
  m = randomUUID(),
  extra = randomUUID();
const concept = (id: string, mergedIntoConceptId: string | null = null) => ({
  id,
  mapId,
  label: "TEST-ONLY concept",
  positionX: 10,
  positionY: 20,
  mergedIntoConceptId,
  provenance: [],
});
const initial: MapHistorySnapshot = {
  snapshotVersion: 1,
  mapId,
  mapType: "INTEGRATION",
  basedOnMapId: null,
  kitDefinitionId: null,
  concepts: [concept(a), concept(b)],
  links: [],
};
const merged: MapHistorySnapshot = {
  ...initial,
  concepts: [
    concept(a, m),
    concept(b, m),
    {
      ...concept(m),
      provenance: [a, b].map((sourceConceptId) => ({
        id: randomUUID(),
        targetConceptId: m,
        sourceConceptId,
        relationType: "MERGED_FROM",
        createdAt: "2026-11-06T00:00:00.000Z",
      })),
    },
  ],
};
const operation: HistoryOperation = {
  id: randomUUID(),
  mapId,
  sequenceNumber: "1",
  operationType: "MERGE_CONCEPT",
  targetType: "CONCEPT",
  targetId: m,
  before: initial,
  after: merged,
  relatedOperationLogId: null,
  historyFormat: "V5",
};
const current = {
  ...merged,
  concepts: [
    ...merged.concepts,
    { ...concept(extra), label: "TEST-ONLY unrelated later edit" },
  ],
};
const desired = releaseMerge(initial, [operation], current, m);
assert.deepEqual(desired.concepts, [...initial.concepts, current.concepts[3]]);
assert.throws(
  () => releaseMerge(merged, [], current, m),
  MergeReleaseUnavailableError,
);
assert.throws(
  () =>
    releaseMerge(
      initial,
      [operation, { ...operation, id: randomUUID(), sequenceNumber: "2" }],
      current,
      m,
    ),
  MergeReleaseUnavailableError,
);
assert.throws(
  () => releaseMerge(initial, [{ ...operation, before: null }], current, m),
  MergeReleaseUnavailableError,
);
assert.throws(
  () =>
    releaseMerge(
      initial,
      [operation],
      {
        ...current,
        concepts: current.concepts.map((c) =>
          c.id === m ? { ...c, mergedIntoConceptId: extra } : c,
        ),
      },
      m,
    ),
  MergeReleaseUnavailableError,
);
console.log(
  "Synthetic Merge release planner: local change, missing/ambiguous snapshots and inactive source refusal PASS",
);
