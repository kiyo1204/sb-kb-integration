import type { PoolClient } from "pg";
import {
  compareKitBuild,
  type KitBuildComparisonInput,
} from "./kit-build-comparison.js";

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
  // Load both graphs and their assignments from one statement snapshot.
  const result = await client.query<KitBuildComparisonInput>(
    `
      WITH selected AS (
        SELECT map.id, map.kit_definition_id, kit.goal_map_id
        FROM maps AS map
        LEFT JOIN kit_definitions AS kit ON kit.id = map.kit_definition_id
        WHERE map.id = $1::uuid AND map.type = 'KB'
      ),
      comparison_concepts AS (
        SELECT concept.id, concept.map_id, concept.label
        FROM concepts AS concept
        JOIN selected ON concept.map_id IN (selected.id, selected.goal_map_id)
        WHERE concept.merged_into_concept_id IS NULL
      ),
      comparison_links AS (
        SELECT link.id, link.map_id, link.label,
          link.source_concept_id AS "sourceConceptId",
          link.target_concept_id AS "targetConceptId"
        FROM links AS link
        JOIN selected ON link.map_id IN (selected.id, selected.goal_map_id)
      )
      SELECT selected.kit_definition_id AS "kitDefinitionId",
        jsonb_build_object(
          'concepts', ARRAY(SELECT row_to_json(c) FROM comparison_concepts AS c
            WHERE c.map_id = selected.goal_map_id),
          'links', ARRAY(SELECT row_to_json(l) FROM comparison_links AS l
            WHERE l.map_id = selected.goal_map_id)
        ) AS goal,
        ARRAY(SELECT source_concept_id FROM kit_concept_items
          WHERE kit_definition_id = selected.kit_definition_id) AS "assignedConceptIds",
        ARRAY(SELECT source_link_id FROM kit_link_items
          WHERE kit_definition_id = selected.kit_definition_id) AS "assignedLinkIds",
        jsonb_build_object(
          'concepts', ARRAY(SELECT row_to_json(c) FROM comparison_concepts AS c
            WHERE c.map_id = selected.id),
          'links', ARRAY(SELECT row_to_json(l) FROM comparison_links AS l
            WHERE l.map_id = selected.id),
          'conceptProvenance', ARRAY(
            SELECT jsonb_build_object('targetId', p.target_concept_id,
                                      'sourceId', p.source_concept_id)
            FROM concept_provenance AS p
            JOIN comparison_concepts AS c ON c.id = p.target_concept_id
            WHERE c.map_id = selected.id AND p.relation_type = 'CLONED_FROM'
          ),
          'linkProvenance', ARRAY(
            SELECT jsonb_build_object('targetId', p.target_link_id,
                                      'sourceId', p.source_link_id)
            FROM link_provenance AS p
            JOIN comparison_links AS l ON l.id = p.target_link_id
            WHERE l.map_id = selected.id AND p.relation_type = 'RECONSTRUCTED_FROM'
          )
        ) AS built
      FROM selected
    `,
    [mapId],
  );
  const input = result.rows[0];
  if (!input) return null;

  const {
    configurationComplete,
    matched,
    concepts,
    relations,
    conceptsMatch,
    relationsMatch,
  } = compareKitBuild(input);
  const issues: string[] = [];
  if (!conceptsMatch) issues.push("概念部品の配置を見直してください。");
  if (!relationsMatch) issues.push("関係部品の接続先を見直してください。");

  return {
    configurationComplete,
    matched,
    concepts,
    relations,
    message: !configurationComplete
      ? "このKitはGoal Map全体を含んでいません。研究者に確認してください。"
      : matched
        ? "Kit-Buildがゴールマップと一致しました。内容を見直して提出できます。"
        : `一致している部品：概念 ${concepts.matched}/${concepts.total}、関係 ${relations.matched}/${relations.total}。${issues.join("")}`,
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
