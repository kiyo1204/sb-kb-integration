// Synthetic real-API fixture only; the DB guard runs before Pool creation.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { Pool } = createRequire(new URL("../../backend/package.json", import.meta.url))("pg");
import { chromium } from "playwright";
import { createServer } from "vite";
import { verifyMockTestUrl } from "../../backend/src/scripts/mock-db.js";
import { createLearnerToken, storeLearnerToken } from "../../backend/src/access-control.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const base=process.env.API_BASE_URL!, credential=createLearnerToken();
assert.ok(base && ["127.0.0.1", "localhost"].includes(new URL(base).hostname), "loopback test API required");
async function api(path:string,method="GET",body?:unknown,token=credential.token) {
 const r=await fetch(base+"/api"+path,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
 assert.ok(r.ok,`API ${method} ${path} failed: ${r.status}`);return r.json();
}
const vite=await createServer({server:{host:"127.0.0.1",port:0}});await vite.listen();
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL??"msedge",headless:true});
try {
 const client=await pool.connect();let sid:string;
 try {await client.query("BEGIN");sid=(await client.query("INSERT INTO sessions(protocol_key,participant_code,lesson_video_url,research_kit_definition_id) VALUES('STAGE1_4',$1,'/synthetic.mp4','66666666-6666-4666-8666-666666666662') RETURNING id",['MOCK-LINK-'+randomUUID()])).rows[0].id;
 for(const [i,type]of ['LESSON','PRIOR_MAP','KB_MAP','INTEGRATION_MAP'].entries())await client.query("INSERT INTO session_stages(session_id,stage_type,order_index) VALUES($1,$2,$3)",[sid,type,i]);
 await storeLearnerToken(client,sid,credential.hash);await client.query("COMMIT");}finally{client.release();}
 const flow=await api(`/sessions/${sid!}/flow`);const stage=(t:string)=>flow.stages.find((x:{stageType:string})=>x.stageType===t).id;
 await api(`/sessions/${sid!}/start`,'POST',{});await api(`/session-stages/${stage('LESSON')}/start`,'POST',{});await api(`/session-stages/${stage('LESSON')}/complete`,'POST',{});await api(`/session-stages/${stage('PRIOR_MAP')}/start`,'POST',{});
 const map=await api(`/session-stages/${stage('PRIOR_MAP')}/prior-map`,'POST');
 const nodes=[];for(const [label,x,y]of [['MOCK A',100,100],['MOCK B',550,100],['MOCK C',550,400]] as const)nodes.push(await api(`/maps/${map.id}/concepts`,'POST',{label,positionX:x,positionY:y}));
 for(let i=0;i<20;i++)await api(`/maps/${map.id}/concepts`,'POST',{label:`MOCK extra ${i}`,positionX:1000+i*30,positionY:650});
 const link=await api(`/maps/${map.id}/links`,'POST',{sourceConceptId:nodes[0].id,targetConceptId:nodes[1].id,label:'MOCK relation'});
 await api(`/links/${link.id}/position`,'PATCH',{labelPositionX:320,labelPositionY:220});
 const other=await api(`/maps/${map.id}/links`,'POST',{sourceConceptId:nodes[1].id,targetConceptId:nodes[2].id,label:'MOCK other'});
 await api(`/links/${other.id}/position`,'PATCH',{labelPositionX:700,labelPositionY:250});
 for(let i=0;i<15;i++){const extra=await api(`/maps/${map.id}/links`,'POST',{sourceConceptId:nodes[0].id,targetConceptId:nodes[1].id,label:`MOCK parallel ${i}`});await api(`/links/${extra.id}/position`,'PATCH',{labelPositionX:800+i*20,labelPositionY:40+i*3});}
 const page=await browser.newPage({viewport:{width:1500,height:1100}});await page.addInitScript(t=>sessionStorage.setItem('stage1-access-token',t),credential.token);
 let delayed=false;
 await page.route('**/api/**',async route=>{if(delayed&&route.request().method()==='PATCH')await new Promise(r=>setTimeout(r,180));const u=new URL(route.request().url());const response=await route.fetch({url:base+u.pathname+u.search});await route.fulfill({response});});
 const open=async()=>{await page.goto(vite.resolvedUrls!.local[0]!+`maps/${map.id}`);await page.locator(`[data-connector-id="${link.id}"]`).waitFor();await page.waitForFunction(()=>!document.querySelector(".link-connector-handle")?.hasAttribute("disabled"));await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));};await open();
 const connector=page.locator(`[data-connector-id="${link.id}"]`), label=connector.locator('.link-connector-label');
 const hit=page.locator(`.concept-edge-hit-target[aria-label^="Link ${link.id}:"]`);
 async function selectLine() {await page.locator(`[data-connector-id="${other.id}"] .link-connector-label`).click();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));assert.equal(await hit.getAttribute('aria-pressed'),'false');const p=await hit.locator('..').evaluate((group,id)=>{for(const el of group.querySelectorAll<SVGPathElement>('.concept-edge-path'))for(const fraction of [0.2,0.4,0.6,0.8]){const q=el.getPointAtLength(el.getTotalLength()*fraction),m=el.getScreenCTM()!,p={x:m.a*q.x+m.c*q.y+m.e,y:m.b*q.x+m.d*q.y+m.f};const top=document.elementFromPoint(p.x,p.y);if(top?.getAttribute('aria-label')?.startsWith(`Link ${id}:`))return p;}return null;},link.id);assert.ok(p,'a visible, unoccluded link segment must be selectable');await page.mouse.click(p.x,p.y);await page.waitForFunction(id=>document.querySelector(`.concept-edge-hit-target[aria-label^=\"Link ${id}:\"]`)?.getAttribute('aria-pressed')==='true',link.id);}
 async function drag(dx:number,dy:number,status=200){const b=await label.boundingBox();assert.ok(b);const response=page.waitForResponse(r=>r.url().endsWith(`/links/${link.id}/position`)&&r.request().method()==='PATCH');await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:10});await page.mouse.up();assert.equal((await response).status(),status);if(status===200)await page.getByText('リンクの位置を保存しました。',{exact:true}).waitFor();}
 for(let i=0;i<3;i++){await selectLine();delayed=i===1;await drag(20,15);await open();const saved=(await api(`/maps/${map.id}`)).links.find((x:{id:string})=>x.id===link.id);assert.equal(await connector.evaluate(e=>(e as HTMLElement).style.left),`${saved.labelPositionX}px`);await selectLine();}
 delayed=false;
 const beforeFailure=(await api(`/maps/${map.id}`)).links.find((x:{id:string})=>x.id===link.id);
 await pool.query(`CREATE FUNCTION mock_link_position_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${link.id}'::uuid THEN RAISE EXCEPTION 'synthetic position failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER mock_link_position_fail BEFORE UPDATE ON links FOR EACH ROW EXECUTE FUNCTION mock_link_position_fail()`);
 try {await drag(35,20,500);await page.waitForFunction(({id,x})=>document.querySelector(`[data-connector-id=\"${id}\"]`)?.getAttribute('style')?.includes(`left: ${x}px`),{id:link.id,x:beforeFailure.labelPositionX});assert.equal((await api(`/maps/${map.id}`)).links.find((x:{id:string})=>x.id===link.id).labelPositionX,beforeFailure.labelPositionX);}finally{await pool.query('DROP TRIGGER mock_link_position_fail ON links; DROP FUNCTION mock_link_position_fail()');}
 await open();
 // Endpoint reconnection is a real mouse drag, preserving direction.
 const handle=connector.locator('.is-target'), target=page.locator(`[data-concept-id="${nodes[2].id}"]`);const h=await handle.boundingBox(),t=await target.boundingBox();assert.ok(h&&t);const reconnected=page.waitForResponse(r=>r.url().endsWith(`/links/${link.id}/reconnect`)&&r.request().method()==='PATCH');await page.mouse.move(h.x+h.width/2,h.y+h.height/2);await page.mouse.down();await page.mouse.move(t.x+t.width/2,t.y+t.height/2,{steps:12});await page.mouse.up();assert.equal((await reconnected).status(),200);
 await open();assert.equal((await api(`/maps/${map.id}`)).links.find((x:{id:string})=>x.id===link.id).targetConceptId,nodes[2].id);await selectLine();
 for(const action of ['UNDO','REDO']){const state=await api(`/maps/${map.id}/undo-redo`);await api(`/maps/${map.id}/undo-redo`,'POST',{action,expectedSequenceNumber:state.sequenceNumber,idempotencyKey:randomUUID(),clientTimestamp:new Date().toISOString()});await open();await selectLine();}
 await page.locator(`[data-connector-id="${other.id}"] .link-connector-label`).click();
 const rim=await connector.evaluate(el=>{const b=el.getBoundingClientRect();for(const y of [b.top+0.5,b.bottom-0.5])for(const x of [b.x+b.width/2,b.x+b.width/3])if(document.elementFromPoint(x,y)===el)return{x,y};return null;});assert.ok(rim);await page.mouse.click(rim.x,rim.y);await page.waitForFunction(id=>document.querySelector(`.concept-edge-hit-target[aria-label^=\"Link ${id}:\"]`)?.getAttribute('aria-pressed')==='true',link.id);
 await page.locator('.concept-canvas').evaluate(el=>{(el as HTMLElement).style.transform='scale(0.8)';(el as HTMLElement).style.transformOrigin='top left';});await selectLine();
 await page.locator('.concept-canvas-viewport').evaluate(el=>{el.scrollLeft=50;el.scrollTop=20;});await selectLine();await open();
 const replay=await api(`/research/sessions/${sid!}/maps/${map.id}/mixed-history`,'GET',undefined,process.env.RESEARCHER_API_TOKEN!);assert.equal(replay.status,'REPLAYABLE');
 const current=await api(`/maps/${map.id}`);assert.deepEqual(replay.state.links.map((x:{id:string})=>x.id).sort(),current.links.map((x:{id:string})=>x.id).sort());
 const shape=(xs:Array<{id:string;sourceConceptId:string;targetConceptId:string;label:string;labelPositionX?:number|null;labelPositionY?:number|null}>)=>xs.map(x=>[x.id,x.sourceConceptId,x.targetConceptId,x.label,x.labelPositionX??null,x.labelPositionY??null]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 assert.deepEqual(shape(replay.state.links),shape(current.links));
 assert.ok((await pool.query("SELECT 1 FROM research_events WHERE map_id=$1 AND event_type='MOVE_LINK' AND outcome='FAILURE'",[map.id])).rowCount);
 const db=(await pool.query('SELECT target_concept_id,label_position_x,label_position_y FROM links WHERE id=$1',[link.id])).rows[0];const saved=current.links.find((x:{id:string})=>x.id===link.id);assert.equal(db.target_concept_id,saved.targetConceptId);assert.equal(db.label_position_x,saved.labelPositionX);assert.equal(db.label_position_y,saved.labelPositionY);
 // Existing composite fixture imports Kit parts through the real API. Check
 // the imported link in its researcher view as well (submitted maps stay locked).
 const imported=(await pool.query("SELECT l.id,m.id AS map_id FROM links l JOIN link_provenance p ON p.target_link_id=l.id JOIN maps m ON m.id=l.map_id WHERE p.relation_type='IMPORTED_FROM' AND m.type='INTEGRATION' AND m.status='SUBMITTED' LIMIT 1")).rows[0];
 assert.ok(imported,'run five-flow-composite before this browser regression');
 const kitPage=await browser.newPage({viewport:{width:1500,height:1100}});await kitPage.addInitScript(t=>sessionStorage.setItem('stage1-access-token',t),process.env.RESEARCHER_API_TOKEN!);
 await kitPage.route('**/api/**',async route=>{const u=new URL(route.request().url());await route.fulfill({response:await route.fetch({url:base+u.pathname+u.search})});});
 await kitPage.goto(vite.resolvedUrls!.local[0]!+`maps/${imported.map_id}`);
 const importedLabel=kitPage.locator(`[data-connector-id="${imported.id}"] .link-connector-label`);await importedLabel.click();
 await kitPage.waitForFunction(id=>document.querySelector(`.concept-edge-hit-target[aria-label^="Link ${id}:"]`)?.getAttribute('aria-pressed')==='true',imported.id);
 await kitPage.close();
 console.log('Real API mouse link selection, repeated/delayed label moves, reconnect, reload, Undo/Redo and DB/replay: PASS');
} finally {await browser.close();await vite.close();await pool.end();}
