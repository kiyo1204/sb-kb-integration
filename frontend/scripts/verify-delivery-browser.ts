import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createServer } from "vite";
type Outbox = typeof import("../src/observation-outbox");
type QueueRow = Parameters<Parameters<Outbox["changeState"]>[1]>[0];
declare global {
  interface Window {
    outbox: Outbox;
    oldDeliveryDb: IDBDatabase;
  }
}
const server = await createServer({
  server: { port: 0, host: "127.0.0.1" },
  plugins: [{
    name: "delivery-test-harness",
    resolveId(id) { if (id === "/__delivery_harness") return "\0delivery-harness"; },
    load(id) {
      if (id === "\0delivery-harness")
        return 'import * as react from "react"; import * as dom from "react-dom/client"; export {react,dom};';
    },
  }],
});
await server.listen();
const origin = server.resolvedUrls!.local[0],
  profile = await mkdtemp(join(tmpdir(), "stage1-issue8-browser-"));
const session = "11111111-1111-4111-8111-111111111111",
  stage = "22222222-2222-4222-8222-222222222222";
const holdSession = "33333333-3333-4333-8333-333333333333";
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
const heldRequests: { id: string; order: string; stream: string; generation: string; event: unknown }[] = [];
let identity = session;
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
      return route.fulfill({ json: { role: "learner", sessionId: identity } });
    if (path.endsWith("/delivery-status")) {
      reports.push(route.request().postDataJSON());
      return route.fulfill({ json: { reportSaved: true } });
    }
    if (path.endsWith("/events")) {
      if (path === "/api/sessions/" + holdSession + "/events") {
        const headers = route.request().headers();
        heldRequests.push({
          id: headers["idempotency-key"], order: headers["x-client-sequence"],
          stream: headers["x-client-stream-id"], generation: headers["x-experiment-origin-generation"],
          event: route.request().postDataJSON(),
        });
        return route.fulfill({ status: 409, json: { error: "experiment_origin_stale" } });
      }
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
const state = (id = session) => page.evaluate((id) => window.outbox.queueStatus(id), id);
const flush = (id = session) => page.evaluate((id) => window.outbox.flush(id, fetch), id);
const enqueue = (e = event, id = session) => page.evaluate(
  ({ session, event }) => window.outbox.enqueue(session, event),
  { session: id, event: e },
);
const readHeld = () => page.evaluate(async (id) => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("stage1-observation-outbox");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<QueueRow>((resolve, reject) => {
      const read = db.transaction("sessions").objectStore("sessions").get(id);
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
  } finally { db.close(); }
}, holdSession);
const showStatus = () => page.evaluate(async (sessionId) => {
  const harness = "/__delivery_harness";
  const { react, dom } = await import(harness);
  const modulePath = "/src/DeliveryStatus.tsx";
  const { LearnerDeliveryStatus } = await import(modulePath);
  const target = document.createElement("div");
  target.id = "delivery-test";
  document.body.append(target);
  dom.createRoot(target).render(react.createElement(LearnerDeliveryStatus, { sessionId }));
}, holdSession);
try {
  await open();
  identity = holdSession;
  const prior = {
    sessionId: holdSession, clientId: crypto.randomUUID(), next: 3,
    reportSequence: 0, attempts: 0, lastResponse: "NONE", acknowledged: 0,
    capacityLost: 0, expiredLost: 0, rejectedLost: 0, storageLost: 0,
    items: [2, 8].map((generation, index) => ({
      experimentOrigin: { clientId: crypto.randomUUID(), generation },
      id: crypto.randomUUID(), order: index + 1, event,
      created: Date.now() - (index === 0 ? 8 * 86400000 : 0), attempts: 0, last: "UNSENT",
    })),
  };
  // A version 1 connection with the mixed queue blocks the upgrade. Verify the
  // rollback leaves the original row intact before allowing a fresh open.
  const oldTab = await context!.newPage();
  await oldTab.route("**/api/**", (route) => route.abort());
  await oldTab.goto(origin);
  await oldTab.evaluate(async (row) => {
    window.oldDeliveryDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("stage1-observation-outbox", 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("sessions", { keyPath: "sessionId" }).put(row);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }, prior);
  await showStatus();
  const display = page.locator("#delivery-test");
  await display.getByRole("alert").getByText(/未保存の入力.*旧版のタブを閉じ.*再読み込み/).waitFor();
  await assert.rejects(state(holdSession), /storage_upgrade_blocked/);
  assert.deepEqual(await oldTab.evaluate(async (id) => new Promise((resolve, reject) => {
    const read = window.oldDeliveryDb.transaction("sessions").objectStore("sessions").get(id);
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  }), holdSession), prior);
  const oldOpen = () => page.evaluate(async () => {
    return new Promise<string>((resolve) => {
      const open = indexedDB.open("stage1-observation-outbox", 1);
      open.onsuccess = () => { open.result.close(); resolve("opened"); };
      open.onerror = () => resolve(open.error?.name ?? "unknown");
    });
  });
  await oldTab.close();
  assert.equal(await oldOpen(), "opened");
  assert.equal((await state(holdSession)).pending, 2);
  assert.deepEqual(await readHeld(), prior, "upgrade itself may not rewrite the queue");
  assert.equal(await oldOpen(), "VersionError");
  await page.reload();
  await page.evaluate('(async()=>{window.outbox = await import("/src/observation-outbox.ts"); window.operations = await import("/src/operation-client.ts")})()');
  await showStatus();
  await display.getByText(/送信待ち 2件/).waitFor();
  // If the hold marker cannot be written, expose the 409 in this tab and retry
  // only the marker write. The next flush must not resubmit the old item.
  const markerFailed = await page.evaluate(async (id) => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (value?.heldHeadId) throw new DOMException("full", "QuotaExceededError");
      return put.call(this, value, key);
    };
    try { return await window.outbox.flush(id, fetch); }
    finally { IDBObjectStore.prototype.put = put; }
  }, holdSession);
  assert.equal(markerFailed, false);
  await display.getByText(/先頭1件は旧世代.*後続 1件/).waitFor();
  await display.getByText(/状態を記憶領域に保存できません/).waitFor();
  assert.equal((await readHeld()).heldHeadId, undefined);
  assert.equal(await flush(holdSession), false);
  await display.getByText(/先頭1件は旧世代.*後続 1件/).waitFor();
  await display.getByText(/7日を過ぎた未確認記録も保持/).waitFor();
  assert.equal((await state(holdSession)).retrying, 0);
  assert.equal((await state(holdSession)).acknowledged, 0);
  assert.deepEqual(heldRequests, [{
    id: prior.items[0].id, order: "1", stream: prior.clientId, generation: "2", event,
  }]);
  const held = await readHeld();
  assert.deepEqual(held.items.map(({ attempts, last, ...item }) => item),
    prior.items.map(({ attempts, last, ...item }) => item));
  assert.equal(held.items[1].attempts, 0, "current-generation item was never attempted");
  assert.equal(held.heldHeadId, prior.items[0].id);
  assert.equal(held.rejectedLost + held.expiredLost, 0);
  // Inject quota failure at the real write. Reads and stored data still work.
  await page.evaluate(async ({ session, event }) => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = () => { throw new DOMException("full", "QuotaExceededError"); };
    try { await window.outbox.enqueue(session, event); }
    catch (error) { if (String(error).includes("storage_unavailable")) return; throw error; }
    finally { IDBObjectStore.prototype.put = original; }
    throw new Error("Quota injection unexpectedly accepted the record");
  }, { session: holdSession, event });
  assert.deepEqual(await readHeld(), held);
  await display.getByText(/このタブで新たな操作記録 1件を保持できません/).waitFor();
  // Lower only the test admission threshold to hit the byte boundary exactly.
  const originalBytes = await page.evaluate((limit) => {
    const prior = window.outbox.limits.bytes;
    window.outbox.limits.bytes = limit;
    return prior;
  }, new TextEncoder().encode(JSON.stringify(held.items)).length);
  await assert.rejects(enqueue(event, holdSession), /observation_capacity/);
  await page.evaluate((limit) => { window.outbox.limits.bytes = limit; }, originalBytes);
  const afterBytes = await readHeld();
  assert.deepEqual(afterBytes.items, held.items);
  assert.equal(afterBytes.next, held.next);
  await page.evaluate(async ({ session, event }) => {
    for (let i = 2; i < 500; i++) await window.outbox.enqueue(session, event);
  }, { session: holdSession, event });
  const full = await readHeld();
  assert.equal(full.items.length, 500);
  await assert.rejects(enqueue(event, holdSession), /observation_capacity/);
  const refused = await readHeld();
  assert.deepEqual(refused, { ...full, capacityRefused: 2 });
  await display.getByText(/容量上限のため、新たな操作記録 2件を保持できません/).waitFor();
  await context!.close();
  await open();
  await showStatus();
  await page.locator("#delivery-test").getByText(/先頭1件は旧世代.*後続 499件/).waitFor();
  assert.equal(await flush(holdSession), false);
  assert.equal(heldRequests.length, 1, "hold persisted across browser restart; no skip or retry");
  const restarted = await readHeld();
  assert.deepEqual(restarted, { ...refused, reportSequence: refused.reportSequence + 1 });
  assert.equal(restarted.clientId, prior.clientId);
  assert.equal(restarted.acknowledged, 0);
  assert.ok(reports.some((r) => r.clientId === prior.clientId &&
    r.pending === 500 && r.rejectedLost === 0 && r.expiredLost === 0 && r.capacityLost === 2));
  const originalSessionLimit = await page.evaluate(() => {
    const prior = window.outbox.limits.sessions;
    window.outbox.limits.sessions = 1;
    return prior;
  });
  await assert.rejects(enqueue(), /observation_capacity/);
  assert.equal((await state()).capacityRefused, 1);
  assert.equal((await state()).pending, 0);
  assert.deepEqual(await readHeld(), restarted);
  await page.evaluate((limit) => { window.outbox.limits.sessions = limit; }, originalSessionLimit);
  identity = session;
  await enqueue();
  await enqueue({ ...event, eventType: "VIDEO_PAUSE" });
  assert.equal((await state()).pending, 2);
  assert.equal(await flush(), false);
  assert.equal((await state()).pending, 2);
  assert.equal((await state()).held, false);
  assert.equal((await state()).retrying, 1);
  assert.equal((await state()).acknowledged, 0);
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
    const database=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open("stage1-observation-outbox");r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject();});
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
    "Real Edge/IndexedDB: offline, lost ACK, ordered retry, mixed-generation hold, v1 upgrade and rollback, count/byte/age preservation, quota failure, browser restart, strict payloads, operation keys: PASS",
  );
} finally {
  await context?.close();
  await server.close();
  assert.ok(
    resolve(profile).startsWith(join(resolve(tmpdir()),"stage1-issue8-browser-")),
  );
  await rm(profile, { recursive: true, force: true });
}
