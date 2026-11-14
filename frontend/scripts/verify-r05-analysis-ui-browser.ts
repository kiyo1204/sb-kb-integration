// Synthetic UI fixtures only: this check does not connect to an API server or database.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Page, type Route } from "playwright";
import { createServer } from "vite";

const ids = {
  version: "91000000-0000-4000-8000-000000000001",
  run: "91000000-0000-4000-8000-000000000002",
  session: "91000000-0000-4000-8000-000000000003",
  priorMap: "91000000-0000-4000-8000-000000000004",
  integrationMap: "91000000-0000-4000-8000-000000000005",
  conceptA: "91000000-0000-4000-8000-000000000006",
  conceptB: "91000000-0000-4000-8000-000000000007",
  link: "91000000-0000-4000-8000-000000000008",
  operation: "91000000-0000-4000-8000-000000000009",
};
const recordedAt = "2026-11-14T03:00:00.000Z";
const snapshot = (mapId: string, mapType: "PRIOR" | "INTEGRATION") => ({
  snapshotVersion: 1,
  mapId,
  mapType,
  concepts: [
    {
      id: ids.conceptA,
      mapId,
      label: "合成概念 A",
      positionX: 180,
      positionY: 160,
      mergedIntoConceptId: null,
      provenance: [],
    },
    {
      id: ids.conceptB,
      mapId,
      label: "合成概念 B",
      positionX: 520,
      positionY: 160,
      mergedIntoConceptId: null,
      provenance: [],
    },
  ],
  links: [
    {
      id: ids.link,
      mapId,
      label: "合成関係",
      sourceConceptId: ids.conceptA,
      targetConceptId: ids.conceptB,
      provenance: [],
    },
  ],
});
const prior = snapshot(ids.priorMap, "PRIOR");
const integration = snapshot(ids.integrationMap, "INTEGRATION");
const material = {
  body: {
    title: "合成教材 R05",
    videoRef: "",
    sbInstructions: "合成SB案内",
    kbInstructions: "合成KB案内",
    integrationInstructions: "合成統合案内",
    integrationSeconds: 600,
    seedConceptItemIds: [],
  },
  concepts: [],
  links: [],
};
const sbMap = {
  id: ids.priorMap,
  map_kind: "SB",
  state: prior,
  submitted_at: null,
};
const emptyR05 = () => ({
  material,
  run: null,
  acceptance: null,
  data: null,
  audit: [],
});
const workingR05 = () => ({
  material,
  run: {
    id: ids.run,
    phase: "SB",
    revision: 2,
    integrationStartedAt: null,
    lastCheck: null,
  },
  acceptance: null,
  data: {
    maps: [sbMap],
    history: [
      {
        id: ids.operation,
        test_map_id: ids.priorMap,
        recorded_at: recordedAt,
        operation: {
          operationType: "MOVE_CONCEPT",
          before: prior,
          after: prior,
        },
      },
    ],
  },
  audit: [
    {
      action: "MOVE_CONCEPT",
      http_status: 200,
      outcome: "SUCCESS",
      reason_code: "accepted",
      recorded_at: recordedAt,
    },
  ],
});
const submittedR05 = () => {
  const value = workingR05();
  return {
    ...value,
    run: { ...value.run, phase: "KB", revision: 3 },
    data: value.data
      ? {
          ...value.data,
          maps: value.data.maps.map((map) => ({
            ...map,
            submitted_at: recordedAt,
          })),
        }
      : null,
  };
};
const availableState = {
  status: "AVAILABLE",
  reason: null,
  state: integration,
  capturedAt: recordedAt,
  submittedAt: null,
  eventId: null,
};
const unavailableState = {
  status: "UNAVAILABLE",
  reason: "NOT_SUBMITTED",
  state: null,
  capturedAt: null,
  submittedAt: null,
  eventId: null,
};
const analysis = {
  experiment: {
    runId: ids.run,
    materialVersionId: ids.version,
    materialTitle: "合成教材 R05",
    materialVersion: 2,
    integrationSeconds: 600,
  },
  integrationStates: {
    mapId: ids.integrationMap,
    start: availableState,
    submission: unavailableState,
  },
  session: {
    id: ids.session,
    participantCode: "SYNTHETIC-P01",
    protocolKey: "SBKB_INTEGRATION_V1",
    status: "IN_PROGRESS",
  },
  stages: [
    {
      id: "91000000-0000-4000-8000-000000000010",
      stageType: "LESSON",
      orderIndex: 1,
      status: "COMPLETED",
      startedAt: recordedAt,
      completedAt: recordedAt,
    },
    {
      id: "91000000-0000-4000-8000-000000000011",
      stageType: "PRIOR_MAP",
      orderIndex: 2,
      status: "IN_PROGRESS",
      startedAt: recordedAt,
      completedAt: null,
    },
  ],
  maps: [
    {
      id: ids.priorMap,
      type: "PRIOR",
      status: "SUBMITTED",
      researchRole: "PRIOR",
      concepts: prior.concepts,
      links: prior.links,
      historyReplayStatus: "AVAILABLE",
      basedOnMapId: null,
      kitDefinitionId: null,
      conceptProvenance: [{ conceptId: ids.conceptA, relationType: "SEED" }],
      linkProvenance: [],
    },
    {
      id: ids.integrationMap,
      type: "INTEGRATION",
      status: "DRAFT",
      researchRole: "INTEGRATION",
      concepts: integration.concepts,
      links: integration.links,
      historyReplayStatus: "UNAVAILABLE",
      basedOnMapId: ids.priorMap,
      kitDefinitionId: null,
      conceptProvenance: [],
      linkProvenance: [],
    },
  ],
  operations: [
    {
      id: ids.operation,
      mapId: ids.priorMap,
      mapType: "PRIOR",
      researchRole: "PRIOR",
      operationType: "MOVE_CONCEPT",
      targetId: ids.conceptA,
      targetType: "CONCEPT",
      sequenceNumber: "1",
      relatedOperationLogId: null,
      relatedLegacyOperationLogId: null,
      historySource: "EVENT",
      eventId: ids.operation,
      serverTimestamp: recordedAt,
      elapsedMs: 4200,
      before: prior,
      after: prior,
      outcome: "SUCCESS",
      reasonCode: "accepted",
      eventType: "MAP_OPERATION",
      relatedEventId: null,
      actorType: "PARTICIPANT",
      targetLabel: "合成概念 A",
    },
  ],
  operationCounts: { MOVE_CONCEPT: 1 },
  features: {},
  propositionEvaluations: [],
  reflectionNotes: [],
  limitations: ["Counts indicate operations, not learning quality."],
};

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function setNewUiEnabled(page: Page, enabled: boolean) {
  await page.evaluate((value) => {
    document.documentElement.toggleAttribute("data-r05-analysis-ui", value);
  }, enabled);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

async function readLayout(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyHeight: document.body.scrollHeight,
    cardCount: document.querySelectorAll(".session-card").length,
    buttonCount: document.querySelectorAll("button").length,
    canvasCount: document.querySelectorAll(".concept-canvas").length,
  }));
}

