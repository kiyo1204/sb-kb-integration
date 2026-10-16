import type { HistoryOperation, MapHistorySnapshot } from "./map-history.js";

const MUTABLE_OPERATION_TYPES = new Set([
  "ADD_CONCEPT",
  "EDIT_CONCEPT",
  "DELETE_CONCEPT",
  "MOVE_CONCEPT",
  "ADD_LINK",
  "EDIT_LINK",
  "DELETE_LINK",
  "RECONNECT_LINK",
  "IMPORT_KIT_CONCEPT",
  "IMPORT_KIT_LINK",
  "MERGE_CONCEPT",
]);

export type UndoRedoAvailability = {
  undoOperation: HistoryOperation | null;
  redoOperation: HistoryOperation | null;
};

export function deriveUndoRedoAvailability(
  operations: HistoryOperation[],
): UndoRedoAvailability {
  const ordered = [...operations].sort((left, right) => {
    const a = BigInt(left.sequenceNumber);
    const b = BigInt(right.sequenceNumber);
    return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
  });
  const undoStack: HistoryOperation[] = [];
  const redoStack: HistoryOperation[] = [];
  const byId = new Map<string, HistoryOperation>();

  for (const operation of ordered) {
    if (
      operation.operationType === "UNDO" ||
      operation.operationType === "REDO"
    ) {
      const targetId = operation.relatedOperationLogId;
      const target =
        typeof targetId === "string" ? byId.get(targetId) : undefined;
      if (
        !target ||
        target.mapId !== operation.mapId ||
        !MUTABLE_OPERATION_TYPES.has(target.operationType)
      ) {
        throw new Error(
          `${operation.operationType} points to an invalid operation.`,
        );
      }

      if (operation.operationType === "UNDO") {
        if (undoStack.at(-1)?.id !== target.id) {
          throw new Error(
            "UNDO does not target the most recent applied operation.",
          );
        }
        undoStack.pop();
        redoStack.push(target);
      } else {
        if (redoStack.at(-1)?.id !== target.id) {
          throw new Error(
            "REDO does not target the most recent undone operation.",
          );
        }
        redoStack.pop();
        undoStack.push(target);
      }
    } else {
      if (!MUTABLE_OPERATION_TYPES.has(operation.operationType)) {
        throw new Error(
          `Unsupported operation type: ${operation.operationType}`,
        );
      }
      undoStack.push(operation);
      redoStack.length = 0;
    }
    byId.set(operation.id, operation);
  }

  return {
    undoOperation: undoStack.at(-1) ?? null,
    redoOperation: redoStack.at(-1) ?? null,
  };
}

function canonicalProvenance<T extends { id: string }>(items: T[]) {
  return [...items]
    .map((item) => canonicalEntity(item) as T)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalSnapshot(snapshot: MapHistorySnapshot) {
  return {
    snapshotVersion: snapshot.snapshotVersion,
    mapId: snapshot.mapId,
    mapType: snapshot.mapType,
    basedOnMapId: snapshot.basedOnMapId,
    kitDefinitionId: snapshot.kitDefinitionId,
    concepts: [...snapshot.concepts]
      .map((item) => ({
        id: item.id,
        mapId: item.mapId,
        label: item.label,
        positionX: item.positionX,
        positionY: item.positionY,
        mergedIntoConceptId: item.mergedIntoConceptId,
        provenance: canonicalProvenance(item.provenance),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    links: [...snapshot.links]
      .map((item) => ({
        id: item.id,
        mapId: item.mapId,
        sourceConceptId: item.sourceConceptId,
        targetConceptId: item.targetConceptId,
        label: item.label,
        provenance: canonicalProvenance(item.provenance),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function historySnapshotsEqual(
  left: MapHistorySnapshot,
  right: MapHistorySnapshot,
): boolean {
  return (
    JSON.stringify(canonicalSnapshot(left)) ===
    JSON.stringify(canonicalSnapshot(right))
  );
}

function canonicalEntity(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalEntity);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [
        key,
        key === "provenance" && Array.isArray(record[key])
          ? canonicalProvenance(record[key] as Array<{ id: string }>)
          : canonicalEntity(record[key]),
      ]),
  );
}

function sameEntity(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalEntity(left)) ===
    JSON.stringify(canonicalEntity(right))
  );
}

export function historyStateDelta(
  before: MapHistorySnapshot,
  after: MapHistorySnapshot,
  relatedOperationLogId: string,
  relatedOperationType: string,
) {
  const beforeConcepts = new Map(
    before.concepts.map((item) => [item.id, item]),
  );
  const afterConcepts = new Map(after.concepts.map((item) => [item.id, item]));
  const beforeLinks = new Map(before.links.map((item) => [item.id, item]));
  const afterLinks = new Map(after.links.map((item) => [item.id, item]));
  const affectedConceptIds = [
    ...new Set([...beforeConcepts.keys(), ...afterConcepts.keys()]),
  ]
    .filter((id) => !sameEntity(beforeConcepts.get(id), afterConcepts.get(id)))
    .sort();
  const affectedLinkIds = [
    ...new Set([...beforeLinks.keys(), ...afterLinks.keys()]),
  ]
    .filter((id) => !sameEntity(beforeLinks.get(id), afterLinks.get(id)))
    .sort();

  const statePatch = (snapshot: MapHistorySnapshot) => ({
    relatedOperationLogId,
    relatedOperationType,
    affectedConceptIds,
    affectedLinkIds,
    concepts: snapshot.concepts.filter((item) =>
      affectedConceptIds.includes(item.id),
    ),
    links: snapshot.links.filter((item) => affectedLinkIds.includes(item.id)),
  });

  return {
    affectedConceptIds,
    affectedLinkIds,
    before: statePatch(before),
    after: statePatch(after),
  };
}
