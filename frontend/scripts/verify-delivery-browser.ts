import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createServer } from "vite";
const server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const origin = server.resolvedUrls!.local[0],
  profile = await mkdtemp(join(tmpdir(), "stage1-issue8-browser-"));
const session = "11111111-1111-4111-8111-111111111111",
  stage = "22222222-2222-4222-8222-222222222222";
const event = {
  schemaVersion: 1,
  eventType: "VIDEO_PLAY",
  targetType: "VIDEO",
  stageId: stage,
  outcome: "SUCCESS",
  clientTimeQuality: "OBSERVED",
  clientTimestamp: new Date().toISOString(),
};
const receipts = new Map<
    string,
    { eventId: string; sequenceNumber: string; logSaved: boolean }
  >(),
  orders: number[] = [],
  reports: Record<string, unknown>[] = [];
let mode = "offline",
  context: BrowserContext | undefined,
  page: Page;
async function open() {
  context = await chromium.launchPersistentContext(profile, {
    channel: process.env.BROWSER_CHANNEL ?? "msedge",
    headless: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined });
  });
  page = await context.newPage();
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me")
      return route.fulfill({ json: { role: "learner", sessionId: session } });
    if (path.endsWith("/delivery-status")) {
      reports.push(route.request().postDataJSON());
      return route.fulfill({ json: { reportSaved: true } });
    }
    if (path.endsWith("/events")) {
      if (mode === "offline") return route.abort("internetdisconnected");
      const headers = route.request().headers(),
        id = headers["idempotency-key"];
      let ack = receipts.get(id);
      if (!ack) {
        ack = {
          eventId: crypto.randomUUID(),
          sequenceNumber: String(receipts.size + 1),
          logSaved: true,
        };
        receipts.set(id, ack);
        orders.push(Number(headers["x-client-sequence"]));
      }
      if (mode === "acklost") {
        mode = "online";
        return route.abort("connectionreset");
      }
      return route.fulfill({ status: 201, json: ack });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(origin);
  await page.evaluate(
    '(async()=>{window.outbox = await import("/src/observation-outbox.ts"); window.operations = await import("/src/operation-client.ts")})()',
  );
}
const state = () =>
  page.evaluate('window.outbox.queueStatus("' + session + '")');
const flush = () =>
  page.evaluate('window.outbox.flush("' + session + '",(p,i)=>fetch(p,i))');
const enqueue = (e = event) =>
  page.evaluate(
    async (args) => {
      return await (window as any).outbox.enqueue(args.session, args.e);
    },
    { session, e },
  );