async function installSyntheticApi(
  page: Page,
  mode:
    | "r05-empty"
    | "r05-working"
    | "r05-submitted"
    | "r05-loading"
    | "r05-error"
    | "analysis"
    | "analysis-empty"
    | "analysis-loading"
    | "analysis-error",
) {
  let currentR05: Record<string, unknown> =
    mode === "r05-working"
      ? workingR05()
      : mode === "r05-submitted"
        ? submittedR05()
        : emptyR05();
  await page.addInitScript(() =>
    sessionStorage.setItem("stage1-access-token", "SYNTHETIC_ONLY"),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") return fulfillJson(route, { role: "researcher" });
    if (path.endsWith("/delivery-status"))
      return fulfillJson(route, { clientReported: [], serverVerified: [] });
    if (path === `/api/research/materials/${ids.version}/r05`) {
      if (request.method() === "GET") {
        if (mode === "r05-loading") return new Promise<void>(() => {});
        if (mode === "r05-error")
          return fulfillJson(route, { error: "synthetic_unavailable" }, 503);
        return fulfillJson(route, currentR05);
      }
      currentR05 = {
        ...emptyR05(),
        run: {
          id: ids.run,
          phase: "LESSON",
          revision: 1,
          integrationStartedAt: null,
          lastCheck: null,
        },
      };
      return fulfillJson(route, { accepted: true }, 201);
    }
    if (path.endsWith(`/r05/${ids.run}/operations`)) {
      const command = request.postDataJSON() as { action?: string };
      if (command.action === "LESSON_COMPLETE") currentR05 = workingR05();
      return fulfillJson(route, { outcome: { matched: true } });
    }
    if (path === `/api/research/stage1/sessions/${ids.session}/analysis`) {
      if (mode === "analysis-loading") return new Promise<void>(() => {});
      if (mode === "analysis-error")
        return fulfillJson(route, { error: "synthetic_unavailable" }, 503);
      const value =
        mode === "analysis-empty"
          ? {
              ...analysis,
              stages: [],
              maps: [],
              operations: [],
              operationCounts: {},
              integrationStates: {
                mapId: null,
                start: {
                  ...unavailableState,
                  reason: "INITIAL_SNAPSHOT_MISSING_OR_INVALID",
                },
                submission: unavailableState,
              },
            }
          : analysis;
      return fulfillJson(route, value);
    }
    if (path.startsWith(`/api/research/stage1/sessions/${ids.session}/maps/`))
      return fulfillJson(route, {
        status: "UNAVAILABLE",
        reason: "INITIAL_SNAPSHOT_MISSING_OR_INVALID",
        mapId: ids.priorMap,
        mapType: "PRIOR",
        sequenceNumber: 0,
        operation: null,
        beforeState: null,
        afterState: null,
      });
    if (path.endsWith("/export") || path.endsWith(".csv"))
      return route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: "synthetic-only",
      });
    return fulfillJson(route, { error: "not_found" }, 404);
  });
}

