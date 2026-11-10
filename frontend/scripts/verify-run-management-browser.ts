// TEST ONLY fixtures. Real disposable DB/API, except stated UI failure/gate cases.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import {
  verifyMockTestUrl,
  verificationReportPath,
} from "../../backend/src/scripts/mock-db.js";
await verifyMockTestUrl(process.env.DATABASE_URL!);
const base = process.env.API_BASE_URL!,
  token = process.env.RESEARCHER_API_TOKEN!;
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(r.ok, method + " " + path);
  return r.json();
}
const asset = await api("/research/goal-maps/import", "POST", {
  format: "sb-kb-goal-map",
  schemaVersion: 1,
  goalMap: {
    title: "TEST ONLY browser run asset " + randomUUID(),
    concepts: [
      { id: "a", label: "TEST ONLY browser seed", position: { x: 0, y: 0 } },
    ],
    links: [],
  },
});
const assets = await api("/research/materials/assets"),
  part = assets.assets.find(
    (a: { kitId: string }) => a.kitId === asset.kitDefinitionId,
  ).concepts[0].id;
const draft = await api("/research/materials", "POST", {});
const body = {
  title: "TEST ONLY browser run material",
  researcherDescription: "TEST ONLY description",
  videoRef: "/test-only.mp4",
  sbInstructions: "TEST ONLY SB",
  kbInstructions: "TEST ONLY KB",
  integrationInstructions: "TEST ONLY integration",
  kitId: asset.kitDefinitionId,
  seedConceptItemIds: [part],
  integrationSeconds: 601,
};
const saved = await api(`/research/materials/${draft.id}`, "PUT", {
  expectedRevision: draft.editRevision,
  body,
});
const material = await api(`/research/materials/${draft.id}/publish`, "POST", {
  expectedRevision: saved.editRevision,
});
const unpublished = await api("/research/materials", "POST", {});
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
const screenshots =
  process.env.RUN_SCREENSHOT_DIR ?? join(tmpdir(), "sbkb-runs-preview");
