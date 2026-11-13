import {checkExportPool} from "./experiment-export-pool-checks.js";
// TEST ONLY: called by the real learner-flow fixture in a fresh guarded mock DB.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { parse } from "csv-parse/sync";
import { integrationResearchStates } from "../experiment-research-states.js";
import type { SessionRawExport } from "../research-export.js";
import { extractionQuery } from "../event-export-query.js";
/** Compare actual bulk CSV with JSON and DB at stable points in the synthetic flow. */
export async function checkMapStateCsv(input: {
  pool: Pool; base: string; token: string; runId: string; sessionId: string;
}) {
  const {pool, base, token, runId, sessionId} = input;
  const get = async (suffix: string) => {
    const response = await fetch(`${base}/api/research/experiment-runs/${runId}/research.${suffix}`, {
      headers: {Authorization: `Bearer ${token}`},
    });
    assert.equal(response.status, 200);
    return response;
  };
  const json = await (await get("json")).json();
  const raw: SessionRawExport = json.sessions.find((s: SessionRawExport) => s.session.id === sessionId);
  assert.ok(raw);
  const csv = await (await get("csv")).text();
  const columns = parse(csv, {bom:true})[0];
  assert.deepEqual(columns, ["outputContract","protocolKey","runId","materialVersionId","sessionId","pseudonym","sessionStatus","exportedAt","mapId","mapType","point","status","reason","recordedAt","submissionEventId","state","mapStatus","mapSubmittedAt"]);
  const rows = (parse(csv, {columns:true,bom:true}) as Record<string,string>[]).filter(r=>r.sessionId === sessionId);
  assert.ok(rows.length);
  const db = (await pool.query("SELECT m.id,m.status,m.submitted_at FROM maps m JOIN session_stages st ON st.id=m.session_stage_id WHERE st.session_id=$1", [sessionId])).rows;
  for (const row of rows) {
    const map = raw.maps.find(m=>m.id === row.mapId);
    const saved = db.find(m=>m.id === row.mapId);
    assert.equal(row.mapStatus, map?.status ?? "");
    assert.equal(row.mapSubmittedAt, map?.submittedAt ?? "");
    assert.equal(row.mapStatus, saved?.status ?? "");
    assert.equal(row.mapSubmittedAt, saved?.submitted_at?.toISOString() ?? "");
    if (row.mapStatus === "DRAFT") assert.equal(row.mapSubmittedAt, "");
    if (row.mapStatus === "SUBMITTED") assert.ok(row.mapSubmittedAt.endsWith("Z"));
    if (row.point === "SAVED_AT_READ" && map) assert.equal(row.status, "AVAILABLE");
    if (row.point !== "SAVED_AT_READ") {
      const point = row.point === "INTEGRATION_START" ? raw.integrationStates!.start : raw.integrationStates!.submission;
      assert.equal(row.status, point.status);
      assert.equal(row.reason, point.reason ?? "");
      if (!point.state) assert.equal(row.state, "");
    }
    if (row.point === "ACCEPTED_SUBMISSION" && map?.status !== "SUBMITTED") {
      assert.equal(row.status, "UNAVAILABLE");
      assert.equal(row.reason, "NOT_SUBMITTED");
      assert.equal(row.state, "");
    }
    if (row.point === "INTEGRATION_START" && !map) {
      assert.equal(row.reason, "INTEGRATION_MAP_MISSING");
      assert.equal(row.state, "");
    }
  }
}
export async function checkExperimentResearch(input: {
  pool: Pool;
  base: string;
  token: string;
  learner: string;
  runId: string;
  versionId: string;
  sessionIds: string[];
}) {
  const { pool, base, token, learner, runId, versionId, sessionIds } = input;
  async function get(path: string, status = 200, auth = token) {
    const r = await fetch(base + "/api" + path, {
      headers: { Authorization: "Bearer " + auth },
    });
    assert.equal(r.status, status, path);
    return r;
  }
  const sessionPath = (id: string) => `/research/stage1/sessions/${id}`;
  const ordinary = async () =>
    (
      await pool.query(
        "SELECT (SELECT count(*) FROM sessions)::int sessions,(SELECT count(*) FROM maps)::int maps,(SELECT count(*) FROM research_events WHERE actor_type='LEARNER')::int learner_events",
      )
    ).rows[0];
  const before = await ordinary();
  // R05 has its own live Map/history while ordinary research output is being generated.
  const e = randomUUID();
  const start = await fetch(base + `/api/research/materials/${versionId}/r05`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({ executionId: e }),
  });
  assert.equal(start.status, 200);
  const test = (await start.json()) as { id: string };
  const op = await fetch(
    base + `/api/research/materials/${versionId}/r05/${test.id}/operations`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        executionId: e,
        expectedRevision: 0,
        action: "LESSON_COMPLETE",
        data: { viewed: true },
      }),
    },
  );
  assert.equal(op.status, 200);
  const testMap = (
    await pool.query(
      "SELECT id FROM r05_test_maps WHERE test_run_id=$1 LIMIT 1",
      [test.id],
    )
  ).rows[0].id;
  for (const path of [
    `${sessionPath(sessionIds[0])}/analysis`,
    `${sessionPath(sessionIds[0])}/operations.csv`,
    `${sessionPath(sessionIds[0])}/map-states.csv`,
    `/research/sessions/${sessionIds[0]}/export`,
    `/research/experiment-runs/${runId}/research.json`,
    `/research/experiment-runs/${runId}/research.csv`,
  ]) {
    await get(path, 401, "");
    await get(path, 403, learner);
  }
  const all = await (
    await get(`/research/experiment-runs/${runId}/research.json`)
  ).json();
  assert.equal(all.outputContract, "sbkb-integration-research-v1");
  assert.equal(all.run.registeredSessions, sessionIds.length);
  assert.equal(all.run.plannedParticipants, 1);
  assert.deepEqual(
    all.sessions.map((s: SessionRawExport) => s.session.id).sort(),
    [...sessionIds].sort(),
  );
  const bulkRows = parse(
    await (await get(`/research/experiment-runs/${runId}/research.csv`)).text(),
    { columns: true, bom: true },
  ) as Record<string, string>[];
  for (const id of sessionIds) {
    await checkMapStateCsv({...input, sessionId:id});
    const raw: SessionRawExport = await (
      await get(`/research/sessions/${id}/export`)
    ).json();
    const analysis = await (await get(`${sessionPath(id)}/analysis`)).json();
    assert.equal(raw.exportVersion, 4);
    assert.equal(raw.session.protocolKey, "SBKB_INTEGRATION_V1");
    assert.ok(
      raw.session.participantCode?.startsWith("P-"),
      "existing pseudonym, never participant label/token",
    );
    assert.equal(raw.survey, undefined);
    assert.equal(raw.assessment, undefined);
    assert.equal(raw.experiment?.runId, runId);
    assert.equal(raw.maps.length, 3);
    assert.ok(raw.maps.every(map=>map.status === "SUBMITTED"));
    assert.deepEqual(analysis.integrationStates, raw.integrationStates);
    assert.deepEqual(analysis.features, {});
    assert.equal(analysis.descriptiveFeatures, undefined);
    assert.equal(raw.integrationStates?.start.status, "AVAILABLE");
    assert.equal(raw.integrationStates?.submission.status, "AVAILABLE");
    const submitted = raw.integrationStates!.submission;
    assert.ok(submitted.eventId);
    assert.ok(submitted.state!.concepts.some((c) => c.provenance?.length));
    const m = raw.maps.find((m) => m.type === "INTEGRATION")!;
    const history = await (
      await get(
        `${sessionPath(id)}/maps/${m.id}/history?sequenceNumber=${(m.operationLogs as unknown[]).length}`,
      )
    ).json();
    assert.equal(history.status, "REPLAYABLE");
    assert.deepEqual(history.afterState, submitted.state);
    const ops = parse(
      await (await get(`${sessionPath(id)}/operations.csv`)).text(),
      { columns: true, bom: true },
    ) as Record<string, string>[];
    assert.equal(ops.length, analysis.operations.length);
    assert.deepEqual(
      ops.map((o) => o.id),
      analysis.operations.map((o: { id: string }) => o.id),
    );
    assert.ok(ops.every((o) => o.protocolKey === "SBKB_INTEGRATION_V1"));
    const rows = parse(
      await (await get(`${sessionPath(id)}/map-states.csv`)).text(),
      { columns: true, bom: true },
    ) as Record<string, string>[];
    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.equal(row.pseudonym, raw.session.participantCode);
      assert.equal(row.outputContract, raw.outputContract);
      const source = bulkRows.find(
        (r) =>
          r.sessionId === id && r.point === row.point && r.mapId === row.mapId,
      );
      assert.ok(source);
      assert.deepEqual(JSON.parse(source.state), JSON.parse(row.state));
    }
    assert.deepEqual(
      JSON.parse(rows.find((r) => r.point === "ACCEPTED_SUBMISSION")!.state),
      submitted.state,
    );
    assert.ok(!JSON.stringify(raw).includes(learner));
    const exportResponse = await fetch(base + "/api/research/event-exports", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filters: { sessionIds: [id] } }),
    });
    assert.equal(exportResponse.status, 201);
    const exported = await exportResponse.json();
    const eventJson = await (
      await get(`/research/event-exports/${exported.exportId}/events.json`)
    ).json();
    const eventCsv = parse(
      await (
        await get(`/research/event-exports/${exported.exportId}/events.csv`)
      ).text(),
      { columns: true, bom: true },
    ) as Record<string, string>[];
    assert.equal(eventJson.events.length, eventCsv.length);
    const saved = raw.maps
      .flatMap((m) => m.operationLogs as Array<Record<string, unknown>>)
      .filter((op) => op.historySource === "EVENT");
    for (const op of saved) {
      const event = eventJson.events.find(
        (e: { event_id: string }) => e.event_id === op.eventId,
      );
      assert.ok(
        event,
        "new-protocol saved operation included in common export",
      );
      assert.equal(event.protocol_key, "SBKB_INTEGRATION_V1");
      assert.equal(event.learner_id, raw.session.participantCode);
      assert.equal(event.outcome, op.outcome);
      assert.equal(event.server_timestamp, op.serverTimestamp);
      assert.deepEqual(event.before, op.before);
      assert.deepEqual(event.after, op.after);
      const csv = eventCsv.find((e) => e.event_id === op.eventId)!;
      assert.ok(csv);
      assert.equal(csv.protocol_key, event.protocol_key);
      assert.equal(csv.outcome, event.outcome);
      assert.equal(csv.server_timestamp, event.server_timestamp);
    }
    const released = await fetch(
      base + `/api/research/event-exports/${exported.exportId}`,
      { method: "DELETE", headers: { Authorization: "Bearer " + token } },
    );
    assert.equal(released.status, 200);
    const auditRead = await get(`${sessionPath(id)}/analysis`);
    assert.equal(auditRead.headers.get("x-research-event-saved"), "true");

    const client = await pool.connect();
    try {
      const maps = raw.maps as Parameters<typeof integrationResearchStates>[2];
      const missing = await integrationResearchStates(
        client,
        id,
        maps.map((m) => ({ ...m, initialSnapshot: null })),
      );
      assert.equal(missing.start.state, null);
      assert.equal(missing.submission.state, null);
      const bad = structuredClone(maps);
      bad.find((m) => m.type === "INTEGRATION")!.concepts = [];
      const inconsistent = await integrationResearchStates(client, id, bad);
      assert.equal(inconsistent.submission.reason, "HISTORY_INCONSISTENT");
      assert.equal(inconsistent.submission.state, null);
    } finally {
      client.release();
    }
    await get(`${sessionPath(id)}/features.csv`, 409);
  }
  // TEST ONLY: missing snapshot in the guarded disposable DB, restored even on failure.
  const integrationMapId = all.sessions[0].maps.find((m: {type:string})=>m.type === "INTEGRATION").id;
  const initial = (await pool.query("SELECT * FROM map_initial_snapshots WHERE map_id=$1",[integrationMapId])).rows[0];
  assert.ok(initial);
  try {
    await pool.query("DELETE FROM map_initial_snapshots WHERE map_id=$1",[integrationMapId]);
    await checkMapStateCsv({...input, sessionId:sessionIds[0]!});
    const missingRows = parse(await (await get(`/research/experiment-runs/${runId}/research.csv`)).text(),{columns:true,bom:true}) as Record<string,string>[];
    for (const row of missingRows.filter(r=>r.mapId === integrationMapId && r.point !== "SAVED_AT_READ")) {
      assert.equal(row.mapStatus,"SUBMITTED");
      assert.equal(row.status,"UNAVAILABLE");
      assert.equal(row.reason,"INITIAL_SNAPSHOT_MISSING_OR_INVALID");
      assert.equal(row.state,"");
    }
  } finally {
    await pool.query("INSERT INTO map_initial_snapshots(map_id,snapshot_version,snapshot,captured_at) VALUES($1,$2,$3,$4)",[initial.map_id,initial.snapshot_version,initial.snapshot,initial.captured_at]);
  }
  await get(
    `${sessionPath(sessionIds[0])}/maps/${all.sessions.find((s: SessionRawExport) => s.session.id === sessionIds[1]).maps[0].id}/history?sequenceNumber=0`,
    404,
  );
  const kinds = all.sessions
    .map((s: SessionRawExport) => s.integrationStates?.submission.eventType)
    .sort();
  assert.deepEqual(kinds, ["MAP_AUTO_SUBMIT", "MAP_SUBMIT"]);
  for (const path of [
    `/research/sessions/${test.id}/export`,
    `${sessionPath(test.id)}/analysis`,
    `${sessionPath(test.id)}/map-states.csv`,
    `/research/experiment-runs/${test.id}/research.json`,
  ])
    await get(path, 404);
  assert.ok(!JSON.stringify(all).includes(testMap));
  assert.ok(!JSON.stringify(bulkRows).includes(testMap));
  const query = extractionQuery({
    sessionIds: [test.id],
    learnerIds: [],
    groups: [],
    activities: [],
    eventTypes: [],
    from: null,
    to: null,
  });
  assert.equal((await pool.query(query.text, query.values)).rows.length, 0);
  assert.deepEqual(
    await ordinary(),
    before,
    "no participant data/map/learner event writes from research reads or R05",
  );
  const create=async(path:string,body:unknown)=>{const r=await fetch(base+"/api"+path,{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json","Idempotency-Key":randomUUID()},body:JSON.stringify(body)});assert.equal(r.status,201);return r.json();};
  const otherRun=await create("/research/experiment-runs",{name:"TEST ONLY pool isolation",catalogVersionId:versionId,plannedParticipants:0});
  const other=await create(`/research/experiment-runs/${otherRun.id}/participants`,{participantLabel:"TEST ONLY foreign membership"});
  await checkExportPool(runId,other.sessionId);
  return {
    status: "PASS",
    sessionIds,
    runId,
    testMap,
    manual: true,
    automatic: true,
    authorization: true,
    jsonCsvParity: true,
    r05Excluded: true,
  };
}
