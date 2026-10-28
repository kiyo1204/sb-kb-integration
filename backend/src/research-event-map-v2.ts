import type { HistoryConcept, HistoryLink, MapHistorySnapshot } from "./map-history.js";

export type MapStateV2 = MapHistorySnapshot;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/;
const forbiddenText = /(?:https?:\/\/|www\.|\b(?:authorization|bearer|cookie|password|passwd|token|secret|api[_-]?key|access[_-]?code)\b|アクセスコード|パスワード|トークン|認証情報|[a-z0-9_-]{32,})/i;
const id = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const obj = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const nullableId = (value: unknown) => value === null || id(value);
const label = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim().length > 0 && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) && !forbiddenText.test(value);
const timestamp = (value: unknown) => typeof value === "string" && iso.test(value) && Number.isFinite(Date.parse(value));
const coord = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10000000;
function provenance(value: unknown, owner: string, kind: "concept" | "link"): boolean {
  if (!Array.isArray(value) || value.length > 1000) return false;
  const target = kind === "concept" ? "targetConceptId" : "targetLinkId";
  const source = kind === "concept" ? "sourceConceptId" : "sourceLinkId";
  const seen = new Set<string>();
  return value.every(item => {
    if (!obj(item) || !exact(item, ["id", target, source, "relationType", "createdAt"]) || !id(item.id) || seen.has(item.id) || item[target] !== owner || !id(item[source]) || item[source] === owner || !timestamp(item.createdAt)) return false;
    seen.add(item.id);
    return typeof item.relationType === "string" && (kind === "concept" ? ["CLONED_FROM", "IMPORTED_FROM", "MERGED_FROM"] : ["CLONED_FROM", "IMPORTED_FROM", "RECONSTRUCTED_FROM"]).includes(item.relationType);
  });
}
function concept(value: unknown, mapId: string): value is HistoryConcept {
  return obj(value) && exact(value, ["id", "mapId", "label", "positionX", "positionY", "mergedIntoConceptId", "provenance"]) && id(value.id) && value.mapId === mapId && label(value.label) && coord(value.positionX) && coord(value.positionY) && nullableId(value.mergedIntoConceptId) && value.mergedIntoConceptId !== value.id && provenance(value.provenance, value.id, "concept");
}
function link(value: unknown, mapId: string): value is HistoryLink {
  return obj(value) && exact(value, ["id", "mapId", "label", "sourceConceptId", "targetConceptId", "provenance"]) && id(value.id) && value.mapId === mapId && label(value.label) && id(value.sourceConceptId) && id(value.targetConceptId) && provenance(value.provenance, value.id, "link");
}
export function validateMapStateV2(value: unknown, mapId: string): value is MapStateV2 {
  if (!obj(value) || !exact(value, ["snapshotVersion", "mapId", "mapType", "basedOnMapId", "kitDefinitionId", "concepts", "links"]) || value.snapshotVersion !== 1 || value.mapId !== mapId || !["PRIOR", "KB", "INTEGRATION"].includes(String(value.mapType)) || !nullableId(value.basedOnMapId) || !nullableId(value.kitDefinitionId) || !Array.isArray(value.concepts) || !Array.isArray(value.links) || value.concepts.length > 1000 || value.links.length > 2000) return false;
  if (!value.concepts.every(item => concept(item, mapId)) || !value.links.every(item => link(item, mapId))) return false;
  const concepts = value.concepts as HistoryConcept[], links = value.links as HistoryLink[];
  const conceptIds = new Set(concepts.map(item => item.id)), linkIds = new Set(links.map(item => item.id));
  if (conceptIds.size !== concepts.length || linkIds.size !== links.length) return false;
  return concepts.every(item => item.mergedIntoConceptId === null || conceptIds.has(item.mergedIntoConceptId)) && links.every(item => conceptIds.has(item.sourceConceptId) && conceptIds.has(item.targetConceptId));
}
const operations = ["ADD_CONCEPT", "EDIT_CONCEPT", "MOVE_CONCEPT", "DELETE_CONCEPT", "MERGE_CONCEPT", "IMPORT_KIT_CONCEPT", "ADD_LINK", "EDIT_LINK", "DELETE_LINK", "RECONNECT_LINK", "IMPORT_KIT_LINK", "UNDO", "REDO", "MAP_SAVE", "MAP_SUBMIT", "MAP_AUTO_SUBMIT"];
export function validateMapEventV2(event: Record<string, unknown>): boolean {
  if (typeof event.eventType !== "string" || !operations.includes(event.eventType) || !id(event.mapId)) return false;
  if (event.before !== undefined && !validateMapStateV2(event.before, event.mapId) || event.after !== undefined && !validateMapStateV2(event.after, event.mapId)) return false;
  if (event.outcome !== "SUCCESS") return true;
  if (!validateMapStateV2(event.before, event.mapId) || !validateMapStateV2(event.after, event.mapId)) return false;
  const before = event.before, after = event.after;
  if (before.mapType !== after.mapType || before.kitDefinitionId !== after.kitDefinitionId || before.basedOnMapId !== after.basedOnMapId) return false;
  if (["UNDO", "REDO"].includes(event.eventType) && !id(event.relatedEventId)) return false;
  if (event.targetType === "CONCEPT" || event.targetType === "LINK") {
    const group = event.targetType === "CONCEPT" ? "concepts" : "links";
    const hasBefore = before[group].some(item => item.id === event.targetId), hasAfter = after[group].some(item => item.id === event.targetId);
    if (["ADD_CONCEPT", "ADD_LINK", "IMPORT_KIT_CONCEPT", "IMPORT_KIT_LINK", "MERGE_CONCEPT"].includes(event.eventType)) return !hasBefore && hasAfter;
    if (["DELETE_CONCEPT", "DELETE_LINK"].includes(event.eventType)) return hasBefore && !hasAfter;
    return hasBefore && hasAfter;
  }
  return true;
}
export function mapStateLabels(state: MapStateV2): string[] { return [...state.concepts.map(item => item.label), ...state.links.map(item => item.label)]; }
