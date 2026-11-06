import type { Express, Response } from "express";
import type { Pool, PoolClient } from "pg";
import { principalOf, tokenHash } from "./access-control.js";
import { MAX_MAP_STATE_BYTES, validMapLabel } from "./research-event-map-v2.js";
import { validMapCoordinate } from "./research-event-map-v5.js";

export const GOAL_MAP_JSON_FORMAT = "sb-kb-goal-map";
export const GOAL_MAP_JSON_SCHEMA_VERSION = 1;
export const MAX_GOAL_MAP_CONCEPTS = 1000;
export const MAX_GOAL_MAP_LINKS = 2000;

type Point = { x: number; y: number };
export type GoalMapJson = {
  format: typeof GOAL_MAP_JSON_FORMAT;
  schemaVersion: typeof GOAL_MAP_JSON_SCHEMA_VERSION;
  goalMap: {
    title: string;
    concepts: Array<{ id: string; label: string; position: Point }>;
    links: Array<{
      id: string;
      label: string;
      sourceId: string;
      targetId: string;
      labelPosition: Point | null;
    }>;
  };
};

const obj = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const portableId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
const validPoint = (value: unknown): value is Point =>
  obj(value) &&
  exact(value, ["x", "y"]) &&
  validMapCoordinate(value.x) &&
  validMapCoordinate(value.y);

export function validateGoalMapJson(value: unknown): value is GoalMapJson {
  if (
    !obj(value) ||
    !exact(value, ["format", "schemaVersion", "goalMap"]) ||
    value.format !== GOAL_MAP_JSON_FORMAT ||
    value.schemaVersion !== GOAL_MAP_JSON_SCHEMA_VERSION ||
    !obj(value.goalMap) ||
    !exact(value.goalMap, ["title", "concepts", "links"])
  )
    return false;
  const map = value.goalMap;
  if (
    typeof map.title !== "string" ||
    map.title !== map.title.trim() ||
    !validMapLabel(map.title) ||
    map.title.length > 120 ||
    !Array.isArray(map.concepts) ||
    !Array.isArray(map.links) ||
    map.concepts.length > MAX_GOAL_MAP_CONCEPTS ||
    map.links.length > MAX_GOAL_MAP_LINKS
  )
    return false;
  const allIds = new Set<string>();
  const conceptIds = new Set<string>();
  for (const concept of map.concepts) {
    if (
      !obj(concept) ||
      !exact(concept, ["id", "label", "position"]) ||
      !portableId(concept.id) ||
      allIds.has(concept.id) ||
      !validMapLabel(concept.label) ||
      !validPoint(concept.position)
    )
      return false;
    allIds.add(concept.id);
    conceptIds.add(concept.id);
  }
  for (const link of map.links) {
    if (
      !obj(link) ||
      !exact(link, ["id", "label", "sourceId", "targetId", "labelPosition"]) ||
      !portableId(link.id) ||
      allIds.has(link.id) ||
      !validMapLabel(link.label) ||
      !portableId(link.sourceId) ||
      !portableId(link.targetId) ||
      !conceptIds.has(link.sourceId) ||
      !conceptIds.has(link.targetId) ||
      !(link.labelPosition === null || validPoint(link.labelPosition))
    )
      return false;
    allIds.add(link.id);
  }
  return (
    Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_MAP_STATE_BYTES
  );
}

function statusError(
  response: Response,
  status: number,
  error: string,
  message: string,
) {
  return response.status(status).json({ error, message });
}

async function hasLearnerCredential(client: Pick<PoolClient, "query">, textValues: string[]) {
  const result = await client.query<{ learner_access_token_hash: string }>(
    "SELECT learner_access_token_hash FROM sessions WHERE learner_access_token_hash IS NOT NULL",
  );
  const hashes = new Set(result.rows.map(row => row.learner_access_token_hash));
  const matches = (text: string) => hashes.has(tokenHash(text));
  for (const value of textValues) {
    if (matches(value) || value.split(/\s+/).some(matches)) return true;
    for (const run of value.match(/[A-Za-z0-9_-]{32,}/g) ?? []) {
      if (matches(run)) return true;
      // Current learner codes are 32 random bytes encoded as 43 base64url
      // characters. Also detect them inside old labels with no separator.
      for (let i = 0; i + 43 <= run.length; i++)
        if (matches(run.slice(i, i + 43))) return true;
    }
  }
  return false;
}

