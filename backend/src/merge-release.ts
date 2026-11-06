import {
  replayMapAt,
  type HistoryOperation,
  type MapHistorySnapshot,
} from "./map-history.js";
import { validateMapStateV5 } from "./research-event-map-v5.js";

export class MergeReleaseUnavailableError extends Error {}

/** A local inverse of the generating Merge, never a rollback of the whole Map. */
export function releaseMerge(
  initial: MapHistorySnapshot,
  operations: HistoryOperation[],
  current: MapHistorySnapshot,
  targetId: string,
) {
  const fail = (): never => {
    throw new MergeReleaseUnavailableError();
  };
  const matches = operations
    .map((operation, index) => ({ operation, index }))
    .filter(
      ({ operation }) =>
        operation.operationType === "MERGE_CONCEPT" &&
        operation.targetId === targetId,
    );
  if (matches.length !== 1) return fail();
  const { index } = matches[0]!;
  const before = replayMapAt(initial, operations, index);
  const after = replayMapAt(initial, operations, index + 1);
  if (before.status !== "REPLAYABLE" || after.status !== "REPLAYABLE")
    return fail();
  const sources = after.state.concepts.filter(
    (c) => c.mergedIntoConceptId === targetId,
  );
  const sourceIds = new Set(sources.map((c) => c.id));
  const originals = before.state.concepts.filter((c) => sourceIds.has(c.id));
  const target = current.concepts.find((c) => c.id === targetId);
  if (
    !target ||
    target.mergedIntoConceptId !== null ||
    sources.length !== 2 ||
    originals.length !== 2 ||
    originals.some((c) => c.mergedIntoConceptId !== null)
  )
    return fail();
  const actualSources = current.concepts.filter(
    (c) => c.mergedIntoConceptId === targetId,
  );
  if (
    actualSources.length !== 2 ||
    actualSources.some((c) => !sourceIds.has(c.id))
  )
    return fail();
  const provenanceSources = target.provenance.filter(
    (p) => p.relationType === "MERGED_FROM",
  );
  if (
    provenanceSources.length !== 2 ||
    provenanceSources.some((p) => !sourceIds.has(p.sourceConceptId))
  )
    return fail();
  const restoredLinks = before.state.links.filter(
    (l) => sourceIds.has(l.sourceConceptId) || sourceIds.has(l.targetConceptId),
  );
  const restoredLinkIds = new Set(restoredLinks.map((l) => l.id));
  const desired = structuredClone(current);
  desired.concepts = desired.concepts
    .filter((c) => c.id !== targetId)
    .map((c) => originals.find((o) => o.id === c.id) ?? c);
  // Existing incident links follow ordinary deletion cascade. Original Merge links
  // are restored by identity even when subsequently edited, deleted or reconnected.
  desired.links = desired.links.filter(
    (l) =>
      l.sourceConceptId !== targetId &&
      l.targetConceptId !== targetId &&
      !restoredLinkIds.has(l.id),
  );
  desired.links.push(...restoredLinks);
  if (
    !validateMapStateV5(desired, current.mapId) ||
    desired.concepts.some((c) =>
      c.provenance.some((p) => p.sourceConceptId === targetId),
    ) ||
    desired.links.some((l) =>
      l.provenance.some(
        (p) =>
          current.links.some((old) => old.id === p.sourceLinkId) &&
          !desired.links.some((next) => next.id === p.sourceLinkId),
      ),
    )
  )
    return fail();
  return desired;
}
