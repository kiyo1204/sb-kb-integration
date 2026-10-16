export type ConceptProvenanceSnapshot = {
  id: string;
  targetConceptId: string;
  sourceConceptId: string;
  relationType: string;
  createdAt: string;
};

export type LinkProvenanceSnapshot = {
  id: string;
  targetLinkId: string;
  sourceLinkId: string;
  relationType: string;
  createdAt: string;
};

export type HistoryConcept = {
  id: string;
  mapId: string;
  label: string;
  positionX: number;
  positionY: number;
  mergedIntoConceptId: string | null;
  provenance: ConceptProvenanceSnapshot[];
};

export type HistoryLink = {
  id: string;
  mapId: string;
  sourceConceptId: string;
  targetConceptId: string;
  label: string;
  provenance: LinkProvenanceSnapshot[];
};

export type MapHistorySnapshot = {
  snapshotVersion: 1;
  mapId: string;
  mapType: string;
  basedOnMapId: string | null;
  kitDefinitionId: string | null;
  concepts: HistoryConcept[];
  links: HistoryLink[];
};

export type HistoryOperation = {
  id: string;
  mapId: string;
  sequenceNumber: string;
  operationType: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  relatedOperationLogId?: string | null;
};

export type ReplayResult =
  | { status: "REPLAYABLE"; state: MapHistorySnapshot; appliedSequence: number }
  | { status: "PARTIAL"; state: null; appliedSequence: number; reason: string };

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function array(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function cloneSnapshot(snapshot: MapHistorySnapshot): MapHistorySnapshot {
  return structuredClone(snapshot);
}

function concept(value: unknown, mapId: string): HistoryConcept | null {
  const item = record(value);
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.label !== "string" ||
    typeof item.positionX !== "number" ||
    typeof item.positionY !== "number"
  ) {
    return null;
  }
  if (item.mapId !== undefined && item.mapId !== mapId) return null;
  const mergedIntoConceptId = item.mergedIntoConceptId;
  if (
    mergedIntoConceptId !== undefined &&
    mergedIntoConceptId !== null &&
    typeof mergedIntoConceptId !== "string"
  ) {
    return null;
  }
  if (item.provenance !== undefined && !Array.isArray(item.provenance))
    return null;
  return {
    id: item.id,
    mapId,
    label: item.label,
    positionX: item.positionX,
    positionY: item.positionY,
    mergedIntoConceptId:
      typeof mergedIntoConceptId === "string" ? mergedIntoConceptId : null,
    provenance:
      (item.provenance as ConceptProvenanceSnapshot[] | undefined) ?? [],
  };
}

function link(value: unknown, mapId: string): HistoryLink | null {
  const item = record(value);
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.label !== "string" ||
    typeof item.sourceConceptId !== "string" ||
    typeof item.targetConceptId !== "string"
  ) {
    return null;
  }
  if (item.mapId !== undefined && item.mapId !== mapId) return null;
  if (item.provenance !== undefined && !Array.isArray(item.provenance))
    return null;
  return {
    id: item.id,
    mapId,
    sourceConceptId: item.sourceConceptId,
    targetConceptId: item.targetConceptId,
    label: item.label,
    provenance: (item.provenance as LinkProvenanceSnapshot[] | undefined) ?? [],
  };
}

function assertConceptMatches(
  state: MapHistorySnapshot,
  item: HistoryConcept,
  rawSnapshot: unknown,
): string | null {
  const current = state.concepts.find((candidate) => candidate.id === item.id);
  if (!current)
    return `Concept ${item.id} is absent before its recorded operation.`;
  if (
    current.label !== item.label ||
    current.positionX !== item.positionX ||
    current.positionY !== item.positionY ||
    current.mergedIntoConceptId !== item.mergedIntoConceptId
  ) {
    return `Concept ${item.id} does not match the recorded before snapshot.`;
  }
  if (
    Array.isArray(record(rawSnapshot)?.provenance) &&
    JSON.stringify(current.provenance) !== JSON.stringify(item.provenance)
  ) {
    return `Concept ${item.id} Provenance does not match the recorded before snapshot.`;
  }
  return null;
}