try {
  await open();
  await enqueue();
  await enqueue({ ...event, eventType: "VIDEO_PAUSE" });
  assert.equal((await state()).pending, 2);
  assert.equal(await flush(), false);
  assert.equal((await state()).pending, 2);
  await context!.close();
  await open();
  assert.equal(
    (await state()).pending,
    2,
    "IndexedDB survives a real browser process restart",
  );
  mode = "acklost";
  assert.equal(await flush(), false);
  assert.equal(receipts.size, 1);
  assert.equal((await state()).pending, 2);
  await page.reload();
  await page.evaluate(
    '(async()=>{window.outbox = await import("/src/observation-outbox.ts"); window.operations = await import("/src/operation-client.ts")})()',
  );
  assert.equal(await flush(), true);
  assert.equal((await state()).pending, 0);
  assert.equal(receipts.size, 2);
  assert.deepEqual(orders, [1, 2]);
  assert.equal((await state()).acknowledged, 2);
  assert.ok(
    reports.some((r) => r.lastResponse === "SENDING" && Number(r.retrying) > 0),
  );
  // Only the strict observation allowlist enters IndexedDB, never Map, answers or credentials.
  for (const invalid of [
    { ...event, token: "secret" },
    { ...event, details: { answer: "private" } },
    { ...event, schemaVersion: 2 },
    { ...event, schemaVersion: 3 },
    { ...event, schemaVersion: 4 },
  ])
    assert.equal(
      await page.evaluate(
        (e) => (window as any).outbox.allowedObservation(e),
        invalid,
      ),
      false,
    );
  await page.evaluate(
    async (args) => {
      for (let i = 0; i < 505; i++)
        await (window as any).outbox.enqueue(args.session, args.event);
    },
    { session, event },
  );
  let s = await state();
  assert.equal(s.pending, 500);
  assert.equal(s.lost, 5);
  await page.evaluate(async (id) => {
    await (window as any).outbox.changeState(id, (s: any) => {
      s.items.forEach((i: any) => (i.created = Date.now() - 8 * 86400000));
    });
  }, session);
  await enqueue();
  s = await state();
  assert.equal(s.pending, 1);
  assert.equal(s.lost, 505);
  await page.evaluate(
    async (args) => {
      const m = (window as any).outbox;
      m.limits.bytes = 800;
      for (let i = 0; i < 8; i++) await m.enqueue(args.session, args.event);
      m.limits.bytes = 1000000;
    },
    { session, event },
  );
  s = await state();
  assert.ok(s.lost > 505);
  assert.ok(s.pending < 9);
  await flush();
  assert.ok(
    reports.some(
      (r) => Number(r.capacityLost) > 5 && Number(r.expiredLost) === 500,
    ),
  );
  // Operation requests keep only a digest and stable key across unknown responses and reload.
  const retry = await page.evaluate(async () => {
    const keys: string[] = [];
    let calls = 0;
    await (window as any).operations.reliableFetch(
      "/api/maps/dummy/concepts",
      { method: "POST", body: JSON.stringify({ label: "private text" }) },
      async (_p: unknown, i: RequestInit) => {
        keys.push(new Headers(i.headers).get("Idempotency-Key")!);
        if (!calls++) throw new TypeError("lost response");
        return Response.json({ saved: true });
      },
    );
    return keys;
  });
  assert.equal(retry.length, 2);
  assert.equal(retry[0], retry[1]);
  const concurrentKeys = await page.evaluate(async () =>
    Promise.all(
      Array.from({ length: 8 }, () =>
        (window as any).operations.operationKey("a".repeat(64)),
      ),
    ),
  );
  assert.equal(new Set(concurrentKeys).size, 1);
  const unknown = await page.evaluate(async () => {
    let key = "";
    try {
      await (window as any).operations.reliableFetch(
        "/api/maps/dummy/concepts",
        { method: "POST", body: JSON.stringify({ label: "private text" }) },
        async (_p: unknown, i: RequestInit) => {
          key = new Headers(i.headers).get("Idempotency-Key")!;
          throw new TypeError("timeout");
        },
      );
    } catch {}
    const ledger = await new Promise((resolve) => {
      const r = indexedDB.open("stage1-operation-keys", 1);
      r.onsuccess = () => {
        const db = r.result,
          q = db.transaction("keys").objectStore("keys").getAll();
        q.onsuccess = () => {
          resolve(JSON.stringify(q.result));
          db.close();
        };
      };
    });
    return { key, ledger: String(ledger) };
  });
  assert.ok(!unknown.ledger?.includes("private text"));
  assert.ok(!unknown.ledger?.includes("label"));
  await context!.close();
  await open();
  const recoveredKey = await page.evaluate(async () => {
    let key = "";
    await (window as any).operations.reliableFetch(
      "/api/maps/dummy/concepts",
      { method: "POST", body: JSON.stringify({ label: "private text" }) },
      async (_p: unknown, i: RequestInit) => {
        key = new Headers(i.headers).get("Idempotency-Key")!;
        return Response.json({ saved: true });
      },
    );
    return key;
  });
  assert.equal(recoveredKey, unknown.key);
  // Storage failure is observable, reported numerically, and never converted to successful ACK.
  await page.evaluate(
    async (args) => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function () {
        throw new DOMException("full", "QuotaExceededError");
      };
      try {
        await (window as any).outbox.enqueue(args.session, args.event);
      } catch {}
      IDBDatabase.prototype.transaction = original;
    },
    { session, event },
  );
  await flush();
  assert.ok(reports.some((r) => r.storageLost === 1));
  const stored = await page.evaluate(
    async (id) =>
      JSON.stringify(
        await (window as any).outbox.changeState(id, (s: any) => s),
      ),
    session,
  );
  assert.ok(!stored.includes("private text"));
  assert.ok(!stored.includes("token"));
  await page.reload();
  await page.evaluate(
    '(async()=>{window.outbox = await import("/src/observation-outbox.ts"); window.operations = await import("/src/operation-client.ts")})()',
  );
  await page.evaluate(async (id) => {
    await (window as any).outbox.changeState(id, (s: any) => {
      s.items = [{ event: { token: "must not be sent" } }];
    });
  }, session);
  assert.equal(await flush(), false);
  assert.ok(
    reports.some((r) => r.lastResponse === "STORAGE" && r.storageLost === 0),
  );
  assert.ok(!JSON.stringify(reports).includes("must not be sent"));
  const keyBoundary = await page.evaluate(async () => {
    const m = (window as any).operations;
    let secretRejected = false,
      boundRejected = false;
    try {
      await m.operationKey("b".repeat(64), "Bearer secret-must-not-persist");
    } catch {
      secretRejected = true;
    }
    for (let i = 0; i < 99; i++)
      await m.operationKey(i.toString(16).padStart(64, "0"));
    try {
      await m.operationKey("c".repeat(64));
    } catch {
      boundRejected = true;
    }
    return { secretRejected, boundRejected };
  });
  assert.deepEqual(keyBoundary, { secretRejected: true, boundRejected: true });
  const purged=await page.evaluate(async ({session,event})=>{
    const m=(window as any).outbox;
    // Reset a dedicated fixture and keep another session untouched.
    const target="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const other="ffffffff-ffff-4fff-8fff-ffffffffffff";
    await m.enqueue(target,event);await m.enqueue(other,event);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(target))),x=>x.toString(16).padStart(2,"0")).join("");
    const drafts=await import("/src/assessment-drafts.ts");
    const deletedDraft=drafts.assessmentDraftKey(target,"stage-a"),otherDraft=drafts.assessmentDraftKey(other,"stage-b");
    localStorage.setItem(deletedDraft,"MOCK draft");localStorage.setItem(otherDraft,"MOCK other draft");localStorage.setItem("stage1-assessment-draft-unknown-stage","MOCK legacy draft");
    Object.defineProperty(crypto,"subtle",{value:undefined,configurable:true}); // HTTP LAN capability
    let ack=0;await m.discardDeletedQueue(hash,async(path:string,init:RequestInit)=>{if(path==="/api/deletion-ack"&&!String(init.body).includes(session))ack++;return new Response('{}',{status:200});});
    const state=await m.queueStatus(other);
    const database=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open("stage1-observation-outbox",1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject();});
    const absent=await new Promise<boolean>(resolve=>{const r=database.transaction("sessions","readonly").objectStore("sessions").get(target);r.onsuccess=()=>resolve(r.result===undefined);});database.close();
    return {absent,other:state.pending,ack,draftRemoved:localStorage.getItem(deletedDraft)===null,otherDraft:localStorage.getItem(otherDraft),legacyKept:localStorage.getItem("stage1-assessment-draft-unknown-stage")!==null};
  },{session,event});
  assert.deepEqual(purged,{absent:true,other:1,ack:1,draftRemoved:true,otherDraft:"MOCK other draft",legacyKept:true});
  const draftAudit=await page.evaluate(async()=>{
    const drafts=await import("/src/assessment-drafts.ts");const identity=await import("/src/client-identity.ts");const m=(window as any).outbox;
    const session="11111111-1111-4111-8111-111111111118",stage="22222222-2222-4222-8222-222222222228";
    localStorage.setItem("stage1-assessment-draft-"+stage,JSON.stringify([{questionId:"mock-question",answer:"MOCK recovered answer"}]));
    const recovered=drafts.recoverAssessmentDraft(session,stage);const migrated=localStorage.getItem("stage1-assessment-draft-"+stage)===null&&!!localStorage.getItem(drafts.assessmentDraftKey(session,stage));
    let unsafeRejected=false;try{drafts.writeAssessmentDraft(session,stage,'[{"answer":"Bearer credential-example-12345678"}]');}catch{unsafeRejected=true;}
    await m.discardDeletedQueue(identity.requestDigest(session),async()=>new Response('{}',{status:200}));
    let resaveBlocked=false;try{drafts.writeAssessmentDraft(session,stage,'MOCK late response');}catch{resaveBlocked=true;}
    return{recovered:!!recovered,migrated,legacyKept:localStorage.getItem("stage1-assessment-draft-"+stage)!==null,quarantined:drafts.quarantinedDraftCount()>=1,unsafeRejected,resaveBlocked,removed:localStorage.getItem(drafts.assessmentDraftKey(session,stage))===null};
  });
  assert.deepEqual(draftAudit,{recovered:false,migrated:false,legacyKept:true,quarantined:true,unsafeRejected:true,resaveBlocked:true,removed:true});
  console.log(
    "Real Edge/IndexedDB: offline, browser restart, lost ACK, ordered retry, count/byte/age bounds, strict payloads, storage loss reporting, operation key persistence: PASS",
  );
} finally {
  await context?.close();
  await server.close();
  assert.ok(
    resolve(profile).startsWith(join(resolve(tmpdir()),"stage1-issue8-browser-")),
  );
  await rm(profile, { recursive: true, force: true });
}
