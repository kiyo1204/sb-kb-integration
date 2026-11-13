// TEST ONLY. Actual isolated API; no participant code or client secret is logged
// or included in screenshots. Learning remains deliberately unavailable.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
  token = process.env.RESEARCHER_API_TOKEN!,
  root = "/research/experiment-runs";
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
const goal = await api("/research/goal-maps/import", "POST", {
  format: "sb-kb-goal-map",
  schemaVersion: 1,
  goalMap: {
    title: "TEST ONLY R08 browser " + randomUUID(),
    concepts: [{ id: "a", label: "TEST ONLY seed", position: { x: 0, y: 0 } }],
    links: [],
  },
});
const asset = (await api("/research/materials/assets")).assets.find(
    (a: { kitId: string }) => a.kitId === goal.kitDefinitionId,
  ),
  draft = await api("/research/materials", "POST", {});
const body = {
  title: "TEST ONLY R08 browser material",
  researcherDescription: "",
  videoRef: "/test-only.mp4",
  sbInstructions: "TEST ONLY SB",
  kbInstructions: "TEST ONLY KB",
  integrationInstructions: "TEST ONLY integration",
  kitId: goal.kitDefinitionId,
  seedConceptItemIds: [asset.concepts[0].id],
  integrationSeconds: 601,
};
const saved = await api(`/research/materials/${draft.id}`, "PUT", {
    expectedRevision: draft.editRevision,
    body,
  }),
  material = await api(`/research/materials/${draft.id}/publish`, "POST", {
    expectedRevision: saved.editRevision,
  });
const run = await api(root, "POST", {
  name: "TEST ONLY R08 " + randomUUID().slice(0, 8),
  catalogVersionId: material.id,
  plannedParticipants: 1,
});
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL ?? "msedge",
    headless: true,
  }),
  dir = process.env.ACCESS_SCREENSHOT_DIR ?? join(tmpdir(), "sbkb-r08-preview");