function assertLinkMatches(
  state: MapHistorySnapshot,
  item: HistoryLink,
  rawSnapshot: unknown,
): string | null {
  const current = state.links.find((candidate) => candidate.id === item.id);
  if (!current)
    return `Link ${item.id} is absent before its recorded operation.`;
  if (
    current.sourceConceptId !== item.sourceConceptId ||
    current.targetConceptId !== item.targetConceptId ||
    current.label !== item.label
  ) {
    return `Link ${item.id} does not match the recorded before snapshot.`;
  }
  if (
    Array.isArray(record(rawSnapshot)?.provenance) &&
    JSON.stringify(current.provenance) !== JSON.stringify(item.provenance)
  ) {
    return `Link ${item.id} Provenance does not match the recorded before snapshot.`;
  }
  return null;
}

function replaceConcept(
  state: MapHistorySnapshot,
  next: HistoryConcept,
  rawSnapshot: unknown,
): void {
  const index = state.concepts.findIndex((item) => item.id === next.id);
  if (index < 0) {
    state.concepts.push(next);
  } else {
    const current = state.concepts[index]!;
    state.concepts[index] = {
      ...current,
      ...next,
      provenance: Array.isArray(record(rawSnapshot)?.provenance)
        ? next.provenance
        : current.provenance,
    };
  }
}

function replaceLink(
  state: MapHistorySnapshot,
  next: HistoryLink,
  rawSnapshot: unknown,
): void {
  const index = state.links.findIndex((item) => item.id === next.id);
  if (index < 0) {
    state.links.push(next);
  } else {
    const current = state.links[index]!;
    state.links[index] = {
      ...current,
      ...next,
      provenance: Array.isArray(record(rawSnapshot)?.provenance)
        ? next.provenance
        : current.provenance,
    };
  }
}

function requireConcept(value: unknown, mapId: string): HistoryConcept {
  const result = concept(value, mapId);
  if (!result)
    throw new Error("Concept snapshot is missing required map fields.");
  return result;
}

function requireLink(value: unknown, mapId: string): HistoryLink {
  const result = link(value, mapId);
  if (!result) throw new Error("Link snapshot is missing required map fields.");
  return result;
}

