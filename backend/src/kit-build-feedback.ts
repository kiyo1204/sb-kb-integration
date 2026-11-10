import type { PoolClient } from "pg";
type KitBuildFeedback = {
  configurationComplete: boolean;
  matched: boolean;
  concepts: { matched: number; total: number };
  relations: { matched: number; total: number };
  message: string;
};

export type KitBuildFeedbackWithSignature = KitBuildFeedback & {
  mapSignature: string;
};

export async function readKitBuildFeedback(
  client: PoolClient,
  mapId: string,
): Promise<KitBuildFeedback | null> {
  const result = await client.query<{
    kitDefinitionId: string | null;
    expectedConcepts: number;
    assignedConcepts: number;
    validAssignedConcepts: number;
    matchedConcepts: number;
    activeConcepts: number;
    expectedLinks: number;
    assignedLinks: number;
    validAssignedLinks: number;
    matchedLinks: number;
    activeLinks: number;
  }>(
    `
      SELECT
        map.kit_definition_id AS "kitDefinitionId",
        (SELECT count(*)::int
         FROM kit_definitions AS kit
         INNER JOIN concepts AS goal_concept
           ON goal_concept.map_id = kit.goal_map_id
           AND goal_concept.merged_into_concept_id IS NULL
         WHERE kit.id = map.kit_definition_id) AS "expectedConcepts",
        (SELECT count(*)::int FROM kit_concept_items AS item
         WHERE item.kit_definition_id = map.kit_definition_id) AS "assignedConcepts",
        (SELECT count(*)::int
         FROM kit_concept_items AS item
         INNER JOIN kit_definitions AS kit ON kit.id = item.kit_definition_id
         INNER JOIN concepts AS goal_concept
           ON goal_concept.id = item.source_concept_id
           AND goal_concept.map_id = kit.goal_map_id
           AND goal_concept.merged_into_concept_id IS NULL
         WHERE item.kit_definition_id = map.kit_definition_id) AS "validAssignedConcepts",
        (SELECT count(*)::int
         FROM kit_definitions AS kit
         INNER JOIN concepts AS goal_concept
           ON goal_concept.map_id = kit.goal_map_id
           AND goal_concept.merged_into_concept_id IS NULL
         WHERE kit.id = map.kit_definition_id
           AND EXISTS (
             SELECT 1 FROM kit_concept_items AS item
             WHERE item.kit_definition_id = kit.id
               AND item.source_concept_id = goal_concept.id
           )
           AND EXISTS (
             SELECT 1
             FROM concepts AS built_concept
             INNER JOIN concept_provenance AS provenance
               ON provenance.target_concept_id = built_concept.id
               AND provenance.source_concept_id = goal_concept.id
               AND provenance.relation_type = 'CLONED_FROM'
             WHERE built_concept.map_id = map.id
               AND built_concept.merged_into_concept_id IS NULL
               AND built_concept.label = goal_concept.label
           )) AS "matchedConcepts",
        (SELECT count(*)::int FROM concepts AS built_concept
         WHERE built_concept.map_id = map.id
           AND built_concept.merged_into_concept_id IS NULL) AS "activeConcepts",
        (SELECT count(*)::int
         FROM kit_definitions AS kit
         INNER JOIN links AS goal_link ON goal_link.map_id = kit.goal_map_id
         INNER JOIN concepts AS goal_source
           ON goal_source.id = goal_link.source_concept_id
           AND goal_source.map_id = kit.goal_map_id
           AND goal_source.merged_into_concept_id IS NULL
         INNER JOIN concepts AS goal_target
           ON goal_target.id = goal_link.target_concept_id
           AND goal_target.map_id = kit.goal_map_id
           AND goal_target.merged_into_concept_id IS NULL
         WHERE kit.id = map.kit_definition_id) AS "expectedLinks",
        (SELECT count(*)::int FROM kit_link_items AS item
         WHERE item.kit_definition_id = map.kit_definition_id) AS "assignedLinks",
        (SELECT count(*)::int
         FROM kit_link_items AS item
         INNER JOIN kit_definitions AS kit ON kit.id = item.kit_definition_id
         INNER JOIN links AS goal_link
           ON goal_link.id = item.source_link_id
           AND goal_link.map_id = kit.goal_map_id
         INNER JOIN concepts AS goal_source
           ON goal_source.id = goal_link.source_concept_id
           AND goal_source.map_id = kit.goal_map_id
           AND goal_source.merged_into_concept_id IS NULL
         INNER JOIN concepts AS goal_target
           ON goal_target.id = goal_link.target_concept_id
           AND goal_target.map_id = kit.goal_map_id
           AND goal_target.merged_into_concept_id IS NULL
         WHERE item.kit_definition_id = map.kit_definition_id) AS "validAssignedLinks",
        (SELECT count(*)::int
         FROM kit_definitions AS kit
         INNER JOIN links AS goal_link
           ON goal_link.map_id = kit.goal_map_id
         INNER JOIN concepts AS goal_source
           ON goal_source.id = goal_link.source_concept_id
           AND goal_source.map_id = kit.goal_map_id
           AND goal_source.merged_into_concept_id IS NULL
         INNER JOIN concepts AS goal_target
           ON goal_target.id = goal_link.target_concept_id
           AND goal_target.map_id = kit.goal_map_id
           AND goal_target.merged_into_concept_id IS NULL
         WHERE kit.id = map.kit_definition_id
           AND EXISTS (
             SELECT 1 FROM kit_link_items AS item
             WHERE item.kit_definition_id = kit.id
               AND item.source_link_id = goal_link.id
           )
           AND EXISTS (
             SELECT 1
             FROM links AS built_link
             INNER JOIN link_provenance AS link_source
               ON link_source.target_link_id = built_link.id
               AND link_source.source_link_id = goal_link.id
               AND link_source.relation_type = 'RECONSTRUCTED_FROM'
             WHERE built_link.map_id = map.id
               AND built_link.label = goal_link.label
               AND EXISTS (
                 SELECT 1
                 FROM concept_provenance AS source_provenance
                 INNER JOIN concepts AS built_source
                   ON built_source.id = source_provenance.target_concept_id
                   AND built_source.map_id = map.id
                   AND built_source.merged_into_concept_id IS NULL
                 WHERE built_source.id = built_link.source_concept_id
                   AND source_provenance.source_concept_id = goal_link.source_concept_id
                   AND source_provenance.relation_type = 'CLONED_FROM'
               )
               AND EXISTS (
                 SELECT 1
                 FROM concept_provenance AS target_provenance
                 INNER JOIN concepts AS built_target
                   ON built_target.id = target_provenance.target_concept_id
                   AND built_target.map_id = map.id
                   AND built_target.merged_into_concept_id IS NULL
                 WHERE built_target.id = built_link.target_concept_id
                   AND target_provenance.source_concept_id = goal_link.target_concept_id
                   AND target_provenance.relation_type = 'CLONED_FROM'
               )
           )) AS "matchedLinks",
        (SELECT count(*)::int
         FROM links AS built_link
         INNER JOIN concepts AS source_concept
           ON source_concept.id = built_link.source_concept_id
           AND source_concept.map_id = map.id
           AND source_concept.merged_into_concept_id IS NULL
         INNER JOIN concepts AS target_concept
           ON target_concept.id = built_link.target_concept_id
           AND target_concept.map_id = map.id
           AND target_concept.merged_into_concept_id IS NULL
         WHERE built_link.map_id = map.id) AS "activeLinks"
      FROM maps AS map
      WHERE map.id = $1::uuid AND map.type = 'KB'
    `,
    [mapId],
  );
  const counts = result.rows[0];
  if (!counts) return null;

  const conceptsMatch =
    counts.expectedConcepts > 0 &&
    counts.expectedConcepts === counts.matchedConcepts &&
    counts.expectedConcepts === counts.activeConcepts;
  const relationsMatch =
    counts.expectedLinks === counts.matchedLinks &&
    counts.expectedLinks === counts.activeLinks;
  const configurationComplete =
    counts.kitDefinitionId !== null &&
    counts.expectedConcepts > 0 &&
    counts.expectedConcepts === counts.assignedConcepts &&
    counts.assignedConcepts === counts.validAssignedConcepts &&
    counts.expectedLinks === counts.assignedLinks &&
    counts.assignedLinks === counts.validAssignedLinks;
  const matched = configurationComplete && conceptsMatch && relationsMatch;
  const issues: string[] = [];
  if (!conceptsMatch) issues.push("概念部品の配置を見直してください。");
  if (!relationsMatch) issues.push("関係部品の接続先を見直してください。");

  return {
    configurationComplete,
    matched,
    concepts: {
      matched: counts.matchedConcepts,
      total: counts.expectedConcepts,
    },
    relations: {
      matched: counts.matchedLinks,
      total: counts.expectedLinks,
    },
    message: !configurationComplete
      ? "このKitはGoal Map全体を含んでいません。研究者に確認してください。"
      : matched
        ? "Kit-Buildがゴールマップと一致しました。内容を見直して提出できます。"
        : `一致している部品：概念 ${counts.matchedConcepts}/${counts.expectedConcepts}、関係 ${counts.matchedLinks}/${counts.expectedLinks}。${issues.join("")}`,
  };
}

