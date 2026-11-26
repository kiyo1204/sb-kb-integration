import assert from "node:assert/strict";
import {
  compareKitBuild,
  type KitBuildComparisonInput,
} from "../kit-build-comparison.js";

// Matches the development photosynthesis Kit pinned in the rehearsal plan.
const goal = {
  concepts: [
    { id: "plant", label: "植物" },
    { id: "photosynthesis", label: "光合成" },
    { id: "carbon-dioxide", label: "二酸化炭素" },
  ],
  links: [
    {
      id: "perform",
      label: "行う",
      sourceConceptId: "plant",
      targetConceptId: "photosynthesis",
    },
    {
      id: "require",
      label: "必要とする",
      sourceConceptId: "photosynthesis",
      targetConceptId: "carbon-dioxide",
    },
  ],
};
const input: KitBuildComparisonInput = {
  kitDefinitionId: "66666666-6666-4666-8666-666666666662",
  goal,
  assignedConceptIds: goal.concepts.map(({ id }) => id),
  assignedLinkIds: goal.links.map(({ id }) => id),
  built: {
    concepts: goal.concepts.map(({ id, label }) => ({
      id: `built-${id}`,
      label,
    })),
    links: goal.links.map(
      ({ id, label, sourceConceptId, targetConceptId }) => ({
        id: `built-${id}`,
        label,
        sourceConceptId: `built-${sourceConceptId}`,
        targetConceptId: `built-${targetConceptId}`,
      }),
    ),
    conceptProvenance: goal.concepts.map(({ id }) => ({
      targetId: `built-${id}`,
      sourceId: id,
    })),
    linkProvenance: goal.links.map(({ id }) => ({
      targetId: `built-${id}`,
      sourceId: id,
    })),
  },
};
const [perform, requireLink] = input.built.links;
const reversed = {
  ...requireLink,
  sourceConceptId: requireLink.targetConceptId,
  targetConceptId: requireLink.sourceConceptId,
};
const reversedBuild = { ...input.built, links: [perform, reversed] };

// The carbon dioxide part is still in the palette. A visually misplaced
// part alone is not a mismatch, because coordinates are not compared.
const initial = compareKitBuild({
  ...input,
  built: {
    ...reversedBuild,
    concepts: input.built.concepts.slice(0, 2),
    links: [perform],
    conceptProvenance: input.built.conceptProvenance.slice(0, 2),
    linkProvenance: input.built.linkProvenance.slice(0, 1),
  },
});
assert.equal(initial.configurationComplete, true);
assert.equal(initial.matched, false);
assert.deepEqual(initial.concepts, { matched: 2, total: 3 });
assert.deepEqual(initial.relations, { matched: 1, total: 2 });

// Even with all parts placed, the reversed relation does not match.
const wrongDirection = compareKitBuild({ ...input, built: reversedBuild });
assert.equal(wrongDirection.matched, false);
assert.deepEqual(wrongDirection.concepts, { matched: 3, total: 3 });
assert.deepEqual(wrongDirection.relations, { matched: 1, total: 2 });

const wrongEndpoint = compareKitBuild({
  ...input,
  built: {
    ...input.built,
    links: [perform, { ...requireLink, targetConceptId: "built-plant" }],
  },
});
assert.equal(wrongEndpoint.matched, false);
assert.deepEqual(wrongEndpoint.relations, { matched: 1, total: 2 });

// Correct label and endpoints alone cannot replace the selected Kit part.
const wrongPart = compareKitBuild({
  ...input,
  built: {
    ...input.built,
    linkProvenance: input.built.linkProvenance.slice(0, 1),
  },
});
assert.equal(wrongPart.matched, false);
assert.deepEqual(wrongPart.relations, { matched: 1, total: 2 });

const before = structuredClone(input);
const corrected = compareKitBuild(input);
assert.equal(corrected.matched, true);
assert.deepEqual(corrected.concepts, { matched: 3, total: 3 });
assert.deepEqual(corrected.relations, { matched: 2, total: 2 });
assert.deepEqual(input, before);
assert.equal(
  compareKitBuild({ ...input, assignedLinkIds: ["perform", "foreign-link"] })
    .configurationComplete,
  false,
);
console.log(
  "KB comparison: PASS (incomplete placement, reversed relation, wrong endpoint, wrong part, corrected match, invalid assignment)",
);
