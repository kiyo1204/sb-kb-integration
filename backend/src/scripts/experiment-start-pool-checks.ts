// TEST ONLY: production start route/authentication with real disposable PostgreSQL.
import assert from "node:assert/strict";
import express from "express";
import {Pool} from "pg";
import {randomUUID} from "node:crypto";
import {accessControl} from "../access-control.js";
import {registerExperimentExecutionRoutes} from "../experiment-execution.js";
import {verifyMockTestUrl} from "./mock-db.js";
export async function checkStartPool(base:string, version:string) {
  await verifyMockTestUrl(process.env.DATABASE_URL!);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:1000});
  let mode="normal";
  const queryPool=pool.query.bind(pool);
  pool.query=((...args:unknown[])=>{
    if(mode==="audit-fault" && typeof args[0]==="string" && args[0].includes("INSERT INTO experiment_start_audit"))return queryPool("SELECT test_only_start_private_fault");
    return Reflect.apply(queryPool,pool,args);
  }) as typeof pool.query;
  const connect=pool.connect.bind(pool);
  pool.connect=((callback?:Parameters<Pool["connect"]>[0])=>{
    if(typeof callback==="function")return connect(callback);
    return (async()=>{
      const c=await connect(),query=c.query.bind(c),release=c.release.bind(c);
      c.query=(async(...args:unknown[])=>{
        const sql=args[0];
        if(typeof sql==="string" && ((mode==="write-fault" && sql.startsWith("INSERT INTO experiment_start_receipts")) || (mode==="audit-fault" && sql.includes("INSERT INTO experiment_start_audit"))))
          return query("SELECT test_only_start_private_fault");
        return Reflect.apply(query,c,args);
      }) as typeof c.query;
      c.release=((...args:unknown[])=>{c.query=query;return Reflect.apply(release,c,args);}) as typeof c.release;
      return c;
    })();
  }) as typeof pool.connect;
  const app=express();app.use(express.json());app.use("/api",accessControl(pool));registerExperimentExecutionRoutes(app,pool);
  const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const token=process.env.RESEARCHER_API_TOKEN!;
  const start=(id:string,key=randomUUID(),auth=token)=>fetch(`http://127.0.0.1:${address.port}/api/research/experiment-runs/${id}/start`,{method:"POST",headers:{Authorization:"Bearer "+auth,"Content-Type":"application/json","Idempotency-Key":key},body:"{}",signal:AbortSignal.timeout(12000)});
  const create=async(path:string,body:unknown)=>{
    const r=await fetch(base+"/api"+path,{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json","Idempotency-Key":randomUUID()},body:JSON.stringify(body)});
    assert.equal(r.status,201);return r.json();
  };
  const make=async(participant=true)=>{
    const r=await create("/research/experiment-runs",{name:"TEST ONLY start pool",catalogVersionId:version,plannedParticipants:0});
    if(participant)await create(`/research/experiment-runs/${r.id}/participants`,{participantLabel:"TEST ONLY start participant"});
    return r.id as string;
  };
  try {
    const empty=await make(false),eligible=await make();
    assert.equal((await start(eligible,randomUUID(),"invalid-test-only")).status,401);
    for(const [fault,status,code,id] of [["normal",404,"not_found",randomUUID()],["normal",409,"participants_required",empty],["write-fault",503,"start_unavailable",eligible],["audit-fault",503,"start_unavailable",eligible]] as const){
      mode=fault;
      const replies=await Promise.all(Array.from({length:4},()=>start(id)));
      for(const reply of replies){
        assert.equal(reply.status,status,fault+" HTTP");const text=await reply.text();assert.equal(JSON.parse(text).error,code);
        assert.ok(!text.includes("test_only_start_private_fault")&&!text.includes(token));
        assert.equal(reply.headers.get("X-Experiment-Start-Audit-Saved"),String(fault!=="audit-fault"));
      }
      mode="normal";
      if(fault!=="audit-fault"){
        const rows=(await pool.query("SELECT http_status,outcome,reason_code FROM experiment_start_audit WHERE run_id=$1 ORDER BY server_timestamp DESC LIMIT 4",[id])).rows;
        assert.equal(rows.length,4);for(const r of rows){assert.equal(r.http_status,status);assert.equal(r.reason_code,code);assert.equal(r.outcome,status>=500?"FAILURE":"REJECTED");}
      }
      if(id===eligible){assert.equal((await pool.query("SELECT state FROM experiment_runs WHERE id=$1",[id])).rows[0].state,"PREPARING");assert.equal((await pool.query("SELECT count(*)::int n FROM experiment_start_receipts WHERE run_id=$1",[id])).rows[0].n,0);}
      const normal=await make(),key=randomUUID();
      const ok=await Promise.all(Array.from({length:4},()=>start(normal,key)));
      for(const r of ok)assert.equal(r.status,200);
      assert.equal((await pool.query("SELECT count(*)::int n FROM experiment_start_receipts WHERE run_id=$1",[normal])).rows[0].n,1);
      assert.equal((await pool.query("SELECT count(*)::int n FROM experiment_start_audit WHERE run_id=$1 AND outcome='SUCCESS'",[normal])).rows[0].n,1);
      assert.equal((await start(normal)).status,409);
    }
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await pool.end();}
}
