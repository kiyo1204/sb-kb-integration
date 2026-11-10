import {checkExperimentResearch} from "./experiment-research-checks.js";
import type { Request, Response } from "express";
import {
  initializeExperimentPreview,
  validateExperimentRequest,
} from "../experiment-execution.js";
// TEST ONLY. Own API process and verified disposable mock DB; no real participant use.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { Pool } from "pg";
import { writeFile } from "node:fs/promises";
import { verifyMockTestUrl, verificationReportPath } from "./mock-db.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
  researcher = process.env.RESEARCHER_API_TOKEN!,
  root = "/research/experiment-runs";
const listener = createServer();
await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((r) => listener.close(() => r()));
const base = "http://127.0.0.1:" + port,
  server = spawn(process.execPath, ["dist/index.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      STAGE1_EXPERIMENT_LEARNER_PREVIEW: "1",
    },
    stdio: "ignore",
    windowsHide: true,
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 150; i++) {
  try {
    if ((await fetch(base + "/api/health")).ok) {
      ready = true;
      break;
    }
  } catch {
    /* API process is starting. */
  }
  await sleep(100);
}
let auth = researcher,
  extra: Record<string, string> = {};
const clients = new Map<string, string>();
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  status = 200,
  key: string = randomUUID(),
  token = auth,
) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  assert.equal(
    r.status,
    status,
    method + " " + path + " " + (data?.error ?? ""),
  );
  return { data, response: r };
}
const research = (
  path: string,
  method = "GET",
  body?: unknown,
  status = 200,
  key: string = randomUUID(),
) => call(path, method, body, status, key, researcher);
async function claim(token: string) {
  auth = token;
  extra = {
    "X-Experiment-Client":
      clients.get(token) ?? randomBytes(32).toString("base64url"),
  };
  clients.set(token, extra["X-Experiment-Client"]);
  const c = (await call("/experiment-client/claim", "POST", {})).data;
  extra["X-Experiment-Generation"] = String(c.deviceGeneration);
  extra["X-Experiment-Origin-Client"] = c.clientId;
  extra["X-Experiment-Origin-Generation"] = String(c.deviceGeneration);
  return c;
}
async function undo(id: string, action = "UNDO") {
  const h = (await call(`/maps/${id}/undo-redo`)).data;
  return call(`/maps/${id}/undo-redo`, "POST", {
    action,
    expectedSequenceNumber: h.sequenceNumber,
    idempotencyKey: randomUUID(),
  });
}
try {
  assert.ok(ready, "mock preview API ready");
  process.env.STAGE1_EXPERIMENT_LEARNER_PREVIEW = "1";
  await initializeExperimentPreview(pool);
  let failedStatus = 200,
    failedBody: unknown;
  const proof = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    kitId: randomUUID(),
    credentialHash: "0".repeat(64),
    credentialGeneration: 1,
  };
  const response = {
    locals: {
      principal: {
        role: "learner",
        sessionId: proof.sessionId,
        kitId: proof.kitId,
        experiment: proof,
      },
    },
    status(value: number) {
      failedStatus = value;
      return this;
    },
    json(value: unknown) {
      failedBody = value;
      return this;
    },
  };
  const failedPool = {
    connect: async () => ({
      query: async () => {
        throw new Error("TEST ONLY private DB lookup fault");
      },
      release() {
        /* fake DB resource */
      },
    }),
  };
  assert.equal(
    await validateExperimentRequest(
      failedPool as unknown as Pool,
      {
        header: () => undefined,
        path: "/maps/test",
        method: "PATCH",
      } as unknown as Request,
      response as unknown as Response,
    ),
    false,
  );
  assert.equal(failedStatus, 503);
  assert.equal(
    (failedBody as { error: string }).error,
    "experiment_access_unavailable",
  );
  assert.ok(!JSON.stringify(failedBody).includes("private DB lookup fault"));

  const goal = (
    await call(
      "/research/goal-maps/import",
      "POST",
      {
        format: "sb-kb-goal-map",
        schemaVersion: 1,
        goalMap: {
          title: "TEST ONLY access " + randomUUID(),
          concepts: [
            { id: "a", label: "TEST ONLY seed", position: { x: 0, y: 0 } },
            { id: "b", label: "TEST ONLY second", position: { x: 250, y: 0 } },
          ],
          links: [
            {
              id: "ab",
              label: "TEST ONLY relation",
              sourceId: "a",
              targetId: "b",
              labelPosition: null,
            },
          ],
        },
      },
      201,
    )
  ).data;
  const part = (
    await pool.query(
      "SELECT id FROM kit_concept_items WHERE kit_definition_id=$1",
      [goal.kitDefinitionId],
    )
  ).rows[0].id;
  const d = (await call("/research/materials", "POST", {}, 201)).data;
  const body = {
    title: "TEST ONLY access material",
    researcherDescription: "",
    videoRef: "/test-only.mp4",
    sbInstructions: "TEST ONLY SB",
    kbInstructions: "TEST ONLY KB",
    integrationInstructions: "TEST ONLY integration",
    kitId: goal.kitDefinitionId,
    seedConceptItemIds: [part],
    integrationSeconds: 8,
  };
  const s = (
    await call(`/research/materials/${d.id}`, "PUT", {
      expectedRevision: d.editRevision,
      body,
    })
  ).data;
  const mat = (
    await call(`/research/materials/${d.id}/publish`, "POST", {
      expectedRevision: s.editRevision,
    })
  ).data;
  const run = (
    await call(
      root,
      "POST",
      {
        name: "TEST ONLY learner flow",
        catalogVersionId: mat.id,
        plannedParticipants: 1,
      },
      201,
    )
  ).data;

  if(process.env.EXPERIMENT_RESEARCH_CHECKS==="1") {
    const empty=(await research(`${root}/${run.id}/research.json`)).data;
    assert.equal(empty.sessions.length,0);
  }
  await research(`${root}/${run.id}/start`, "POST", {}, 409);
  const p = (
    await research(
      `${root}/${run.id}/participants`,
      "POST",
      { participantLabel: "TEST ONLY learner P1" },
      201,
    )
  ).data;
  const preparedMe = (
    await call("/me", "GET", undefined, 200, randomUUID(), p.issuedCode)
  ).data;
  assert.equal(preparedMe.sessionId, p.sessionId);
  const preparedClaim = await claim(p.issuedCode);
  assert.equal(
    preparedClaim.ownership,
    "OWNED",
    "PREPARING permits client registration",
  );
  const preparedStage = (
    await pool.query(
      "SELECT id FROM session_stages WHERE session_id=$1 ORDER BY order_index LIMIT 1",
      [p.sessionId],
    )
  ).rows[0].id;
  const preparedSnapshot = async () =>
    (
      await pool.query(
        `SELECT s.status,
    (SELECT jsonb_agg(to_jsonb(st) ORDER BY st.order_index) FROM session_stages st WHERE st.session_id=s.id) stages,
    (SELECT count(*) FROM maps m JOIN session_stages st ON st.id=m.session_stage_id WHERE st.session_id=s.id)::int maps,
    (SELECT count(*) FROM operation_receipts WHERE principal_scope=$2)::int receipts
    FROM sessions s WHERE s.id=$1`,
        [p.sessionId, "LEARNER:" + p.sessionId],
      )
    ).rows[0];
  const beforeLearning = await preparedSnapshot();
  if(process.env.EXPERIMENT_RESEARCH_CHECKS==="1") {
    const preparing=(await research(`/research/stage1/sessions/${p.sessionId}/analysis`)).data;
    assert.equal(preparing.session.status,"NOT_STARTED");assert.equal(preparing.maps.length,0);
    assert.equal(preparing.integrationStates.submission.state,null);
  }
  const absentMap = randomUUID(); // No learner Map can exist before Stage start.
  for (const [path, method, body] of [
    [`/sessions/${p.sessionId}/flow`, "GET", undefined],
    [`/sessions/${p.sessionId}/start`, "POST", {}],
    [`/session-stages/${preparedStage}/start`, "POST", {}],
    ["/maps", "POST", { sessionStageId: preparedStage, type: "PRIOR" }],
    [`/maps/${absentMap}`, "GET", undefined],
    [`/maps/${absentMap}`, "PATCH", { title: "TEST ONLY refused" }],
    [`/maps/${absentMap}/submit`, "POST", {}],
  ] as const) {
    assert.equal(
      (await call(path, method, body, 409)).data.error,
      "experiment_not_running",
    );
  }
  assert.deepEqual(
    await preparedSnapshot(),
    beforeLearning,
    "PREPARING denies learning without partial writes/receipts",
  );
  const failedStartKey = randomUUID();
  await pool.query(
    "CREATE FUNCTION mock_learner_start_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.outcome='SUCCESS' THEN RAISE EXCEPTION 'TEST ONLY start audit fault';END IF;RETURN NEW;END$$;CREATE TRIGGER mock_learner_start_fault BEFORE INSERT ON experiment_start_audit FOR EACH ROW EXECUTE FUNCTION mock_learner_start_fault()",
  );
  try {
    await research(`${root}/${run.id}/start`, "POST", {}, 503, failedStartKey);
    assert.equal(
      (
        await pool.query("SELECT state FROM experiment_runs WHERE id=$1", [
          run.id,
        ])
      ).rows[0].state,
      "PREPARING",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM experiment_start_receipts WHERE request_key=$1",
          [failedStartKey],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await pool.query(
      "DROP TRIGGER mock_learner_start_fault ON experiment_start_audit;DROP FUNCTION mock_learner_start_fault()",
    );
  }
  const startKey = randomUUID();
  const started = (
    await research(`${root}/${run.id}/start`, "POST", {}, 200, startKey)
  ).data;
  assert.deepEqual(
    (await research(`${root}/${run.id}/start`, "POST", {}, 200, startKey)).data,
    started,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM experiment_start_audit WHERE run_id=$1 AND outcome='SUCCESS'",
        [run.id],
      )
    ).rows[0].n,
    1,
  );
  const late = (
    await research(
      `${root}/${run.id}/participants`,
      "POST",
      { participantLabel: "TEST ONLY late P2" },
      201,
    )
  ).data;
  const flow = (await call(`/sessions/${p.sessionId}/flow`)).data;
  assert.deepEqual(
    flow.stages.map((s: { stageType: string }) => s.stageType),
    ["LESSON", "PRIOR_MAP", "KB_MAP", "INTEGRATION_MAP"],
  );
  await call(`/sessions/${late.sessionId}/flow`, "GET", undefined, 404);
  await call(`${root}/${run.id}/participants`, "GET", undefined, 403);

  async function buildParticipant(
    sessionId: string,
    token: string,
    manual: boolean,
  ) {
    await claim(token);
    const fs = (await call(`/sessions/${sessionId}/flow`)).data;
    const st = (kind: string) =>
      fs.stages.find((s: { stageType: string }) => s.stageType === kind).id;
    await call(`/sessions/${sessionId}/start`, "POST", {});
    await call(`/session-stages/${st("KB_MAP")}/start`, "POST", {}, 409);
    await call(`/session-stages/${st("LESSON")}/start`, "POST", {});
    extra["X-Client-Stream-Id"] = randomUUID();
    extra["X-Client-Sequence"] = "1";
    await call(
      `/sessions/${sessionId}/events`,
      "POST",
      {
        schemaVersion: 1,
        eventType: "VIDEO_COMPLETE",
        targetType: "VIDEO",
        stageId: st("LESSON"),
        outcome: "SUCCESS",
        clientTimeQuality: "NOT_APPLICABLE",
      },
      201,
    );
    const origin = extra["X-Experiment-Origin-Generation"];
    extra["X-Experiment-Origin-Generation"] = "0";
    await call(
      `/sessions/${sessionId}/events`,
      "POST",
      {
        schemaVersion: 1,
        eventType: "VIDEO_COMPLETE",
        targetType: "VIDEO",
        stageId: st("LESSON"),
        outcome: "SUCCESS",
        clientTimeQuality: "NOT_APPLICABLE",
      },
      409,
    );
    extra["X-Experiment-Origin-Generation"] = origin;
    delete extra["X-Client-Stream-Id"];
    delete extra["X-Client-Sequence"];
    await call(`/session-stages/${st("LESSON")}/complete`, "POST", {});
    await call(`/session-stages/${st("PRIOR_MAP")}/start`, "POST", {});
    const sb = (
      await call(
        `/session-stages/${st("PRIOR_MAP")}/prior-map`,
        "POST",
        {},
        201,
      )
    ).data;
    const initial = (await call(`/maps/${sb.id}`)).data;
    assert.equal(initial.concepts.length, 1);
    assert.ok(initial.concepts[0].isSeed);
    await call(
      `/concepts/${initial.concepts[0].id}/label`,
      "PATCH",
      { label: "TEST ONLY denied" },
      409,
    );
    await call(`/concepts/${initial.concepts[0].id}`, "DELETE", {}, 409);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM concept_provenance WHERE target_concept_id=$1",
          [initial.concepts[0].id],
        )
      ).rows[0].n,
      1,
    );
    const key = randomUUID();
    const a = (
      await call(
        `/maps/${sb.id}/concepts`,
        "POST",
        { label: "TEST ONLY ordinary", positionX: 100, positionY: 100 },
        201,
        key,
      )
    ).data;
    assert.equal(
      (
        await call(
          `/maps/${sb.id}/concepts`,
          "POST",
          { label: "TEST ONLY ordinary", positionX: 100, positionY: 100 },
          201,
          key,
        )
      ).data.id,
      a.id,
    );
    await undo(sb.id);
    await undo(sb.id, "REDO");
    if (manual) {
      const faultKey = randomUUID(),
        before = (
          await pool.query(
            "SELECT count(*)::int n FROM concepts WHERE map_id=$1",
            [sb.id],
          )
        ).rows[0].n;
      await pool.query(
        "CREATE FUNCTION mock_learner_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.label='TEST ONLY atomic-fault' THEN RAISE EXCEPTION 'TEST ONLY injected write fault';END IF;RETURN NEW;END$$;CREATE TRIGGER mock_learner_fault BEFORE INSERT ON concepts FOR EACH ROW EXECUTE FUNCTION mock_learner_fault()",
      );
      try {
        await call(
          `/maps/${sb.id}/concepts`,
          "POST",
          { label: "TEST ONLY atomic-fault", positionX: 400, positionY: 100 },
          500,
          faultKey,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int n FROM concepts WHERE map_id=$1",
              [sb.id],
            )
          ).rows[0].n,
          before,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int n FROM operation_receipts WHERE principal_scope=$1 AND operation_key=$2",
              ["LEARNER:" + sessionId, faultKey],
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await pool.query(
          "DROP TRIGGER mock_learner_fault ON concepts;DROP FUNCTION mock_learner_fault()",
        );
      }
      await call(
        `/maps/${sb.id}/concepts`,
        "POST",
        { label: "TEST ONLY atomic-fault", positionX: 400, positionY: 100 },
        201,
        faultKey,
      );
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT * FROM experiment_participant_access WHERE session_id=$1 FOR UPDATE",
        [sessionId],
      );
      const rotation = research(
        `${root}/${run.id}/participants/${sessionId}/code/reissue`,
        "POST",
        { expectedCredentialGeneration: 1 },
      );
      const waiters = async () =>
        Number(
          (
            await pool.query(
              "SELECT count(*) n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%experiment_participant_access%' AND pid<>pg_backend_pid()",
            )
          ).rows[0].n,
        );
      try {
        for (let i = 0; i < 100 && (await waiters()) < 1; i++) await sleep(20);
        assert.ok((await waiters()) >= 1);
        const stale = call(
          `/concepts/${a.id}/label`,
          "PATCH",
          { label: "TEST ONLY must not commit" },
          401,
        );
        for (let i = 0; i < 100 && (await waiters()) < 2; i++) await sleep(20);
        assert.ok((await waiters()) >= 2);
        await blocker.query("COMMIT");
        const re = (await rotation).data;
        await stale;
        await call("/me", "GET", undefined, 401, randomUUID(), token);
        token = re.issuedCode;
        await claim(token);
        assert.equal(
          (await pool.query("SELECT label FROM concepts WHERE id=$1", [a.id]))
            .rows[0].label,
          "TEST ONLY ordinary",
        );
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
      }
    }

    await call(`/maps/${sb.id}/submit`, "POST", {});
    await call(
      `/concepts/${a.id}/position`,
      "PATCH",
      { positionX: 500, positionY: 100 },
      404,
    );
    await call(`/session-stages/${st("KB_MAP")}/start`, "POST", {});
    const kb = (
      await call(
        `/kits/${goal.kitDefinitionId}/kb-map`,
        "POST",
        { sessionStageId: st("KB_MAP") },
        201,
      )
    ).data;
    assert.equal(
      (await call(`/maps/${kb.id}/kit-feedback`)).data.matched,
      false,
    );
    await call(`/maps/${kb.id}/submit`, "POST", {}, 409);
    const parts = (
      await pool.query(
        "SELECT id,source_concept_id AS source FROM kit_concept_items WHERE kit_definition_id=$1 ORDER BY id",
        [goal.kitDefinitionId],
      )
    ).rows;
    const nodes = new Map<string, string>();
    for (const part of parts) {
      const c = (
        await call(
          `/maps/${kb.id}/kit-concepts/${part.id}/import`,
          "POST",
          { positionX: 100 + nodes.size * 250, positionY: 100 },
          201,
        )
      ).data;
      nodes.set(part.source, c.id);
    }
    const part = (
      await pool.query(
        "SELECT i.id,l.source_concept_id AS source,l.target_concept_id AS target FROM kit_link_items i JOIN links l ON l.id=i.source_link_id WHERE i.kit_definition_id=$1",
        [goal.kitDefinitionId],
      )
    ).rows[0];
    const l = (
      await call(
        `/maps/${kb.id}/kit-links/${part.id}`,
        "POST",
        {
          sourceConceptId: nodes.get(part.source),
          targetConceptId: nodes.get(part.target),
        },
        201,
      )
    ).data;
    const good = (await call(`/maps/${kb.id}/kit-feedback`)).data;
    assert.equal(good.matched, true);
    assert.deepEqual(
      Object.keys(good).sort(),
      [
        "concepts",
        "configurationComplete",
        "logSaved",
        "mapSignature",
        "matched",
        "message",
        "relations",
      ].sort(),
    );
    await call(`/concepts/${nodes.get(part.source)}/position`, "PATCH", {
      positionX: 400,
      positionY: 200,
    });
    assert.equal(
      (await call(`/maps/${kb.id}/kit-graph-signature`)).data.mapSignature,
      good.mapSignature,
    );
    await call(`/links/${l.id}/reconnect`, "PATCH", {
      sourceConceptId: nodes.get(part.target),
      targetConceptId: nodes.get(part.source),
    });
    await call(`/maps/${kb.id}/submit`, "POST", {}, 409);
    await undo(kb.id);
    assert.equal(
      (await call(`/maps/${kb.id}/kit-feedback`)).data.matched,
      true,
    );
    await call(`/maps/${kb.id}/submit`, "POST", {});
    await call(`/session-stages/${st("INTEGRATION_MAP")}/start`, "POST", {});
    const int = (
      await call(
        `/session-stages/${st("INTEGRATION_MAP")}/integration-map`,
        "POST",
        {},
        201,
      )
    ).data;
    let m = (await call(`/maps/${int.id}`)).data;
    if (!m.kitDefinitionId) {
      await call(`/maps/${int.id}/kit-definition`, "PATCH", {
        kitDefinitionId: goal.kitDefinitionId,
      });
      m = (await call(`/maps/${int.id}`)).data;
    }
    assert.equal(m.type, "INTEGRATION");
    await call(`/maps/${int.id}/kit-feedback`, "GET", undefined, 404);
    const ids = m.concepts
      .filter(
        (c: { mergedIntoConceptId: string | null }) => !c.mergedIntoConceptId,
      )
      .map((c: { id: string }) => c.id);
    const merged = (
      await call(
        `/maps/${int.id}/concepts/merge`,
        "POST",
        { conceptIds: ids.slice(0, 2), label: "TEST ONLY merge" },
        201,
      )
    ).data;
    const outerSource = (
      await call(
        `/maps/${int.id}/concepts`,
        "POST",
        { label: "TEST ONLY outer source", positionX: 700, positionY: 300 },
        201,
      )
    ).data;
    const outer = (
      await call(
        `/maps/${int.id}/concepts/merge`,
        "POST",
        {
          conceptIds: [merged.concept.id, outerSource.id],
          label: "TEST ONLY outer merge",
        },
        201,
      )
    ).data;
    await call(`/concepts/${outer.concept.id}`, "DELETE", {});
    const oneLevel = (await call(`/maps/${int.id}`)).data;
    assert.ok(
      oneLevel.concepts.some(
        (c: { id: string; isMergeResult: boolean }) =>
          c.id === merged.concept.id && c.isMergeResult,
      ),
    );
    assert.ok(
      ids
        .slice(0, 2)
        .every(
          (id: string) =>
            !oneLevel.concepts.some((c: { id: string }) => c.id === id),
        ),
      "inner merge stays hidden",
    );
    await call(`/concepts/${merged.concept.id}`, "DELETE", {});
    await undo(int.id);
    await undo(int.id, "REDO");
    if(process.env.EXPERIMENT_RESEARCH_CHECKS==="1" && manual) {
      const editing=(await research(`/research/stage1/sessions/${sessionId}/analysis`)).data;
      assert.equal(editing.integrationStates.start.status,"AVAILABLE");
      assert.equal(editing.integrationStates.submission.reason,"NOT_SUBMITTED");
      assert.equal(editing.integrationStates.submission.state,null);
    }
    if (manual) await call(`/maps/${int.id}/submit`, "POST", {});
    else {
      let done = false;
      for (let i = 0; i < 150; i++) {
        const row = (
          await pool.query(
            "SELECT status,auto_submitted_at FROM maps WHERE id=$1",
            [int.id],
          )
        ).rows[0];
        if (row.status === "SUBMITTED") {
          assert.ok(row.auto_submitted_at);
          done = true;
          break;
        }
        await sleep(100);
      }
      assert.ok(done, "automatic submission accepted");
    }
    assert.equal(
      (await call(`/sessions/${sessionId}/flow`)).data.session.status,
      "IN_PROGRESS",
    );
    const replay = (
      await research(
        `/research/sessions/${sessionId}/maps/${int.id}/mixed-history`,
      )
    ).data;
    assert.equal(replay.status, "REPLAYABLE");
    await call(`/session-stages/${st("INTEGRATION_MAP")}/complete`, "POST", {});
    const end = (await call(`/sessions/${sessionId}/flow`)).data;
    assert.equal(end.session.status, "COMPLETED");
    assert.equal(end.stages.length, 4);
    return { sb: sb.id, kb: kb.id, int: int.id };
  }
  const maps = await buildParticipant(p.sessionId, p.issuedCode, true);
  await buildParticipant(late.sessionId, late.issuedCode, false);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM survey_questions WHERE session_id=ANY($1::uuid[])",
        [[p.sessionId, late.sessionId]],
      )
    ).rows[0].n,
    0,
  );
  if(process.env.EXPERIMENT_RESEARCH_CHECKS==="1") {
    const result=await checkExperimentResearch({pool,base,token:researcher,learner:late.issuedCode,runId:run.id,versionId:mat.id,sessionIds:[p.sessionId,late.sessionId]});
    await writeFile(verificationReportPath("invariants").replace(/invariants\.json$/,"experiment-research.json"),JSON.stringify(result,null,2)+"\n");
    if(process.env.RESEARCH_BROWSER_CHECKS==="1") {
      // TEST ONLY: verified disposable DB, remove only this fixture's initial row.
      const missingId=maps.int;
      const savedInitial=(await pool.query("SELECT * FROM map_initial_snapshots WHERE map_id=$1",[missingId])).rows[0];
      assert.ok(savedInitial);
      await pool.query("DELETE FROM map_initial_snapshots WHERE map_id=$1",[missingId]);
      const missing=(await research(`/research/stage1/sessions/${p.sessionId}/analysis`)).data;
      assert.equal(missing.integrationStates.start.reason,"INITIAL_SNAPSHOT_MISSING_OR_INVALID");
      assert.equal(missing.integrationStates.start.state,null);assert.equal(missing.integrationStates.submission.state,null);
      const child=spawn(process.execPath,[process.env.npm_execpath!,"run","test:experiment-research-browser"],{cwd:"../frontend",env:{...process.env,API_BASE_URL:base,EXPERIMENT_RESEARCH_RUN:run.id,EXPERIMENT_RESEARCH_SESSION:p.sessionId,EXPERIMENT_MISSING_SNAPSHOT:"1"},stdio:"inherit",windowsHide:true});
      assert.equal((await once(child,"exit"))[0],0,"research browser");
    }
  }
  // Separate browser Session, never use completed data as an editable fixture.
  if (process.env.RESEARCH_BROWSER_CHECKS === "1") {
    const browserRun = (
      await research(
        root,
        "POST",
        {
          name: "TEST ONLY waiting browser",
          catalogVersionId: mat.id,
          plannedParticipants: 1,
        },
        201,
      )
    ).data;
    const bp = (
      await research(
        `${root}/${browserRun.id}/participants`,
        "POST",
        { participantLabel: "TEST ONLY browser flow" },
        201,
      )
    ).data;
    const cli = process.env.npm_execpath!;
    const child = spawn(
      process.execPath,
      [cli, "run", "test:experiment-learner-browser"],
      {
        cwd: "../frontend",
        env: {
          ...process.env,
          API_BASE_URL: base,
          EXPERIMENT_BROWSER_TOKEN: bp.issuedCode,
          EXPERIMENT_BROWSER_SESSION: bp.sessionId,
          EXPERIMENT_BROWSER_RUN: browserRun.id,
        },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    assert.equal((await once(child, "exit"))[0], 0, "learner browser");
  }
  await writeFile(
    verificationReportPath("invariants").replace(
      /invariants\.json$/,
      "learner-flow.json",
    ),
    JSON.stringify(
      {
        syntheticOnly: true,
        protocol: "SBKB_INTEGRATION_V1",
        normalPublication: false,
        checks: [
          "start prerequisite/idempotency/late participant/fixed version",
          "separate Sessions and forbidden researcher access",
          "seed/provenance/replay/Undo/Redo",
          "KB mismatch/current match/position signature/structural invalidation/server submit",
          "integration merge/release/manual and automatic submit/explicit Next/completion",
          "legacy regression is separate full suite",
        ],
        maps,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Experiment learner API flow: PASS (isolated mock preview only)");
} finally {
  server.kill();
  await once(server, "exit").catch(() => undefined);
  await pool.end();
}
