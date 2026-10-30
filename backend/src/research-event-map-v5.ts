import { historySnapshotsEqual } from "./map-undo-redo.js";
import {
  validateMapStateV2,
  validateMapEventV2,
  MAX_MAP_STATE_BYTES,
} from "./research-event-map-v2.js";
import type { HistoryLink, MapHistorySnapshot } from "./map-history.js";
export const validMapCoordinate = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 10000000;
function withoutPosition(link: HistoryLink) {
  const base = { ...link };
  delete base.labelPositionX;
  delete base.labelPositionY;
  return base;
}
/** v2 remains exact. Only v5 adds a paired optional saved label position. Absence means automatic layout. */
export function validateMapStateV5(
  value: unknown,
  mapId: string,
): value is MapHistorySnapshot {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as MapHistorySnapshot).links)
  )
    return false;
  const state = value as MapHistorySnapshot;
  const links = state.links.map((link) => {
    if (!link || typeof link !== "object") return link;
    return withoutPosition(link);
  });
  if (
    !validateMapStateV2({ ...state, links }, mapId) ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_MAP_STATE_BYTES
  )
    return false;
  return state.links.every((link) => {
    const x = Object.hasOwn(link, "labelPositionX"),
      y = Object.hasOwn(link, "labelPositionY");
    return (
      x === y &&
      (!x ||
        (validMapCoordinate(link.labelPositionX) &&
          validMapCoordinate(link.labelPositionY)))
    );
  });
}
export function validateMapEventV5(event: Record<string, unknown>) {
  if (typeof event.mapId !== "string") return false;
  for (const field of ["before", "after"])
    if (
      event[field] !== undefined &&
      !validateMapStateV5(event[field], event.mapId)
    )
      return false;
  const strip = (state: unknown) =>
    state === undefined
      ? undefined
      : {
          ...(state as MapHistorySnapshot),
          links: (state as MapHistorySnapshot).links.map(withoutPosition),
        };
  const base = {
    ...event,
    eventType: event.eventType === "MOVE_LINK" ? "EDIT_LINK" : event.eventType,
    before: strip(event.before),
    after: strip(event.after),
  };
  if (!validateMapEventV2(base)) return false;
  if (event.eventType === "MOVE_LINK" && event.outcome === "SUCCESS") {
    const before = event.before as MapHistorySnapshot,
      after = event.after as MapHistorySnapshot;
    const old = before.links.find((x) => x.id === event.targetId),
      next = after.links.find((x) => x.id === event.targetId);
    if (
      !old ||
      !next ||
      !validMapCoordinate(next.labelPositionX) ||
      !validMapCoordinate(next.labelPositionY)
    )
      return false;
    if (
      old.labelPositionX === next.labelPositionX &&
      old.labelPositionY === next.labelPositionY
    )
      return false;
    const expected = structuredClone(before);
    Object.assign(
      expected.links.find((x) => x.id === event.targetId)!,
      {
        labelPositionX: next.labelPositionX,
        labelPositionY: next.labelPositionY,
      },
    );
    return historySnapshotsEqual(expected, after);
  }
  return true;
}