function applyOperation(
  state: MapHistorySnapshot,
  operation: HistoryOperation,
): void {
  if (operation.mapId !== state.mapId)
    throw new Error("Operation belongs to another Map.");
  const before = record(operation.before);
  const after = record(operation.after);
  switch (operation.operationType) {
    case "ADD_CONCEPT":
    case "IMPORT_KIT_CONCEPT": {
      if (!after) throw new Error("Added Concept snapshot is missing.");
      const next = requireConcept(after, state.mapId);
      if (next.id !== operation.targetId)
        throw new Error("Added Concept ID differs from target ID.");
      if (
        operation.operationType === "IMPORT_KIT_CONCEPT" &&
        !Array.isArray(after.provenance)
      ) {
        throw new Error("Kit Concept import snapshot omits Provenance.");
      }
      if (state.concepts.some((item) => item.id === next.id))
        throw new Error("Added Concept already exists.");
      state.concepts.push(next);
      return;
    }
    case "EDIT_CONCEPT":
    case "MOVE_CONCEPT": {
      if (!before || !after)
        throw new Error("Concept change snapshots are missing.");
      const previous = requireConcept(before, state.mapId);
      const next = requireConcept(after, state.mapId);
      if (
        previous.id !== operation.targetId ||
        next.id !== operation.targetId
      ) {
        throw new Error("Concept change ID differs from target ID.");
      }
      const mismatch = assertConceptMatches(state, previous, before);
      if (mismatch) throw new Error(mismatch);
      replaceConcept(state, next, after);
      return;
    }
    case "DELETE_CONCEPT": {
      if (!before) throw new Error("Deleted Concept snapshot is missing.");
      const deletedConcept = before.concept ?? before;
      const previous = requireConcept(deletedConcept, state.mapId);
      if (previous.id !== operation.targetId)
        throw new Error("Deleted Concept ID differs from target ID.");
      const mismatch = assertConceptMatches(state, previous, deletedConcept);
      if (mismatch) throw new Error(mismatch);
      const incidentValues = array(before.incidentLinks);
      if (!incidentValues)
        throw new Error("Deleted Concept incident Link snapshots are missing.");
      const incidentLinks = incidentValues.map((item) =>
        requireLink(item, state.mapId),
      );
      const incidentIds = new Set(incidentLinks.map((item) => item.id));
      for (const [index, item] of incidentLinks.entries()) {
        const linkMismatch = assertLinkMatches(
          state,
          item,
          incidentValues[index],
        );
        if (linkMismatch) throw new Error(linkMismatch);
      }
      const actualIncidentIds = state.links
        .filter(
          (item) =>
            item.sourceConceptId === previous.id ||
            item.targetConceptId === previous.id,
        )
        .map((item) => item.id);
      if (actualIncidentIds.some((id) => !incidentIds.has(id))) {
        throw new Error("Concept deletion snapshot omits a cascaded Link.");
      }
      state.links = state.links.filter((item) => !incidentIds.has(item.id));
      state.concepts = state.concepts.filter((item) => item.id !== previous.id);
      return;
    }
    case "ADD_LINK":
    case "IMPORT_KIT_LINK": {
      if (!after) throw new Error("Added Link snapshot is missing.");
      const next = requireLink(after, state.mapId);
      if (next.id !== operation.targetId)
        throw new Error("Added Link ID differs from target ID.");
      if (
        (operation.operationType === "IMPORT_KIT_LINK" ||
          state.mapType === "KB") &&
        !Array.isArray(after.provenance)
      ) {
        throw new Error("Kit Link import snapshot omits Provenance.");
      }
      if (state.links.some((item) => item.id === next.id))
        throw new Error("Added Link already exists.");
      if (
        !state.concepts.some((item) => item.id === next.sourceConceptId) ||
        !state.concepts.some((item) => item.id === next.targetConceptId)
      ) {
        throw new Error("Added Link references an absent Concept.");
      }
      state.links.push(next);
      return;
    }
    case "EDIT_LINK":
    case "RECONNECT_LINK": {
      if (!before || !after)
        throw new Error("Link change snapshots are missing.");
      const previous = requireLink(before, state.mapId);
      const next = requireLink(after, state.mapId);
      if (
        previous.id !== operation.targetId ||
        next.id !== operation.targetId
      ) {
        throw new Error("Link change ID differs from target ID.");
      }
      const mismatch = assertLinkMatches(state, previous, before);
      if (mismatch) throw new Error(mismatch);
      if (
        !state.concepts.some((item) => item.id === next.sourceConceptId) ||
        !state.concepts.some((item) => item.id === next.targetConceptId)
      ) {
        throw new Error("Updated Link references an absent Concept.");
      }
      replaceLink(state, next, after);
      return;
    }
    case "DELETE_LINK": {
      if (!before) throw new Error("Deleted Link snapshot is missing.");
      const previous = requireLink(before, state.mapId);
      if (previous.id !== operation.targetId)
        throw new Error("Deleted Link ID differs from target ID.");
      const mismatch = assertLinkMatches(state, previous, before);
      if (mismatch) throw new Error(mismatch);
      state.links = state.links.filter((item) => item.id !== previous.id);
      return;
    }
    case "MERGE_CONCEPT": {
      if (!before || !after) throw new Error("Merge snapshots are missing.");
      const beforeConceptValues = array(before.concepts);
      const beforeLinkValues = array(before.incidentLinks);
      const afterLinkValues = array(after.incidentLinks);
      const mergedResult = concept(after.concept, state.mapId);
      if (
        !beforeConceptValues ||
        beforeConceptValues.length !== 2 ||
        !beforeLinkValues ||
        !afterLinkValues ||
        !mergedResult ||
        mergedResult.id !== operation.targetId ||
        !Array.isArray(record(after.concept)?.provenance)
      ) {
        throw new Error(
          "Merge snapshots do not contain complete lineage information.",
        );
      }
      const sourceConcepts = beforeConceptValues.map((item) =>
        requireConcept(item, state.mapId),
      );
      for (const [index, source] of sourceConcepts.entries()) {
        const mismatch = assertConceptMatches(
          state,
          source,
          beforeConceptValues[index],
        );
        if (mismatch) throw new Error(mismatch);
      }
      if (state.concepts.some((item) => item.id === mergedResult.id)) {
        throw new Error("Merge result Concept already exists.");
      }
      const beforeLinks = beforeLinkValues.map((item) =>
        requireLink(item, state.mapId),
      );
      const afterLinks = afterLinkValues.map((item) =>
        requireLink(item, state.mapId),
      );
      const beforeLinkIds = new Set(beforeLinks.map((item) => item.id));
      const afterLinkIds = new Set(afterLinks.map((item) => item.id));
      if (
        beforeLinkIds.size !== afterLinkIds.size ||
        [...beforeLinkIds].some((id) => !afterLinkIds.has(id))
      ) {
        throw new Error("Merge changed the identity of an incident Link.");
      }
      for (const [index, item] of beforeLinks.entries()) {
        const mismatch = assertLinkMatches(
          state,
          item,
          beforeLinkValues[index],
        );
        if (mismatch) throw new Error(mismatch);
      }
      const mergedIds = new Set(sourceConcepts.map((item) => item.id));
      state.concepts = state.concepts.map((item) =>
        mergedIds.has(item.id)
          ? { ...item, mergedIntoConceptId: mergedResult.id }
          : item,
      );
      state.concepts.push(mergedResult);
      for (const [index, updated] of afterLinks.entries()) {
        replaceLink(state, updated, afterLinkValues[index]);
      }
      return;
    }
    case "UNDO":
    case "REDO": {
      if (!before || !after)
        throw new Error(`${operation.operationType} snapshots are missing.`);
      const requiredIds = (value: RecordValue, key: string) => {
        const ids = array(value[key]);
        if (
          !ids ||
          !ids.every((item) => typeof item === "string") ||
          new Set(ids).size !== ids.length
        ) {
          throw new Error(`${operation.operationType} ${key} are invalid.`);
        }
        return ids as string[];
      };
      const conceptIds = requiredIds(before, "affectedConceptIds");
      const linkIds = requiredIds(before, "affectedLinkIds");
      if (
        JSON.stringify(conceptIds) !==
          JSON.stringify(requiredIds(after, "affectedConceptIds")) ||
        JSON.stringify(linkIds) !==
          JSON.stringify(requiredIds(after, "affectedLinkIds"))
      ) {
        throw new Error(`${operation.operationType} affected IDs changed.`);
      }
      const relatedId = operation.relatedOperationLogId;
      if (
        typeof relatedId !== "string" ||
        before.relatedOperationLogId !== relatedId ||
        after.relatedOperationLogId !== relatedId ||
        typeof before.relatedOperationType !== "string" ||
        before.relatedOperationType !== after.relatedOperationType
      ) {
        throw new Error(`${operation.operationType} target is missing.`);
      }

      const applyConceptPatch = (
        patch: RecordValue,
        expected: RecordValue,
      ) => {
        const items = array(patch.concepts);
        if (!items) throw new Error("Undo/Redo Concept snapshots are missing.");
        const parsed = items.map((item) => requireConcept(item, state.mapId));
        if (
          parsed.some(
            (item) =>
              !conceptIds.includes(item.id) ||
              !Array.isArray(record(items.find((raw) => record(raw)?.id === item.id))?.provenance),
          ) ||
          new Set(parsed.map((item) => item.id)).size !== parsed.length
        ) {
          throw new Error("Undo/Redo Concept snapshot IDs are invalid.");
        }
        const byId = new Map(parsed.map((item) => [item.id, item]));
        for (const id of conceptIds) {
          const current = state.concepts.find((item) => item.id === id);
          const snapshot = byId.get(id);
          if (!snapshot) {
            if (current)
              throw new Error(`Concept ${id} presence differs in Undo/Redo snapshot.`);
          } else {
            const raw = array(expected.concepts)?.find(
              (item) => record(item)?.id === id,
            );
            if (!current) {
              throw new Error(`Concept ${id} is absent before its Undo/Redo event.`);
            }
            const mismatch = assertConceptMatches(state, snapshot, raw);
            if (mismatch) throw new Error(mismatch);
          }
        }
      };
      const applyLinkPatch = (patch: RecordValue, expected: RecordValue) => {
        const items = array(patch.links);
        if (!items) throw new Error("Undo/Redo Link snapshots are missing.");
        const parsed = items.map((item) => requireLink(item, state.mapId));
        if (
          parsed.some(
            (item) =>
              !linkIds.includes(item.id) ||
              !Array.isArray(record(items.find((raw) => record(raw)?.id === item.id))?.provenance),
          ) ||
          new Set(parsed.map((item) => item.id)).size !== parsed.length
        ) {
          throw new Error("Undo/Redo Link snapshot IDs are invalid.");
        }
        const byId = new Map(parsed.map((item) => [item.id, item]));
        for (const id of linkIds) {
          const current = state.links.find((item) => item.id === id);
          const snapshot = byId.get(id);
          if (!snapshot) {
            if (current)
              throw new Error(`Link ${id} presence differs in Undo/Redo snapshot.`);
          } else {
            const raw = array(expected.links)?.find(
              (item) => record(item)?.id === id,
            );
            if (!current) {
              throw new Error(`Link ${id} is absent before its Undo/Redo event.`);
            }
            const mismatch = assertLinkMatches(state, snapshot, raw);
            if (mismatch) throw new Error(mismatch);
          }
        }
      };

      applyConceptPatch(before, before);
      applyLinkPatch(before, before);
      const afterConcepts = array(after.concepts);
      const afterLinks = array(after.links);
      if (!afterConcepts || !afterLinks) {
        throw new Error(`${operation.operationType} after snapshots are missing.`);
      }
      const nextConcepts = afterConcepts.map((item) =>
        requireConcept(item, state.mapId),
      );
      const nextLinks = afterLinks.map((item) => requireLink(item, state.mapId));
      if (
        nextConcepts.some((item) => !conceptIds.includes(item.id)) ||
        nextLinks.some((item) => !linkIds.includes(item.id)) ||
        nextConcepts.some(
          (item) => !Array.isArray(record(afterConcepts.find((raw) => record(raw)?.id === item.id))?.provenance),
        ) ||
        nextLinks.some(
          (item) => !Array.isArray(record(afterLinks.find((raw) => record(raw)?.id === item.id))?.provenance),
        )
      ) {
        throw new Error(`${operation.operationType} after snapshot IDs are invalid.`);
      }
      const conceptIdSet = new Set(conceptIds);
      const linkIdSet = new Set(linkIds);
      state.concepts = state.concepts.filter((item) => !conceptIdSet.has(item.id));
      state.links = state.links.filter((item) => !linkIdSet.has(item.id));
      state.concepts.push(...nextConcepts);
      state.links.push(...nextLinks);
      for (const item of state.links) {
        if (
          !state.concepts.some((candidate) => candidate.id === item.sourceConceptId) ||
          !state.concepts.some((candidate) => candidate.id === item.targetConceptId)
        ) {
          throw new Error(`Undo/Redo Link ${item.id} references an absent Concept.`);
        }
      }
      for (const item of state.concepts) {
        if (
          item.mergedIntoConceptId !== null &&
          !state.concepts.some((candidate) => candidate.id === item.mergedIntoConceptId)
        ) {
          throw new Error(`Undo/Redo Concept ${item.id} has a missing Merge target.`);
        }
      }
      return;
    }
    default:
      throw new Error(`Unsupported operation type: ${operation.operationType}`);
  }
}

