import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { verifyMockTestUrl } from "./mock-db.js";
import { validateEvent } from "../research-events.js";
import { validSurveyQuestions } from "../surveys.js";
import { parse } from "csv-parse/sync";
import { writeFile } from "node:fs/promises";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
  base = process.env.API_BASE_URL!,
  researcher = process.env.RESEARCHER_API_TOKEN!;
const kit = "66666666-6666-4666-8666-666666666662";
type Stage = { id: string; stageType: string };
type Session = {
  id: string;
  learnerAccessToken: string;
  protocolKey: string;
  studyGroup: null;
  stages: Stage[];
};
async function api(
  path: string,
  status = 200,
  method = "GET",
  body?: unknown,
  token = researcher,
  key?: string,
) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  assert.equal(r.status, status, path + ":" + text);
  return JSON.parse(text);
}
const questions = [
  { kind: "TEXT", prompt: "模擬の操作感想", required: true, config: {} },
  {
    kind: "CHOICE",
    prompt: "模擬の選択",
    required: true,
    config: { options: ["部品A", "部品B"] },
  },
  {
    kind: "RATING",
    prompt: "模擬の段階",
    required: true,
    config: { min: 1, max: 3, minLabel: "小さい", maxLabel: "大きい" },
  },
  { kind: "TEXT", prompt: "任意の模擬欄", required: false, config: {} },
];
const results: string[] = [];
try {
  await api("/research/stage1/settings", 200, "PUT", { minutes: 1 });
  const parts = (
    await pool.query(
      "SELECT id,source_concept_id FROM kit_concept_items WHERE kit_definition_id=$1 ORDER BY id",
      [kit],
    )
  ).rows;
  const payload = {
    participantCode: "MOCK-SURVEY-" + randomUUID(),
    videoUrl: "/mock.mp4",
    kitDefinitionId: kit,
    seedConceptIds: parts.map((p) => p.id),
    surveyQuestions: questions,
  };
  assert.equal(validSurveyQuestions(questions), true);
  for (const patch of [
    { studyGroup: "CONTROL" },
    { seedConceptIds: [parts[0].id, parts[0].id] },
    { seedConceptIds: [randomUUID()] },
    { surveyQuestions: [{ ...questions[1], config: { options: ["x", "x"] } }] },
  ])
    await api("/research/stage1/sessions", 400, "POST", {
      ...payload,
      ...patch,
    });
  const goalId=(await pool.query("SELECT goal_map_id FROM kit_definitions WHERE id=$1",[kit])).rows[0].goal_map_id;
  const foreignKit=await api("/maps/"+goalId+"/kits",201,"POST",{name:"MOCK foreign Kit "+randomUUID(),conceptIds:[parts[0].source_concept_id],linkIds:[]});
  const foreignPart=(await api("/kits/"+foreignKit.id)).concepts[0].kitConceptItemId;
  await api("/research/stage1/sessions",400,"POST",{...payload,seedConceptIds:[foreignPart]});
  const s = (await api(
    "/research/stage1/sessions",
    201,
    "POST",
    payload,
  )) as Session;
  assert.equal(s.protocolKey, "STAGE1_5");
  assert.equal(s.studyGroup, null);
  assert.deepEqual(
    s.stages.map((x) => x.stageType),
    ["LESSON", "PRIOR_MAP", "KB_MAP", "INTEGRATION_MAP", "SURVEY"],
  );
  const other = (await api("/research/stage1/sessions", 201, "POST", {
    ...payload,
    participantCode: "MOCK-OTHER-" + randomUUID(),
  })) as Session;
  const path = "/research/stage1/sessions/" + s.id + "/survey";
  await api(path, 403, "GET", undefined, s.learnerAccessToken);
  const config = await api(path);
  assert.equal(config.questions.length, 4);
  await api(path + "/questions", 400, "PUT", {
    questions: [{ ...questions[0], id: randomUUID() }],
  });
  await api(path + "/questions", 200, "PUT", {
    questions: [...questions].reverse(),
  });
  await api(path + "/questions", 200, "PUT", { questions });
  const token = s.learnerAccessToken,
    stage = (kind: string) => s.stages.find((x) => x.stageType === kind)!;
  const call = (
    path: string,
    status = 200,
    method = "GET",
    body?: unknown,
    key?: string,
  ) => api(path, status, method, body, token, key);
  const start = async (type: string) => {
    await call("/session-stages/" + stage(type).id + "/start", 200, "POST", {});
  };
  await call("/sessions/" + s.id + "/start", 200, "POST", {});
  await api(path + "/questions", 409, "PUT", { questions });
  await start("LESSON");
  await call(
    "/session-stages/" + stage("LESSON").id + "/complete",
    200,
    "POST",
    {},
  );
  await start("PRIOR_MAP");
  const legacySource=parts[0].source_concept_id;
  const sourceLabel=(await pool.query("SELECT label FROM concepts WHERE id=$1",[legacySource])).rows[0].label;
  await pool.query("UPDATE concepts SET label=$2 WHERE id=$1",[legacySource,researcher]);
  try{const rejected=await call("/session-stages/"+stage("PRIOR_MAP").id+"/prior-map",400,"POST",{});assert.equal(rejected.error,"invalid_seed_label");assert.ok(!JSON.stringify(rejected).includes(researcher));assert.equal(Number((await pool.query("SELECT count(*) n FROM maps WHERE session_stage_id=$1",[stage("PRIOR_MAP").id])).rows[0].n),0);}finally{await pool.query("UPDATE concepts SET label=$2 WHERE id=$1",[legacySource,sourceLabel]);}
  const prior = await call(
    "/session-stages/" + stage("PRIOR_MAP").id + "/prior-map",
    201,
    "POST",
    {},
  );
  const initial = await call("/maps/" + prior.id);
  assert.equal(initial.concepts.length, parts.length);
  assert.equal(initial.links.length, 0);
  assert.ok(initial.concepts.every((c: { isSeed: boolean }) => c.isSeed));
  const seeded = initial.concepts[0],
    original = { x: seeded.positionX, y: seeded.positionY };
  await call("/concepts/" + seeded.id + "/label", 409, "PATCH", {
    label: "変更拒否",
  });
  await call("/concepts/" + seeded.id, 409, "DELETE");
  await api("/concepts/" + seeded.id + "/label", 409, "PATCH", {
    label: "研究者も初期条件維持",
  });
  await call("/concepts/" + seeded.id + "/position", 200, "PATCH", {
    positionX: original.x + 30,
    positionY: original.y + 10,
  });
  for (const action of ["UNDO", "REDO"]) {
    const state = await call("/maps/" + prior.id + "/undo-redo");
    await call("/maps/" + prior.id + "/undo-redo", 200, "POST", {
      action,
      expectedSequenceNumber: state.sequenceNumber,
      idempotencyKey: randomUUID(),
    });
  }
  await call("/maps/" + prior.id + "/links", 201, "POST", {
    label: "模擬の接続",
    sourceConceptId: initial.concepts[0].id,
    targetConceptId: initial.concepts[1].id,
  });
  const replay = await api(
    "/research/sessions/" + s.id + "/maps/" + prior.id + "/mixed-history",
  );
  assert.equal(replay.status, "REPLAYABLE", replay.reason);
  await call("/maps/" + prior.id + "/submit", 200, "POST", {});
  await start("KB_MAP");
  const kb = await call("/kits/" + kit + "/kb-map", 201, "POST", {
    sessionStageId: stage("KB_MAP").id,
  });
  const built = new Map<string, string>();
  for (const [i, p] of parts.entries()) {
    const c = await call(
      "/maps/" + kb.id + "/kit-concepts/" + p.id + "/import",
      201,
      "POST",
      { positionX: 100 + i * 200, positionY: 100 },
    );
    built.set(p.source_concept_id, c.id);
  }
  const kitLinks = (
    await pool.query(
      "SELECT i.id,l.source_concept_id,l.target_concept_id FROM kit_link_items i JOIN links l ON l.id=i.source_link_id WHERE i.kit_definition_id=$1",
      [kit],
    )
  ).rows;
  for (const l of kitLinks)
    await call("/maps/" + kb.id + "/kit-links/" + l.id, 201, "POST", {
      sourceConceptId: built.get(l.source_concept_id),
      targetConceptId: built.get(l.target_concept_id),
    });
  await call("/maps/" + kb.id + "/submit", 200, "POST", {});
  await start("INTEGRATION_MAP");
  const integration = await call(
    "/session-stages/" + stage("INTEGRATION_MAP").id + "/integration-map",
    201,
    "POST",
    {},
  );
  await call("/maps/" + integration.id + "/submit", 200, "POST", {});
  assert.equal(
    (await call("/sessions/" + s.id + "/flow")).currentStage.stageType,
    "SURVEY",
  );
  await start("SURVEY");
  const surveyPath = "/session-stages/" + stage("SURVEY").id + "/survey";
  const q = (await call(surveyPath)).questions;
  const answers = q
    .slice(0, 3)
    .map((x: { id: string; kind: string }) => ({
      questionId: x.id,
      value: x.kind === "TEXT" ? "模擬回答" : x.kind === "CHOICE" ? "部品A" : 2,
    }));
  await call(surveyPath + "/submit", 400, "POST", { answers: [] });
  for (const invalid of ["   ", "Bearer abcdefghijklmnopqrstuvwxyz012345", 3])
    await call(surveyPath + "/save", 400, "POST", {
      answers: [{ questionId: q[0].id, value: invalid }],
    });
  await call(surveyPath + "/save", 400, "POST", {
    answers: [{ questionId: randomUUID(), value: "模擬" }],
  });
  await api(surveyPath, 404, "GET", undefined, other.learnerAccessToken);
  await call("/sessions/" + s.id + "/events", 403, "POST", {
    schemaVersion: 7,
    eventType: "SURVEY_SUBMIT",
    targetType: "ASSESSMENT",
    stageId: stage("SURVEY").id,
    targetId: stage("SURVEY").id,
    outcome: "SUCCESS",
    clientTimeQuality: "NOT_APPLICABLE",
  });
  const foreignQuestion=(await api("/research/stage1/sessions/"+other.id+"/survey")).questions[0].id;
  for(const answer of [{questionId:foreignQuestion,value:"模擬"},{questionId:q[1].id,value:"選択肢にない模擬値"},{questionId:q[2].id,value:4},{questionId:q[2].id,value:1.5}])await call(surveyPath+"/save",400,"POST",{answers:[answer]});
  const save = surveyPath + "/save",
    key = randomUUID();
  await call(save, 200, "POST", { answers }, key);
  await call(save, 200, "POST", { answers }, key);
  const count = async () =>
    Number(
      (
        await pool.query(
          "SELECT count(*) n FROM research_events WHERE session_id=$1 AND schema_version=7 AND outcome='SUCCESS'",
          [s.id],
        )
      ).rows[0].n,
    );
  const n = await count();
  assert.equal(n, 3);
  await call(save, 200, "POST", { answers });
  assert.equal(await count(), n);
  await pool.query(
    "CREATE FUNCTION mock_survey_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private exception must not escape'; END $$",
  );
  await pool.query(
    "CREATE TRIGGER mock_survey_fail BEFORE INSERT ON research_events FOR EACH ROW WHEN(NEW.schema_version=7 AND NEW.outcome='SUCCESS') EXECUTE FUNCTION mock_survey_fail()",
  );
  const changed = [
    { ...answers[0], value: "別の模擬回答" },
    ...answers.slice(1),
  ];
  try {
    const failed = await call(
      save,
      500,
      "POST",
      { answers: changed },
      randomUUID(),
    );
    assert.equal(failed.logSaved, true);
    assert.ok(!JSON.stringify(failed).includes("private exception"));
    assert.equal(
      (
        await pool.query(
          "SELECT answer FROM survey_answers WHERE question_id=$1",
          [q[0].id],
        )
      ).rows[0].answer,
      "模擬回答",
    );
    await call(surveyPath + "/submit", 500, "POST", { answers });
    assert.equal(
      (await call("/sessions/" + s.id + "/flow")).session.status,
      "IN_PROGRESS",
    );
  } finally {
    await pool.query(
      "DROP TRIGGER mock_survey_fail ON research_events; DROP FUNCTION mock_survey_fail()",
    );
  }
  await call(surveyPath + "/submit", 200, "POST", { answers });
  assert.equal(
    (await call("/sessions/" + s.id + "/flow")).session.status,
    "COMPLETED",
  );
  await call(surveyPath, 409);
  const raw = await api("/research/sessions/" + s.id + "/export");
  assert.equal(raw.exportVersion, 3);
  assert.equal(raw.session.studyGroup, null);
  assert.equal(raw.assessment, undefined);
  assert.equal(raw.survey.answers.length, 3);
  assert.equal(
    raw.survey.events.filter(
      (e: { eventType: string; outcome: string }) =>
        e.eventType === "SURVEY_EDIT" && e.outcome === "SUCCESS",
    ).length,
    3,
  );
  const analysis = await api("/research/stage1/sessions/" + s.id + "/analysis");
  assert.equal(analysis.survey.answers.length, 3);
  const csv = await fetch(
    base + "/api" + path.replace(/survey$/, "survey-answers.csv"),
    { headers: { Authorization: "Bearer " + researcher } },
  );
  assert.equal(csv.status, 200);
  assert.ok((await csv.text()).includes("模擬回答"));
  results.push(
    "5-stage end-to-end, null group, seed origin/locks, Link/move, Undo/Redo/replay, Kit, manual integration submit, survey formats/required/optional/freeze/auth/atomicity/retry/export: PASS",
  );
  // Timed integration on another new session, server worker and idempotency.
  const auto = (await api("/research/stage1/sessions", 201, "POST", {
    ...payload,
    participantCode: "MOCK-AUTO-" + randomUUID(),
    seedConceptIds: [],
  })) as Session;
  const st = auto.stages.find((x) => x.stageType === "INTEGRATION_MAP")!;
  await pool.query(
    "UPDATE sessions SET status='IN_PROGRESS',started_at=clock_timestamp() WHERE id=$1",
    [auto.id],
  );
  await pool.query(
    "UPDATE session_stages SET status='COMPLETED',started_at=clock_timestamp(),completed_at=clock_timestamp() WHERE session_id=$1 AND order_index<3",
    [auto.id],
  );
  await pool.query(
    "UPDATE session_stages SET status='IN_PROGRESS',started_at=clock_timestamp() WHERE id=$1",
    [st.id],
  );
  // Use real creation endpoint requires submitted source maps; create minimal source fixtures with snapshots to exercise clone init.
  for (const type of ["PRIOR_MAP", "KB_MAP"]) {
    const source = auto.stages.find((x) => x.stageType === type)!;
    await pool.query(
      "INSERT INTO maps(type,status,session_stage_id,kit_definition_id) VALUES($1,'SUBMITTED',$2,$3)",
      [
        type === "PRIOR_MAP" ? "PRIOR" : "KB",
        source.id,
        type === "KB_MAP" ? kit : null,
      ],
    );
  }
  const im = await api(
    "/session-stages/" + st.id + "/integration-map",
    201,
    "POST",
    {},
    auto.learnerAccessToken,
  );
  await pool.query(
    "UPDATE session_stages SET started_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",
    [st.id],
  );
  for (let i = 0; i < 40; i++) {
    if (
      (await pool.query("SELECT status FROM maps WHERE id=$1", [im.id])).rows[0]
        .status === "SUBMITTED"
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(
    (await pool.query("SELECT status FROM maps WHERE id=$1", [im.id])).rows[0]
      .status,
    "SUBMITTED",
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) n FROM research_events WHERE map_id=$1 AND event_type='MAP_AUTO_SUBMIT' AND outcome='SUCCESS'",
          [im.id],
        )
      ).rows[0].n,
    ),
    1,
  );
  await api("/maps/" + im.id, 404, "GET", undefined, auto.learnerAccessToken);
  await api(
    "/session-stages/" + st.id + "/complete",
    200,
    "POST",
    {},
    auto.learnerAccessToken,
  );
  assert.equal(
    (
      await api(
        "/sessions/" + auto.id + "/flow",
        200,
        "GET",
        undefined,
        auto.learnerAccessToken,
      )
    ).currentStage.stageType,
    "SURVEY",
  );
  results.push(
    "new protocol deadline auto-submit once, hidden submitted map, explicit next to SURVEY: PASS",
  );
  const surveyEvent = {
    schemaVersion: 7,
    eventType: "SURVEY_EDIT",
    targetType: "ASSESSMENT",
    stageId: randomUUID(),
    targetId: randomUUID(),
    outcome: "SUCCESS",
    clientTimeQuality: "NOT_APPLICABLE",
  };
  const b = { questionId: surveyEvent.targetId, kind: "TEXT", value: null },
    a = { ...b, value: "模擬" };
  assert.ok(validateEvent({ ...surveyEvent, before: b, after: a }));
  for (const patch of [
    { extra: "x" },
    { schemaVersion: 3 },
    { after: { ...a, password: "x" } },
    { after: { ...a, value: "password=not-allowed" } },
  ])
    assert.equal(
      validateEvent({ ...surveyEvent, before: b, after: a, ...patch }),
      false,
    );
  const exportJob = await api("/research/event-exports", 201, "POST", {
    filters: {
      sessionIds: [s.id],
      eventTypes: ["SURVEY_EDIT", "SURVEY_SUBMIT"],
    },
  });
  const json = await api(
    "/research/event-exports/" + exportJob.exportId + "/events.json",
  );
  assert.equal(json.export_schema_version, 3);
  assert.ok(
    json.events.every(
      (e: {
        protocol_key: string;
        study_group: null;
        payload_status: string;
      }) =>
        e.protocol_key === "STAGE1_5" &&
        e.study_group === null &&
        ["EXPORTED", "NO_PAYLOAD"].includes(e.payload_status),
    ),
  );
  const csvFile = async (name: string) => {
    const r = await fetch(
      base + "/api/research/event-exports/" + exportJob.exportId + "/" + name,
      { headers: { Authorization: "Bearer " + researcher } },
    );
    assert.equal(r.status, 200);
    return parse(await r.text(), { columns: true, bom: true }) as {
      event_id: string;
      protocol_key: string;
      server_timestamp: string;
      outcome: string;
    }[];
  };
  const common = await csvFile("events.csv"),
    detail = await csvFile("survey_events.csv"),
    old = await csvFile("assessment_events.csv");
  assert.equal(old.length, 0);
  assert.equal(common.length, json.event_count);
  assert.equal(detail.length, common.length);
  for (const e of json.events) {
    const row = common.find((x) => x.event_id === e.event_id)!;
    assert.equal(row.outcome, e.outcome);
    assert.equal(row.server_timestamp, e.server_timestamp);
    assert.equal(row.protocol_key, "STAGE1_5");
    assert.ok(detail.some((x) => x.event_id === e.event_id));
  }
  await api("/research/event-exports/" + exportJob.exportId, 200, "DELETE");
  results.push(
    "real v7 JSON/common CSV/detail CSV exact IDs/counts/times/outcomes/protocol; old assessment CSV excludes survey: PASS",
  );
  const preview = () =>
    api("/research/data-management/preview", 200, "POST", { sessionId: s.id });
  let plan = await preview();
  assert.equal(plan.counts.survey_answers, 3);
  assert.equal(plan.counts.seeded_map_concepts, parts.length);
  await pool.query(
    "CREATE FUNCTION mock_survey_delete_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private delete failure'; END $$",
  );
  await pool.query(
    "CREATE TRIGGER mock_survey_delete_fail BEFORE DELETE ON survey_questions FOR EACH ROW EXECUTE FUNCTION mock_survey_delete_fail()",
  );
  try {
    await api("/research/data-management/delete", 409, "POST", {
      planId: plan.planId,
      confirm: "DELETE",
    });
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) n FROM survey_answers WHERE session_id=$1",
            [s.id],
          )
        ).rows[0].n,
      ),
      3,
    );
  } finally {
    await pool.query(
      "DROP TRIGGER mock_survey_delete_fail ON survey_questions; DROP FUNCTION mock_survey_delete_fail()",
    );
  }
  plan = await preview();
  await api("/research/data-management/delete", 200, "POST", {
    planId: plan.planId,
    confirm: "DELETE",
  });
  for (const table of [
    "survey_answers",
    "survey_questions",
    "seeded_map_concepts",
    "session_seed_concepts",
  ]) {
    assert.equal(
      Number(
        (
          await pool.query(
            `SELECT count(*) n FROM ${table} WHERE session_id=$1`,
            [s.id],
          )
        ).rows[0].n,
      ),
      0,
    );
  }
  await call("/sessions/" + s.id + "/flow", 410);
  assert.equal(
    (
      await api(
        "/sessions/" + other.id + "/flow",
        200,
        "GET",
        undefined,
        other.learnerAccessToken,
      )
    ).session.status,
    "NOT_STARTED",
  );
  results.push(
    "new survey/seed records included in confirmed deletion, injected failure rolls back, deleted credential rejects replay, other session retained: PASS",
  );
  results.push("v7 strict payload and secret/unknown-field rejection: PASS");
  console.log(results.join("\n"));
  await writeFile(
    "../docs/session-flow-survey-results.json",
    JSON.stringify({ mockOnly: true, results }, null, 2) + "\n",
  );
} finally {
  await pool.end();
}
