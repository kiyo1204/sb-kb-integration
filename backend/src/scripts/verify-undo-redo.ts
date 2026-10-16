import assert from "node:assert/strict";
import type { HistoryOperation, MapHistorySnapshot } from "../map-history.js";
import { replayMapAt } from "../map-history.js";
import {
  deriveUndoRedoAvailability,
  historySnapshotsEqual,
  historyStateDelta,
} from "../map-undo-redo.js";

const mapId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const anchorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const addedId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const addOperationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const undoOperationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const redoOperationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const anchor = {
  id: anchorId,
  mapId,
  label: "注意",
  positionX: 100,
  positionY: 120,
  mergedIntoConceptId: null,
  provenance: [],
};
const added = {
  id: addedId,
  mapId,
  label: "確認",
  positionX: 260,
  positionY: 180,
  mergedIntoConceptId: null,
  provenance: [],
};
const initial: MapHistorySnapshot = {
  snapshotVersion: 1,
  mapId,
  mapType: "PRIOR",
  basedOnMapId: null,
  kitDefinitionId: null,
  concepts: [anchor],
  links: [],
};
const afterAdd: MapHistorySnapshot = {
  ...initial,
  concepts: [anchor, added],
};
const addOperation: HistoryOperation = {
  id: addOperationId,
  mapId,
  sequenceNumber: "1",
  operationType: "ADD_CONCEPT",
  targetType: "CONCEPT",
  targetId: addedId,
  before: null,
  after: added,
};

function actionEvent(
  id: string,
  sequenceNumber: string,
  operationType: "UNDO" | "REDO",
  before: MapHistorySnapshot,
  after: MapHistorySnapshot,
): HistoryOperation {
  const delta = historyStateDelta(before, after, addOperationId, "ADD_CONCEPT");
  return {
    id,
    mapId,
    sequenceNumber,
    operationType,
    targetType: "CONCEPT",
    targetId: addedId,
    relatedOperationLogId: addOperationId,
    before: delta.before,
    after: delta.after,
  };
}

const undo = actionEvent(undoOperationId, "2", "UNDO", afterAdd, initial);
const redo = actionEvent(redoOperationId, "3", "REDO", initial, afterAdd);
const events = [addOperation, undo, redo];

assert.deepEqual(deriveUndoRedoAvailability([addOperation]), {
  undoOperation: addOperation,
  redoOperation: null,
});
assert.deepEqual(deriveUndoRedoAvailability([addOperation, undo]), {
  undoOperation: null,
  redoOperation: addOperation,
});
assert.deepEqual(deriveUndoRedoAvailability(events), {
  undoOperation: addOperation,
  redoOperation: null,
});

const afterUndo = replayMapAt(initial, events, 2);
assert.equal(afterUndo.status, "REPLAYABLE");
if (afterUndo.status === "REPLAYABLE") {
  assert.ok(historySnapshotsEqual(afterUndo.state, initial));
}
const afterRedo = replayMapAt(initial, events, 3);
assert.equal(afterRedo.status, "REPLAYABLE");
if (afterRedo.status === "REPLAYABLE") {
  assert.ok(historySnapshotsEqual(afterRedo.state, afterAdd));
}

const branchEdit: HistoryOperation = {
  id: "11111111-1111-4111-8111-111111111111",
  mapId,
  sequenceNumber: "3",
  operationType: "MOVE_CONCEPT",
  targetType: "CONCEPT",
  targetId: anchorId,
  before: null,
  after: null,
};
const afterBranchUndo = { ...undo, sequenceNumber: "2" };
const branchAvailability = deriveUndoRedoAvailability([
  addOperation,
  afterBranchUndo,
  branchEdit,
]);
assert.equal(branchAvailability.redoOperation, null);
assert.equal(branchAvailability.undoOperation?.id, branchEdit.id);

const wrongTarget = { ...undo, relatedOperationLogId: anchorId };
assert.throws(() => deriveUndoRedoAvailability([addOperation, wrongTarget]));

const provenanceEntry = {
  id: "22222222-2222-4222-8222-222222222222",
  targetConceptId: addedId,
  sourceConceptId: anchorId,
  relationType: "CLONED_FROM",
  createdAt: "2026-10-13T00:00:00.000Z",
};
const provenanceSnapshot: MapHistorySnapshot = {
  ...afterAdd,
  concepts: [anchor, { ...added, provenance: [provenanceEntry] }],
};
const jsonbOrderedProvenance = Object.fromEntries(
  Object.entries(provenanceEntry).sort(([left], [right]) =>
    right.localeCompare(left),
  ),
) as typeof provenanceEntry;
const jsonbOrderedSnapshot = {
  ...provenanceSnapshot,
  concepts: [anchor, { ...added, provenance: [jsonbOrderedProvenance] }],
};
assert.ok(historySnapshotsEqual(provenanceSnapshot, jsonbOrderedSnapshot));

console.log("Undo/Redo reducer unit checks succeeded");