await mkdir(dir, { recursive: true });
try {
  const researcherPage = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  await researcherPage.addInitScript(
    (t) => sessionStorage.setItem("stage1-access-token", t),
    token,
  );
  let loseRegistration = true,
    registeredSid = "",
    firstCode = "";
  const registrationKeys: string[] = [];
  await researcherPage.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()),
      response = await route.fetch({ url: base + url.pathname + url.search });
    if (
      url.pathname === `/api${root}/${run.id}/participants` &&
      route.request().method() === "POST"
    ) {
      registrationKeys.push(route.request().headers()["idempotency-key"]!);
      if (loseRegistration) {
        loseRegistration = false;
        assert.equal(response.status(), 201);
        const d = await response.json();
        registeredSid = d.sessionId;
        firstCode = d.issuedCode;
        return route.abort("failed");
      }
    }
    return route.fulfill({ response });
  });
  const origin = vite.resolvedUrls!.local[0]!;
  await researcherPage.goto(origin + "research/experiment-runs");
  await researcherPage
    .getByRole("row")
    .filter({ hasText: run.name })
    .getByRole("link", { name: "実施詳細", exact: true })
    .click();
  await researcherPage.locator("#participant-label").waitFor();
  assert.equal(
    await researcherPage
      .getByRole("button", { name: "実施開始（未公開）", exact: true })
      .isDisabled(),
    true,
  );
  await researcherPage
    .locator("#participant-label")
    .fill("TEST ONLY browser P1");
  await researcherPage
    .getByRole("button", {
      name: "＋ 参加者Session・検証用コードを追加",
      exact: true,
    })
    .click();
  await researcherPage
    .getByRole("alert")
    .filter({ hasText: "保存状態を確認できません" })
    .waitFor();
  assert.equal(
    await researcherPage.locator("#participant-label").inputValue(),
    "TEST ONLY browser P1",
  );
  await researcherPage
    .getByRole("button", {
      name: "＋ 参加者Session・検証用コードを追加",
      exact: true,
    })
    .click();
  await researcherPage
    .getByRole("status")
    .filter({ hasText: "受付済みの操作" })
    .waitFor();
  assert.equal(registrationKeys.length, 2);
  assert.equal(registrationKeys[0], registrationKeys[1]);
  assert.equal(await researcherPage.locator("dialog").count(), 0);
  let row = researcherPage
    .getByRole("row")
    .filter({ hasText: "TEST ONLY browser P1" });
  await row.locator("summary").click();
  researcherPage.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "コード再発行", exact: true }).click();
  const issued = researcherPage.locator(".issued-participant-code");
  await issued.waitFor();
  const code = await issued.innerText();
  assert.equal(code.length, 43);
  assert.ok(code !== firstCode);
  await researcherPage
    .getByRole("button", { name: "コード表示を閉じる", exact: true })
    .click();
  assert.equal(
    (await api(`${root}/${run.id}/participants`)).participants[0].id,
    registeredSid,
  );
  async function learner() {
    const context = await browser.newContext({
      viewport: { width: 1100, height: 800 },
    });
    const page = await context.newPage();
    let learningCalls = 0;
    await page.addInitScript(
      (t) => sessionStorage.setItem("stage1-access-token", t),
      code,
    );
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (/^\/api\/(sessions|session-stages|maps)\//.test(url.pathname))
        learningCalls++;
      const r = await route.fetch({ url: base + url.pathname + url.search });
      return route.fulfill({ response: r });
    });
    await page.goto(origin + `sessions/${registeredSid}`);
    await page
      .getByRole("heading", { name: "学習者フローはまだ利用できません" })
      .waitFor();
    await page.locator("section code").waitFor();
    await page
      .getByText("参加者向けの公開を停止しています。", { exact: false })
      .waitFor();
    assert.equal(
      await page
        .getByRole("heading", { name: "実施の開始を待っています", exact: true })
        .count(),
      0,
    );
    assert.equal(learningCalls, 0);
    assert.equal(await page.locator("svg,canvas").count(), 0);
    return { context, page };
  }
  const a = await learner(),
    clientA = await a.page.locator("section code").innerText();
  await a.page
    .getByText("コードの確認と、この画面の端末登録は完了しています。", {
      exact: false,
    })
    .waitFor();
  await a.page.getByRole("button", { name: "接続状態を更新" }).click();
  await a.page
    .getByText("コードの確認と、この画面の端末登録は完了しています。", {
      exact: false,
    })
    .waitFor();
  assert.equal(await a.page.locator("section code").innerText(), clientA);
  const b = await learner(),
    clientB = await b.page.locator("section code").innerText();
  await b.page
    .getByText("別の画面が登録されています。", { exact: false })
    .waitFor();
  await b.page
    .getByRole("heading", { name: "この画面では利用できません", exact: true })
    .waitFor();
  assert.notEqual(clientA, clientB);
  await researcherPage
    .getByRole("button", { name: "状態を更新", exact: true })
    .click();
  await row
    .locator(`option[value="${clientB}"]`)
    .waitFor({ state: "attached" });
  await row.locator("select").selectOption(clientB);
  researcherPage.once("dialog", (d) => d.accept());
  await row
    .getByRole("button", { name: "利用画面を切替", exact: true })
    .click();
  await researcherPage
    .getByRole("status")
    .filter({ hasText: "管理操作を保存" })
    .waitFor();
  await a.page.getByRole("button", { name: "接続状態を更新" }).click();
  await a.page
    .getByText("別の画面が登録されています。", { exact: false })
    .waitFor();
  await b.page.getByRole("button", { name: "接続状態を更新" }).click();
  await b.page
    .getByText("コードの確認と、この画面の端末登録は完了しています。", {
      exact: false,
    })
    .waitFor();
  await researcherPage
    .locator("#participant-label")
    .fill("TEST ONLY browser P2");
  await researcherPage
    .getByRole("button", {
      name: "＋ 参加者Session・検証用コードを追加",
      exact: true,
    })
    .click();
  await researcherPage.locator(".issued-participant-code").waitFor();
  await researcherPage
    .getByRole("button", { name: "コード表示を閉じる", exact: true })
    .click();
  await researcherPage
    .getByRole("row")
    .filter({ hasText: "TEST ONLY browser P2" })
    .waitFor();
  assert.equal(
    (await api(`${root}/${run.id}/participants`)).participants.length,
    2,
  );
  assert.equal(
    await researcherPage
      .getByRole("button", { name: "実施開始（未公開）", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await researcherPage.locator("svg,canvas").count(), 0);
  await researcherPage.screenshot({
    path: join(dir, "r08-desktop.png"),
    fullPage: true,
  });
  await researcherPage.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await researcherPage
      .locator(".participants-table")
      .evaluate((table) => table.getBoundingClientRect().width >= 1070),
    "mobile table preserves usable column widths",
  );
  assert.ok(
    await researcherPage
      .locator(".material-table-scroll")
      .evaluate((scroll) => scroll.scrollWidth > scroll.clientWidth),
    "mobile participant table scrolls within its own region",
  );
  assert.ok(
    await researcherPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  await researcherPage.screenshot({
    path: join(dir, "r08-mobile.png"),
    fullPage: true,
  });
  await a.page.screenshot({
    path: join(dir, "learner-unpublished-gate.png"),
    fullPage: true,
  });
  // Reissue via UI keeps Session identity; the earlier learner code is denied.
  row = researcherPage
    .getByRole("row")
    .filter({ hasText: "TEST ONLY browser P1" });
  researcherPage.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "コード再発行", exact: true }).click();
  await researcherPage.locator(".issued-participant-code").waitFor();
  await researcherPage
    .getByRole("button", { name: "コード表示を閉じる", exact: true })
    .click();
  await a.page.getByRole("button", { name: "接続状態を更新" }).click();
  await a.page
    .getByRole("alert")
    .filter({ hasText: "コードまたは接続状態" })
    .waitFor();
  assert.equal(
    (await api(`${root}/${run.id}/participants`)).participants[0].id,
    registeredSid,
  );
  await a.context.close();
  await b.context.close();
  await writeFile(
    verificationReportPath("invariants").replace(
      /invariants\.json$/,
      "participant-access-browser.json",
    ),
    JSON.stringify(
      {
        syntheticOnly: true,
        realApi: true,
        checks: [
          "R07 to R08, unpublished start, no live Map",
          "lost committed registration ACK, same-key retry without duplicate/plaintext replay",
          "one-time UI reissue, two pages pending/owned, researcher switch and old-page rejection",
          "registration beyond planned, desktop/mobile, reissue keeps Session and old code cannot authenticate",
        ],
        screenshotsContainCredentials: false,
        startEnabled: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Participant access browser: PASS (real R08/code response loss/reissue/client switch, unpublished learner gate, desktop/mobile; no codes in screenshots)",
  );
} finally {
  await browser.close();
  await vite.close();
}
