import { replayMapAt } from "../map-history.js";
import { verifyMockTestUrl } from "./mock-db.js";
import { Pool } from "pg";
import { insertAudit } from "../server-audit.js";
import { createStage1Session } from "../sessions.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { eventTargets, type EventType } from "../research-event-catalog.js";
import { eventTestMatrix, legacyOperationTypes } from "../event-test-matrix.js";
import { validateEvent } from "../research-events.js";
import type { MapStateV2 } from "../research-event-map-v2.js";
assert.deepEqual(
  Object.keys(eventTargets).sort(),
  Object.keys(eventTestMatrix).sort(),
);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const map = randomUUID(),
  stage = randomUUID(),
  element = randomUUID(),
  question = randomUUID();
const empty: MapStateV2 = {
  snapshotVersion: 1,
  mapId: map,
  mapType: "PRIOR",
  basedOnMapId: null,
  kitDefinitionId: null,
  concepts: [],
  links: [],
};
const populated: MapStateV2 = {
  ...empty,
  concepts: [
    {
      id: element,
      mapId: map,
      label: "MOCK concept",
      positionX: 1,
      positionY: 2,
      mergedIntoConceptId: null,
      provenance: [],
    },
  ],
  links: [],
};
let checks = 0;
for (const name of Object.keys(eventTestMatrix) as EventType[]) {
  const policy = eventTestMatrix[name];
  assert.ok(
    (policy.versions as number[]).every((v) => [1, 2, 3, 4, 5, 6].includes(v)),
  );
  for (const suite of policy.suites) assert.ok(pkg.scripts[suite], suite);
  const base = {
    schemaVersion: 1,
    eventType: name,
    targetType: eventTargets[name],
    mapId: map,
    stageId: stage,
    targetId: element,
    outcome: "SUCCESS",
    clientTimeQuality: "MISSING",
  };
  for (const outcome of ((policy.versions as number[]).includes(1) ? [
    "SUCCESS",
    "FAILURE",
    "REJECTED",
    "CANCELLED",
    "UNKNOWN",
  ] : [])) {
    assert.equal(
      validateEvent({
        ...base,
        outcome,
        ...(outcome === "SUCCESS"
          ? {}
          : {
              reasonCode: outcome === "CANCELLED" ? "USER_CANCELLED" : "SERVER",
            }),
      }),
      true,
      name + ":v1:" + outcome,
    );
    checks++;
  }
  assert.equal(validateEvent({ ...base, actorType: "SYSTEM" }), false);
  assert.equal(validateEvent({ ...base, schemaVersion: 4 }), false);
  assert.equal(
    validateEvent({ ...base, details: { authorization: "Bearer forbidden" } }),
    false,
  );
  assert.equal(
    validateEvent({ ...base, eventType: "UNREVIEWED_EVENT" }),
    false,
  );
  for (const mapVersion of [2,5].filter(v=>(policy.versions as number[]).includes(v))) {
    let before: MapStateV2 = structuredClone(empty),
      after: MapStateV2 = structuredClone(populated);
    if (eventTargets[name] === "LINK") {
      before = {
        ...populated,
        concepts: [{ ...populated.concepts[0], id: question }],
      };
      after = {
        ...before,
        links: [
          {
            id: element,
            mapId: map,
            label: "MOCK relation",
            sourceConceptId: question,
            targetConceptId: question,
            provenance: [],
          },
        ],
      };
    }
    if (["DELETE_CONCEPT", "DELETE_LINK"].includes(name)) {
      before = after;
      after = empty;
    } else if (
      ["EDIT_CONCEPT", "MOVE_CONCEPT", "EDIT_LINK", "RECONNECT_LINK", "MOVE_LINK"].includes(
        name,
      )
    ) {
      before = structuredClone(after);
    }
    if (name === "MAP_KIT_ASSIGN") {
      before = { ...empty, mapType: "INTEGRATION" };
      after = { ...before, kitDefinitionId: randomUUID() };
    }
    if(name === "MOVE_LINK") after.links[0]={...after.links[0],labelPositionX:50,labelPositionY:60};
    const event = {
      ...base,
      schemaVersion: mapVersion,
      before,
      after,
      ...(["UNDO", "REDO"].includes(name)
        ? { targetId: map, relatedEventId: randomUUID() }
        : {}),
    };
    assert.equal(validateEvent(event), true, name + ":v2");
    assert.equal(
      validateEvent({ ...event, after: { ...after, mapId: randomUUID() } }),
      false,
    );
    for (const outcome of ["FAILURE", "REJECTED", "CANCELLED", "UNKNOWN"])
      assert.equal(
        validateEvent({
          ...event,
          outcome,
          before: undefined,
          after: undefined,
        }),
        true,
        name + ":v2:" + outcome,
      );
    checks += 6;
  }
  if ((policy.versions as number[]).includes(6)) {
    const feedback={...base,schemaVersion:6,targetId:map,clientTimeQuality:"NOT_APPLICABLE",beforeQuality:"NOT_APPLICABLE",afterQuality:"NOT_APPLICABLE",details:{matched:false}};
    assert.equal(validateEvent(feedback),true);
    assert.equal(validateEvent({...feedback,details:{matched:true}}),true);
    assert.equal(validateEvent({...feedback,details:{matched:false,label:"forbidden"}}),false);
    for(const outcome of ["REJECTED","FAILURE"])assert.equal(validateEvent({...feedback,outcome,reasonCode:"SERVER",details:undefined}),true);
    assert.equal(validateEvent({...feedback,outcome:"REJECTED",reasonCode:"VALIDATION"}),false);
    checks+=6;
  }
  if ((policy.versions as number[]).includes(3)) {
    const event = {
      ...base,
      schemaVersion: 3,
      mapId: undefined,
      targetId: name === "ASSESSMENT_SUBMIT" ? stage : question,
      ...(name === "ASSESSMENT_EDIT"
        ? {
            before: { questionId: question, answer: null },
            after: { questionId: question, answer: "MOCK answer" },
          }
        : {}),
    };
    assert.equal(validateEvent(event), true, name + ":v3");
    assert.equal(
      validateEvent({ ...event, details: { answer: "forbidden" } }),
      false,
    );
    for (const outcome of ["FAILURE", "REJECTED", "CANCELLED", "UNKNOWN"])
      assert.equal(
        validateEvent({
          ...event,
          outcome,
          before: undefined,
          after: undefined,
        }),
        true,
      );
    checks += 6;
  }
}
// Missing/unknown old formats must never be silently treated as successful replay.
for (const name of legacyOperationTypes) {
  assert.ok(Object.hasOwn(eventTargets, name));
  const replay = replayMapAt(
    empty,
    [
      {
        id: randomUUID(),
        mapId: map,
        sequenceNumber: "1",
        operationType: name,
        targetType: eventTargets[name],
        targetId: element,
        before: null,
        after: null,
      },
    ],
    1,
  );
  assert.equal(replay.status, "PARTIAL", name + " missing legacy payload");
}
if (process.env.DATABASE_URL) {
  await verifyMockTestUrl(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const s = await createStage1Session(c, {
      participantCode: "MOCK-CATALOG",
      lessonVideoUrl: "/dummy.mp4",
      kitDefinitionId: "66666666-6666-4666-8666-666666666662",
      studyGroup: "EXPERIMENTAL",
      groupActivitySeconds: 60,
    });
    const st = s.stages.find((x) => x.stageType === "INTEGRATION_MAP")!;
    const m = (
      await c.query(
        "INSERT INTO maps(type,session_stage_id) VALUES('INTEGRATION',$1) RETURNING id",
        [st.id],
      )
    ).rows[0].id;
    const auditLink = randomUUID();
    await c.query(
      "INSERT INTO concepts(id,map_id,label,position_x,position_y) VALUES($1,$2,'MOCK audit concept',0,0),($3,$2,'MOCK audit concept two',1,1)",
      [element, m, question],
    );
    await c.query(
      "INSERT INTO links(id,map_id,label,source_concept_id,target_concept_id) VALUES($1,$2,'MOCK audit link',$3,$4)",
      [auditLink, m, element, question],
    );
    for (const name of Object.keys(eventTestMatrix) as EventType[]) {
      if (!(eventTestMatrix[name].versions as number[]).includes(4)) continue;
      for (const outcome of [
        "SUCCESS",
        "FAILURE",
        "REJECTED",
        "CANCELLED",
        "UNKNOWN",
      ] as const) {
        const system = ["MAP_AUTO_SUBMIT", "STAGE_DEADLINE"].includes(name);
        await insertAudit(
          c,
          {
            eventType: name,
            sessionId: s.id,
            ...(eventTargets[name] === "MAP" ||
            ["DELETE_CONCEPT", "DELETE_LINK"].includes(name)
              ? {
                  mapId: m,
                  targetId:
                    eventTargets[name] === "MAP"
                      ? m
                      : name === "DELETE_LINK"
                        ? auditLink
                        : element,
                }
              : {}),
            ...(name === "STAGE_DEADLINE" ? { stageId: st.id } : {}),
          },
          system ? "SYSTEM" : "RESEARCHER",
          outcome,
          outcome === "SUCCESS" ? undefined : "SERVER",
        );
        const row = (
          await c.query(
            "SELECT * FROM research_events WHERE session_id=$1 ORDER BY sequence_number DESC LIMIT 1",
            [s.id],
          )
        ).rows[0];
        assert.equal(row.schema_version, 4);
        assert.equal(row.actor_type, system ? "SYSTEM" : "RESEARCHER");
        assert.equal(row.outcome, outcome);
        assert.equal(row.event_type, name);
        assert.equal(
          row.target_id,
          eventTargets[name] === "MAP"
            ? m
            : name === "DELETE_LINK"
              ? auditLink
              : name === "DELETE_CONCEPT"
                ? element
                : name === "STAGE_DEADLINE"
                  ? st.id
                  : eventTargets[name] === "ASSESSMENT" ? null : s.id,
        );
        assert.equal(row.before_state, null);
        assert.equal(row.after_state, null);
        assert.deepEqual(row.details, {});
        assert.ok(Number.isFinite(new Date(row.server_timestamp).getTime()));
        checks++;
      }
    }
  } finally {
    await c.query("ROLLBACK");
    c.release();
    await pool.end();
  }
}

