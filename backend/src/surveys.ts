import type { Express, RequestHandler } from "express";
import type { Pool, PoolClient } from "pg";
import { principalOf, tokenHash } from "./access-control.js";
import {
  isUuid,
  reliableOperation,
  operationCommitted,
} from "./delivery-reliability.js";
import {
  insertResearchEvent,
  type EventInput,
  type EventActor,
} from "./research-events.js";
import { lockSessionStageProgress, assertStageIsCurrent } from "./sessions.js";
import { validAnswerText } from "./research-event-assessment-v3.js";
import { validMapLabel } from "./research-event-map-v2.js";
import { redactResearchOutput } from "./research-output-safety.js";
import { csvCell } from "./csv.js";
import type { SurveyStateV7 } from "./research-event-survey-v7.js";
export type SurveyQuestion = {
  id?: string;
  kind: "TEXT" | "CHOICE" | "RATING";
  prompt: string;
  required: boolean;
  config: {
    options?: string[];
    min?: number;
    max?: number;
    minLabel?: string;
    maxLabel?: string;
  };
};
const obj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
export function validSurveyQuestions(x: unknown): x is SurveyQuestion[] {
  return (
    Array.isArray(x) &&
    x.length > 0 &&
    x.length <= 1000 &&
    new Set(x.filter((q) => q?.id).map((q) => q.id)).size ===
      x.filter((q) => q?.id).length &&
    x.every((q) => {
      if (
        !obj(q) ||
        Object.keys(q).some(
          (k) => !["id", "kind", "prompt", "required", "config"].includes(k),
        ) ||
        (q.id !== undefined && !isUuid(q.id)) ||
        !validAnswerText(q.prompt) ||
        q.prompt.length > 10000 ||
        typeof q.required !== "boolean" ||
        !obj(q.config)
      )
        return false;
      const c = q.config;
      if (q.kind === "TEXT") return Object.keys(c).length === 0;
      if (q.kind === "CHOICE")
        return (
          Object.keys(c).length === 1 &&
          Array.isArray(c.options) &&
          c.options.length >= 2 &&
          c.options.length <= 1000 &&
          c.options.every((o) => validAnswerText(o) && o.length <= 512) &&
          new Set(c.options).size === c.options.length
        );
      return (
        q.kind === "RATING" &&
        Object.keys(c).length === 4 &&
        ["min", "max", "minLabel", "maxLabel"].every((k) =>
          Object.hasOwn(c, k),
        ) &&
        Number.isInteger(c.min) &&
        Number.isInteger(c.max) &&
        Number(c.min) >= -100 &&
        Number(c.max) <= 1000 &&
        Number(c.min) < Number(c.max) &&
        Number(c.max) - Number(c.min) <= 1000 &&
        validAnswerText(c.minLabel) &&
        c.minLabel.length <= 512 &&
        validAnswerText(c.maxLabel) &&
        c.maxLabel.length <= 512
      );
    })
  );
}
async function safeText(client: PoolClient, texts: string[]) {
  const secret = process.env.RESEARCHER_API_TOKEN;
  if (secret && texts.some((t) => t.includes(secret)))
    throw new Error("unsafe_survey_text");
  const hashes = texts.flatMap((t) => [t, ...t.split(/\s+/)]).map(tokenHash);
  if (
    hashes.length &&
    (
      await client.query(
        "SELECT 1 FROM sessions WHERE learner_access_token_hash=ANY($1::text[]) LIMIT 1",
        [hashes],
      )
    ).rowCount
  )
    throw new Error("unsafe_survey_text");
}
export async function saveSurveyQuestions(
  c: PoolClient,
  sessionId: string,
  qs: SurveyQuestion[],
) {
  await safeText(
    c,
    qs.flatMap((q) => [
      q.prompt,
      ...(q.config.options ?? []),
      q.config.minLabel ?? "",
      q.config.maxLabel ?? "",
    ]),
  );
  const old = (
    await c.query<{ id: string }>(
      "SELECT id FROM survey_questions WHERE session_id=$1",
      [sessionId],
    )
  ).rows;
  if (qs.some((q) => q.id && !old.some((o) => o.id === q.id)))
    throw new Error("invalid_question_id");
  await c.query("DELETE FROM survey_questions WHERE session_id=$1", [
    sessionId,
  ]);
  for (const [i, q] of qs.entries())
    await c.query(
      "INSERT INTO survey_questions(id,session_id,kind,prompt,required,display_order,config) VALUES(coalesce($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7)",
      [
        q.id ?? null,
        sessionId,
        q.kind,
        q.prompt,
        q.required,
        i,
        JSON.stringify(q.config),
      ],
    );
}
export class SeedValidationError extends Error {}
export async function seedLearnerMap(
  c: PoolClient,
  sessionId: string,
  mapId: string,
) {
  const s = (
    await c.query("SELECT protocol_key FROM sessions WHERE id=$1", [sessionId])
  ).rows[0];
  if (s?.protocol_key !== "STAGE1_5") return false;
  const items = (
    await c.query<{ id: string; source: string; label: string }>(
      `SELECT item.id,item.source_concept_id AS source,g.label FROM session_seed_concepts seed JOIN kit_concept_items item ON item.id=seed.kit_concept_item_id JOIN sessions s ON s.id=seed.session_id AND s.research_kit_definition_id=item.kit_definition_id JOIN concepts g ON g.id=item.source_concept_id WHERE seed.session_id=$1 ORDER BY item.id FOR SHARE OF item,g`,
      [sessionId],
    )
  ).rows;
  // Old Goal data may predate today's label policy. Validate the entire selection
  // before initialization, including configured credentials, without logging it.
  if(items.some(item=>!validMapLabel(item.label)))throw new SeedValidationError();
  try {await safeText(c,items.map(item=>item.label));}catch{throw new SeedValidationError();}
  for (const [i, item] of items.entries()) {
    if (!validMapLabel(item.label)) throw new Error("invalid_seed_label");
    const id = (
      await c.query(
        "INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1,$2,$3,$4) RETURNING id",
        [mapId, item.label, 160 + (i % 5) * 220, 160 + Math.floor(i / 5) * 150],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO concept_provenance(target_concept_id,source_concept_id,relation_type) VALUES($1,$2,'CLONED_FROM')",
      [id, item.source],
    );
    await c.query(
      "INSERT INTO seeded_map_concepts(concept_id,session_id,kit_concept_item_id) VALUES($1,$2,$3)",
      [id, sessionId, item.id],
    );
  }
  return true;
}
export function seededConceptGuard(pool: Pool): RequestHandler {
  return async (req, res, next) => {
    const m = /^\/concepts\/([^/]+)(?:\/label)?$/.exec(req.path);
    if (
      !m ||
      !(
        req.method === "DELETE" ||
        (req.method === "PATCH" && req.path.endsWith("/label"))
      ) ||
      !isUuid(m[1])
    )
      return next();
    try {
      if (
        (
          await pool.query(
            "SELECT 1 FROM seeded_map_concepts WHERE concept_id=$1",
            [m[1]],
          )
        ).rowCount
      )
        return res
          .status(409)
          .json({
            error: "seed_concept_read_only",
            message:
              "初期概念の名前変更・削除はできません。移動とリンク作成はできます。",
          });
      return next();
    } catch {
      return res.status(503).json({ error: "seed_check_failed" });
    }
  };
}
async function tx<T>(
  p: Pool,
  fn: (c: PoolClient) => Promise<T>,
  phase = "operation",
) {
  const c = await p.connect();
  try {
    await c.query("BEGIN");
    const r = await reliableOperation(c, () => fn(c), phase);
    await c.query("COMMIT");
    operationCommitted();
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
async function requiredEvent(
  c: PoolClient,
  s: string,
  a: EventActor,
  e: EventInput,
) {
  if (!(await insertResearchEvent(c, s, a, e)))
    throw new Error("survey_event_failed");
}
export async function surveySnapshot(c: PoolClient, sessionId: string) {
  const questions = (
    await c.query(
      'SELECT id,kind,prompt,required,display_order AS "displayOrder",config FROM survey_questions WHERE session_id=$1 ORDER BY display_order,id',
      [sessionId],
    )
  ).rows;
  const answers = (
    await c.query(
      'SELECT stage_id AS "stageId",question_id AS "questionId",answer,updated_at AS "updatedAt" FROM survey_answers WHERE session_id=$1 ORDER BY stage_id,question_id',
      [sessionId],
    )
  ).rows;
  const events = (
    await c.query(
      'SELECT event_id AS "eventId",schema_version AS "schemaVersion",stage_id AS "stageId",event_type AS "eventType",actor_type AS "actorType",outcome,reason_code AS "reasonCode",sequence_number AS "sequenceNumber",server_timestamp AS "serverTimestamp",before_state AS before,after_state AS after FROM research_events WHERE session_id=$1 AND schema_version=7 ORDER BY sequence_number',
      [sessionId],
    )
  ).rows;
  return redactResearchOutput({ questions, answers, events }, c);
}
async function current(c: PoolClient, id: string) {
  const stage = await lockSessionStageProgress(c, id);
  return stage?.stageType === "SURVEY" &&
    stage.status === "IN_PROGRESS" &&
    (await assertStageIsCurrent(c, stage)).kind === "ready"
    ? stage
    : null;
}
export function registerSurveyRoutes(app: Express, pool: Pool) {
  app.get("/api/research/stage1/sessions/:sessionId/survey", async (q, r) => {
    if (principalOf(r).role !== "researcher" || !isUuid(q.params.sessionId))
      return r.status(404).json({ error: "not_found" });
    try {
      return r.json(
        await tx(pool, (c) => surveySnapshot(c, q.params.sessionId)),
      );
    } catch {
      return r.status(503).json({ error: "survey_fetch_failed" });
    }
  });
  app.put(
    "/api/research/stage1/sessions/:sessionId/survey/questions",
    async (q, r) => {
      if (principalOf(r).role !== "researcher" || !isUuid(q.params.sessionId))
        return r.status(404).json({ error: "not_found" });
      if (
        !obj(q.body) ||
        Object.keys(q.body).length !== 1 ||
        !validSurveyQuestions(q.body.questions)
      )
        return r
          .status(400)
          .json({
            error: "invalid_questions",
            message: "設問・回答形式・選択肢・範囲を確認してください。",
          });
      try {
        const result = await tx(pool, async (c) => {
          const s = (
            await c.query(
              "SELECT status FROM sessions WHERE id=$1 AND protocol_key='STAGE1_5' FOR NO KEY UPDATE",
              [q.params.sessionId],
            )
          ).rows[0];
          if (!s) return 404;
          if (s.status !== "NOT_STARTED") return 409;
          await saveSurveyQuestions(c, q.params.sessionId, q.body.questions);
          await requiredEvent(c, q.params.sessionId, "RESEARCHER", {
            eventType: "SESSION_SETTINGS_CHANGE",
            targetType: "SESSION",
            outcome: "SUCCESS",
            clientTimeQuality: "NOT_APPLICABLE",
          });
          return 200;
        });
        return r
          .status(result)
          .json(
            result === 200
              ? { saved: true }
              : {
                  error: "survey_locked",
                  message: "セッション開始後はアンケートを変更できません。",
                },
          );
      } catch {
        return r
          .status(400)
          .json({
            error: "survey_settings_failed",
            message: "設問IDと入力内容を確認してください。",
          });
      }
    },
  );
  app.get("/api/session-stages/:stageId/survey", async (q, r) => {
    if (!isUuid(q.params.stageId))
      return r.status(404).json({ error: "not_found" });
    try {
      const data = await tx(pool, async (c) => {
        const st = await current(c, q.params.stageId);
        if (!st) return null;
        const snapshot = await surveySnapshot(c, st.sessionId);
        return {
          stageId: st.id,
          questions: snapshot.questions,
          answers: snapshot.answers,
        };
      });
      return data
        ? r.json(data)
        : r.status(409).json({ error: "survey_not_current" });
    } catch {
      return r.status(503).json({ error: "survey_fetch_failed" });
    }
  });
  for (const action of ["save", "submit"] as const)
    app.post("/api/session-stages/:stageId/survey/" + action, async (q, r) => {
      const id = q.params.stageId;
      if (!isUuid(id)) return r.status(404).json({ error: "not_found" });
      const principal = principalOf(r),
        actor = principal.role === "learner" ? "LEARNER" : "RESEARCHER";
      const unsuccessful = async (
        outcome: "REJECTED" | "FAILURE",
        reasonCode: "VALIDATION" | "CONFLICT" | "SERVER",
      ) => {
        try {
          return await tx(
            pool,
            async (c) => {
              const st = await lockSessionStageProgress(c, id);
              if (
                st?.stageType !== "SURVEY" ||
                (principal.role === "learner" &&
                  principal.sessionId !== st.sessionId)
              )
                return false;
              await requiredEvent(c, st.sessionId, actor, {
                schemaVersion: 7,
                eventType: action === "save" ? "SURVEY_EDIT" : "SURVEY_SUBMIT",
                targetType: "ASSESSMENT",
                stageId: id,
                targetId: id,
                outcome,
                reasonCode,
                clientTimeQuality: "NOT_APPLICABLE",
              });
              return true;
            },
            outcome,
          );
        } catch {
          return false;
        }
      };
      try {
        const result = await tx(pool, async (c) => {
          const st = await current(c, id);
          if (!st) return { error: "survey_not_current" };
          const body: unknown = q.body;
          if (
            !obj(body) ||
            Object.keys(body).length !== 1 ||
            !Array.isArray(body.answers) ||
            body.answers.length > 1000 ||
            !body.answers.every(
              (a) =>
                obj(a) &&
                Object.keys(a).length === 2 &&
                isUuid(a.questionId) &&
                Object.hasOwn(a, "value"),
            ) ||
            new Set(body.answers.map((a) => a.questionId)).size !==
              body.answers.length
          )
            return { error: "invalid_answers" };
          const questions = (
            await c.query<SurveyQuestion & { id: string }>(
              "SELECT id,kind,prompt,required,config FROM survey_questions WHERE session_id=$1 ORDER BY display_order",
              [st.sessionId],
            )
          ).rows;
          const answers = body.answers as {
            questionId: string;
            value: string | number;
          }[];
          if (
            answers.some((a) => {
              const question = questions.find((x) => x.id === a.questionId);
              return (
                !question ||
                (question.kind === "TEXT"
                  ? !validAnswerText(a.value)
                  : question.kind === "CHOICE"
                    ? !question.config.options!.includes(String(a.value)) ||
                      typeof a.value !== "string"
                    : !Number.isInteger(a.value) ||
                      Number(a.value) < question.config.min! ||
                      Number(a.value) > question.config.max!)
              );
            })
          )
            return { error: "invalid_answers" };
          const missing = questions
            .filter(
              (x) => x.required && !answers.some((a) => a.questionId === x.id),
            )
            .map((x) => x.id);
          if (action === "submit" && missing.length)
            return { error: "required_answers", missingQuestionIds: missing };
          await safeText(
            c,
            answers.flatMap((a) =>
              typeof a.value === "string" ? [a.value] : [],
            ),
          );
          const before = (
            await c.query<{ question_id: string; answer: string | number }>(
              "SELECT question_id,answer FROM survey_answers WHERE stage_id=$1",
              [id],
            )
          ).rows;
          await c.query("DELETE FROM survey_answers WHERE stage_id=$1", [id]);
          for (const a of answers)
            await c.query(
              "INSERT INTO survey_answers(session_id,stage_id,question_id,answer) VALUES($1,$2,$3,$4)",
              [st.sessionId, id, a.questionId, JSON.stringify(a.value)],
            );
          const after = (
            await c.query<{ question_id: string; answer: string | number }>(
              "SELECT question_id,answer FROM survey_answers WHERE stage_id=$1",
              [id],
            )
          ).rows;
          for (const question of questions) {
            const b =
                before.find((a) => a.question_id === question.id)?.answer ??
                null,
              n =
                after.find((a) => a.question_id === question.id)?.answer ??
                null;
            if (b === n) continue;
            const state = (value: string | number | null): SurveyStateV7 => ({
              questionId: question.id,
              kind: question.kind,
              value,
            });
            await requiredEvent(c, st.sessionId, actor, {
              schemaVersion: 7,
              eventType: "SURVEY_EDIT",
              targetType: "ASSESSMENT",
              stageId: id,
              targetId: question.id,
              outcome: "SUCCESS",
              clientTimeQuality: "NOT_APPLICABLE",
              before: state(b),
              after: state(n),
            });
          }
          if (action === "submit") {
            await c.query(
              "UPDATE session_stages SET status='COMPLETED',completed_at=clock_timestamp() WHERE id=$1",
              [id],
            );
            await requiredEvent(c, st.sessionId, actor, {
              schemaVersion: 7,
              eventType: "SURVEY_SUBMIT",
              targetType: "ASSESSMENT",
              stageId: id,
              targetId: id,
              outcome: "SUCCESS",
              clientTimeQuality: "NOT_APPLICABLE",
            });
            await requiredEvent(c, st.sessionId, actor, {
              eventType: "STAGE_COMPLETE",
              targetType: "STAGE",
              stageId: id,
              outcome: "SUCCESS",
              clientTimeQuality: "NOT_APPLICABLE",
            });
            const completed = await c.query(
              "UPDATE sessions SET status='COMPLETED',completed_at=clock_timestamp() WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM session_stages WHERE session_id=$1 AND status<>'COMPLETED')",
              [st.sessionId],
            );
            if (completed.rowCount !== 1) throw new Error("incomplete_session");
            await requiredEvent(c, st.sessionId, actor, {
              eventType: "SESSION_COMPLETE",
              targetType: "SESSION",
              outcome: "SUCCESS",
              clientTimeQuality: "NOT_APPLICABLE",
            });
          }
          return { saved: true, submitted: action === "submit" };
        });
        if ("error" in result) {
          const logSaved = await unsuccessful(
            "REJECTED",
            result.error === "survey_not_current" ? "CONFLICT" : "VALIDATION",
          );
          return r
            .status(result.error === "survey_not_current" ? 409 : 400)
            .json({
              ...result,
              message:
                "現在の活動と回答を確認してください。必須項目には回答が必要です。",
              operationOutcome: "REJECTED",
              logSaved,
            });
        }
        return r.json({
          ...result,
          operationOutcome: "SUCCESS",
          logSaved: true,
        });
      } catch {
        const logSaved = await unsuccessful("FAILURE", "SERVER");
        return r
          .status(500)
          .json({
            error: "survey_save_failed",
            message:
              "回答を保存できませんでした。入力を保持して再度お試しください。",
            operationOutcome: "FAILURE",
            logSaved,
          });
      }
    });
  app.get(
    "/api/research/stage1/sessions/:sessionId/survey-answers.csv",
    async (q, r) => {
      if (principalOf(r).role !== "researcher" || !isUuid(q.params.sessionId))
        return r.status(404).json({ error: "not_found" });
      try {
        const { snapshot, pseudonym } = await tx(pool, async (c) => ({
          snapshot: await surveySnapshot(c, q.params.sessionId),
          pseudonym:
            (
              await c.query(
                "SELECT pseudonym FROM research_session_ids WHERE session_id=$1",
                [q.params.sessionId],
              )
            ).rows[0]?.pseudonym ?? null,
        }));
        const columns = [
          "protocolKey",
          "participantCode",
          "sessionId",
          "stageId",
          "questionId",
          "kind",
          "prompt",
          "required",
          "answer",
          "updatedAt",
        ];
        const rows = snapshot.questions.flatMap((question) => {
          const answers = snapshot.answers.filter(
            (a) => a.questionId === question.id,
          );
          return (answers.length ? answers : [{}]).map((a) => ({
            protocolKey: "STAGE1_5",
            participantCode: pseudonym,
            sessionId: q.params.sessionId,
            ...question,
            ...a,
            questionId: question.id,
          }));
        });
        return r
          .type("text/csv")
          .attachment("survey-answers.csv")
          .send(
            "\uFEFF" +
              [
                columns.join(","),
                ...rows.map((a) =>
                  columns
                    .map((k) => csvCell((a as Record<string, unknown>)[k]))
                    .join(","),
                ),
              ].join("\r\n") +
              "\r\n",
          );
      } catch {
        return r.status(503).json({ error: "survey_export_failed" });
      }
    },
  );
}
