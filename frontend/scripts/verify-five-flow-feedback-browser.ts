// Mock API fixture only; these labels and timing do not define experiment conditions.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
const sid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
  mid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
  stage = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03",
  kit = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04";
let kind: "KB" | "INTEGRATION" = "KB",
  stale = false,
  checks = 0;
const concepts = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05",
    mapId: mid,
    label: "TEST-ONLY UI",
    positionX: 100,
    positionY: 100,
    mergedIntoConceptId: null,
  },
];
const signature = JSON.stringify([
  mid,
  kit,
  concepts.map((c) => [c.id, c.label]),
  [],
]);
try {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "stage1-access-token",
      "mock-ui-only-1234567890123456789012345",
    ),
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me")
      return route.fulfill({
        json: { role: "learner", sessionId: sid, kitId: kit },
      });
    if (path === `/api/maps/${mid}`)
      return route.fulfill({
        json: {
          id: mid,
          type: kind,
          status: "DRAFT",
          basedOnMapId: null,
          kitDefinitionId: kit,
          kitDefinitionName: "TEST-ONLY Kit",
          sessionId: sid,
          sessionStageId: stage,
          sessionProtocolKey: "STAGE1_5",
          concepts,
          links: [],
          kitConcepts: [],
          kitLinks: [],
        },
      });
    if (path === `/api/sessions/${sid}/flow`) {
      const current = {
        id: stage,
        stageType: kind === "KB" ? "KB_MAP" : "INTEGRATION_MAP",
        status: "IN_PROGRESS",
        startedAt: new Date().toISOString(),
        orderIndex: kind === "KB" ? 2 : 3,
        mapId: mid,
      };
      return route.fulfill({
        json: {
          session: {
            id: sid,
            status: "IN_PROGRESS",
            protocolKey: "STAGE1_5",
            studyGroup: null,
            groupActivitySeconds: 1800,
          },
          stages: [current],
          currentStage: current,
          serverNow: new Date().toISOString(),
        },
      });
    }
    if (path === `/api/maps/${mid}/access`)
      return route.fulfill({
        json: {
          allowed: true,
          serverNow: new Date().toISOString(),
          expiresAt: null,
        },
      });
    if (path === `/api/maps/${mid}/undo-redo`)
      return route.fulfill({
        json: {
          status: "AVAILABLE",
          canUndo: false,
          canRedo: false,
          sequenceNumber: 0,
        },
      });
    if (path === `/api/maps/${mid}/kit-feedback`) {
      checks++;
      return route.fulfill({
        json: {
          configurationComplete: true,
          matched: true,
          message: "TEST-ONLY matched result",
          mapSignature: signature,
          concepts: { matched: 1, total: 1 },
          relations: { matched: 0, total: 0 },
          logSaved: true,
        },
      });
    }
    if (path === `/api/maps/${mid}/kit-graph-signature`)
      return route.fulfill({
        json: { mapSignature: stale ? signature + "changed" : signature },
      });
    if (path.endsWith("/kit-feedback/display") || path.endsWith("/events"))
      return route.fulfill({ status: 201, json: { logSaved: true } });
    if (path.endsWith("/delivery-status"))
      return route.fulfill({
        json: {
          clientReported: [],
          serverVerified: [],
          missingIsUnknown: true,
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: "test_only_not_found" },
    });
  });
  const url = vite.resolvedUrls!.local[0]! + "maps/" + mid;
  await page.goto(url);
  await page
    .getByRole("button", { name: "一致状況を確認", exact: true })
    .click();
  await page
    .locator("dialog[open]")
    .getByText("TEST-ONLY matched result", { exact: true })
    .waitFor();
  await page
    .locator("dialog[open]")
    .getByText("前回の結果は最新です。", { exact: true })
    .waitFor();
  stale = true;
  const refreshed = page.waitForResponse((r) =>
    r.url().endsWith("/kit-graph-signature"),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await refreshed;
  await page
    .locator("dialog[open]")
    .getByText("前回の結果は古くなっています。", { exact: true })
    .waitFor();
  kind = "INTEGRATION";
  await page.goto(url);
  await page.getByRole("button", { name: "＋ 概念", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "一致状況を確認", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .locator(".kit-feedback-actions,dialog[open].kit-feedback-dialog")
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "＋ 概念", exact: true })
      .isEnabled(),
    true,
  );
  assert.equal(
    checks,
    1,
    "integration must not request or display KB feedback",
  );
  console.log(
    "New-five-flow mock browser: KB result/current-to-stale; integration editing shown without feedback UI/requests: PASS",
  );
} finally {
  await browser.close();
  await vite.close();
}
