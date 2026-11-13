// TEST ONLY synthetic content; actual isolated API. No R05 Session creation.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
async function request(path: string, method = "GET", body?: unknown) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(r.ok, method + " " + path + " status " + r.status);
  return r.json();
}
const fixture = await request("/research/goal-maps/import", "POST", {
  format: "sb-kb-goal-map",
  schemaVersion: 1,
  goalMap: {
    title: "TEST ONLY browser asset " + randomUUID(),
    concepts: [
      { id: "a", label: "TEST ONLY browser A", position: { x: 0, y: 0 } },
      { id: "b", label: "TEST ONLY browser B", position: { x: 100, y: 80 } },
    ],
    links: [
      {
        id: "ab",
        label: "TEST ONLY browser relation",
        sourceId: "a",
        targetId: "b",
        labelPosition: null,
      },
    ],
  },
});
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
const screenshots =
  process.env.MATERIAL_SCREENSHOT_DIR ??
  join(tmpdir(), "sbkb-materials-preview");
await mkdir(screenshots, { recursive: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.name));
  await page.addInitScript(
    (value) => sessionStorage.setItem("stage1-access-token", value),
    token,
  );
  let failSave = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (
      failSave &&
      route.request().method() === "PUT" &&
      url.pathname.startsWith("/api/research/materials/")
    ) {
      failSave = false;
      return route.fulfill({
        status: 503,
        json: {
          error: "material_storage_unavailable",
          message:
            "教材の保存状態を確認できません。時間をおいて再試行してください。",
        },
      });
    }
    const response = await route.fetch({
      url: base + url.pathname + url.search,
    });
    return route.fulfill({ response });
  });
  const origin = vite.resolvedUrls!.local[0]!;
  const nav = (name: string) =>
    page
      .getByRole("navigation", { name: "教材の編集項目" })
      .getByRole("button", { name, exact: true })
      .click();
  await page.goto(origin + "research/materials");
  await page
    .getByRole("button", { name: "教材の下書きを作成", exact: true })
    .click();
  await page.waitForURL(/\/research\/materials\/[a-f0-9-]{36}$/);
  const id = page.url().split("/").at(-1)!;
  await page.locator("#material-title").waitFor();
  assert.equal(await page.locator("#material-title").inputValue(), "");
  assert.equal(
    await page
      .locator(".material-actions")
      .getByRole("button", { name: "テスト実行", exact: true })
      .isDisabled(),
    true,
  );
  await nav("統合 課題説明");
  assert.equal(await page.locator("#material-time").inputValue(), "");
  await nav("基本情報");
  await page.locator("#material-title").fill("TEST ONLY browser material");
  await page.locator("#material-description").fill("TEST ONLY 研究者向け説明");
  await page.getByRole("button", { name: "下書き保存", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "下書きを保存しました" })
    .waitFor();
  assert.equal(
    (await request(`/research/materials/${id}`)).body.integrationSeconds,
    null,
  );
  await page.getByRole("button", { name: "完成チェック", exact: true }).click();
  await page.locator(".material-issue-details summary").waitFor();
  await page.screenshot({
    path: join(screenshots, "r04-missing.png"),
    fullPage: true,
  });
  await page.locator(".material-issue-details summary").click();
  await page
    .locator(".material-issues")
    .getByRole("button", { name: "動画参照を設定してください。", exact: true })
    .click();
  await page.waitForFunction(
    () => document.activeElement?.id === "material-video",
  );
  await page.locator("#material-video").fill("/test-only-browser.mp4");
  await nav("SB 課題説明");
  await page.locator("#material-sb").fill("TEST ONLY SB課題説明");
  await nav("KB 課題説明");
  await page.locator("#material-kb").fill("TEST ONLY KB課題説明");
  await nav("統合 課題説明");
  await page.locator("#material-integration").fill("TEST ONLY 統合課題説明");
  await page.locator("#material-time").fill("601");
  await nav("ゴールマップ・Kit");
  await page.locator("#material-kit").selectOption(fixture.kitDefinitionId);
  await nav("初期概念");
  await page
    .getByRole("checkbox", { name: "TEST ONLY browser A", exact: true })
    .check();
  await page.getByRole("button", { name: "完成チェック", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLButtonElement>(".material-complete")
        ?.disabled === false,
  );
  await nav("基本情報");
  await page.screenshot({
    path: join(screenshots, "r04-draft-desktop.png"),
    fullPage: true,
  });
  const dimensions = await page
    .locator(".material-editor-grid")
    .evaluate((el) => {
      const children = [...el.children].map((x) => x.getBoundingClientRect());
      return children.map((x) => ({ x: x.x, width: x.width }));
    });
  assert.ok(
    dimensions[0].x < dimensions[1].x && dimensions[1].x < dimensions[2].x,
    "desktop follows R04 navigation/editor/checklist columns",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "完成登録", exact: true }).click();
  assert.equal((await request(`/research/materials/${id}`)).state, "DRAFT");
  page.once("dialog", async (dialog) => {
    assert.match(dialog.message(), /未実施でも完成登録/);
    await dialog.accept();
  });
  await page.getByRole("button", { name: "完成登録", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "完成登録しました" })
    .waitFor();
  assert.equal(await page.locator("#material-title").isDisabled(), true);
  assert.equal((await request(`/research/materials/${id}`)).state, "PUBLISHED");
  await page.screenshot({
    path: join(screenshots, "r04-published-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "次版の下書きを作成", exact: true })
    .click();
  await page.waitForURL((url) => url.pathname !== `/research/materials/${id}`);
  const nextId = page.url().split("/").at(-1)!;
  await page.locator("#material-title").waitFor();
  await page
    .locator("#material-description")
    .fill("TEST ONLY 次版の未保存説明");
  failSave = true;
  await page.getByRole("button", { name: "下書き保存", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "保存状態を確認できません" })
    .waitFor();
  assert.equal(
    await page.locator("#material-description").inputValue(),
    "TEST ONLY 次版の未保存説明",
  );
  assert.equal(
    (await request(`/research/materials/${nextId}`)).body.researcherDescription,
    "TEST ONLY 研究者向け説明",
  );
  await page.getByRole("button", { name: "下書き保存", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "下書きを保存しました" })
    .waitFor();
  const current = await request(`/research/materials/${nextId}`);
  await request(`/research/materials/${nextId}`, "PUT", {
    expectedRevision: current.editRevision,
    body: { ...current.body, title: "TEST ONLY concurrent saved" },
  });
  await page.locator("#material-description").fill("TEST ONLY 古い画面の入力");
  await page.getByRole("button", { name: "下書き保存", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "別の保存または更新" })
    .waitFor();
  assert.equal(
    await page.locator("#material-description").inputValue(),
    "TEST ONLY 古い画面の入力",
  );
  assert.equal(
    (await request(`/research/materials/${nextId}`)).body.title,
    "TEST ONLY concurrent saved",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await page.locator("#material-title").waitFor();
  assert.equal(
    await page.locator("#material-title").inputValue(),
    "TEST ONLY concurrent saved",
  );
  assert.equal(
    (await request(`/research/materials/${id}`)).body.researcherDescription,
    "TEST ONLY 研究者向け説明",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: join(screenshots, "r04-mobile.png"),
    fullPage: true,
  });
  await page.goto(origin + "research/materials");
  await page.getByRole("heading", { name: "教材一覧", exact: true }).waitFor();
  await page.locator(`a[href="/research/materials/${nextId}"]`).waitFor();
  const series = page
    .locator(".material-series")
    .filter({ has: page.locator(`a[href="/research/materials/${nextId}"]`) });
  assert.equal(await series.locator("tbody tr").count(), 2);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.screenshot({
    path: join(screenshots, "r03-list.png"),
    fullPage: true,
  });
  const denied = await browser.newPage();
  let materialReads = 0;
  await denied.addInitScript(() =>
    sessionStorage.setItem(
      "stage1-access-token",
      "TEST-ONLY-learner-ui-gate-0000000000",
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
    if (path.includes("/materials")) materialReads++;
    return route.fulfill({ status: 403, json: { error: "forbidden" } });
  });
  await denied.goto(origin + `research/materials/${id}`);
  await denied
    .getByRole("heading", { name: "ページが見つかりません" })
    .waitFor();
  assert.equal(await denied.locator("#material-title").count(), 0);
  assert.equal(materialReads, 0);
  assert.deepEqual(pageErrors, []);
  await writeFile(
    verificationReportPath("invariants").replace(
      /invariants\.json$/,
      "materials-browser.json",
    ),
    JSON.stringify(
      {
        syntheticOnly: true,
        realApi: true,
        checks: [
          "R03 series/draft/published list",
          "R04 three columns, no defaults, missing-field focus",
          "draft save, completion check, optional-test confirmation and immutable completed view",
          "next draft, failed save retained input, stale update refused",
          "desktop/mobile geometry and researcher-only UI gate",
        ],
        screenshots: [
          "r03-list.png",
          "r04-missing.png",
          "r04-draft-desktop.png",
          "r04-published-desktop.png",
          "r04-mobile.png",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Material catalog browser: PASS (real isolated API; draft/check/publish/next, focus, safe failures, role gate, desktop/mobile)",
  );
} finally {
  await browser.close();
  await vite.close();
}
