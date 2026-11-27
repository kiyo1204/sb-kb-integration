type Concept = { id: string; label: string };
type Link = Concept & { sourceConceptId: string; targetConceptId: string };
type Provenance = { targetId: string; sourceId: string };

type Graph = {
  concepts: readonly Concept[];
  links: readonly Link[];
};

// Graphs contain active concepts from their respective maps. Provenance
// lists contain only CLONED_FROM concepts and RECONSTRUCTED_FROM links.
export type KitBuildComparisonInput = {
  kitDefinitionId: string | null;
  goal: Graph;
  assignedConceptIds: readonly string[];
  assignedLinkIds: readonly string[];
  built: Graph & {
    conceptProvenance: readonly Provenance[];
    linkProvenance: readonly Provenance[];
  };
};

function sourcesByTarget(rows: readonly Provenance[]) {
  const index = new Map<string, Set<string>>();
  for (const { targetId, sourceId } of rows) {
    let sources = index.get(targetId);
    if (!sources) {
      sources = new Set();
      index.set(targetId, sources);
    }
    sources.add(sourceId);
  }
  return index;
}

function activeLinks(graph: Graph) {
  const concepts = new Set(graph.concepts.map(({ id }) => id));
  return graph.links.filter(
    ({ sourceConceptId, targetConceptId }) =>
      concepts.has(sourceConceptId) && concepts.has(targetConceptId),
  );
}

export function compareKitBuild({
  kitDefinitionId,
  goal,
  assignedConceptIds,
  assignedLinkIds,
  built,
}: KitBuildComparisonInput) {
  const goalLinks = activeLinks(goal);
  const builtLinks = activeLinks(built);
  const conceptSources = sourcesByTarget(built.conceptProvenance);
  const linkSources = sourcesByTarget(built.linkProvenance);
  const assignedConcepts = new Set(assignedConceptIds);
  const assignedLinks = new Set(assignedLinkIds);
  const coveredConcepts = goal.concepts.filter(({ id }) =>
    assignedConcepts.has(id),
  );
  const coveredLinks = goalLinks.filter(({ id }) => assignedLinks.has(id));

  const matchedConcepts = coveredConcepts.filter((expected) =>
    built.concepts.some(
      (actual) =>
        actual.label === expected.label &&
        conceptSources.get(actual.id)?.has(expected.id),
    ),
  ).length;
  const matchedLinks = coveredLinks.filter((expected) =>
    builtLinks.some(
      (actual) =>
        actual.label === expected.label &&
        linkSources.get(actual.id)?.has(expected.id) &&
        conceptSources
          .get(actual.sourceConceptId)
          ?.has(expected.sourceConceptId) &&
        conceptSources
          .get(actual.targetConceptId)
          ?.has(expected.targetConceptId),
    ),
  ).length;

  const concepts = { matched: matchedConcepts, total: goal.concepts.length };
  const relations = { matched: matchedLinks, total: goalLinks.length };
  const conceptsMatch =
    concepts.total > 0 &&
    concepts.total === concepts.matched &&
    concepts.total === built.concepts.length;
  const relationsMatch =
    relations.total === relations.matched &&
    relations.total === builtLinks.length;
  const configurationComplete =
    kitDefinitionId !== null &&
    concepts.total > 0 &&
    concepts.total === assignedConceptIds.length &&
    concepts.total === coveredConcepts.length &&
    relations.total === assignedLinkIds.length &&
    relations.total === coveredLinks.length;

  return {
    configurationComplete,
    matched: configurationComplete && conceptsMatch && relationsMatch,
    concepts,
    relations,
    conceptsMatch,
    relationsMatch,
  };
}