const dictionary =
  "# 研究イベント・テスト対応表（自動照合）\n\nスキーマ契約の全outcome検証と、実API処理の検証は別である。契約がCANCELLEDを表現可能でも、実際に取消を観測・記録する経路があるとは意味しない。v4はserver-auditのDB検証で確認する。旧形式は固定のschemaVersionを持たず、未知種別は再生不能/本文非表示として扱う。\n\n|イベント|対象|互換schemaVersion|実行する主な検証|非適用・観測限界|\n|---|---|---|---|---|\n" +
  (Object.keys(eventTestMatrix) as EventType[])
    .map((n) => {
      const p = eventTestMatrix[n];
      return `|${n}|${eventTargets[n]}|${p.versions.join(",")}|${p.suites.join(",")}|${p.limitation}|`;
    })
    .join("\n") +
  "\n\n旧操作語彙：" +
  legacyOperationTypes.join(", ") +
  "。Map再生の全分岐・不正状態はUndo/Redo・混在履歴・実Map APIの検証と組み合わせる。\n";
if (process.argv.includes("--write-dictionary"))
  await writeFile("../docs/research-event-test-matrix.md", dictionary);
else
  assert.equal(
    await readFile("../docs/research-event-test-matrix.md", "utf8"),
    dictionary,
    "Regenerate the reviewed dictionary on catalog change",
  );
console.log(
  `Catalog ${Object.keys(eventTargets).length} types, ${checks} version/outcome fixture checks; exhaustive registry and dictionary: PASS`,
);