// Callers hold a Map row lock; positions do not affect matching.
export async function readKitBuildMapSignature(
  client: PoolClient,
  mapId: string,
): Promise<string | null> {
  const map = await client.query<{ kitDefinitionId: string | null }>(
    `SELECT kit_definition_id AS "kitDefinitionId" FROM maps WHERE id = $1::uuid`,
    [mapId],
  );
  if (!map.rows[0]) return null;
  const concepts = await client.query<{ id: string; label: string }>(
    `SELECT id, label FROM concepts
     WHERE map_id = $1::uuid AND merged_into_concept_id IS NULL ORDER BY id`,
    [mapId],
  );
  const links = await client.query<{
    id: string;
    label: string;
    sourceConceptId: string;
    targetConceptId: string;
  }>(
    `SELECT link.id, link.label, link.source_concept_id AS "sourceConceptId",
            link.target_concept_id AS "targetConceptId"
     FROM links link
     JOIN concepts source ON source.id = link.source_concept_id
       AND source.map_id = link.map_id AND source.merged_into_concept_id IS NULL
     JOIN concepts target ON target.id = link.target_concept_id
       AND target.map_id = link.map_id AND target.merged_into_concept_id IS NULL
     WHERE link.map_id = $1::uuid ORDER BY link.id`,
    [mapId],
  );
  return JSON.stringify([
    mapId,
    map.rows[0].kitDefinitionId,
    concepts.rows.map(({ id, label }) => [id, label]),
    links.rows.map(({ id, label, sourceConceptId, targetConceptId }) => [
      id,
      label,
      sourceConceptId,
      targetConceptId,
    ]),
  ]);
}

// The feedback and its signature describe the same saved graph under the Map lock.
export async function readKitBuildFeedbackWithSignature(
  client: PoolClient,
  mapId: string,
): Promise<KitBuildFeedbackWithSignature | null> {
  const feedback = await readKitBuildFeedback(client, mapId);
  if (!feedback) return null;
  const mapSignature = await readKitBuildMapSignature(client, mapId);
  return mapSignature === null ? null : { ...feedback, mapSignature };
}