export function replayMapAt(
  initial: MapHistorySnapshot,
  operations: HistoryOperation[],
  throughSequence: number,
): ReplayResult {
  if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) {
    return {
      status: "PARTIAL",
      state: null,
      appliedSequence: 0,
      reason: "Invalid sequence number.",
    };
  }
  const sorted = [...operations].sort((a, b) => {
    const left = BigInt(a.sequenceNumber);
    const right = BigInt(b.sequenceNumber);
    return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
  });
  if (throughSequence > sorted.length) {
    return {
      status: "PARTIAL",
      state: null,
      appliedSequence: sorted.length,
      reason: "Requested sequence is beyond the recorded history.",
    };
  }
  const state = cloneSnapshot(initial);
  for (let index = 0; index < throughSequence; index += 1) {
    const operation = sorted[index]!;
    if (operation.sequenceNumber !== String(index + 1)) {
      return {
        status: "PARTIAL",
        state: null,
        appliedSequence: index,
        reason: `Sequence gap before operation ${operation.id}.`,
      };
    }
    try {
      applyOperation(state, operation);
    } catch (error) {
      return {
        status: "PARTIAL",
        state: null,
        appliedSequence: index,
        reason:
          error instanceof Error
            ? error.message
            : "Operation could not be replayed.",
      };
    }
  }
  return { status: "REPLAYABLE", state, appliedSequence: throughSequence };
}
