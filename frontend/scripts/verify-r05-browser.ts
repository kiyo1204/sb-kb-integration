// TEST ONLY real R05 API. Researcher credential is not printed or screenshotted.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const base = process.env.API_BASE_URL!,
  version = process.env.R05_BROWSER_VERSION!,
  token = process.env.RESEARCHER_API_TOKEN!,
  endpoint = base + "/api/research/materials/" + version + "/r05";
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
    viewport: { width: 1366, height: 1000 },
  });
  await page.addInitScript(
    (t) => sessionStorage.setItem("stage1-access-token", t),
    token,
  );
  page.on("dialog", (d) => void d.accept());
  await page.goto(
    vite.resolvedUrls!.local[0] + "research/materials/" + version,
  );
  await page
    .getByRole("link", { name: "テスト実行・記録", exact: true })
    .click();
  await page.getByRole("heading", { name: "R05：教材テスト実行" }).waitFor();
  const startKeys: string[] = [];
  let loseStart = true;
  await page.route("**/api/research/materials/*/r05", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    startKeys.push(route.request().headers()["idempotency-key"]);
    const response = await route.fetch();
    if (loseStart) {
      loseStart = false;
      return route.abort("failed");
    }
    return route.fulfill({ response });
  });
  await page.getByRole("button", { name: "テストを開始", exact: true }).click();
  await page
    .getByRole("button", { name: "開始結果を再確認", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "開始結果を再確認", exact: true })
    .click();

  await page
    .getByRole("heading", { name: "授業・動画", exact: true })
    .waitFor();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "SBへ進む", exact: true }).click();
  await page.getByRole("heading", { name: "SB", exact: true }).waitFor();
  const registered = await (
    await fetch(endpoint, { headers: { Authorization: "Bearer " + token } })
  ).json();
  const seed = registered.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "SB",
  ).state.concepts[0];
  const node = page.locator(".concept-node").first();
  await node.scrollIntoViewIfNeeded();
  const box = await node.boundingBox();
  assert.ok(box);
  const moved = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.endsWith("/operations") &&
      r.request().postDataJSON()?.action === "MOVE_CONCEPT",
  );
  await page.mouse.move(box.x + 25, box.y + 25);
  await page.mouse.down();
  await page.mouse.move(box.x + 65, box.y + 55, { steps: 6 });
  await page.mouse.up();
  assert.equal((await moved).status(), 200);
  await page.waitForFunction(
    () => !document.body.textContent?.includes("保存処理中"),
  );
  const movedView = await (
    await fetch(endpoint, { headers: { Authorization: "Bearer " + token } })
  ).json();
  const actual = movedView.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "SB",
  ).state.concepts[0];
  assert.equal(actual.positionX, seed.positionX + 40);
  assert.equal(actual.positionY, seed.positionY + 30);
  assert.equal(startKeys.length, 2);
  assert.equal(startKeys[0], startKeys[1]);
  await page.unroute("**/api/research/materials/*/r05");
  const operationKeys: string[] = [];
  let loseOperation = true;
  await page.route("**/r05/*/operations", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action !== "ADD_CONCEPT") return route.continue();
    operationKeys.push(route.request().headers()["idempotency-key"]);
    const response = await route.fetch();
    if (loseOperation) {
      loseOperation = false;
      return route.abort("failed");
    }
    return route.fulfill({ response });
  });

  await page
    .getByLabel("概念・リンク名", { exact: true })
    .fill("TEST ONLY browser addition");
  await page.getByRole("button", { name: "概念を追加", exact: true }).click();
  await page
    .getByRole("button", { name: "結果未確認の操作を再確認", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "結果未確認の操作を再確認", exact: true })
    .click();
  await page.waitForFunction(
    () => !document.body.textContent?.includes("結果未確認の操作を再確認"),
  );
  assert.equal(operationKeys.length, 2);
  assert.equal(operationKeys[0], operationKeys[1]);
  await page.unroute("**/r05/*/operations");

  await page.getByLabel("概念・リンク名", { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll(".concept-node").length === 2,
  );

  await page
    .getByLabel("概念・リンク名", { exact: true })
    .fill("TEST ONLY endpoint target");
  await page.getByRole("button", { name: "概念を追加", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".concept-node").length === 3,
  );
  const beforeLink = await (
    await fetch(endpoint, { headers: { Authorization: "Bearer " + token } })
  ).json();
  const sbBeforeLink = beforeLink.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "SB",
  );
  assert.equal(sbBeforeLink.state.concepts.length, 3);
  const [linkSource, linkTarget, alternateSource] =
    sbBeforeLink.state.concepts;
  await page.getByLabel("始点", { exact: true }).selectOption(linkSource.id);
  await page.getByLabel("終点", { exact: true }).selectOption(linkTarget.id);
  await page
    .getByLabel("概念・リンク名", { exact: true })
    .fill("TEST ONLY endpoint relation");
  const addLinkResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      new URL(response.url()).pathname.endsWith("/operations") &&
      request.method() === "POST" &&
      request.postDataJSON()?.action === "ADD_LINK"
    );
  });
  await page.getByRole("button", { name: "リンクを追加", exact: true }).click();
  assert.equal((await addLinkResponse).status(), 200);
  const linkCreatedView = await (
    await fetch(endpoint, { headers: { Authorization: "Bearer " + token } })
  ).json();
  const sbWithLink = linkCreatedView.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "SB",
  );
  const createdLink = sbWithLink.state.links[0];
  assert.equal(createdLink.sourceConceptId, linkSource.id);
  assert.equal(createdLink.targetConceptId, linkTarget.id);

  const sourceHandle = page.locator(
    ".concept-canvas .link-connector-handle.is-source",
  );
  await sourceHandle.waitFor();
  const endpointGeometry = await sourceHandle.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = element.closest<HTMLElement>(".concept-canvas");
    const rect = element.getBoundingClientRect();
    return {
      width: style.width,
      height: style.height,
      minHeight: style.minHeight,
      padding: style.padding,
      canvasZoom: canvas ? Number.parseFloat(getComputedStyle(canvas).zoom) : 0,
      excludedFromMaterialsButtonRule: !element.matches(
        ".materials-page button:not(.concept-canvas *)",
      ),
      rectWidth: rect.width,
      rectHeight: rect.height,
    };
  });
  assert.equal(endpointGeometry.excludedFromMaterialsButtonRule, true);
  assert.equal(endpointGeometry.width, "18px");
  assert.equal(endpointGeometry.height, "18px");
  assert.notEqual(endpointGeometry.minHeight, "38px");
  assert.equal(endpointGeometry.padding, "0px");
  assert.ok(endpointGeometry.rectWidth > 0);
  assert.ok(endpointGeometry.canvasZoom > 0);
  assert.ok(
    Math.abs(endpointGeometry.rectWidth / endpointGeometry.canvasZoom - 18) <
      0.5,
    JSON.stringify(endpointGeometry),
  );
  assert.ok(
    Math.abs(endpointGeometry.rectHeight / endpointGeometry.canvasZoom - 18) <
      0.5,
    JSON.stringify(endpointGeometry),
  );

  const endpointOperations: string[] = [];
  const recordEndpointOperation = (request: import("playwright").Request) => {
    if (!new URL(request.url()).pathname.endsWith("/operations")) return;
    if (request.method() !== "POST") return;
    endpointOperations.push(request.postDataJSON()?.action ?? "");
  };
  page.on("request", recordEndpointOperation);
  await sourceHandle.click();
  assert.deepEqual(endpointOperations, []);
  const afterEndpointClick = await (
    await fetch(endpoint, { headers: { Authorization: "Bearer " + token } })
  ).json();
  const sbAfterEndpointClick = afterEndpointClick.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "SB",
  );
  assert.deepEqual(sbAfterEndpointClick.state.links, sbWithLink.state.links);

  const alternateNode = page.locator(
    `[data-concept-id="${alternateSource.id}"]`,
  );
  await alternateNode.scrollIntoViewIfNeeded();
  const handleBox = await sourceHandle.boundingBox();
  const alternateBox = await alternateNode.boundingBox();
  assert.ok(handleBox);
  assert.ok(alternateBox);
  const reconnectResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      new URL(response.url()).pathname.endsWith("/operations") &&
      request.method() === "POST" &&
      request.postDataJSON()?.action === "RECONNECT_LINK"
    );
  });
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    alternateBox.x + alternateBox.width / 2,
    alternateBox.y + alternateBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  assert.equal((await reconnectResponse).status(), 200);
  assert.deepEqual(endpointOperations, ["RECONNECT_LINK"]);
  page.off("request", recordEndpointOperation);
  const afterReconnect = await (
    await fetch(endpoint, { headers: { Authorization: "Bearer " + token } })
  ).json();
  const sbAfterReconnect = afterReconnect.data.maps.find(
    (m: { map_kind: string }) => m.map_kind === "SB",
  );
  const persistedLink = sbAfterReconnect.state.links.find(
    (link: { id: string }) => link.id === createdLink.id,
  );
  assert.equal(persistedLink.sourceConceptId, alternateSource.id);
  assert.equal(persistedLink.targetConceptId, linkTarget.id);

  await page
    .getByRole("button", { name: "このMapを提出", exact: true })
    .click();
  await page.getByRole("heading", { name: "KB", exact: true }).waitFor();
  assert.ok(
    await page
      .getByRole("button", { name: "このMapを提出", exact: true })
      .isDisabled(),
  );
  await page.getByRole("button", { name: "一致を確認", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "不一致：" }).waitFor();
  async function api() {
    const r = await fetch(endpoint, {
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(r.status, 200);
    return r.json();
  }
  let view = await api();
  for (const c of view.material.concepts) {
    await page
      .getByRole("button", { name: c.label + " を配置", exact: true })
      .click();
    await page.waitForFunction(
      (n) => document.querySelectorAll(".concept-node").length === n,
      view.material.concepts.indexOf(c) + 1,
    );
  }
  view = await api();
  const kb = view.data.maps.find(
      (m: { map_kind: string }) => m.map_kind === "KB",
    ),
    l = view.material.links[0];
  const source = kb.state.concepts.find(
      (c: { provenance: { sourceConceptId: string }[] }) =>
        c.provenance.some((p) => p.sourceConceptId === l.sourceConceptId),
    ),
    target = kb.state.concepts.find(
      (c: { provenance: { sourceConceptId: string }[] }) =>
        c.provenance.some((p) => p.sourceConceptId === l.targetConceptId),
    );
  await page.getByLabel("始点", { exact: true }).selectOption(source.id);
  await page.getByLabel("終点", { exact: true }).selectOption(target.id);
  await page.getByLabel("Kit関係部品", { exact: true }).selectOption(l.id);
  await page
    .getByRole("button", { name: "関係部品を接続", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "一致を確認",
      )?.disabled,
  );
  await page.getByRole("button", { name: "一致を確認", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "一致：" }).waitFor();
  await page
    .getByRole("button", { name: "このMapを提出", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "INTEGRATION", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "一致を確認", exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "このMapを提出", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "テスト実施済み" })
    .waitFor();
  const dir = process.env.R05_SCREENSHOT_DIR ?? join(tmpdir(), "sbkb-r05");
  await mkdir(dir, { recursive: true });
  await page.screenshot({
    path: join(dir, "r05-completed.png"),
    fullPage: true,
  });
  const deleteKeys: string[] = [];
  let loseDelete = true;
  await page.route("**/api/research/materials/*/r05/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deleteKeys.push(route.request().headers()["idempotency-key"]);
    const response = await route.fetch();
    if (loseDelete) {
      loseDelete = false;
      return route.abort("failed");
    }
    return route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "テストデータを削除", exact: true })
    .click();
  await page
    .getByRole("button", { name: "削除結果を再確認", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "削除結果を再確認", exact: true })
    .click();
  await page.waitForFunction(
    () => !document.body.textContent?.includes("削除結果を再確認"),
  );
  assert.equal(deleteKeys.length, 2);
  assert.equal(deleteKeys[0], deleteKeys[1]);

  await page.waitForFunction(
    () => !document.body.textContent?.includes("Map・履歴の確認"),
  );
  await page
    .getByRole("status")
    .filter({ hasText: "テスト実施済み" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "テストを開始", exact: true })
      .count(),
    0,
  );
  assert.equal((await api()).run, null);
  await page.screenshot({
    path: join(dir, "r05-deleted-completed.png"),
    fullPage: true,
  });
  console.log(
    "R05 browser: PASS (real R04/lesson/SB/KB/integration submission/history deletion, retained acceptance)",
  );
} finally {
  await browser.close();
  await vite.close();
}