const outputDirectory = join(tmpdir(), "sbkb-r05-analysis-ui-20261114");
await mkdir(outputDirectory, { recursive: true });
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen();
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL ?? "msedge",
    headless: true,
  });
  const metrics: Array<Record<string, unknown>> = [];
  const scenarios: Array<{
    name: string;
    path: string;
    mode: Parameters<typeof installSyntheticApi>[1];
    expectedText: string;
  }> = [
    {
      name: "r05-empty",
      path: `/research/materials/${ids.version}/test`,
      mode: "r05-empty",
      expectedText: "テスト未実施",
    },
    {
      name: "r05-loading",
      path: `/research/materials/${ids.version}/test`,
      mode: "r05-loading",
      expectedText: "読み込み中…",
    },
    {
      name: "r05-error",
      path: `/research/materials/${ids.version}/test`,
      mode: "r05-error",
      expectedText: "テスト状態を読み込めません",
    },
    {
      name: "r05-unsubmitted",
      path: `/research/materials/${ids.version}/test`,
      mode: "r05-working",
      expectedText: "SB作成",
    },
    {
      name: "r05-submitted",
      path: `/research/materials/${ids.version}/test`,
      mode: "r05-submitted",
      expectedText: "KB再構成",
    },
    {
      name: "analysis-mixed",
      path: `/research/stage1/${ids.session}/analysis`,
      mode: "analysis",
      expectedText: "状態記録なし／算出不可：未提出",
    },
    {
      name: "analysis-empty-missing",
      path: `/research/stage1/${ids.session}/analysis`,
      mode: "analysis-empty",
      expectedText: "INITIAL_SNAPSHOT_MISSING_OR_INVALID",
    },
    {
      name: "analysis-loading",
      path: `/research/stage1/${ids.session}/analysis`,
      mode: "analysis-loading",
      expectedText: "分析データを読み込んでいます",
    },
    {
      name: "analysis-error",
      path: `/research/stage1/${ids.session}/analysis`,
      mode: "analysis-error",
      expectedText: "分析データを取得できませんでした",
    },
  ];
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    for (const scenario of scenarios) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      page.on("pageerror", (error) =>
        console.error(
          `Synthetic page error in ${scenario.name}: ${error.name}: ${error.message}`,
        ),
      );
      page.on("console", (message) => {
        if (
          message.type() === "error" &&
          !message.text().includes("503 (Service Unavailable)")
        )
          console.error(
            `Synthetic browser error in ${scenario.name}: ${message.text().slice(0, 300)}`,
          );
      });
      await installSyntheticApi(page, scenario.mode);
      await page.goto(
        new URL(
          scenario.path.slice(1),
          vite.resolvedUrls!.local[0]!,
        ).toString(),
      );
      try {
        await page
          .getByText(scenario.expectedText, { exact: false })
          .first()
          .waitFor({ timeout: 8000 });
      } catch (error) {
        console.error(
          `Synthetic fixture did not reach ${scenario.name}; path=${new URL(page.url()).pathname}; text=${(await page.locator("body").innerText()).slice(0, 600)}`,
        );
        throw error;
      }
      if (scenario.name === "r05-unsubmitted") {
        await page.getByRole("heading", { name: "SB", exact: true }).waitFor();
        await page
          .getByRole("heading", { name: "Map・履歴の確認", exact: true })
          .waitFor();
        await page
          .getByRole("heading", { name: "保存済み操作履歴", exact: true })
          .waitFor();
        const mapStatus = page.locator(".r05-map-submit-state strong");
        assert.equal(await mapStatus.textContent(), "未提出");
        assert.equal(await mapStatus.isVisible(), true);
      }
      if (scenario.name === "r05-submitted") {
        const mapStatus = page.locator(".r05-map-submit-state strong");
        assert.equal(await mapStatus.textContent(), "提出済み");
        assert.equal(await mapStatus.isVisible(), true);
        await page.locator(".r05-map-submit-state time").waitFor();
      }
      if (scenario.name === "r05-error") {
        await page
          .getByRole("button", { name: "状態を再取得", exact: true })
          .waitFor();
        await page
          .getByText("読み込み中…", { exact: true })
          .waitFor({ state: "detached" });
      }
      if (scenario.name === "analysis-mixed") {
        await page
          .getByRole("heading", {
            name: "統合開始時・受理済み提出状態",
            exact: true,
          })
          .waitFor();
        assert.equal(
          await page.locator(".stage1-analysis-exports button").count(),
          3,
          "new-protocol JSON/CSV export actions remain present",
        );
        await page
          .getByText("Scratch-Buildの保存状態・出所情報", { exact: true })
          .click();
        await page.getByText("SUBMITTED", { exact: false }).first().waitFor();
        await page
          .getByText("状態記録なし／算出不可：未提出", { exact: true })
          .waitFor();
        await page
          .locator(".map-history-section select")
          .selectOption(ids.integrationMap);
        await page
          .getByText("このマップの操作履歴はありません。", { exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "生データJSON", exact: true })
          .focus();
        await page.keyboard.press("Tab");
        const focusOutline = await page.evaluate(
          () => getComputedStyle(document.activeElement!).outlineStyle,
        );
        assert.equal(
          focusOutline,
          "solid",
          "keyboard navigation shows the existing visible focus outline",
        );
      }
      if (scenario.name === "analysis-empty-missing") {
        await page
          .getByText("活動記録はありません。", { exact: true })
          .waitFor();
        await page
          .getByText("INITIAL_SNAPSHOT_MISSING_OR_INVALID", { exact: false })
          .first()
          .waitFor();
      }
      if (scenario.name === "analysis-error") {
        await page
          .getByRole("button", { name: "分析データを再取得", exact: true })
          .waitFor();
        await page
          .getByText("分析データを読み込んでいます…", { exact: true })
          .waitFor({ state: "detached" });
      }
      if (
        scenario.name.includes("loading") ||
        scenario.name.includes("error") ||
        scenario.name.endsWith("-empty") ||
        scenario.name === "analysis-empty-missing" ||
        scenario.name === "r05-empty" ||
        scenario.name === "r05-submitted"
      ) {
        await setNewUiEnabled(page, true);
        await page.screenshot({
          path: join(
            outputDirectory,
            `${scenario.name}-${viewport.width}x${viewport.height}.png`,
          ),
          fullPage: true,
        });
      }
      if (
        scenario.name === "r05-unsubmitted" ||
        scenario.name === "analysis-mixed"
      ) {
        const text = await page.locator("body").innerText();
        await setNewUiEnabled(page, false);
        const beforePath = join(
          outputDirectory,
          `${scenario.name}-${viewport.width}x${viewport.height}-before.png`,
        );
        await page.screenshot({ path: beforePath, fullPage: true });
        const beforeLayout = await readLayout(page);
        assert.equal(
          beforeLayout.scrollWidth <= beforeLayout.clientWidth,
          true,
          `${scenario.name} baseline horizontal overflow at ${viewport.width}`,
        );

        await setNewUiEnabled(page, true);
        const afterPath = join(
          outputDirectory,
          `${scenario.name}-${viewport.width}x${viewport.height}-after.png`,
        );
        await page.screenshot({ path: afterPath, fullPage: true });
        const afterLayout = await readLayout(page);
        assert.equal(
          afterLayout.scrollWidth <= afterLayout.clientWidth,
          true,
          `${scenario.name} horizontal overflow at ${viewport.width}`,
        );
        const actionSelector =
          scenario.name === "r05-unsubmitted"
            ? ".r05-status-card button, .r05-map-workspace button"
            : ".stage1-analysis-exports button";
        const actionBounds = await page
          .locator(actionSelector)
          .evaluateAll((elements) =>
            elements
              .filter(
                (element) =>
                  (element as HTMLElement).getClientRects().length > 0,
              )
              .map((element) => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, right: rect.right };
              }),
          );
        assert.ok(
          actionBounds.every(
            (rect) => rect.left >= 0 && rect.right <= viewport.width,
          ),
          `${scenario.name} action controls remain within the ${viewport.width}px viewport`,
        );
        metrics.push({
          name: scenario.name,
          viewport,
          before: { screenshot: beforePath, ...beforeLayout },
          after: { screenshot: afterPath, ...afterLayout },
          textLength: text.length,
        });
      }
      await context.close();
    }
  }
  await writeFile(
    join(outputDirectory, "comparison-metrics.json"),
    JSON.stringify(metrics, null, 2),
  );
  console.log(
    `R05/research analysis UI comparison: PASS (synthetic API fixtures; Edge; 1366x768 and 1440x900). Screenshots: ${outputDirectory}`,
  );
} finally {
  await browser?.close();
  await vite.close();
}
