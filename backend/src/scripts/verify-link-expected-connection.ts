// TEST ONLY: guarded disposable PostgreSQL and product API; no normal publication.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { Pool } from "pg";
import { verifyMockTestUrl } from "./mock-db.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const listener = createServer();
await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((r) => listener.close(() => r()));
const base = `http://127.0.0.1:${port}`,
  researcher = process.env.RESEARCHER_API_TOKEN!;
const server = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    API_BIND_ADDRESS: "127.0.0.1",
    STAGE1_EXPERIMENT_LEARNER_PREVIEW: "1",
  },
  stdio: "ignore",
  windowsHide: true,
});
let auth = researcher;
const extra: Record<string, string> = {};
async function call(path: string, body?: unknown, method = "POST") {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + auth,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(r.ok, method + " " + path + " HTTP " + r.status);
  return r.json();
}
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) {
        ready = true;
        break;
      }
    } catch {
      /* startup */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready);
  const goal = await call("/research/goal-maps/import", {
    format: "sb-kb-goal-map",
    schemaVersion: 1,
    goalMap: {
      title: "MOCK expected connection " + randomUUID(),
      concepts: [
        { id: "a", label: "MOCK A", position: { x: 80, y: 100 } },
        { id: "b", label: "MOCK B", position: { x: 650, y: 100 } },
      ],
      links: [
        {
          id: "ab",
          label: "MOCK kit relation",
          sourceId: "a",
          targetId: "b",
          labelPosition: null,
        },
      ],
    },
  });
  const parts = (
    await pool.query(
      "SELECT id,source_concept_id AS source FROM kit_concept_items WHERE kit_definition_id=$1 ORDER BY id",
      [goal.kitDefinitionId],
    )
  ).rows;
  const draft = await call("/research/materials", {});
  const materialSaved = await call(
    `/research/materials/${draft.id}`,
    {
      expectedRevision: draft.editRevision,
      body: {
        title: "MOCK expected material",
        researcherDescription: "",
        videoRef: "/mock-only.mp4",
        sbInstructions: "MOCK SB",
        kbInstructions: "MOCK KB",
        integrationInstructions: "MOCK integration",
        kitId: goal.kitDefinitionId,
        seedConceptItemIds: [parts[0].id],
        integrationSeconds: 1800,
      },
    },
    "PUT",
  );
  const material = await call(`/research/materials/${draft.id}/publish`, {
    expectedRevision: materialSaved.editRevision,
  });
  const run = await call("/research/experiment-runs", {
    name: "MOCK expected connection",
    catalogVersionId: material.id,
    plannedParticipants: 1,
  });
  const p = await call(`/research/experiment-runs/${run.id}/participants`, {
    participantLabel: "MOCK participant",
  });
  await call(`/research/experiment-runs/${run.id}/start`, {});
  auth = p.issuedCode;
  extra["X-Experiment-Client"] = randomBytes(32).toString("base64url");
  const claim = await call("/experiment-client/claim", {});
  extra["X-Experiment-Generation"] = String(claim.deviceGeneration);
  await call(`/sessions/${p.sessionId}/start`, {});
  const flow = await call(`/sessions/${p.sessionId}/flow`, undefined, "GET");
  const stage = (type: string) =>
    flow.stages.find((s: { stageType: string }) => s.stageType === type).id;
  await call(`/session-stages/${stage("LESSON")}/start`, {});
  Object.assign(extra, {
    "X-Experiment-Origin-Client": claim.clientId,
    "X-Experiment-Origin-Generation": String(claim.deviceGeneration),
    "X-Client-Stream-Id": randomUUID(),
    "X-Client-Sequence": "1",
  });
  await call(`/sessions/${p.sessionId}/events`, {
    schemaVersion: 1,
    eventType: "VIDEO_COMPLETE",
    targetType: "VIDEO",
    stageId: stage("LESSON"),
    outcome: "SUCCESS",
    clientTimeQuality: "NOT_APPLICABLE",
  });
  delete extra["X-Client-Stream-Id"];
  delete extra["X-Client-Sequence"];
  await call(`/session-stages/${stage("LESSON")}/complete`, {});
  await call(`/session-stages/${stage("PRIOR_MAP")}/start`, {});
  const sb = await call(`/session-stages/${stage("PRIOR_MAP")}/prior-map`, {});
  const ids: string[] = [];
  for (let i=0;i<4;i++) ids.push((await call(`/maps/${sb.id}/concepts`, {label:"MOCK endpoint",positionX:80+i*220,positionY:600})).id);
  const [a,b,c,d]=ids as [string,string,string,string];
  const link=await call(`/maps/${sb.id}/links`, {sourceConceptId:a,targetConceptId:b,label:"MOCK guarded relation"});
  const connection=(sourceConceptId:string,targetConceptId:string)=>({sourceConceptId,targetConceptId});
  const body=(source:string,target:string,expected?:unknown)=>({...connection(source,target),clientTimestamp:new Date().toISOString(),...(expected===undefined?{}:{expectedConnection:expected})});
  async function patch(payload:unknown,key=randomUUID(),target=link.id) {
    const r=await fetch(base+`/api/links/${target}/reconnect`,{method:"PATCH",headers:{Authorization:"Bearer "+auth,"Content-Type":"application/json","Idempotency-Key":key,...extra},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
    return {status:r.status,data:await r.json(),recorded:r.headers.get("X-Operation-Recorded"),replayed:r.headers.get("X-Operation-Replayed")};
  }
  async function saved() {
    return (await pool.query('SELECT id,source_concept_id AS "sourceConceptId",target_concept_id AS "targetConceptId",label,label_position_x,label_position_y,updated_at FROM links WHERE id=$1',[link.id])).rows[0];
  }
  async function counts() {
    return (await pool.query(`SELECT
      (SELECT count(*)::int FROM research_events WHERE target_id=$1 AND schema_version=5 AND event_type='RECONNECT_LINK' AND outcome='SUCCESS') AS success,
      (SELECT count(*)::int FROM map_operation_logs WHERE target_id=$1 AND operation_type='RECONNECT_LINK') AS legacy,
      (SELECT count(*)::int FROM operation_receipts WHERE principal_scope=$2) AS receipts`,[link.id,"LEARNER:"+p.sessionId])).rows[0];
  }
  const checks: string[]=[];
  const initial=await saved(), successKey=randomUUID(), firstBody=body(b,c,connection(a,b));
  const first=await patch(firstBody,successKey);
  assert.equal(first.status,200); assert.equal(first.data.id,link.id);
  assert.equal(first.recorded,"true"); assert.equal(first.replayed,"false");
  const afterFirst=await saved();
  for (const k of ["id","label","label_position_x","label_position_y"]) assert.deepEqual(afterFirst[k],initial[k]);
  const beforeReplay=await counts();
  const replay=await patch(firstBody,successKey);
  assert.equal(replay.status,200); assert.deepEqual(replay.data,first.data); assert.equal(replay.replayed,"true");
  assert.deepEqual(await counts(),beforeReplay); assert.deepEqual(await saved(),afterFirst);
  // Same key with only the expectation changed is a different request.
  const changed=await patch({...firstBody,expectedConnection:connection(b,c)},successKey);
  assert.equal(changed.status,409); assert.equal(changed.data.error,"idempotency_conflict");
  assert.deepEqual(await counts(),beforeReplay);
  checks.push("matching expectation, same-ID metadata, stale-expectation success replay, changed expectation/key conflict");

  // Reproduce the actual TOCTOU: authenticated GET, legitimate old-client change, stale conditional PATCH.
  const preflight=await call(`/maps/${sb.id}`,undefined,"GET");
  const original=preflight.links.find((l:{id:string})=>l.id===link.id);
  const old=await patch(body(c,d)); assert.equal(old.status,200);
  const beforeConflict=await saved(), beforeCounts=await counts(), staleKey=randomUUID();
  const stale=await patch(body(a,d,connection(original.sourceConceptId,original.targetConceptId)),staleKey);
  assert.equal(stale.status,409); assert.equal(stale.data.error,"link_connection_conflict"); assert.equal(stale.data.operationCommitted,false);
  assert.notEqual(stale.recorded,"true"); assert.equal(stale.data.logSaved,true);
  assert.deepEqual(await saved(),beforeConflict); assert.deepEqual(await counts(),beforeCounts);
  const refusal=(await pool.query("SELECT schema_version,outcome,reason_code FROM research_events WHERE target_id=$1 AND event_type='RECONNECT_LINK' AND idempotency_key=$2",[link.id,staleKey])).rows;
  assert.deepEqual(refusal,[{schema_version:5,outcome:"REJECTED",reason_code:"CONFLICT"}]);
  assert.equal((await pool.query("SELECT 1 FROM operation_receipts WHERE principal_scope=$1 AND operation_key=$2",["LEARNER:"+p.sessionId,staleKey])).rowCount,0);
  // Expectation is checked even when desired endpoints already equal saved endpoints.
  assert.equal((await patch(body(c,d,connection(b,c)))).data.error,"link_connection_conflict");
  checks.push("GET/change/stale PATCH rejected atomically, DB unchanged, zero new success/receipt, v5 refusal audit; omitted old client supported");

  const invalids=[null,[],"invalid",{}, {sourceConceptId:c}, {sourceConceptId:c,targetConceptId:"bad"}];
  for(const expected of invalids){const bad=await patch(body(a,b,expected));assert.equal(bad.status,400);assert.equal(bad.data.error,"invalid_expected_connection");}
  assert.deepEqual(await saved(),beforeConflict);
  const uppercase=await patch(body(a,b,connection(c.toUpperCase(),d.toUpperCase())));assert.equal(uppercase.status,200);
  checks.push("invalid expectation shapes/UUID rejected; UUID case normalized");

  const parallelBody=body(b,c,connection(a,b)), parallelKey=randomUUID(), beforeParallel=await counts();
  const parallel=await Promise.all([patch(parallelBody,parallelKey),patch(parallelBody,parallelKey)]);
  assert.deepEqual(parallel.map(r=>r.status),[200,200]);assert.deepEqual(parallel[0].data,parallel[1].data);
  assert.equal(parallel.filter(r=>r.replayed==="true").length,1);
  const afterParallel=await counts();assert.equal(afterParallel.success-beforeParallel.success,1);assert.equal(afterParallel.receipts-beforeParallel.receipts,1);
  const competingBefore=await counts();
  const competing=await Promise.all([patch(body(c,d,connection(b,c))),patch(body(a,d,connection(b,c)))]);
  assert.deepEqual(competing.map(r=>r.status).sort(),[200,409]);assert.equal(competing.find(r=>r.status===409)!.data.error,"link_connection_conflict");
  const competingAfter=await counts();assert.equal(competingAfter.success-competingBefore.success,1);assert.equal(competingAfter.receipts-competingBefore.receipts,1);
  assert.equal(competingAfter.legacy,0,"v5 operation events are not duplicated in legacy logs");
  checks.push("parallel same-key replay once; distinct-key same-expectation one success/one conflict");

  const gone=await call(`/maps/${sb.id}/links`,{...connection(a,b),label:"MOCK deleted relation"});
  await call(`/links/${gone.id}`,{},"DELETE");
  assert.equal((await patch(body(c,d,connection(a,b)),randomUUID(),gone.id)).status,404);
  assert.equal((await pool.query("SELECT 1 FROM links WHERE id=$1",[gone.id])).rowCount,0);
  checks.push("deleted link cannot be recreated by conditional reconnect");

  // A real approved screen switch invalidates even the old screen's known successful receipt.
  const oldSecret=extra["X-Experiment-Client"], oldGeneration=extra["X-Experiment-Generation"];
  extra["X-Experiment-Client"]=randomBytes(32).toString("base64url");
  const pendingResponse=await fetch(base+"/api/experiment-client/claim",{method:"POST",headers:{Authorization:"Bearer "+auth,"Content-Type":"application/json",...extra},body:"{}"});
  assert.equal(pendingResponse.status,409);const pending=await pendingResponse.json();
  auth=researcher;
  const switched=await call(`/research/experiment-runs/${run.id}/participants/${p.sessionId}/client-switch`,{clientId:pending.clientId,expectedDeviceGeneration:claim.deviceGeneration});
  const newSecret=extra["X-Experiment-Client"];
  auth=p.issuedCode;extra["X-Experiment-Client"]=oldSecret;extra["X-Experiment-Generation"]=oldGeneration;
  const screenBefore=await saved(), screenCounts=await counts();
  const staleScreen=await patch(firstBody,successKey);assert.equal(staleScreen.status,409);assert.notEqual(staleScreen.data.error,"link_connection_conflict");
  assert.deepEqual(await saved(),screenBefore);assert.deepEqual(await counts(),screenCounts);
  extra["X-Experiment-Client"]=newSecret;extra["X-Experiment-Generation"]=String(switched.deviceGeneration);
  extra["X-Experiment-Origin-Client"]=pending.clientId;extra["X-Experiment-Origin-Generation"]=String(switched.deviceGeneration);
  const current=await saved();assert.equal((await patch(body(a,b,connection(current.sourceConceptId,current.targetConceptId)))).status,200);
  auth=researcher;await call(`/research/experiment-runs/${run.id}/end`,{confirmed:true});auth=p.issuedCode;
  const endedBefore=await saved(),endedCounts=await counts();
  const ended=await patch(body(c,d,connection(a,b)));assert.equal(ended.status,409);assert.equal(ended.data.error,"experiment_ended");
  assert.deepEqual(await saved(),endedBefore);assert.deepEqual(await counts(),endedCounts);
  checks.push("approved screen switch rejects stale screen/replay; current screen works; ended run blocks matching expectation");
  console.log("PASS expectedConnection real API: "+checks.join("; "));
} finally {
  if(server.exitCode===null){const stopped=once(server,"exit");server.kill();await stopped;}
  await pool.end();
}
