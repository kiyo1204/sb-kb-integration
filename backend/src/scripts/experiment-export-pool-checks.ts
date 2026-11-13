// TEST ONLY: real disposable PostgreSQL connections, bounded pool and HTTP.
import assert from "node:assert/strict";
import express from "express";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { accessControl } from "../access-control.js";
import { registerExperimentResearchRoutes } from "../experiment-research.js";
import { verifyMockTestUrl } from "./mock-db.js";
export async function checkExportPool(runId: string, foreignSession: string) {
  await verifyMockTestUrl(process.env.DATABASE_URL!);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:300});
  const connect=pool.connect.bind(pool);
  let mode="normal";
  pool.connect=((callback?: Parameters<Pool["connect"]>[0])=>{
    if(typeof callback==="function")return connect(callback);
    return (async()=>{
    const client=await connect();const query=client.query.bind(client);
    client.query=((...args:unknown[])=>{
      const sql=args[0];
      if(typeof sql==="string"&&sql.startsWith("SELECT session_id FROM experiment_run_sessions")&&mode==="foreign")
        return query('SELECT $1::uuid AS session_id',[foreignSession]);
      if(typeof sql==="string"&&sql.startsWith("SELECT id,state,")&&mode==="sql-fault")
        return query('SELECT test_only_missing_column FROM experiment_runs');
      return Reflect.apply(query,client,args);
    }) as typeof client.query;
    const release=client.release.bind(client);
    client.release=((...args:unknown[])=>{client.query=query;return Reflect.apply(release,client,args);}) as typeof client.release;
    return client;
    })();
  }) as typeof pool.connect;
  const app=express();app.use("/api",accessControl(pool));registerExperimentResearchRoutes(app,pool);
  const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const request=(id:string)=>fetch(`http://127.0.0.1:${address.port}/api/research/experiment-runs/${id}/research.json`,{headers:{Authorization:"Bearer "+process.env.RESEARCHER_API_TOKEN},signal:AbortSignal.timeout(10000)});
  try {
    for(const [testMode,status,code,id] of [["normal",404,"not_found",randomUUID()],["foreign",409,"research_data_inconsistent",runId],["sql-fault",503,"research_unavailable",runId]] as const){
      mode=testMode;
      const responses=await Promise.all(Array.from({length:4},()=>request(id)));
      for(const response of responses){assert.equal(response.status,status,testMode+" HTTP");const body=await response.text();assert.equal(JSON.parse(body).error,code);assert.ok(!body.includes("test_only_missing_column"));}
      mode="normal";
      const audit=await pool.query("SELECT http_status,outcome,reason,reason_code FROM experiment_run_audit WHERE target_id=$1 ORDER BY server_timestamp DESC LIMIT 4",[id]);
      assert.equal(audit.rows.length,4);
      for(const row of audit.rows){assert.equal(row.http_status,status);assert.equal(row.reason_code,code);assert.equal(row.outcome,status===503?"FAILURE":"REJECTED");}
      assert.equal((await request(runId)).status,200,"subsequent normal request completes");
    }
    for(const id of [runId,runId.toUpperCase(),runId.split("").map((c,i)=>i%2?c.toUpperCase():c).join("")]) {
      const response=await request(id);assert.equal(response.status,200);assert.equal((await response.json()).run.id,runId);
    }
  } finally {await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));await pool.end();}
}
