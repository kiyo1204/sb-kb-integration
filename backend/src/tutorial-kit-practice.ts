import { compareKitBuild } from "./kit-build-comparison.js";

const photosynthesisKit = {
  id: "66666666-6666-4666-8666-666666666662",
  concepts: [
    {
      kitItemId: "77777777-7777-4777-8777-777777777781",
      id: "55555555-5555-4555-8555-555555555561",
      label: "植物",
    },
    {
      kitItemId: "77777777-7777-4777-8777-777777777782",
      id: "55555555-5555-4555-8555-555555555562",
      label: "光合成",
    },
    {
      kitItemId: "77777777-7777-4777-8777-777777777783",
      id: "55555555-5555-4555-8555-555555555563",
      label: "二酸化炭素",
    },
  ],
  links: [
    {
      kitItemId: "88888888-8888-4888-8888-888888888882",
      id: "99999999-9999-4999-8999-999999999981",
      label: "行う",
      sourceConceptId: "55555555-5555-4555-8555-555555555561",
      targetConceptId: "55555555-5555-4555-8555-555555555562",
    },
    {
      kitItemId: "88888888-8888-4888-8888-888888888883",
      id: "99999999-9999-4999-8999-999999999982",
      label: "必要とする",
      sourceConceptId: "55555555-5555-4555-8555-555555555562",
      targetConceptId: "55555555-5555-4555-8555-555555555563",
    },
  ],
} as const;

type ConceptPlacement = { kitConceptItemId: string; id: string };
type LinkPlacement = {
  kitLinkItemId: string;
  id: string;
  sourceConceptId: string;
  targetConceptId: string;
};

const practiceId = /^[A-Za-z0-9_-]{1,80}$/;

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parsePlacements(body: unknown) {
  if (
    !body ||
    typeof body !== "object" ||
    !hasExactKeys(body as Record<string, unknown>, ["concepts", "links"])
  ) {
    return null;
  }
  const { concepts, links } = body as {
    concepts: unknown;
    links: unknown;
  };
  if (
    !Array.isArray(concepts) ||
    !Array.isArray(links) ||
    concepts.length > photosynthesisKit.concepts.length ||
    links.length > photosynthesisKit.links.length
  ) {
    return null;
  }

  const allowedConceptItems = new Set<string>(
    photosynthesisKit.concepts.map(({ kitItemId }) => kitItemId),
  );
  const allowedLinkItems = new Set<string>(
    photosynthesisKit.links.map(({ kitItemId }) => kitItemId),
  );
  const conceptPlacements: ConceptPlacement[] = [];
  const linkPlacements: LinkPlacement[] = [];

  for (const value of concepts) {
    if (
      !value ||
      typeof value !== "object" ||
      !hasExactKeys(value as Record<string, unknown>, [
        "kitConceptItemId",
        "id",
      ])
    ) {
      return null;
    }
    const item = value as ConceptPlacement;
    if (
      typeof item.kitConceptItemId !== "string" ||
      !allowedConceptItems.has(item.kitConceptItemId) ||
      typeof item.id !== "string" ||
      !practiceId.test(item.id)
    ) {
      return null;
    }
    conceptPlacements.push(item);
  }

  const conceptIds = new Set(conceptPlacements.map(({ id }) => id));
  if (
    conceptIds.size !== conceptPlacements.length ||
    new Set(conceptPlacements.map(({ kitConceptItemId }) => kitConceptItemId))
      .size !== conceptPlacements.length
  ) {
    return null;
  }

  for (const value of links) {
    if (
      !value ||
      typeof value !== "object" ||
      !hasExactKeys(value as Record<string, unknown>, [
        "kitLinkItemId",
        "id",
        "sourceConceptId",
        "targetConceptId",
      ])
    ) {
      return null;
    }
    const item = value as LinkPlacement;
    if (
      typeof item.kitLinkItemId !== "string" ||
      !allowedLinkItems.has(item.kitLinkItemId) ||
      typeof item.id !== "string" ||
      !practiceId.test(item.id) ||
      !conceptIds.has(item.sourceConceptId) ||
      !conceptIds.has(item.targetConceptId) ||
      item.sourceConceptId === item.targetConceptId
    ) {
      return null;
    }
    linkPlacements.push(item);
  }

  if (
    new Set(linkPlacements.map(({ id }) => id)).size !== linkPlacements.length ||
    new Set(linkPlacements.map(({ kitLinkItemId }) => kitLinkItemId)).size !==
      linkPlacements.length ||
    new Set([
      ...conceptPlacements.map(({ id }) => id),
      ...linkPlacements.map(({ id }) => id),
    ]).size !== conceptPlacements.length + linkPlacements.length
  ) {
    return null;
  }
  return { conceptPlacements, linkPlacements };
}

export function evaluatePhotosynthesisKitPractice(body: unknown) {
  const placements = parsePlacements(body);
  if (!placements) return null;

  const conceptsByItem = new Map<string, (typeof photosynthesisKit.concepts)[number]>(
    photosynthesisKit.concepts.map((concept) => [concept.kitItemId, concept]),
  );
  const linksByItem = new Map<string, (typeof photosynthesisKit.links)[number]>(
    photosynthesisKit.links.map((link) => [link.kitItemId, link]),
  );
  const builtConcepts = placements.conceptPlacements.map((placement) => {
    const source = conceptsByItem.get(placement.kitConceptItemId)!;
    return { id: placement.id, label: source.label };
  });
  const builtLinks = placements.linkPlacements.map((placement) => {
    const source = linksByItem.get(placement.kitLinkItemId)!;
    return {
      id: placement.id,
      label: source.label,
      sourceConceptId: placement.sourceConceptId,
      targetConceptId: placement.targetConceptId,
    };
  });
  const result = compareKitBuild({
    kitDefinitionId: photosynthesisKit.id,
    goal: {
      concepts: photosynthesisKit.concepts.map(({ id, label }) => ({
        id,
        label,
      })),
      links: photosynthesisKit.links.map(
        ({ id, label, sourceConceptId, targetConceptId }) => ({
          id,
          label,
          sourceConceptId,
          targetConceptId,
        }),
      ),
    },
    assignedConceptIds: photosynthesisKit.concepts.map(({ id }) => id),
    assignedLinkIds: photosynthesisKit.links.map(({ id }) => id),
    built: {
      concepts: builtConcepts,
      links: builtLinks,
      conceptProvenance: placements.conceptPlacements.map((placement) => ({
        targetId: placement.id,
        sourceId: conceptsByItem.get(placement.kitConceptItemId)!.id,
      })),
      linkProvenance: placements.linkPlacements.map((placement) => ({
        targetId: placement.id,
        sourceId: linksByItem.get(placement.kitLinkItemId)!.id,
      })),
    },
  });
  return {
    matched: result.matched,
    concepts: result.concepts,
    relations: result.relations,
  };
}
