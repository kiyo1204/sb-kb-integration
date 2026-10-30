import assert from "node:assert/strict";
import { parse } from "csv-parse/sync";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { verifyMockTestUrl } from "./mock-db.js";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";
import { validateMapStateV2 } from "../research-event-map-v2.js";
import { validateMapStateV5 } from "../research-event-map-v5.js";
import { validateEvent } from "../research-events.js";
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const base = process.env.API_BASE_URL!,
  researcher = process.env.RESEARCHER_API_TOKEN!,
  kit = "66666666-6666-4666-8666-666666666662";
async function api(
  path: string,
  token: string,
  status: number,
  method = "GET",
  body?: unknown,
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
  const data = await r.json();
  assert.equal(
    r.status,
    status,
    method + " " + path + " " + JSON.stringify(data),
  );
  return data;
}
try {
  for (const type of ["PRIOR", "KB", "INTEGRATION"]) {
    const credential = createLearnerToken(),
      session = randomUUID(),
      stage = randomUUID(),
      map = randomUUID(),
      stageType =
        type === "PRIOR"
          ? "PRIOR_MAP"
          : type === "KB"
            ? "KB_MAP"
            : "INTEGRATION_MAP";
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "INSERT INTO sessions(id,protocol_key,participant_code,lesson_video_url,research_kit_definition_id,status,started_at,study_group,group_activity_seconds) VALUES($1,$3,'MOCK-POSITION','/mock.mp4',$2,'IN_PROGRESS',clock_timestamp(),$4,$5)",
        [
          session,
          kit,
          type === "INTEGRATION" ? "STAGE1_6" : "STAGE1_4",
          type === "INTEGRATION" ? "EXPERIMENTAL" : null,
          type === "INTEGRATION" ? 600 : null,
        ],
      );
      await storeLearnerToken(c, session, credential.hash);
      await c.query(
        "INSERT INTO session_stages(id,session_id,stage_type,order_index,status,started_at) VALUES($1,$2,$3,0,'IN_PROGRESS',clock_timestamp())",
        [stage, session, stageType],
      );
      await c.query(
        "INSERT INTO maps(id,type,session_stage_id,kit_definition_id) VALUES($1,$2,$3,$4)",
        [map, type, stage, type === "KB" ? kit : null],
      );
      const initial = {
        snapshotVersion: 1,
        mapId: map,
        mapType: type,
        basedOnMapId: null,
        kitDefinitionId: type === "KB" ? kit : null,
        concepts: [],
        links: [],
      };
      await c.query(
        "INSERT INTO map_initial_snapshots(map_id,snapshot_version,snapshot) VALUES($1,1,$2)",
        [map, initial],
      );
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const token = credential.token;
    let link: string;
    if (type === "KB") {
      const definition = await api("/kits/" + kit, token, 200);
      const imported = [];
      for (const part of definition.concepts.slice(0, 2))
        imported.push(
          await api(
            `/maps/${map}/kit-concepts/${part.kitConceptItemId}/import`,
            token,
            201,
            "POST",
            { positionX: 100, positionY: 100 },
          ),
        );
      const part = definition.links[0];
      const created = await api(
        `/maps/${map}/kit-links/${part.kitLinkItemId}`,
        token,
        201,
        "POST",
        { sourceConceptId: imported[0].id, targetConceptId: imported[1].id },
      );
      link = created.id;
    } else {
      const a = await api(`/maps/${map}/concepts`, token, 201, "POST", {
        label: "MOCK 始点",
        positionX: 0,
        positionY: 0,
      });
      const b = await api(`/maps/${map}/concepts`, token, 201, "POST", {
        label: "MOCK 終点",
        positionX: 200,
        positionY: 100,
      });
      link = (
        await api(`/maps/${map}/links`, token, 201, "POST", {
          label: "MOCK 関係",
          sourceConceptId: a.id,
          targetConceptId: b.id,
        })
      ).id;
    }
    const path = `/links/${link}/position`,
      key = randomUUID(),
      body = {
        labelPositionX: 240,
        labelPositionY: 180,
        clientTimestamp: "2026-01-01T00:00:00.000Z",
      };
    await Promise.all([
      api(path, token, 200, "PATCH", body, key),
      api(path, token, 200, "PATCH", body, key),
    ]);
    const row = (
      await pool.query(
        "SELECT * FROM research_events WHERE map_id=$1 AND event_type='MOVE_LINK'",
        [map],
      )
    ).rows;
    assert.equal(row.length, 1);
    assert.equal(row[0].schema_version, 5);
    assert.equal(row[0].target_id, link);
    assert.equal(row[0].actor_type, "LEARNER");
    assert.equal(row[0].outcome, "SUCCESS");
    assert.equal(
      new Date(row[0].client_timestamp).toISOString(),
      body.clientTimestamp,
    );
    assert.ok(Number.isFinite(new Date(row[0].server_timestamp).getTime()));
    const old = row[0].before_state.links.find(
        (l: { id: string }) => l.id === link,
      ),
      next = row[0].after_state.links.find(
        (l: { id: string }) => l.id === link,
      );
    assert.equal(old.labelPositionX, undefined);
    assert.equal(next.labelPositionX, 240);
    assert.equal(next.labelPositionY, 180);
    assert.equal(validateMapStateV2(row[0].after_state, map), false);
    assert.equal(validateMapStateV5(row[0].after_state, map), true);
    const invalid = structuredClone(row[0].after_state);
    invalid.links[0].labelPositionY = 10000001;
    assert.equal(validateMapStateV5(invalid, map), false);
    delete invalid.links[0].labelPositionY;
    assert.equal(validateMapStateV5(invalid, map), false);
    const undo = async (action: string) => {
      const current = await api(`/maps/${map}/undo-redo`, token, 200);
      return api(`/maps/${map}/undo-redo`, token, 200, "POST", {
        action,
        expectedSequenceNumber: current.sequenceNumber,
        idempotencyKey: randomUUID(),
      });
    };
    await undo("UNDO");
    assert.equal(
      (
        await pool.query("SELECT label_position_x FROM links WHERE id=$1", [
          link,
        ])
      ).rows[0].label_position_x,
      null,
    );
    await undo("REDO");
    assert.equal(
      (
        await pool.query("SELECT label_position_x FROM links WHERE id=$1", [
          link,
        ])
      ).rows[0].label_position_x,
      240,
    );
    const retry = await api(path, token, 200, "PATCH", {
      labelPositionX: 350,
      labelPositionY: 250,
    });
    assert.equal(retry.labelPositionX, 350);
    const sameCount = (
      await pool.query(
        "SELECT count(*)::int n FROM research_events WHERE map_id=$1 AND event_type='MOVE_LINK' AND outcome='SUCCESS'",
        [map],
      )
    ).rows[0].n;
    await api(path, token, 200, "PATCH", {
      labelPositionX: 350,
      labelPositionY: 250,
    });
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM research_events WHERE map_id=$1 AND event_type='MOVE_LINK' AND outcome='SUCCESS'",
          [map],
        )
      ).rows[0].n,
      sameCount,
    );
    await api(path, token, 400, "PATCH", {
      labelPositionX: 10000001,
      labelPositionY: 0,
    });
    await api(path, researcher, 200, "PATCH", {
      labelPositionX: 360,
      labelPositionY: 260,
    });
    assert.equal(
      (
        await pool.query(
          "SELECT actor_type FROM research_events WHERE map_id=$1 AND event_type='MOVE_LINK' AND outcome='SUCCESS' ORDER BY sequence_number DESC LIMIT 1",
          [map],
        )
      ).rows[0].actor_type,
      "RESEARCHER",
    );
    if (type !== "KB") {
      const graph = await api(`/maps/${map}`, token, 200);
      const source = graph.links.find(
        (l: { id: string }) => l.id === link,
      ).sourceConceptId;
      await api(`/concepts/${source}`, token, 200, "DELETE");
      await undo("UNDO");
      assert.equal(
        (
          await pool.query("SELECT label_position_x FROM links WHERE id=$1", [
            link,
          ])
        ).rows[0].label_position_x,
        360,
      );
    }
    await api(`/links/${link}`, token, 200, "DELETE");
    await undo("UNDO");
    assert.equal(
      (
        await pool.query("SELECT label_position_x FROM links WHERE id=$1", [
          link,
        ])
      ).rows[0].label_position_x,
      360,
    );
    await api(`/sessions/${session}/events`, token, 403, "POST", {
      schemaVersion: 5,
      eventType: "MOVE_LINK",
      targetType: "LINK",
      targetId: link,
      mapId: map,
      outcome: "SUCCESS",
      clientTimeQuality: "MISSING",
      before: row[0].before_state,
      after: row[0].after_state,
    });
    const saved = await api(`/maps/${map}`, token, 200);
    assert.equal(
      saved.links.find((l: { id: string }) => l.id === link).labelPositionX,
      360,
    );
    const replay = await api(
      `/research/sessions/${session}/maps/${map}/mixed-history`,
      researcher,
      200,
    );
    assert.equal(replay.status, "REPLAYABLE", JSON.stringify(replay));
    assert.equal(
      replay.state.links.find((l: { id: string }) => l.id === link)
        .labelPositionX,
      360,
    );
    const prior = await pool.query(
      "SELECT label_position_x,label_position_y FROM links WHERE id=$1",
      [link],
    );
    await pool.query(
      "CREATE FUNCTION reject_followup_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='MOVE_LINK' THEN RAISE EXCEPTION 'mock forbidden exception'; END IF; RETURN NEW; END $$;CREATE TRIGGER reject_followup_event BEFORE INSERT ON research_events FOR EACH ROW EXECUTE FUNCTION reject_followup_event()",
    );
    try {
      const failed = await api(path, token, 409, "PATCH", {
        labelPositionX: 500,
        labelPositionY: 300,
      });
      assert.ok(!JSON.stringify(failed).includes("forbidden exception"));
      assert.deepEqual(
        (
          await pool.query(
            "SELECT label_position_x,label_position_y FROM links WHERE id=$1",
            [link],
          )
        ).rows,
        prior.rows,
      );
    } finally {
      await pool.query(
        "DROP TRIGGER reject_followup_event ON research_events;DROP FUNCTION reject_followup_event()",
      );
    }
    const other = createLearnerToken();
    const n = (
      await pool.query(
        "SELECT count(*)::int n FROM research_events WHERE map_id=$1",
        [map],
      )
    ).rows[0].n;
    await api(path, other.token, 401, "PATCH", body);
    const otherSession = randomUUID();
    await pool.query(
      "INSERT INTO sessions(id,protocol_key,participant_code,lesson_video_url,research_kit_definition_id) VALUES($1,'STAGE1_4','MOCK-OTHER','/mock.mp4',$2)",
      [otherSession, kit],
    );
    const oc = await pool.connect();
    try {
      await storeLearnerToken(oc, otherSession, other.hash);
    } finally {
      oc.release();
    }
    await api(path, other.token, 404, "PATCH", body);
    const goal = (
      await pool.query("SELECT goal_map_id FROM kit_definitions WHERE id=$1", [
        kit,
      ])
    ).rows[0].goal_map_id;
    await api(`/maps/${goal}`, token, 404);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM research_events WHERE map_id=$1",
          [map],
        )
      ).rows[0].n,
      n,
    );
    if (type === "KB") {
      const feedback = await api(`/maps/${map}/kit-feedback`, token, 200);
      assert.equal(feedback.matched, false);
      let e = (
        await pool.query(
          "SELECT * FROM research_events WHERE map_id=$1 AND event_type='FEEDBACK_CHECK' ORDER BY sequence_number DESC LIMIT 1",
          [map],
        )
      ).rows[0];
      assert.equal(e.schema_version, 6);
      assert.equal(e.outcome, "SUCCESS");
      assert.deepEqual(e.details, { matched: false });
      assert.equal(e.reason_code, null);
      await api(`/maps/${map}/kit-feedback/display`, token, 200, "POST", {});
      const parts = (
        await pool.query(
          "SELECT id,source_concept_id FROM kit_concept_items WHERE kit_definition_id=$1 ORDER BY created_at,id",
          [kit],
        )
      ).rows;
      const assignments = new Map<string, string>(
        (
          await pool.query(
            "SELECT p.source_concept_id AS source,p.target_concept_id AS target FROM concept_provenance p JOIN concepts c ON c.id=p.target_concept_id WHERE c.map_id=$1",
            [map],
          )
        ).rows.map((x) => [x.source, x.target]),
      );
      for (const part of parts)
        if (!assignments.has(part.source_concept_id)) {
          const c = await api(
            `/maps/${map}/kit-concepts/${part.id}/import`,
            token,
            201,
            "POST",
            { positionX: 100, positionY: 100 },
          );
          assignments.set(part.source_concept_id, c.id);
        }
      const linkParts = (
        await pool.query(
          "SELECT item.id,l.source_concept_id,l.target_concept_id FROM kit_link_items item JOIN links l ON l.id=item.source_link_id WHERE item.kit_definition_id=$1 ORDER BY item.created_at,item.id",
          [kit],
        )
      ).rows;
      for (const [i, part] of linkParts.entries()) {
        const endpoints = {
          sourceConceptId: assignments.get(part.source_concept_id),
          targetConceptId: assignments.get(part.target_concept_id),
        };
        if (i === 0)
          await api(`/links/${link}/reconnect`, token, 200, "PATCH", endpoints);
        else
          await api(
            `/maps/${map}/kit-links/${part.id}`,
            token,
            201,
            "POST",
            endpoints,
          );
      }
      assert.equal(
        (await api(`/maps/${map}/kit-feedback`, token, 200)).matched,
        true,
      );
      const matched = (
        await pool.query(
          "SELECT outcome,details FROM research_events WHERE map_id=$1 AND event_type='FEEDBACK_CHECK' ORDER BY sequence_number DESC LIMIT 1",
          [map],
        )
      ).rows[0];
      assert.equal(matched.outcome, "SUCCESS");
      assert.deepEqual(matched.details, { matched: true });

      // Deny a read used only after ownership is established to observe an actual technical failure.
      await pool.query(
        "ALTER TABLE kit_concept_items RENAME TO mock_hidden_kit_concepts",
      );
      try {
        const result = await api(`/maps/${map}/kit-feedback`, token, 500);
        assert.equal(result.operationOutcome, "FAILURE");
        assert.ok(!JSON.stringify(result).includes("private body"));
      } finally {
        await pool.query(
          "ALTER TABLE mock_hidden_kit_concepts RENAME TO kit_concept_items",
        );
      }
      e = (
        await pool.query(
          "SELECT * FROM research_events WHERE map_id=$1 AND event_type='FEEDBACK_CHECK' ORDER BY sequence_number DESC LIMIT 1",
          [map],
        )
      ).rows[0];
      assert.equal(e.outcome, "FAILURE");
      assert.equal(e.reason_code, "SERVER");
      assert.deepEqual(e.details, {});
      await pool.query("UPDATE maps SET kit_definition_id=NULL WHERE id=$1", [
        map,
      ]);
      const reject = await api(`/maps/${map}/kit-feedback`, token, 409);
      assert.equal(reject.operationOutcome, "REJECTED");
      e = (
        await pool.query(
          "SELECT * FROM research_events WHERE map_id=$1 AND event_type='FEEDBACK_CHECK' ORDER BY sequence_number DESC LIMIT 1",
          [map],
        )
      ).rows[0];
      assert.equal(e.outcome, "REJECTED");
      assert.equal(e.reason_code, "VALIDATION");
      assert.deepEqual(e.details, {});
      await pool.query("UPDATE maps SET kit_definition_id=$2 WHERE id=$1", [
        map,
        kit,
      ]);
    }
    const extraction = await api(
      "/research/event-exports",
      researcher,
      201,
      "POST",
      { filters: { sessionIds: [session] } },
    );
    const exported = await api(
      `/research/event-exports/${extraction.exportId}/events.json`,
      researcher,
      200,
    );
    const download = await fetch(
      base + `/api/research/event-exports/${extraction.exportId}/events.csv`,
      { headers: { Authorization: "Bearer " + researcher } },
    );
    assert.equal(download.status, 200);
    const rows = parse(await download.text(), {
      columns: true,
      bom: true,
    }) as Array<Record<string, string>>;
    assert.equal(rows.length, exported.events.length);
    for (const event of exported.events) {
      const csv = rows.find((r) => r.event_id === event.event_id)!;
      assert.ok(csv);
      assert.equal(csv.outcome, event.outcome);
      assert.equal(
        csv.feedback_match,
        event.feedback_match == null ? "" : String(event.feedback_match),
      );
    }
    assert.ok(
      exported.events.some(
        (e: { schema_version: number }) => e.schema_version === 5,
      ),
    );
    if (type === "KB")
      assert.ok(
        exported.events.some(
          (e: {
            schema_version: number;
            feedback_match: unknown;
            outcome: string;
          }) =>
            e.schema_version === 6 &&
            e.feedback_match === false &&
            e.outcome === "SUCCESS",
        ),
      );
    if (type === "INTEGRATION") {
      await pool.query(
        "UPDATE session_stages SET started_at=clock_timestamp()-interval '601 seconds' WHERE id=$1",
        [stage],
      );
      await api(path, token, 404, "PATCH", {
        labelPositionX: 999,
        labelPositionY: 999,
      });
      assert.equal(
        (
          await pool.query("SELECT label_position_x FROM links WHERE id=$1", [
            link,
          ])
        ).rows[0].label_position_x,
        360,
      );
      assert.ok(
        (
          await pool.query(
            "SELECT 1 FROM research_events WHERE map_id=$1 AND event_type='MOVE_LINK' AND outcome='REJECTED' AND reason_code='DEADLINE'",
            [map],
          )
        ).rowCount,
      );
      assert.equal(
        (
          await api(
            `/research/sessions/${session}/maps/${map}/mixed-history`,
            researcher,
            200,
          )
        ).status,
        "REPLAYABLE",
      );
    }
  }
  // An out-of-contract legacy map must not gain a boundary merely because a move was rejected.
  const unsupported = {
      session: randomUUID(),
      stage: randomUUID(),
      map: randomUUID(),
      concept: randomUUID(),
      link: randomUUID(),
    },
    legacyToken = createLearnerToken();
  await pool.query(
    "INSERT INTO sessions(id,protocol_key,participant_code,lesson_video_url,research_kit_definition_id,status,started_at) VALUES($1,'STAGE1_4','MOCK-LEGACY-OVERSIZE','/mock.mp4',$2,'IN_PROGRESS',clock_timestamp())",
    [unsupported.session, kit],
  );
  const lc = await pool.connect();
  try {
    await storeLearnerToken(lc, unsupported.session, legacyToken.hash);
  } finally {
    lc.release();
  }
  await pool.query(
    "INSERT INTO session_stages(id,session_id,stage_type,order_index,status,started_at) VALUES($1,$2,'PRIOR_MAP',0,'IN_PROGRESS',clock_timestamp())",
    [unsupported.stage, unsupported.session],
  );
  await pool.query(
    "INSERT INTO maps(id,type,session_stage_id) VALUES($1,'PRIOR',$2)",
    [unsupported.map, unsupported.stage],
  );
  await pool.query(
    "INSERT INTO concepts(id,map_id,label,position_x,position_y) VALUES($1,$2,$3,0,0)",
    [unsupported.concept, unsupported.map, "概".repeat(513)],
  );
  await pool.query(
    "INSERT INTO links(id,map_id,label,source_concept_id,target_concept_id) VALUES($1,$2,'MOCK relation',$3,$3)",
    [unsupported.link, unsupported.map, unsupported.concept],
  );
  const invalidLegacy = {
    snapshotVersion: 1,
    mapId: unsupported.map,
    mapType: "PRIOR",
    basedOnMapId: null,
    kitDefinitionId: null,
    concepts: [
      {
        id: unsupported.concept,
        mapId: unsupported.map,
        label: "概".repeat(513),
        positionX: 0,
        positionY: 0,
        mergedIntoConceptId: null,
        provenance: [],
      },
    ],
    links: [
      {
        id: unsupported.link,
        mapId: unsupported.map,
        label: "MOCK relation",
        sourceConceptId: unsupported.concept,
        targetConceptId: unsupported.concept,
        provenance: [],
      },
    ],
  };
  await pool.query(
    "INSERT INTO map_initial_snapshots(map_id,snapshot_version,snapshot) VALUES($1,1,$2)",
    [unsupported.map, invalidLegacy],
  );
  const invalidMove = await api(
    `/links/${unsupported.link}/position`,
    legacyToken.token,
    409,
    "PATCH",
    { labelPositionX: 10, labelPositionY: 20 },
  );
  assert.equal(invalidMove.logSaved, false);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM map_history_boundaries WHERE map_id=$1",
        [unsupported.map],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query("SELECT label_position_x FROM links WHERE id=$1", [
        unsupported.link,
      ])
    ).rows[0].label_position_x,
    null,
  );
  // jsonb::text expands subnormal coordinates. A valid compact state must still fit the DB guard.
  const sizeMap = randomUUID(),
    ids = Array.from({ length: 1000 }, () => randomUUID()),
    label = "概".repeat(330);
  const large = {
    snapshotVersion: 1,
    mapId: sizeMap,
    mapType: "PRIOR",
    basedOnMapId: null,
    kitDefinitionId: null,
    concepts: ids.map((id) => ({
      id,
      mapId: sizeMap,
      label,
      positionX: 1e-308,
      positionY: 1e-308,
      mergedIntoConceptId: null,
      provenance: [],
    })),
    links: Array.from({ length: 2000 }, () => ({
      id: randomUUID(),
      mapId: sizeMap,
      label,
      sourceConceptId: ids[0],
      targetConceptId: ids[1],
      labelPositionX: 1e-308,
      labelPositionY: 1e-308,
      provenance: [],
    })),
  };
  assert.equal(validateMapStateV5(large, sizeMap), true);
  assert.ok(Buffer.byteLength(JSON.stringify(large), "utf8") <= 4000000);
  const storage = (
    await pool.query(
      "SELECT map_event_state_v5_valid($1::jsonb,$2::uuid) AS valid,octet_length($1::jsonb::text) AS bytes",
      [large, sizeMap],
    )
  ).rows[0];
  assert.equal(storage.valid, true);
  assert.ok(storage.bytes > 4200000);
  assert.equal(
    validateEvent({
      schemaVersion: 6,
      eventType: "FEEDBACK_CHECK",
      targetType: "FEEDBACK",
      mapId: randomUUID(),
      stageId: randomUUID(),
      targetId: randomUUID(),
      outcome: "SUCCESS",
      clientTimeQuality: "NOT_APPLICABLE",
      beforeQuality: "NOT_APPLICABLE",
      afterQuality: "NOT_APPLICABLE",
      details: { matched: false, label: "secret" },
    }),
    false,
  );
  console.log(
    "Parent followup: three Map types, v5 position DB/replay/Undo/Redo/concurrency/rollback/actors and v6 mismatch/rejection/failure: PASS",
  );
} finally {
  await pool.end();
}
