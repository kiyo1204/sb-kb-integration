import { diagnoseLinkWait } from "./link-wait-diagnostic.js";
// Real learner authentication, product API and guarded disposable PostgreSQL.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
const base = process.env.API_BASE_URL!,
  sid = process.env.DIRECTION_SESSION!,
  run = process.env.DIRECTION_RUN!,
  mapId = process.env.DIRECTION_MAP!,
  code = process.env.DIRECTION_CODE!,
  researcher = process.env.RESEARCHER_API_TOKEN!;
const mapType = process.env.DIRECTION_TYPE ?? "INTEGRATION";
const [a, b, c] = JSON.parse(process.env.DIRECTION_CONCEPTS!) as string[];
const vite = await createServer({
  server: {
    host: "127.0.0.1",
    port: 0,
    proxy: { "/api": { target: base, changeOrigin: true } },
  },
});
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(15000);
  await page.addInitScript("globalThis.__name = (fn) => fn;");
  await page.addInitScript(
    (t) => sessionStorage.setItem("stage1-access-token", t),
    code,
  );
  async function research(path: string, body?: unknown) {
    const r = await fetch(base + "/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + researcher,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(r.ok);
    return r.json();
  }
  let learnerHeaders: Record<string, string> = {};
  page.on("request", (r) => {
    if (
      r.method() === "GET" &&
      new URL(r.url()).pathname === `/api/maps/${mapId}`
    )
      learnerHeaders = r.headers();
  });
  const snapshot = async () => {
    const r = await page.request.get(base + `/api/maps/${mapId}`, {
      headers: learnerHeaders,
    });
    assert.equal(r.status(), 200);
    const m = await r.json();
    return m.links.map(
      (l: {
        id: string;
        sourceConceptId: string;
        targetConceptId: string;
        label: string;
      }) => ({
        id: l.id,
        source: l.sourceConceptId,
        target: l.targetConceptId,
        label: l.label,
      }),
    );
  };
  async function enter() {
    await page.goto(vite.resolvedUrls!.local[0] + "maps/" + mapId);
    await page
      .getByRole("heading", { name: "この画面では利用できません", exact: true })
      .waitFor();
    const clientId = (
      await page.locator(".session-card code").innerText()
    ).trim();
    const p = (
      await research(`/research/experiment-runs/${run}/participants`)
    ).participants.find((p: { id: string }) => p.id === sid);
    await research(
      `/research/experiment-runs/${run}/participants/${sid}/client-switch`,
      { clientId, expectedDeviceGeneration: p.deviceGeneration },
    );
    await page
      .getByRole("button", { name: "接続状態を更新", exact: true })
      .click();
    await page.locator(".concept-canvas").waitFor();
  }
  async function add() {
    if (mapType === "KB") {
      const part = page.locator(".kit-palette-part.is-link").first(),
        canvas = page.locator(".concept-canvas");
      // Native dragTo waits for both visible targets and dispatches dragover before drop.
      await diagnoseLinkWait(page, "kb-drop", ".kit-palette-part.is-link", ".is-temporary", async () => {
        await part.dragTo(canvas, {targetPosition:{x:400,y:200}});
        await page.locator(".is-temporary").waitFor();
      });
      return;
    }
    await page.getByRole("button", { name: "＋ リンク", exact: true }).click();
    await page
      .getByLabel("リンクラベル", { exact: true })
      .fill(mapType === "PRIOR" ? "MOCK SB direction" : "MOCK direction new");
    await page.getByRole("button", { name: "接続を開始", exact: true }).click();
  }
  async function drag(selector: string, id: string) {
    const handle = page.locator(selector),
      target = page.locator(`[data-concept-id="${id}"]`);
    await handle.scrollIntoViewIfNeeded();
    const h = await handle.boundingBox();
    assert.ok(h);
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page
      .locator(".connection-preview-path[marker-mid]")
      .waitFor({ state: "attached" });
    await target.scrollIntoViewIfNeeded();
    const t = await target.boundingBox();
    assert.ok(t);
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 12 });
  }

  const mutations: string[] = [];
  page.on("request", (r) => {
    if (
      (r.method() === "POST" &&
        (new URL(r.url()).pathname === `/api/maps/${mapId}/links` ||
          new URL(r.url()).pathname.startsWith(
            `/api/maps/${mapId}/kit-links/`,
          ))) ||
      (r.method() === "PATCH" && r.url().endsWith("/reconnect"))
    )
      mutations.push(r.method());
  });
  await enter();
  async function invalidDrop(selector: string) {
    const begin = async () => {
    await page.locator(selector).scrollIntoViewIfNeeded();
    const h = await page.locator(selector).boundingBox();
    assert.ok(h);
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page
      .locator(".connection-preview-path[marker-mid]")
      .waitFor({ state: "attached" });
    };
    if (mapType === "INTEGRATION") await diagnoseLinkWait(page, "integration-preview", selector, ".connection-preview-path[marker-mid]", begin);
    else await begin();
    const area = await page.locator(".concept-canvas").boundingBox();
    assert.ok(area);
    await page.mouse.move(area.x + 12, area.y + 12, { steps: 8 });
    await page.mouse.up();
  }
  const initial = await snapshot();
  await add();
  await invalidDrop(".is-temporary .is-source");
  assert.deepEqual(await snapshot(), initial);
  assert.equal(mutations.length, 0);
  await drag(".is-temporary .is-source", a);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.deepEqual(await snapshot(), initial);
  assert.equal(mutations.length, 0);
  // Whole-link cancellation has its own existing telemetry endpoint, not a mutation.
  const cancelled = page.waitForResponse((r) =>
    r.url().includes(mapType === "KB" ? "/operation-cancellations/IMPORT_KIT_LINK" : "/operation-cancellations/ADD_LINK"),
  );
  await page.locator(".temporary-connector-cancel").click();
  assert.ok((await cancelled).ok());
  assert.deepEqual(await snapshot(), initial);
  await add();
  await drag(".is-temporary .is-source", a);
  await page.mouse.up();
  const created = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      (new URL(r.url()).pathname === `/api/maps/${mapId}/links` ||
        new URL(r.url()).pathname.startsWith(`/api/maps/${mapId}/kit-links/`)),
  );
  await drag(".is-temporary .is-target", b);
  await page.mouse.up();
  const createdResponse = await created;
  assert.equal(createdResponse.status(), 201);
  const link = await createdResponse.json();
  assert.equal(link.sourceConceptId, a);
  assert.equal(link.targetConceptId, b);
  await page.locator(".is-temporary").waitFor({ state: "detached" });
  await enter();
  const saved = `[data-connector-id="${link.id}"]`;
  await page.locator(saved).waitFor();
  let row = (await snapshot()).find((l: { id: string }) => l.id === link.id);
  assert.equal(row.source, a);
  assert.equal(row.target, b);
  const before = await snapshot();
  await invalidDrop(saved + " .is-target");
  assert.deepEqual(await snapshot(), before);
  assert.equal(mutations.length, 1);
  await drag(saved + " .is-target", c);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.deepEqual(await snapshot(), before);
  assert.equal(mutations.length, 1);
  const closeDrawer = page.getByRole("button", {
    name: "Drawerを閉じる",
    exact: true,
  });
  if (await closeDrawer.count()) await closeDrawer.click();
  const reconnected = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith("/reconnect"),
  );
  await drag(saved + " .is-target", c);
  if (process.env.DIRECTION_SCREENSHOT)
    await page.screenshot({
      path: process.env.DIRECTION_SCREENSHOT,
      fullPage: true,
    });
  await page.mouse.up();
  assert.equal((await reconnected).status(), 200);
  async function history(action: string, label: string) {
    const response = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/undo-redo"),
    );
    await page.getByRole("button", { name: label, exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.getByText(action === "UNDO" ? "操作を元に戻しました。" : "操作をやり直しました。",{exact:true}).waitFor();
  }
  await history("UNDO", "元に戻す");
  assert.equal(
    (await snapshot()).find((l: { id: string }) => l.id === link.id).target,
    b,
  );
  await history("REDO", "やり直す");
  assert.equal(
    (await snapshot()).find((l: { id: string }) => l.id === link.id).target,
    c,
  );
  const sourceChanged=page.waitForResponse(r=>r.request().method()==="PATCH"&&r.url().endsWith("/reconnect"));
  await drag(saved+" .is-source",b);await page.mouse.up();assert.equal((await sourceChanged).status(),200);
  assert.equal((await snapshot()).find((l:{id:string})=>l.id===link.id).source,b);
  await history("UNDO","元に戻す");assert.equal((await snapshot()).find((l:{id:string})=>l.id===link.id).source,a);
  if (mapType === "KB") await history("UNDO", "元に戻す");
  await enter();
  await page.locator(saved).waitFor();
  row = (await snapshot()).find((l: { id: string }) => l.id === link.id);
  assert.equal(row.source, a);
  assert.equal(row.target, mapType === "KB" ? b : c);
  assert.equal(mutations.length, 3);
  // The rendered saved edge and its endpoints are derived from the real GET response.
  assert.equal(
    await page
      .locator(`${saved} .is-source`)
      .getAttribute("data-endpoint-label"),
    "始点",
  );
  assert.equal(
    await page
      .locator(`${saved} .is-target`)
      .getAttribute("data-endpoint-label"),
    "矢印の先",
  );
  if (process.env.DIRECTION_SCREENSHOT)
    await page.screenshot({
      path: process.env.DIRECTION_SCREENSHOT,
      fullPage: true,
    });
  console.log(
    `PASS real ${mapType}: create/reload, reconnect/reload, invalid drop, Esc, Undo/Redo, separate cancellation telemetry`,
  );
} finally {
  await browser.close();
  await vite.close();
}