export function registerGoalMapTransferRoutes(app: Express, pool: Pool) {
  app.get(
    "/api/research/goal-maps/:mapId/export",
    async (request, response) => {
      if (principalOf(response).role !== "researcher")
        return statusError(response, 404, "not_found", "見つかりません。");
      const mapId = request.params.mapId;
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          mapId,
        )
      )
        return statusError(response, 404, "not_found", "見つかりません。");
      try {
        const mapResult = await pool.query<{ title: string | null }>(
          "SELECT title FROM maps WHERE id=$1::uuid AND type='GOAL'",
          [mapId],
        );
        if (!mapResult.rowCount)
          return statusError(
            response,
            404,
            "not_found",
            "ゴールマップが見つかりません。",
          );
        const concepts = await pool.query<{
          id: string;
          label: string;
          x: number;
          y: number;
        }>(
          `SELECT id,label,position_x AS x,position_y AS y FROM concepts
         WHERE map_id=$1::uuid AND merged_into_concept_id IS NULL ORDER BY created_at,id`,
          [mapId],
        );
        const internalToPortable = new Map(
          concepts.rows.map((concept, index) => [
            concept.id,
            `concept-${index + 1}`,
          ]),
        );
        const links = await pool.query<{
          id: string;
          label: string;
          sourceId: string;
          targetId: string;
          x: number | null;
          y: number | null;
        }>(
          `SELECT id,label,source_concept_id AS "sourceId",target_concept_id AS "targetId",
                label_position_x AS x,label_position_y AS y
           FROM links WHERE map_id=$1::uuid ORDER BY created_at,id`,
          [mapId],
        );
        const document: GoalMapJson = {
          format: GOAL_MAP_JSON_FORMAT,
          schemaVersion: GOAL_MAP_JSON_SCHEMA_VERSION,
          goalMap: {
            title: mapResult.rows[0]!.title ?? "ゴールマップ",
            concepts: concepts.rows.map((concept, index) => ({
              id: `concept-${index + 1}`,
              label: concept.label,
              position: { x: Number(concept.x), y: Number(concept.y) },
            })),
            links: links.rows.map((link, index) => ({
              id: `link-${index + 1}`,
              label: link.label,
              sourceId: internalToPortable.get(link.sourceId) ?? "",
              targetId: internalToPortable.get(link.targetId) ?? "",
              labelPosition:
                link.x === null || link.y === null
                  ? null
                  : { x: Number(link.x), y: Number(link.y) },
            })),
          },
        };
        const textValues = [document.goalMap.title, ...document.goalMap.concepts.map(item => item.label), ...document.goalMap.links.map(item => item.label)];
        const researcher = process.env.RESEARCHER_API_TOKEN;
        if ((researcher && textValues.some(text => text.includes(researcher))) || await hasLearnerCredential(pool, textValues))
          return statusError(response, 409, "sensitive_text_rejected", "認証情報を含むためゴールマップを書き出せません。");
        if (!validateGoalMapJson(document))
          return statusError(
            response,
            500,
            "goal_map_export_invalid",
            "ゴールマップをJSON形式にできませんでした。",
          );
        const filename = `goal-map-${mapId}.json`;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        return response.json(document);
      } catch {
        return statusError(
          response,
          500,
          "goal_map_export_failed",
          "ゴールマップを書き出せませんでした。",
        );
      }
    },
  );

  app.post("/api/research/goal-maps/import", async (request, response) => {
    if (principalOf(response).role !== "researcher")
      return statusError(response, 404, "not_found", "見つかりません。");
    const document: unknown = request.body;
    if (!validateGoalMapJson(document))
      return statusError(
        response,
        400,
        "invalid_goal_map_json",
        "JSONの形式、項目、概念・リンクの内容を確認してください。",
      );
    const map = document.goalMap;
    const textValues = [
      map.title,
      ...map.concepts.map((concept) => concept.label),
      ...map.links.map((link) => link.label),
    ];
    if (
      process.env.RESEARCHER_API_TOKEN &&
      textValues.some((text) =>
        text.includes(process.env.RESEARCHER_API_TOKEN!),
      )
    )
      return statusError(
        response,
        400,
        "sensitive_text_rejected",
        "タイトルやラベルに認証情報を含めることはできません。",
      );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (await hasLearnerCredential(client, textValues)) {
        await client.query("ROLLBACK");
        return statusError(
          response,
          400,
          "sensitive_text_rejected",
          "タイトルやラベルにアクセスコードを含めることはできません。",
        );
      }
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [map.title.toLowerCase()],
      );
      const duplicate = await client.query(
        "SELECT 1 FROM maps WHERE type='GOAL' AND lower(btrim(title))=lower(btrim($1)) LIMIT 1",
        [map.title],
      );
      if (duplicate.rowCount) {
        await client.query("ROLLBACK");
        return statusError(
          response,
          409,
          "goal_map_name_conflict",
          "同じ名前のゴールマップがあります。JSONのゴールマップ名を変更してから再度取り込んでください。",
        );
      }
      const created = await client.query<{ id: string }>(
        "INSERT INTO maps(type,status,title) VALUES('GOAL','DRAFT',$1) RETURNING id",
        [map.title],
      );
      const mapId = created.rows[0]?.id;
      if (!mapId) throw new Error("goal map import insert failed");
      const idMap = new Map<string, string>();
      for (const concept of map.concepts) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1::uuid,$2,$3,$4) RETURNING id`,
          [mapId, concept.label, concept.position.x, concept.position.y],
        );
        idMap.set(concept.id, inserted.rows[0]!.id);
      }
      const linkIds = new Map<string, string>();
      for (const link of map.links) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO links(map_id,label,source_concept_id,target_concept_id,label_position_x,label_position_y)
           VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5,$6) RETURNING id`,
          [
            mapId,
            link.label,
            idMap.get(link.sourceId),
            idMap.get(link.targetId),
            link.labelPosition?.x ?? null,
            link.labelPosition?.y ?? null,
          ],
        );
        linkIds.set(link.id, inserted.rows[0]!.id);
      }
      const kit = await client.query<{ id: string }>(
        "INSERT INTO kit_definitions(goal_map_id,name) VALUES($1::uuid,$2) RETURNING id",
        [mapId, map.title],
      );
      for (const conceptId of idMap.values())
        await client.query(
          "INSERT INTO kit_concept_items(kit_definition_id,source_concept_id) VALUES($1::uuid,$2::uuid)",
          [kit.rows[0]!.id, conceptId],
        );
      for (const linkId of linkIds.values())
        await client.query(
          "INSERT INTO kit_link_items(kit_definition_id,source_link_id) VALUES($1::uuid,$2::uuid)",
          [kit.rows[0]!.id, linkId],
        );
      await client.query("COMMIT");
      return response
        .status(201)
        .json({
          id: mapId,
          title: map.title,
          kitDefinitionId: kit.rows[0]!.id,
        });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return statusError(
        response,
        500,
        "goal_map_import_failed",
        "ゴールマップを取り込めませんでした。データは保存されていません。",
      );
    } finally {
      client.release();
    }
  });
}
