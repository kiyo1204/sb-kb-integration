import { validateMapStateV5 } from "./research-event-map-v5.js";
import { replayMapAt, type HistoryOperation, type MapHistorySnapshot } from "./map-history.js";
import { historySnapshotsEqual } from "./map-undo-redo.js";
import { validateMapStateV2 } from "./research-event-map-v2.js";

/** Boundary is the count and last ID of the frozen legacy history for this map. */
export type MapHistoryBoundary = { legacyCount: number; legacyLastId: string | null };
export type MapHistoryEventV2 = {
  eventId: string;
  mapId: string;
  schemaVersion: number;
  eventType: string;
  relatedEventId: string | null;
  relatedLegacyOperationLogId?: string | null;
  sequenceNumber: string;
  outcome: string;
  before: unknown;
  after: unknown;
};
export type MixedReplayResult =
  | { status: "REPLAYABLE"; state: MapHistorySnapshot; legacyApplied: number; newApplied: number }
  | { status: "PARTIAL"; state: null; legacyApplied: number; newApplied: number; reason: string; eventId: string | null };

/** Session sequence values may have gaps from other maps. They must still be strictly ordered here. */
export function replayMixedMapHistory(initial: MapHistorySnapshot, boundary: MapHistoryBoundary, legacy: HistoryOperation[], events: MapHistoryEventV2[]): MixedReplayResult {
  const partial = (reason: string, eventId: string | null, legacyApplied: number, newApplied: number): MixedReplayResult => ({ status: "PARTIAL", state: null, legacyApplied, newApplied, reason, eventId });
  if (!Number.isSafeInteger(boundary.legacyCount) || boundary.legacyCount < 0 || legacy.length !== boundary.legacyCount) return partial("旧履歴と切替境界の件数が一致しません。", null, 0, 0);
  if (legacy.some(item => !/^[1-9]\d*$/.test(item.sequenceNumber) || item.mapId !== initial.mapId)) return partial("旧履歴のマップまたは順序が不正です。", null, 0, 0);
  const sorted = [...legacy].sort((a, b) => BigInt(a.sequenceNumber) < BigInt(b.sequenceNumber) ? -1 : BigInt(a.sequenceNumber) > BigInt(b.sequenceNumber) ? 1 : a.id.localeCompare(b.id));
  if ((sorted.at(-1)?.id ?? null) !== boundary.legacyLastId) return partial("旧履歴の最終操作が切替境界と一致しません。", null, 0, 0);
  const old = replayMapAt(initial, sorted, sorted.length);
  if (old.status !== "REPLAYABLE") return partial(old.reason, sorted[old.appliedSequence]?.id ?? null, old.appliedSequence, 0);
  let current = old.state;
  let previous = 0n;
  const seen = new Set<string>();
  const precedingIds = new Set(sorted.map(item => item.id));
  for (const [index, event] of events.entries()) {
    if (!/^[1-9]\d*$/.test(event.sequenceNumber) || BigInt(event.sequenceNumber) <= previous || seen.has(event.eventId)) return partial("新イベントの順序またはIDが不正です。", event.eventId, sorted.length, index);
    previous = BigInt(event.sequenceNumber);
    seen.add(event.eventId);
    if (event.mapId !== initial.mapId || ![2,5].includes(event.schemaVersion)) return partial("新イベントのマップまたは形式が一致しません。", event.eventId, sorted.length, index);
    if (precedingIds.has(event.eventId)) return partial("操作IDが重複しています。", event.eventId, sorted.length, index);
    const validateMapState = event.schemaVersion === 5 ? validateMapStateV5 : validateMapStateV2;
    if (event.outcome !== "SUCCESS") {
      if (!["FAILURE", "REJECTED", "CANCELLED", "UNKNOWN"].includes(event.outcome)) return partial("新イベントの結果が不正です。", event.eventId, sorted.length, index);
      if (event.before !== null || event.after !== null) {
        if (!validateMapState(event.before, initial.mapId) || !validateMapState(event.after, initial.mapId) || !historySnapshotsEqual(current, event.before) || !historySnapshotsEqual(current, event.after)) return partial("不成功イベントの状態が現在の履歴と一致しません。", event.eventId, sorted.length, index);
      }
      precedingIds.add(event.eventId);
      continue;
    }
    if ((event.eventType === "UNDO" || event.eventType === "REDO") && (!(event.relatedEventId ?? event.relatedLegacyOperationLogId) || !precedingIds.has((event.relatedEventId ?? event.relatedLegacyOperationLogId)!))) return partial("Undo/Redoの対象操作が見つかりません。", event.eventId, sorted.length, index);
    if (!validateMapState(event.before, initial.mapId) || !validateMapState(event.after, initial.mapId)) return partial("新イベントの変更前後の状態が不足または不正です。", event.eventId, sorted.length, index);
    if (!historySnapshotsEqual(current, event.before)) return partial("変更前の状態が直前の履歴と一致しません。", event.eventId, sorted.length, index);
    current = structuredClone(event.after);
    precedingIds.add(event.eventId);
  }
  return { status: "REPLAYABLE", state: current, legacyApplied: sorted.length, newApplied: events.length };
}