await mkdir(screenshots, { recursive: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  await page.addInitScript(
    (t) => sessionStorage.setItem("stage1-access-token", t),
    token,
  );
  let loseAck = true,
    failList = false,
    storedId = "";
  const keys: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.name));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (
      failList &&
      url.pathname === "/api/research/experiment-runs" &&
      route.request().method() === "GET"
    ) {
      failList = false;
      return route.fulfill({
        status: 503,
        json: {
          error: "run_storage_unavailable",
          message: "一時的に取得できません。",
        },
      });
    }
    const response = await route.fetch({
      url: base + url.pathname + url.search,
    });
    if (
      url.pathname === "/api/research/experiment-runs" &&
      route.request().method() === "POST"
    ) {
      keys.push(route.request().headers()["idempotency-key"]!);
      if (loseAck) {
        loseAck = false;
        assert.equal(response.status(), 201);
        storedId = (await response.json()).id;
        return route.abort("failed");
      }
    }
    return route.fulfill({ response });
  });
  const origin = vite.resolvedUrls!.local[0]!;
  await page.goto(origin + "research/experiment-runs/new");
  await page.locator("#run-name").waitFor();
  assert.equal(await page.locator("#run-name").inputValue(), "");
  assert.equal(await page.locator("#run-planned").inputValue(), "");
  assert.equal(await page.locator("#run-material").inputValue(), "");
  await page
    .locator(`#run-material option[value="${material.id}"]`)
    .waitFor({ state: "attached" });
  assert.equal(
    await page
      .locator(`#run-material option[value="${unpublished.id}"]`)
      .count(),
    0,
  );
  const name = "TEST ONLY browser run " + randomUUID().slice(0, 8);
  await page.locator("#run-name").fill(name);
  await page.locator("#run-material").selectOption(material.id);
  await page.locator("#run-planned").fill("2147483648");
  assert.equal(
    await page
      .getByRole("button", { name: "準備中の実施を作成", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("alert")
    .filter({ hasText: "保存形式は32bit" })
    .waitFor();
  await page.locator("#run-planned").fill("2");
  await page
    .getByRole("complementary", { name: "固定する教材版" })
    .getByText("601秒", { exact: true })
    .waitFor();
  await page.screenshot({
    path: join(screenshots, "r06-create-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "準備中の実施を作成", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "保存状態を確認できません" })
    .waitFor();
  assert.equal(await page.locator("#run-name").inputValue(), name);
  assert.equal(await page.locator("#run-planned").inputValue(), "2");
  assert.ok(storedId);
  assert.equal(
    (await api("/research/experiment-runs")).runs.filter(
      (r: { name: string }) => r.name === name,
    ).length,
    1,
  );
  await page
    .getByRole("button", { name: "準備中の実施を作成", exact: true })
    .click();
  await page.waitForURL(
    (url) =>
      url.pathname === "/research/experiment-runs" &&
      url.searchParams.get("created") === storedId,
  );
  await page.getByRole("status").filter({ hasText: name }).waitFor();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  let row = page.getByRole("row").filter({ hasText: name });
  await row.waitFor();
  assert.equal(await row.locator("td").nth(2).innerText(), "2");
  assert.equal(await row.locator("td").nth(3).innerText(), "0");
  assert.ok((await row.innerText()).includes("準備中"));
  assert.ok((await row.innerText()).includes("601秒"));
  assert.equal(
    await page
      .locator(".materials-page")
      .getByRole("button", { name: /開始|終了|コード|参加者登録/ })
      .count(),
    0,
  );
  assert.equal(await page.locator('a[href*="/participants"]').count(), 0);
  await page.screenshot({
    path: join(screenshots, "r07-list-desktop.png"),
    fullPage: true,
  });
  await page.reload();
  row = page.getByRole("row").filter({ hasText: name });
  await row.waitFor();
  failList = true;
  await page.getByRole("button", { name: "一覧を更新", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "前回取得時" }).waitFor();
  assert.equal(await row.count(), 1);
  await page.getByRole("button", { name: "一覧を更新", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector('[role="alert"]') &&
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "一覧を更新" && !b.disabled,
      ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: join(screenshots, "r07-mobile.png"),
    fullPage: true,
  });
  await page.goto(origin + "research/experiment-runs/new");
  await page.locator("#run-name").waitFor();
  await page.screenshot({
    path: join(screenshots, "r06-mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  const empty = await browser.newPage();
  await empty.addInitScript(
    (t) => sessionStorage.setItem("stage1-access-token", t),
    token,
  );
  await empty.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/experiment-runs/material-versions"))
      return route.fulfill({ json: { versions: [] } });
    const response = await route.fetch({
      url: base + url.pathname + url.search,
    });
    return route.fulfill({ response });
  });
  await empty.goto(origin + "research/experiment-runs/new");
  await empty
    .getByRole("status")
    .filter({ hasText: "完成教材版がありません" })
    .waitFor();
  assert.equal(
    await empty
      .getByRole("button", { name: "準備中の実施を作成", exact: true })
      .isDisabled(),
    true,
  );
  const denied = await browser.newPage();
  let reads = 0;
  await denied.addInitScript(() =>
    sessionStorage.setItem(
      "stage1-access-token",
      "TEST_ONLY_learner_gate_00000000000000",
    ),
  );
  await denied.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me")
      return route.fulfill({
        json: {
          role: "learner",
          sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      });
    if (path.includes("/experiment-runs")) reads++;
    return route.fulfill({ status: 403, json: { error: "forbidden" } });
  });
  for (const path of [
    "research/experiment-runs",
    "research/experiment-runs/new",
  ]) {
    await denied.goto(origin + path);
    await denied
      .getByRole("heading", { name: "ページが見つかりません" })
      .waitFor();
    assert.equal(await denied.locator("#run-name").count(), 0);
  }
  assert.equal(reads, 0);
  assert.deepEqual(errors, []);
  await writeFile(
    verificationReportPath("invariants").replace(
      /invariants\.json$/,
      "runs-browser.json",
    ),
    JSON.stringify(
      {
        syntheticOnly: true,
        realApi: true,
        checks: [
          "R06 no defaults/published-only/time pin/planned integer validation",
          "lost committed ACK retries same key, no duplicate and input retained",
          "R07 create/reload/counts/state/JST, no R08/start/register controls",
          "refresh failure keeps prior rows; desktop/mobile geometry",
          "mock empty-selection and learner UI gates; backend real authorization checked separately",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Run management browser: PASS (real API creation/lost ACK/retry/list; R06/R07 desktop/mobile, count/state/time and role gates)",
  );
} finally {
  await browser.close();
  await vite.close();
}
