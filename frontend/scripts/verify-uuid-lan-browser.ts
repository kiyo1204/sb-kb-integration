// TEST ONLY: isolated mock DB and product API; no rehearsal data or credentials in output.
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { createServer } from "vite";
import { verifyMockTestUrl } from "../../backend/src/scripts/mock-db.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const base = process.env.API_BASE_URL!,
  token = process.env.RESEARCHER_API_TOKEN!;
const host = process.env.UUID_LAN_HOST!;
assert.match(host, /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/);
const vite = await createServer({
  cacheDir: ".local/uuid-vite-lan",
  server: { host, port: 0 },
});
await vite.listen();
const port = vite.httpServer!.address() as { port: number };
const lan = "http://" + host + ":" + port.port;
const nativeVite = await createServer({
  cacheDir: ".local/uuid-vite-local",
  server: { host: "127.0.0.1", port: 5185 },
});
await nativeVite.listen();
const local =
  "http://127.0.0.1:" +
  (nativeVite.httpServer!.address() as { port: number }).port;
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(r.ok, "synthetic fixture API status " + r.status);
  return r.json();
}
async function pageAt(origin: string, noRandom = false) {
  const p = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await p.addInitScript(
    (t) => sessionStorage.setItem("stage1-access-token", t),
    token,
  );
  if (noRandom)
    await p.addInitScript(() => {
      Object.defineProperty(crypto, "randomUUID", { value: undefined });
      Object.defineProperty(crypto, "getRandomValues", { value: undefined });
    });
  await p.goto(origin + "/research/materials");
  return p;
}
async function replay(p: Page, path: string, button: () => Promise<void>) {
  const keys: string[] = [],
    ids: string[] = [];
  let lose = true;
  await p.route("**/api" + path, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    const r = await route.fetch();
    assert.ok(r.ok());
    const d = await r.json();
    ids.push(d.id ?? d.sessionId);
    if (lose) {
      lose = false;
      return route.fulfill({
        status: 503,
        json: { message: "TEST ONLY lost acknowledgement" },
      });
    }
    return route.fulfill({ response: r });
  });
  await button();
  await p.getByRole("alert").waitFor();
  await button();
  await p.waitForURL((u) =>
    path === "/research/materials"
      ? u.pathname.startsWith(path + "/")
      : u.pathname === path && u.searchParams.has("created"),
  );
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0], uuid);
  assert.equal(ids[0], ids[1]);
  assert.ok(ids[0]);
  await p.unroute("**/api" + path);
  return ids[0];
}
try {
  const native = await pageAt(local);
  const nativeInfo = await native.evaluate(`(async ()=>{
   const path="/src/client-identity.ts";const m=await import(path);
   let calls=0;const original=crypto.randomUUID.bind(crypto);
   Object.defineProperty(crypto,"randomUUID",{value:()=>{calls++;return original();},configurable:true});
   return {secure:isSecureContext,ids:Array.from({length:100},()=>m.newClientId()),calls};
 })()`);
  assert.equal(nativeInfo.secure, true);
  assert.equal(nativeInfo.calls, 100);
  for (const id of nativeInfo.ids) assert.match(id, uuid);
  const nativeDraft = await replay(native, "/research/materials", () =>
    native
      .getByRole("button", { name: "教材の下書きを作成", exact: true })
      .click(),
  );
  assert.ok(nativeDraft);
  await native.close();
  const p = await pageAt(lan);
  const info = await p.evaluate(async () => {
    const path = "/src/client-identity.ts";
    const m = await import(path);
    return {
      secure: isSecureContext,
      native: typeof crypto.randomUUID,
      random: typeof crypto.getRandomValues,
      ids: Array.from({ length: 100 }, () => m.newClientId()),
    };
  });
  assert.equal(info.secure, false);
  assert.equal(info.native, "undefined");
  assert.equal(info.random, "function");
  for (const id of info.ids) assert.match(id, uuid);
  assert.equal(new Set(info.ids).size, 100);
  const draftId = await replay(p, "/research/materials", () =>
    p.getByRole("button", { name: "教材の下書きを作成", exact: true }).click(),
  );
  const asset = await api("/research/goal-maps/import", "POST", {
    format: "sb-kb-goal-map",
    schemaVersion: 1,
    goalMap: {
      title: "TEST ONLY UUID asset " + crypto.randomUUID(),
      concepts: [
        { id: "a", label: "TEST ONLY seed", position: { x: 0, y: 0 } },
      ],
      links: [],
    },
  });
  const assets = await api("/research/materials/assets");
  const part = assets.assets.find(
    (a: { kitId: string }) => a.kitId === asset.kitDefinitionId,
  ).concepts[0].id;
  const draft = await api("/research/materials/" + draftId);
  const saved = await api("/research/materials/" + draftId, "PUT", {
    expectedRevision: draft.editRevision,
    body: {
      title: "TEST ONLY UUID material",
      researcherDescription: "TEST ONLY",
      videoRef: "/test-only.mp4",
      sbInstructions: "TEST ONLY",
      kbInstructions: "TEST ONLY",
      integrationInstructions: "TEST ONLY",
      kitId: asset.kitDefinitionId,
      seedConceptItemIds: [part],
      integrationSeconds: 601,
    },
  });
  const material = await api(
    "/research/materials/" + draftId + "/publish",
    "POST",
    { expectedRevision: saved.editRevision },
  );
  await p.goto(lan + "/research/experiment-runs/new");
  await p.locator("#run-name").fill("TEST ONLY UUID run");
  await p.locator("#run-material").selectOption(material.id);
  await p.locator("#run-planned").fill("2");
  const runId = await replay(p, "/research/experiment-runs", () =>
    p.getByRole("button", { name: "準備中の実施を作成", exact: true }).click(),
  );
  await p.goto(lan + "/research/experiment-runs/" + runId);
  await p.locator("#participant-label").fill("TEST ONLY UUID A");
  // Registration stays on the same page: loss then retry must not add another Session.
  const regPath = "/research/experiment-runs/" + runId + "/participants";
  const regKeys: string[] = [],
    regIds: string[] = [];
  let lose = true;
  await p.route("**/api" + regPath, async (route) => {
    const r = await route.fetch();
    assert.ok(r.ok());
    const d = await r.json();
    regKeys.push(route.request().headers()["idempotency-key"]);
    regIds.push(d.sessionId);
    if (lose) {
      lose = false;
      return route.fulfill({
        status: 503,
        json: { message: "TEST ONLY lost acknowledgement" },
      });
    }
    return route.fulfill({ response: r });
  });
  const register = () =>
    p
      .getByRole("button", { name: /参加者Session・検証用コードを追加/ })
      .click();
  await register();
  await p.getByRole("alert").waitFor();
  await register();
  await p.getByRole("status").filter({ hasText: "受付済みの操作" }).waitFor();
  assert.equal(regKeys.length, 2);
  assert.equal(regKeys[0], regKeys[1]);
  assert.match(regKeys[0], uuid);
  assert.equal(regIds[0], regIds[1]);
  const view = await api(
    "/research/experiment-runs/" + runId + "/participants",
  );
  assert.equal(view.participants.length, 1);
  await p.close();
  const no = await pageAt(lan, true);
  no.on("dialog", (d) => void d.accept());
  let writes = 0;
  await no.route("**/api/**", async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) writes++;
    return route.continue();
  });
  const checkError = () =>
    no
      .getByRole("alert")
      .filter({ hasText: "安全な乱数を生成できない" })
      .waitFor();
  await no
    .getByRole("button", { name: "教材の下書きを作成", exact: true })
    .click();
  await checkError();
  await no.goto(lan + "/research/experiment-runs/new");
  await no.locator("#run-name").fill("TEST ONLY no source");
  await no.locator("#run-material").selectOption(material.id);
  await no.locator("#run-planned").fill("2");
  await no
    .getByRole("button", { name: "準備中の実施を作成", exact: true })
    .click();
  await checkError();
  await no.goto(lan + "/research/experiment-runs/" + runId);
  await no.locator("#participant-label").fill("TEST ONLY no source");
  await no
    .getByRole("button", { name: /参加者Session・検証用コードを追加/ })
    .click();
  await checkError();
  await no.goto(lan + "/research/materials/" + material.id + "/test");
  await no.getByRole("button", { name: "テストを開始", exact: true }).click();
  await checkError();
  // Direct helper failure verifies no weak substitute when the random source is absent.
  const failure = await no.evaluate(async () => {
    const path = "/src/client-identity.ts";
    const m = await import(path);
    try {
      m.newClientId();
      return false;
    } catch (e) {
      return e instanceof Error && e.name === "SecureRandomUnavailableError";
    }
  });
  assert.equal(failure, true);
  assert.equal(writes, 0);
  await no.close();
  console.log(
    JSON.stringify({
      result: "PASS",
      browser: "Edge",
      nativeLocalhost: true,
      lanHttp: {
        secureContext: false,
        randomUUID: "undefined",
        getRandomValues: "function",
      },
      uuidV4: 200,
      realApiReplay: ["material", "run", "participant"],
      safeSourceAbsent: { visibleErrors: 4, writeRequests: 0 },
      fixtures: "synthetic only; asset preparation and publish via API",
    }),
  );
} finally {
  await browser.close();
  await vite.close();
  await nativeVite.close();
}
