import assert from "node:assert/strict";
import express from "express";
import type { Pool } from "pg";
import { registerAudit } from "../server-audit.js";
const app=express();
app.use((_req,res,next)=>{res.locals.principal={role:"researcher"};next();});
const failingPool={query:async()=>{throw new Error("private-database-error");}} as unknown as Pool;
registerAudit(app,failingPool);
let mutations=0;
app.post("/api/research/stage1/sessions/:sessionId/learner-token",(_req,res)=>{mutations++;res.json({saved:true});});
app.delete("/api/concepts/:conceptId",(_req,res)=>{mutations++;res.json({saved:true});});
const server=app.listen(0,"127.0.0.1");
await new Promise<void>(resolve=>server.once("listening",resolve));
try {
 const address=server.address();assert.ok(address&&typeof address!=="string");
 for(const [path,method] of [
  ["/api/research/stage1/sessions/11111111-1111-4111-8111-111111111111/learner-token","POST"],
  ["/api/concepts/22222222-2222-4222-8222-222222222222","DELETE"],
 ]){
  const response: Awaited<ReturnType<typeof fetch>> = await fetch("http://127.0.0.1:"+address.port+path,{method});
  assert.equal(response.status,503);
  assert.equal(response.headers.get("x-research-event-saved"),"false");
  const body=await response.text();
  assert.ok(!body.includes("private-database-error"));
 }
 assert.equal(mutations,0);
 console.log("Audit target resolution failure blocks mutation handlers: OK");
}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}

