// Test fixture endpoints only; never register in normal research operation.
// The caller must first verify the isolated synthetic mock DB manifest and guard.
import type { Express } from "express";
import type { Pool, PoolClient } from "pg";
import { validSurveyQuestions, saveSurveyQuestions } from "../surveys.js";
import { createFiveActivitySession } from "../sessions.js";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";
import { auditCurrent } from "../server-audit.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerLegacySessionCreationFixtures(
  app: Express,
  pool: Pool,
  withTransaction: <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>,
  retiredKitId: string,
) {
  app.get("/api/research/stage1/settings", async (_request, response) => {
    try { const result = await pool.query<{ minutes: number }>("SELECT group_activity_seconds / 60 AS minutes FROM research_settings WHERE id=1"); return response.json({ minutes: result.rows[0]?.minutes ?? null }); }
    catch { return response.status(500).json({ error: "settings_fetch_failed" }); }
  });
  app.put("/api/research/stage1/settings", async (request, response) => {
    const minutes = request.body?.minutes;
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 35791394) return response.status(400).json({ error: "invalid_duration", message: "正の整数の分数を指定してください。" });
    try { await withTransaction(async client => { await client.query("INSERT INTO research_settings (id, group_activity_seconds) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET group_activity_seconds=EXCLUDED.group_activity_seconds", [minutes * 60]); await auditCurrent(client); }); return response.json({ minutes }); }
    catch { return response.status(500).json({ error: "settings_save_failed" }); }
  });
  
  app.post("/api/research/stage1/sessions", async (request, response) => {
    const body: unknown = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return response.status(400).json({ error: "invalid_stage1_request" });
    }
    const data = body as Record<string, unknown>;
    const participantCode =
      typeof data.participantCode === "string" ? data.participantCode.trim() : "";
    const requestedVideo =
      typeof data.videoUrl === "string" ? data.videoUrl.trim() : "";
    const videoUrl = requestedVideo || process.env.STAGE1_VIDEO_URL?.trim() || "";
    const kitDefinitionId = data.kitDefinitionId;
    const surveyQuestions = data.surveyQuestions;
    const seedConceptIds = data.seedConceptIds;
    const validVideoUrl =
      videoUrl.length > 0 &&
      videoUrl.length <= 2048 &&
      ((videoUrl.startsWith("/") && !videoUrl.startsWith("//")) ||
        /^https?:\/\//i.test(videoUrl));
    if (
      data.studyGroup !== undefined || !validSurveyQuestions(surveyQuestions) || !Array.isArray(seedConceptIds) || !seedConceptIds.every(id => typeof id === "string" && uuidPattern.test(id)) || new Set(seedConceptIds).size !== seedConceptIds.length ||
      !participantCode ||
      participantCode.length > 64 ||
      !validVideoUrl ||
      typeof kitDefinitionId !== "string" ||
      !uuidPattern.test(kitDefinitionId)
    ) {
      return response.status(400).json({
        error: "invalid_stage1_request",
        message: "仮名の参加者コード、授業動画URL、教材Kitを指定してください。",
      });
    }
    try {
      const result = await withTransaction(async (client) => {
        const settings = await client.query<{ seconds: number }>("SELECT group_activity_seconds AS seconds FROM research_settings WHERE id=1 FOR SHARE");
        if (!settings.rows[0]) return { kind: "settings_missing" as const };
        const kit = await client.query<{ id: string; goalMapId: string }>(
          `SELECT kit.id, kit.goal_map_id AS "goalMapId"
           FROM kit_definitions AS kit
           INNER JOIN maps AS goal_map
             ON goal_map.id = kit.goal_map_id AND goal_map.type = 'GOAL'
           WHERE kit.id = $1::uuid AND kit.id <> $2::uuid
           FOR SHARE OF kit, goal_map`,
          [kitDefinitionId, retiredKitId],
        );
        if (kit.rowCount !== 1) return { kind: "kit_not_found" as const };
        const coverage = await client.query<{
          goalConcepts: number;
          kitConceptItems: number;
          validKitConceptItems: number;
          goalLinks: number;
          kitLinkItems: number;
          validKitLinkItems: number;
        }>(
          `SELECT
             (SELECT count(*)::int FROM concepts AS goal_concept
              WHERE goal_concept.map_id = $1::uuid
                AND goal_concept.merged_into_concept_id IS NULL) AS "goalConcepts",
             (SELECT count(*)::int FROM kit_concept_items AS item
              WHERE item.kit_definition_id = $2::uuid) AS "kitConceptItems",
             (SELECT count(*)::int
              FROM kit_concept_items AS item
              INNER JOIN concepts AS goal_concept
                ON goal_concept.id = item.source_concept_id
                AND goal_concept.map_id = $1::uuid
                AND goal_concept.merged_into_concept_id IS NULL
              WHERE item.kit_definition_id = $2::uuid) AS "validKitConceptItems",
             (SELECT count(*)::int FROM links AS goal_link
              WHERE goal_link.map_id = $1::uuid) AS "goalLinks",
             (SELECT count(*)::int FROM kit_link_items AS item
              WHERE item.kit_definition_id = $2::uuid) AS "kitLinkItems",
             (SELECT count(*)::int
              FROM kit_link_items AS item
              INNER JOIN links AS goal_link
                ON goal_link.id = item.source_link_id
                AND goal_link.map_id = $1::uuid
              INNER JOIN concepts AS goal_source
                ON goal_source.id = goal_link.source_concept_id
                AND goal_source.map_id = $1::uuid
                AND goal_source.merged_into_concept_id IS NULL
              INNER JOIN concepts AS goal_target
                ON goal_target.id = goal_link.target_concept_id
                AND goal_target.map_id = $1::uuid
                AND goal_target.merged_into_concept_id IS NULL
              WHERE item.kit_definition_id = $2::uuid) AS "validKitLinkItems"`,
          [kit.rows[0]!.goalMapId, kitDefinitionId],
        );
        const parts = coverage.rows[0];
        if (
          !parts ||
          parts.goalConcepts === 0 ||
          parts.goalConcepts !== parts.kitConceptItems ||
          parts.kitConceptItems !== parts.validKitConceptItems ||
          parts.goalLinks !== parts.kitLinkItems ||
          parts.kitLinkItems !== parts.validKitLinkItems
        ) {
          return { kind: "kit_not_complete" as const };
        }
        const seeds = await client.query(`SELECT item.id FROM kit_concept_items item JOIN concepts c ON c.id=item.source_concept_id
          WHERE item.kit_definition_id=$1 AND item.id=ANY($2::uuid[]) AND c.map_id=$3 AND c.merged_into_concept_id IS NULL FOR SHARE OF item,c`,[kitDefinitionId,seedConceptIds,kit.rows[0]!.goalMapId]);
        if(seeds.rowCount !== seedConceptIds.length) return {kind:"invalid_seeds" as const};
        const session = await createFiveActivitySession(client, {
          participantCode,
          lessonVideoUrl: videoUrl,
          kitDefinitionId,
          groupActivitySeconds: settings.rows[0].seconds,
        });
        await saveSurveyQuestions(client,session.id,surveyQuestions);
        for(const item of seedConceptIds) await client.query("INSERT INTO session_seed_concepts(session_id,kit_concept_item_id) VALUES($1,$2)",[session.id,item]);
        const credential = createLearnerToken();
        await storeLearnerToken(client, session.id, credential.hash);
        await auditCurrent(client, { sessionId: session.id });
        return { kind: "created" as const, session, learnerAccessToken: credential.token };
      });
      if (result.kind === "invalid_seeds") return response.status(400).json({error:"invalid_seed_concepts",message:"使用するKitの概念を重複せず選択してください。"});
      if (result.kind === "settings_missing") return response.status(409).json({ error: "settings_missing", message: "群別活動の共通時間を設定してください。" });
      if (result.kind === "kit_not_found") {
        return response.status(404).json({ error: "kit_not_found" });
      }
      if (result.kind === "kit_not_complete") {
        return response.status(422).json({
          error: "stage1_kit_must_cover_goal_map",
          message:
            "Stage 1のKit-Buildでは、Goal Mapのすべての概念と関係を含むKitDefinitionが必要です。",
        });
      }
      return response.status(201).json({ ...result.session, learnerAccessToken: result.learnerAccessToken });
    } catch {
      console.error("stage1_session_create_failed");
      return response.status(500).json({ error: "stage1_session_create_failed" });
    }
  });
}
