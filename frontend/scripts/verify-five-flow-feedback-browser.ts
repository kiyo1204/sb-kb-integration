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
let protocol = "STAGE1_5";
let concepts: {
  id: string;
  mapId: string;
  label: string;
  positionX: number;
  positionY: number;
  mergedIntoConceptId: string | null;
  isMergeResult?: boolean;
}[] = [
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
  const deletes: string[] = [];
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "stage1-access-token",
      "mock-ui-only-1234567890123456789012345",
    ),
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (
      path.startsWith("/api/concepts/") &&
      route.request().method() === "DELETE"
    ) {
      const target = path.split("/").at(-1)!;
      deletes.push(target);
      concepts = concepts.filter((c) => c.id !== target);
      const make = (suffix: string, label: string, isMergeResult = false) => ({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa" + suffix,
        mapId: mid,
        label,
        positionX: 100 + (Number(suffix) - 7) * 340,
        positionY: 100,
        mergedIntoConceptId: null,
        isMergeResult,
      });
      concepts.push(
        ...(target.endsWith("06")
          ? [make("07", "TEST-ONLY inner M", true), make("08", "TEST-ONLY C")]
          : [make("09", "TEST-ONLY A"), make("10", "TEST-ONLY B")]),
      );
      return route.fulfill({ json: { id: target, mergeReleased: true } });
    }
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
          sessionProtocolKey: protocol,
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
            protocolKey: protocol,
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
  concepts = [
    {
      ...concepts[0]!,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06",
      label: "TEST-ONLY outer N",
      isMergeResult: true,
    },
  ];
  await page.goto(url);
  for (const label of ["TEST-ONLY outer N", "TEST-ONLY inner M"]) {
    await page.getByText(label, { exact: true }).click();
    await page.locator("#map-editor-concept-edit-label").waitFor();
    const deletion = page.getByRole("button", { name: "削除", exact: true });
    assert.equal(await deletion.isEnabled(), true);
    page.once("dialog", async (dialog) => {
      assert.ok(dialog.message().includes("1段階だけ解除"));
      assert.ok(dialog.message().includes("後発リンクは削除"));
      await dialog.accept();
    });
    await deletion.click();
    await page
      .getByText(
        label === "TEST-ONLY outer N" ? "TEST-ONLY inner M" : "TEST-ONLY A",
        { exact: true },
      )
      .waitFor();
    assert.equal(await page.getByText(label, { exact: true }).count(), 0);
  }
  assert.equal(deletes.length, 2);
  await page.getByText("TEST-ONLY B", { exact: true }).waitFor();
  await page.getByText("TEST-ONLY C", { exact: true }).waitFor();
  for (const old of ["STAGE1_4", "STAGE1_6"]) {
    protocol = old;
    concepts = [
      {
        ...concepts[0]!,
        label: "TEST-ONLY legacy merged",
        isMergeResult: true,
      },
    ];
    await page.goto(url);
    await page.getByText("TEST-ONLY legacy merged", { exact: true }).click();
    await page.locator("#map-editor-concept-edit-label").waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "削除", exact: true })
        .isDisabled(),
      true,
    );
  }
  console.log(
    "Mock browser: KB freshness; integration no-feedback; nested Merge release confirmation/reload; legacy Merge deletion protected: PASS",
  );
} finally {
  await browser.close();
  await vite.close();
}
