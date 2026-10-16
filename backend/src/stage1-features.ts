import type { SessionRawExport } from "./research-export.js";

/** Exploratory descriptive counts, NOT a learning-quality score. Formula v2. */
type Source = { sourceConceptId?: string; sourceLinkId?: string; relationType: string };
type Concept = { id: string; mergedIntoConceptId: string | null; provenance: Source[] };
type Link = { id: string; sourceConceptId: string; targetConceptId: string; label: string; provenance: Source[] };
type MapData = { researchRole?: string; concepts: Concept[]; links: Link[];
  operationLogs: Array<{ operationType: string }> };
type Kit = { id: string; conceptItems: unknown[]; linkItems: unknown[] };

const numberOf = (map: MapData | undefined, kind: string) =>
  map?.operationLogs.filter(event => event.operationType === kind).length ?? 0;

/**
 * "inherited" = externalized in the post-lesson Scratch map, NOT prior learning.
 * "added" = first present in the integration map; ambiguous merged nodes
 * with both origins are deliberately excluded from the binary cross-link count.
 */
export function deriveStage1Features(raw: SessionRawExport) {
  const maps = raw.maps as MapData[];
  const scratch = maps.find(m => m.researchRole === "learner_map");
  const kb = maps.find(m => m.researchRole === "kitbuild_map");
  const integrated = maps.find(m => m.researchRole === "integration_map");
  const undoEvents = maps.reduce((count,map)=>count+numberOf(map,"UNDO"),0);
  const redoEvents = maps.reduce((count,map)=>count+numberOf(map,"REDO"),0);
  const ordinaryEditEvents = maps.reduce((count,map)=>count+
    (map.operationLogs?.filter(event=>event.operationType!=="UNDO"&&event.operationType!=="REDO").length??0),0);
  const kit = (raw.kitDefinitions as Kit[]).find(
    k => k.id === raw.session.researchKitDefinitionId,
  );
  const originalConceptIds = new Set((scratch?.concepts ?? []).map(x => x.id));
  const originalLinks = new Map((scratch?.links ?? []).map(x => [x.id,x]));
  const integrationConcepts = new Map((integrated?.concepts ?? []).map(x=>[x.id,x]));
  const originalIdOf = new Map<string,string>();
  for (const c of integrated?.concepts ?? []) {
    const priorSource = c.provenance?.find(p=>p.relationType==="CLONED_FROM"
      && p.sourceConceptId && originalConceptIds.has(p.sourceConceptId));
    if (priorSource?.sourceConceptId) originalIdOf.set(c.id,priorSource.sourceConceptId);
  }

  type Flags = { inherited: boolean; added: boolean };
  const origins = new Map<string,Flags>();
  function origin(id: string, visiting = new Set<string>()): Flags {
    const cached=origins.get(id); if(cached) return cached;
    if(visiting.has(id)) return {inherited:false,added:false};
    const node=integrationConcepts.get(id);
    if(!node)return {inherited:false,added:false};
    visiting.add(id);
    const p=node.provenance ?? [];
    const inherited=p.some(s=>s.relationType==="CLONED_FROM"
      && s.sourceConceptId && originalConceptIds.has(s.sourceConceptId));
    const imported=p.some(s=>s.relationType==="IMPORTED_FROM");
    const merged=p.filter(s=>s.relationType==="MERGED_FROM" && s.sourceConceptId);
    const children=merged.map(s=>origin(s.sourceConceptId!,visiting));
    const result: Flags={
      inherited: Boolean(inherited)||children.some(x=>x.inherited),
      added: imported||children.some(x=>x.added)||(!inherited&&!imported&&merged.length===0),
    };
    visiting.delete(id);origins.set(id,result);return result;
  }

  let retained=0,cross=0,mixed=0;
  for(const link of integrated?.links ?? []){
    const original=link.provenance?.filter(s=>s.relationType==="CLONED_FROM"&&s.sourceLinkId)
      .map(s=>originalLinks.get(s.sourceLinkId!)).find(Boolean);
    if(original && original.label===link.label
      && original.sourceConceptId===originalIdOf.get(link.sourceConceptId)
      && original.targetConceptId===originalIdOf.get(link.targetConceptId))retained++;
    const a=origin(link.sourceConceptId),b=origin(link.targetConceptId);
    if((a.inherited&&a.added)||(b.inherited&&b.added))mixed++;
    else if((a.inherited&&!a.added&&b.added&&!b.inherited)
      ||(b.inherited&&!b.added&&a.added&&!a.inherited))cross++;
  }

  const importedConcepts=new Set((integrated?.concepts ?? []).flatMap(c=>
    (c.provenance??[]).filter(p=>p.relationType==="IMPORTED_FROM"&&p.sourceConceptId)
      .map(p=>p.sourceConceptId!)));
  const importedLinks=new Set((integrated?.links ?? []).flatMap(l=>
    (l.provenance??[]).filter(p=>p.relationType==="IMPORTED_FROM"&&p.sourceLinkId)
      .map(p=>p.sourceLinkId!)));
  const conceptParts=kit?.conceptItems?.length??0,linkParts=kit?.linkItems?.length??0;
  return {
    featureVersion:"stage1-descriptive-v2",
    ordinaryEditEvents,
    undoEvents,
    redoEvents,
    scratchConcepts:scratch?.concepts.length??0,
    scratchLinks:scratch?.links.length??0,
    kbConcepts:kb?.concepts.length??0,
    kbLinks:kb?.links.length??0,
    integrationActiveConcepts:integrated?.concepts.filter(c=>c.mergedIntoConceptId===null).length??0,
    integrationLinks:integrated?.links.length??0,
    retainedScratchPropositions:retained,
    inheritedToAddedPropositions:cross,
    mixedMergeEndpointPropositions:mixed,
    kitConceptPartCount:conceptParts,
    kitLinkPartCount:linkParts,
    kitConceptImportEvents:numberOf(integrated,"IMPORT_KIT_CONCEPT"),
    kitLinkImportEvents:numberOf(integrated,"IMPORT_KIT_LINK"),
    currentlyImportedDistinctKitConcepts:importedConcepts.size,
    currentlyImportedDistinctKitLinks:importedLinks.size,
    currentKitConceptUsageRate:conceptParts?importedConcepts.size/conceptParts:null,
    currentKitLinkUsageRate:linkParts?importedLinks.size/linkParts:null,
    addConceptEvents:numberOf(integrated,"ADD_CONCEPT"),
    editConceptEvents:numberOf(integrated,"EDIT_CONCEPT"),
    deleteConceptEvents:numberOf(integrated,"DELETE_CONCEPT"),
    moveConceptEvents:numberOf(integrated,"MOVE_CONCEPT"),
    addLinkEvents:numberOf(integrated,"ADD_LINK"),
    editLinkEvents:numberOf(integrated,"EDIT_LINK"),
    deleteLinkEvents:numberOf(integrated,"DELETE_LINK"),
    reconnectLinkEvents:numberOf(integrated,"RECONNECT_LINK"),
    mergeConceptEvents:numberOf(integrated,"MERGE_CONCEPT"),
  };
}
