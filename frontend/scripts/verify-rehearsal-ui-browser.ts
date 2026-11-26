// Synthetic display fixtures only. No database, credentials or real participant data.
import assert from "node:assert/strict";
import { requestDigest } from "../src/client-identity";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Locator, type Page, type Route } from "playwright";
import { createServer } from "vite";

type Scenario =
  | "login"
  | "login-error"
  | "login-pending"
  | "unpublished"
  | "waiting"
  | "ended"
  | "p02"
  | "legacy-session"
  | "researcher-populated";

const productionIntegrationMapId = "00000000-0000-4000-8000-000000000099";
const productionDuplicateConceptIds = {
  kb: "00000000-0000-4000-8000-000000000092",
  sb: "00000000-0000-4000-8000-000000000091",
  plant: "00000000-0000-4000-8000-000000000093",
  merged: "00000000-0000-4000-8000-000000000094",
};

const syntheticAccessCode = "SYNTHETIC_UI_ACCESS_CODE_ONLY_0000000000000001";
const syntheticOtherAccessCode = "SYNTHETIC_UI_ACCESS_CODE_ONLY_0000000000000002";
const syntheticOtherP02SessionId = "00000000-0000-4000-8000-000000000002";
const tutorialKitConceptItems = {
  plant: "77777777-7777-4777-8777-777777777781",
  photosynthesis: "77777777-7777-4777-8777-777777777782",
  carbonDioxide: "77777777-7777-4777-8777-777777777783",
};
const tutorialKitLinkItems = {
  perform: "88888888-8888-4888-8888-888888888882",
  require: "88888888-8888-4888-8888-888888888883",
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function syntheticKitPracticeResult(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const state = body as { concepts?: unknown; links?: unknown };
  if (!Array.isArray(state.concepts) || !Array.isArray(state.links)) return null;
  const concepts = state.concepts as Array<{ kitConceptItemId?: string; id?: string }>;
  const links = state.links as Array<{
    kitLinkItemId?: string;
    id?: string;
    sourceConceptId?: string;
    targetConceptId?: string;
  }>;
  const conceptCount = concepts.length;
  if (conceptCount === 2 && links.length === 1) {
    return {
      matched: false,
      concepts: { matched: 2, total: 3 },
      relations: { matched: 1, total: 2 },
    };
  }
  if (conceptCount !== 3 || links.length !== 2) return null;
  const idByPart = new Map(
    concepts.map(({ kitConceptItemId, id }) => [kitConceptItemId, id]),
  );
  const requireLink = links.find(
    (link) => link.kitLinkItemId === tutorialKitLinkItems.require,
  );
  const correctDirection =
    requireLink?.sourceConceptId === idByPart.get(tutorialKitConceptItems.photosynthesis) &&
    requireLink?.targetConceptId === idByPart.get(tutorialKitConceptItems.carbonDioxide);
  return {
    matched: correctDirection,
    concepts: { matched: 3, total: 3 },
    relations: { matched: correctDirection ? 2 : 1, total: 2 },
  };
}

async function installTutorialKitPracticeFixture(page: Page) {
  await page.route("**/api/tutorial/kit-practice/check", async (route) => {
    const result = syntheticKitPracticeResult(route.request().postDataJSON());
    return result
      ? json(route, result)
      : json(route, { error: "invalid_tutorial_kit_practice" }, 400);
  });
}

function syntheticSessionFlow(
  sessionId: string,
  protocolKey: "SBKB_INTEGRATION_V1" | "STAGE1_6",
  started: boolean,
) {
  const lesson = {
    id: "00000000-0000-4000-8000-000000000021",
    sessionId,
    stageType: "LESSON",
    orderIndex: 0,
    status: "PENDING",
    startedAt: null,
    completedAt: null,
    mapId: null,
  };
  return {
    session: {
      id: sessionId,
      status: started ? "IN_PROGRESS" : "NOT_STARTED",
      startedAt: started ? "2026-11-15T01:00:00.000Z" : null,
      completedAt: null,
      protocolKey,
      lessonVideoUrl: null,
      researchKitDefinitionId: null,
      studyGroup: null,
      groupActivitySeconds: null,
    },
    serverNow: "2026-11-15T01:00:00.000Z",
    currentMapSubmitted: false,
    currentIntegrationMapExists: false,
    currentMapAutoSubmittedAt: null,
    stages: started ? [lesson] : [],
    currentStage: started ? lesson : null,
    nextStage: null,
  };
}

async function installApiFixture(
  page: Page,
  scenario: Scenario,
  onAccessRequest?: () => Promise<void>,
) {
  const p02StartedSessions = new Set<string>();
  const p02ActiveClients = new Map<string, string>();
  const p02SessionIdFor = (route: Route) =>
    route.request().headers().authorization === `Bearer ${syntheticOtherAccessCode}`
      ? syntheticOtherP02SessionId
      : "00000000-0000-4000-8000-000000000001";
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") {
      if (scenario === "login-pending") await onAccessRequest?.();
      if (scenario === "login-error")
        return json(route, { error: "synthetic_invalid_code" }, 401);
      if (scenario === "p02")
        return json(route, {
          role: "learner",
          sessionId: p02SessionIdFor(route),
          protocolKey: "SBKB_INTEGRATION_V1",
          flowAvailable: true,
          runState: "RUNNING",
        });
      if (scenario === "legacy-session")
        return json(route, {
          role: "learner",
          sessionId: "00000000-0000-4000-8000-000000000003",
          protocolKey: "STAGE1_6",
          flowAvailable: true,
        });
      if (scenario.startsWith("researcher-") || scenario === "login" || scenario === "login-pending")
        return json(route, { role: "researcher" });
      return json(route, {
        role: "learner",
        sessionId: "00000000-0000-4000-8000-000000000001",
        protocolKey: "SBKB_INTEGRATION_V1",
        flowAvailable: scenario !== "unpublished",
        runState: scenario === "ended" ? "ENDED" : "PREPARING",
      });
    }
    if (path === "/api/health") return json(route, { database: true });
    if (path === "/api/experiment-status")
      return json(route, {
        state: scenario === "ended" ? "ENDED" : scenario === "p02" ? "RUNNING" : "PREPARING",
      });
    if (path === "/api/experiment-client/claim") {
      if (scenario === "p02") {
        const sessionId = p02SessionIdFor(route);
        const candidate = route.request().headers()["x-experiment-client"] ?? "";
        const activeClient = p02ActiveClients.get(sessionId);
        if (activeClient === undefined) p02ActiveClients.set(sessionId, candidate);
        const ownsClient = candidate === p02ActiveClients.get(sessionId);
        return json(
          route,
          {
            clientId: sessionId === syntheticOtherP02SessionId
              ? "00000000-0000-4000-8000-000000000003"
              : "00000000-0000-4000-8000-000000000002",
            ownership: ownsClient ? "OWNED" : "PENDING",
            deviceGeneration: ownsClient ? 0 : null,
            ...(!ownsClient ? { error: "experiment_client_in_use" } : {}),
          },
          ownsClient ? 200 : 409,
        );
      }
      return json(route, {
        clientId: "00000000-0000-4000-8000-000000000002",
        ownership: "OWNED",
        deviceGeneration: 0,
      });
    }
    if (scenario === "p02" && path === "/api/experiment-material")
      return json(route, {
        sbInstructions: "合成SB案内",
        kbInstructions: "合成KB案内",
        integrationInstructions: "合成統合案内",
      });
    const p02FlowMatch = path.match(/^\/api\/sessions\/([a-f0-9-]{36})\/flow$/);
    if (scenario === "p02" && p02FlowMatch) {
      const sessionId = p02FlowMatch[1];
      return json(route, syntheticSessionFlow(
        sessionId,
        "SBKB_INTEGRATION_V1",
        p02StartedSessions.has(sessionId),
      ));
    }
    const p02StartMatch = path.match(/^\/api\/sessions\/([a-f0-9-]{36})\/start$/);
    if (scenario === "p02" && p02StartMatch && route.request().method() === "POST") {
      p02StartedSessions.add(p02StartMatch[1]);
      return json(route, { logSaved: true });
    }
    if (scenario === "legacy-session" && path === "/api/sessions/00000000-0000-4000-8000-000000000003/flow")
      return json(
        route,
        syntheticSessionFlow(
          "00000000-0000-4000-8000-000000000003",
          "STAGE1_6",
          false,
        ),
      );
    return json(
      route,
      { error: "experiment_not_running" },
      path === "/api/experiment-material" ? 409 : 200,
    );
  });
}

async function installProductionIntegrationMapFixture(
  page: Page,
  learnerSessionId?: string,
  mapType: "INTEGRATION" | "PRIOR" | "KB" = "INTEGRATION",
  readOnly = false,
  sessionStageId: string | null = null,
) {
  const { kb, sb, plant, merged } = productionDuplicateConceptIds;
  const mapId = productionIntegrationMapId;
  let currentMap = {
    id: mapId,
    type: mapType,
    status: readOnly ? "SUBMITTED" as const : "DRAFT" as const,
    title: "合成統合Map",
    createdAt: "2026-11-25T00:00:00.000Z",
    submittedAt: readOnly ? "2026-11-25T02:30:00.000Z" : null,
    basedOnMapId: null,
    kitDefinitionId: "00000000-0000-4000-8000-000000000090",
    kitDefinitionName: "合成Kit",
    sessionStageId,
    sessionId: learnerSessionId ?? null,
    sessionStageStatus: sessionStageId ? "IN_PROGRESS" : null,
    sessionProtocolKey: learnerSessionId ? "STAGE1_6" : null,
    concepts: [
      { id: kb, label: "光合成", positionX: 430, positionY: 180, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
      { id: plant, label: "植物", positionX: 760, positionY: 260, createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" },
      { id: sb, label: "光合成", positionX: 100, positionY: 100, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
    links: [
      { id: "00000000-0000-4000-8000-000000000095", mapId, sourceConceptId: sb, targetConceptId: plant, label: "SB由来" },
      { id: "00000000-0000-4000-8000-000000000096", mapId, sourceConceptId: plant, targetConceptId: kb, label: "KB由来" },
    ],
    kitLinks: [],
    kitConcepts: [],
    availableKitDefinitions: [],
  };
  const mergeRequests: unknown[] = [];
  const positionRequests: Array<{
    id: string;
    positionX: number;
    positionY: number;
  }> = [];
  let mapReadCount = 0;

  await page.route(`**/api/maps/${mapId}/concepts/merge`, async (route) => {
    if (route.request().method() !== "POST")
      return json(route, { error: "method_not_allowed" }, 405);
    const body = route.request().postDataJSON() as {
      conceptIds?: unknown;
      label?: unknown;
    };
    mergeRequests.push(body);
    if (
      !Array.isArray(body.conceptIds) ||
      body.conceptIds.length !== 2 ||
      !body.conceptIds.includes(sb) ||
      !body.conceptIds.includes(kb) ||
      body.label !== "光合成"
    ) {
      return json(route, { error: "unexpected_merge_request" }, 400);
    }

    const mergedConcept = {
      id: merged,
      mapId,
      label: body.label,
      positionX: 265,
      positionY: 140,
      createdAt: "2026-11-25T01:00:00.000Z",
      updatedAt: "2026-11-25T01:00:00.000Z",
      isMergeResult: true,
    };
    const sourceIds = new Set([sb, kb]);
    const incidentLinks = currentMap.links
      .filter((link) => sourceIds.has(link.sourceConceptId) || sourceIds.has(link.targetConceptId))
      .map((link) => ({
        ...link,
        sourceConceptId: sourceIds.has(link.sourceConceptId) ? merged : link.sourceConceptId,
        targetConceptId: sourceIds.has(link.targetConceptId) ? merged : link.targetConceptId,
      }));
    currentMap = {
      ...currentMap,
      concepts: [
        ...currentMap.concepts.filter((concept) => !sourceIds.has(concept.id)),
        mergedConcept,
      ],
      links: currentMap.links.map((link) =>
        incidentLinks.find((updated) => updated.id === link.id) ?? link,
      ),
    };
    return json(route, {
      concept: mergedConcept,
      mergedConceptIds: body.conceptIds,
      incidentLinks,
    }, 201);
  });
  await page.route(`**/api/maps/${mapId}`, async (route) => {
    if (route.request().method() === "GET") {
      const concepts = [...currentMap.concepts];
      mapReadCount += 1;
      if (mapReadCount > 1) {
        concepts.reverse();
      }
      return json(route, { ...currentMap, concepts });
    }
    return json(route, { error: "method_not_allowed" }, 405);
  });

  await page.route(`**/api/maps/${mapId}/undo-redo`, async (route) =>
    json(route, {
      status: "READY",
      sequenceNumber: 0,
      canUndo: false,
      canRedo: false,
      undoOperation: null,
      redoOperation: null,
    }),
  );
  await page.route("**/api/concepts/*/position", async (route) => {
    if (route.request().method() !== "PATCH")
      return json(route, { error: "method_not_allowed" }, 405);
    const pathParts = new URL(route.request().url()).pathname.split("/");
    const conceptId = pathParts.at(-2);
    const body = route.request().postDataJSON() as {
      positionX?: unknown;
      positionY?: unknown;
    };
    if (
      !conceptId ||
      typeof body.positionX !== "number" ||
      !Number.isFinite(body.positionX) ||
      typeof body.positionY !== "number" ||
      !Number.isFinite(body.positionY)
    ) return json(route, { error: "invalid_position" }, 400);
    const existing = currentMap.concepts.find((concept) => concept.id === conceptId);
    if (!existing) return json(route, { error: "concept_not_found" }, 404);
    const updated = {
      ...existing,
      positionX: body.positionX as number,
      positionY: body.positionY as number,
      updatedAt: "2026-11-25T02:00:00.000Z",
    };
    positionRequests.push({
      id: conceptId,
      positionX: updated.positionX,
      positionY: updated.positionY,
    });
    currentMap = {
      ...currentMap,
      concepts: currentMap.concepts.map((concept) =>
        concept.id === conceptId ? updated : concept,
      ),
    };
    return json(route, updated);
  });

  return {
    mergeRequests,
    positionRequests,
    snapshot: () => currentMap,
    markSubmitted: (submittedAt: string) => {
      currentMap = { ...currentMap, status: "SUBMITTED", submittedAt };
    },
  };
}

async function installIntegrationDeadlineFlowFixture(
  page: Page,
  sessionId: string,
  stageId: string,
  startedAt: string,
  durationSeconds: number,
  shouldSubmit: () => boolean,
  onSubmitted: (submittedAt: string) => void,
) {
  let requestCount = 0;
  let autoSubmittedAt: string | null = null;
  const deadlineAt =
    Date.parse(startedAt) + durationSeconds * 1000;
  await page.route(
    "**/api/sessions/" + sessionId + "/flow",
    async (route) => {
      requestCount += 1;
      const now = new Date();
      if (now.getTime() >= deadlineAt && shouldSubmit()) {
        autoSubmittedAt ??= now.toISOString();
        onSubmitted(autoSubmittedAt);
      }
      return json(route, {
        session: {
          id: sessionId,
          status: "IN_PROGRESS",
          protocolKey: "STAGE1_6",
          groupActivitySeconds: durationSeconds,
        },
        serverNow: now.toISOString(),
        currentMapSubmitted: autoSubmittedAt !== null,
        currentIntegrationMapExists: true,
        currentMapAutoSubmittedAt: autoSubmittedAt,
        stages: [
          {
            id: stageId,
            stageType: "INTEGRATION_MAP",
            status: "IN_PROGRESS",
            startedAt,
            mapId: productionIntegrationMapId,
          },
        ],
        currentStage: {
          id: stageId,
          stageType: "INTEGRATION_MAP",
          startedAt,
          mapId: productionIntegrationMapId,
        },
        nextStage: null,
      });
    },
  );
  return {
    requestCount: () => requestCount,
    deadlineAt,
  };
}

async function readDisplayedRemainingSeconds(page: Page) {
  const label = await page.locator(".integration-deadline-status").innerText();
  const match = label.match(/(\d+):(\d{2})$/);
  assert.ok(match, "active deadline displays a numeric minutes:seconds value");
  return Number(match[1]) * 60 + Number(match[2]);
}

async function captureBeforeAfter(
  page: Page,
  name: string,
  width: number,
  directory: string,
) {
  for (const phase of ["before", "after"] as const) {
    const enabled = phase === "after";
    const count = await page.evaluate((isEnabled) => {
      const styles = document.querySelectorAll<HTMLStyleElement>(
        "style[data-vite-dev-id$='rehearsal-ui.css']",
      );
      for (const style of styles)
        if (style.sheet) style.sheet.disabled = !isEnabled;
      return styles.length;
    }, enabled);
    assert.ok(count > 0, "rehearsal-ui.css is present for comparison");
    await page.screenshot({
      path: join(
        directory,
        `${name}-${width}x${width === 1366 ? 768 : 900}-${phase}.png`,
      ),
      fullPage: true,
    });
    if (phase === "after") await assertNoHorizontalOverflow(page, name, width);
  }
}

async function assertNoHorizontalOverflow(page: Page, name: string, width: number) {
  const layout = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    if (scrollWidth <= viewportWidth) return { viewportWidth, scrollWidth, suspects: [] };

    const suspects: Array<{
      element: string;
      left: number;
      right: number;
      width: number;
      scrollWidth: number;
      clientWidth: number;
      minWidth: string;
      overflowX: string;
      clippedBy: string | null;
    }> = [];
    for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === "none" || rect.width <= 0 || rect.right <= viewportWidth + 1) continue;
      let clippedBy: string | null = null;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        if (!/^(auto|scroll|hidden|clip)$/.test(ancestorStyle.overflowX)) continue;
        if (rect.right > ancestor.getBoundingClientRect().right + 1) {
          clippedBy = `${ancestor.tagName.toLowerCase()}${ancestor.id ? `#${ancestor.id}` : ""}.${Array.from(ancestor.classList).slice(0, 3).join(".")}`;
          break;
        }
      }
      suspects.push({
        element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${Array.from(element.classList).slice(0, 3).join(".")}`,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        minWidth: style.minWidth,
        overflowX: style.overflowX,
        clippedBy,
      });
    }
    suspects.sort((a, b) => Number(!!a.clippedBy) - Number(!!b.clippedBy) || b.right - a.right);
    return { viewportWidth, scrollWidth, suspects: suspects.slice(0, 16) };
  });
  assert.equal(
    layout.scrollWidth > layout.viewportWidth,
    false,
    `${name}: no horizontal overflow at ${width}px; layout=${JSON.stringify(layout)}`,
  );
}

async function exerciseCanvasZoomControls(scope: Page | Locator) {
  const controls = scope.locator(".concept-canvas-view-controls");
  assert.equal(await controls.count(), 1, "learner Canvas exposes one zoom control group");
  const percentage = controls.locator("span[aria-label='現在の倍率']");
  assert.equal(await percentage.innerText(), "100%", "initial Canvas zoom remains 100%");
  await controls.getByRole("button", { name: "マップを縮小" }).click();
  assert.equal(await percentage.innerText(), "90%");
  await controls.getByRole("button", { name: "マップを拡大" }).click();
  assert.equal(await percentage.innerText(), "100%");
  await controls.getByRole("button", { name: "全体表示", exact: true }).click();
  const fitPercentage = Number((await percentage.innerText()).replace("%", ""));
  assert.ok(fitPercentage >= 50 && fitPercentage <= 100, "Fit keeps the existing fit range");
  while (Number((await percentage.innerText()).replace("%", "")) < 150)
    await controls.getByRole("button", { name: "マップを拡大" }).click();
  assert.equal(await percentage.innerText(), "150%");
  const scroll = await scope.locator(".concept-canvas-viewport").evaluate((element) => {
    const viewport = element as HTMLElement;
    viewport.scrollLeft = Math.min(160, viewport.scrollWidth - viewport.clientWidth);
    viewport.scrollTop = Math.min(100, viewport.scrollHeight - viewport.clientHeight);
    return { left: viewport.scrollLeft, top: viewport.scrollTop };
  });
  assert.ok(scroll.left > 0 || scroll.top > 0, "zoomed Canvas can scroll");
  return { controls, percentage };
}

// Edge headless's Playwright dragTo emitted no HTML drag events for these
// draggable Kit buttons. Dispatch the real DOM events to exercise the shared
// palette and Canvas handlers, while keeping native pointer dragging as an
// explicitly unverified interaction.
async function dispatchSyntheticKitPartDrop(
  page: Page,
  kind: "concept" | "link",
  label: string,
  position: { x: number; y: number },
) {
  const { types, accepted, dropped, dropPrevented } = await page.evaluate(({ kind, label, position }) => {
    const part = Array.from(document.querySelectorAll<HTMLButtonElement>(
      `.tutorial-practice-panel:not([hidden]) .kit-palette-part.is-${kind}:not(:disabled)`,
    )).find((candidate) => candidate.textContent?.includes(label));
    const canvas = document.querySelector<HTMLElement>(
      '.tutorial-practice-panel:not([hidden]) .concept-canvas',
    );
    if (!part || !canvas) {
      throw new Error(`Kit ${kind}部品またはCanvasが見つかりません`);
    }

    const dataTransfer = new DataTransfer();
    part.dispatchEvent(
      new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }),
    );

    const types = Array.from(dataTransfer.types);
    if (!types.includes("application/x-kbcm-kit-part")) {
      throw new Error(
        `ドラッグデータが生成されていません: ${JSON.stringify(types)}`,
      );
    }

    const rect = canvas.getBoundingClientRect();
    const x = rect.left + position.x * (rect.width / canvas.offsetWidth);
    const y = rect.top + position.y * (rect.height / canvas.offsetHeight);
    const dragOver = new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX: x,
      clientY: y,
    });
    canvas.dispatchEvent(dragOver);
    const accepted = dragOver.defaultPrevented;

    let dropped = false;
    let dropPrevented = false;
    if (accepted) {
      const drop = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: x,
        clientY: y,
      });
      canvas.dispatchEvent(drop);
      dropped = true;
      dropPrevented = drop.defaultPrevented;
    }
    part.dispatchEvent(
      new DragEvent("dragend", {
        bubbles: true,
        dataTransfer,
      }),
    );
    return { types, accepted, dropped, dropPrevented };
  }, { kind, label, position });

  assert.ok(
    types.includes("application/x-kbcm-kit-part"),
    "Kit palette dragstart provides its expected MIME type",
  );
  assert.equal(accepted, true, "Canvas accepts the synthetic Kit palette drop");
  assert.equal(dropped, true, "synthetic Kit drop is dispatched to Canvas");
  assert.equal(dropPrevented, true, "Canvas prevents the browser's default drop behavior");
}

const directory = join(tmpdir(), `sbkb-kb-practice-${Date.now()}-${process.pid}`);
const viteCacheDir = join(process.cwd(), `.kb-practice-vite-cache-${Date.now()}-${process.pid}`);
await mkdir(directory, { recursive: true });
const vite = await createServer({
  configLoader: "runner",
  cacheDir: viteCacheDir,
  server: { host: "127.0.0.1", port: 0 },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  await vite.listen();
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL ?? "msedge",
  });

  for (const width of [1366, 1440]) {
    const height = width === 1366 ? 768 : 900;

    for (const state of ["login", "unpublished", "waiting", "ended"] as const) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      if (state !== "login")
        await context.addInitScript(() =>
          sessionStorage.setItem(
            "stage1-access-token",
            "SYNTHETIC_LEARNER_TOKEN_ONLY",
          ),
        );
      const page = await context.newPage();
      await installApiFixture(page, state);
      await page.goto(vite.resolvedUrls!.local[0]!);
      const heading =
        state === "login"
          ? "アクセスコードを入力"
          : state === "unpublished"
            ? "学習者フローはまだ利用できません"
            : state === "ended"
              ? "実施は終了しました"
              : "実施の開始を待っています";
      await page.getByRole("heading", { name: heading }).waitFor();
      await captureBeforeAfter(page, `learner-${state}`, width, directory);
      if (state === "login") {
        const input = page.getByLabel("アクセスコード", { exact: true });
        assert.equal(await input.getAttribute("placeholder"), "アクセスコードを入力");
        assert.equal(await page.locator(".home-practice-card").count(), 0);
        assert.equal(
          await page.locator('a[href="/tutorial"]').count(),
          0,
          "signed-out code entry has no practice entry",
        );
        await input.focus();
        assert.equal(
          await input.evaluate((element) => getComputedStyle(element).outlineStyle),
          "solid",
        );
        await input.fill(syntheticAccessCode);
        const accessRequestStarted = page.waitForRequest(
          (request) => new URL(request.url()).pathname === "/api/me",
        );
        await page.getByRole("button", { name: "続行" }).click();
        const accessRequest = await accessRequestStarted;
        assert.equal(accessRequest.method(), "GET");
        assert.ok(
          (await accessRequest.headerValue("authorization"))?.startsWith("Bearer "),
          "existing access-code request still uses the Bearer header",
        );
        await page.getByRole("heading", { name: "研究者トップ" }).waitFor();
      }
      if (state === "ended")
        assert.equal(await page.locator(".map-editor-page").count(), 0);
      await context.close();
    }

    const learnerToken = syntheticAccessCode;
    const p02Context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    const p02Page = await p02Context.newPage();
    const p02ApiObservations: Array<{
      path: string;
      method: string;
      hasBearer: boolean;
    }> = [];
    const p02ClaimSecrets: string[] = [];
    p02Page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/experiment-client/claim")
        p02ClaimSecrets.push(request.headers()["x-experiment-client"] ?? "");
      if (path.startsWith("/api/"))
        p02ApiObservations.push({
          path,
          method: request.method(),
          hasBearer: (request.headers().authorization ?? "").startsWith("Bearer "),
        });
    });
    await installApiFixture(p02Page, "p02");
    await p02Page.goto(vite.resolvedUrls!.local[0]!);
    await p02Page.getByLabel("アクセスコード", { exact: true }).fill(learnerToken);
    await p02Page.getByRole("button", { name: "続行", exact: true }).click();
    await p02Page.getByRole("heading", { name: "活動の案内" }).waitFor();
    const practiceCard = p02Page.locator(".session-practice-card");
    assert.equal(await practiceCard.count(), 1);
    const practiceLink = practiceCard.getByRole("button", { name: /練習を開く/ });
    assert.equal(
      await p02Page.getByRole("button", { name: "セッションを開始", exact: true }).isEnabled(),
      false,
      "session start stays disabled until all three practice modes are completed",
    );
    assert.equal(await p02Page.locator(".map-editor-page").count(), 0);
    await assertNoHorizontalOverflow(p02Page, "p02-practice-card", width);
    await captureBeforeAfter(p02Page, "learner-p02-practice-card", width, directory);
    let practiceLinkKeyboardFocused = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      await p02Page.keyboard.press("Tab");
      if (await practiceLink.evaluate((element) => element.matches(":focus-visible"))) {
        practiceLinkKeyboardFocused = true;
        break;
      }
    }
    assert.equal(practiceLinkKeyboardFocused, true);
    assert.equal(
      await practiceLink.evaluate((element) => getComputedStyle(element).outlineStyle),
      "solid",
      "P02 practice card link has visible keyboard focus",
    );
    const beforeTutorialRequestIndex = p02ApiObservations.length;
    const claimsBeforePractice = p02ApiObservations.filter(request => request.path === "/api/experiment-client/claim").length;
    await practiceLink.click();
    assert.equal(new URL(p02Page.url()).pathname, "/");
    await p02Page.getByRole("heading", { name: "操作の練習" }).waitFor();
    await p02Page.getByRole("button", { name: "練習を終了", exact: true }).waitFor();
    assert.equal(
      await p02Page.getByRole("button", { name: "練習を終了", exact: true }).isDisabled(),
      true,
      "incomplete practice cannot be marked finished",
    );
    assert.equal(
      await p02Page.evaluate(() => sessionStorage.getItem("stage1-access-token")),
      learnerToken,
      "learner authentication survives entry to tutorial",
    );
    await p02Page.getByRole("button", { name: "＋ 概念", exact: true }).click();
    await p02Page.getByLabel("概念名").fill("合成練習概念");
    await p02Page.getByRole("button", { name: "概念を追加" }).click();
    assert.equal(await p02Page.locator(".concept-node").count(), 1);
    const tutorialRequests = p02ApiObservations.slice(beforeTutorialRequestIndex);

    const allowedPracticeReads = new Set([
      "/api/experiment-status",
      "/api/sessions/00000000-0000-4000-8000-000000000001/flow",
    ]);
    const unexpectedTutorialRequests = tutorialRequests.filter(
      (request) =>
        request.method !== "GET" ||
        !allowedPracticeReads.has(request.path),
    );

    assert.deepEqual(
      unexpectedTutorialRequests,
      [],
      "inline practice must not send mutations or unexpected API requests",
    );
    await p02Page.getByRole("button", { name: "案内へ戻る（練習未完了）" }).click();
    await p02Page.getByRole("heading", { name: "活動の案内" }).waitFor();
    assert.equal(await p02Page.locator(".session-practice-card").count(), 1);
    assert.equal(
      await p02Page.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(),
      true,
      "returning before finishing cannot unlock the session",
    );
    assert.equal(p02ApiObservations.filter(request => request.path === "/api/experiment-client/claim").length, claimsBeforePractice, "practice does not regenerate client registration (including StrictMode setup)");
    assert.equal(
      await p02Page.evaluate(() => sessionStorage.getItem("stage1-access-token")),
      learnerToken,
      "learner authentication and client registration survive inline return",
    );

    // F5 remains the same logical tab, and must use the same server-owned
    // client secret instead of registering a new (PENDING) device candidate.
    const originalClaimSecret = p02ClaimSecrets.at(-1);
    assert.ok(originalClaimSecret, "initial client claim contains a secret");
    const cacheKey = "sbkb-experiment-client-v1:00000000-0000-4000-8000-000000000001";
    const cachedIdentity = await p02Page.evaluate(key => sessionStorage.getItem(key), cacheKey);
    assert.ok(cachedIdentity, "F5 identity is cached in this tab");
    const claimsBeforeReload = p02ClaimSecrets.length;
    await p02Page.reload();
    await p02Page.getByRole("heading", { name: "活動の案内" }).waitFor();
    assert.ok(p02ClaimSecrets.length > claimsBeforeReload, "F5 rechecks the server binding");
    assert.equal(p02ClaimSecrets.at(-1), originalClaimSecret, "F5 reuses the existing client secret");
    assert.equal(await p02Page.evaluate(key => sessionStorage.getItem(key), cacheKey), cachedIdentity);

    // Duplicate-tab storage is copied, but it must never be treated as an
    // additional owner of the original secret (nor issue a claim request).
    const duplicatePage = await p02Context.newPage();
    await duplicatePage.addInitScript(({ token, key, value }) => {
      sessionStorage.setItem("stage1-access-token", token);
      sessionStorage.setItem(key, value);
    }, { token: learnerToken, key: cacheKey, value: cachedIdentity! });
    await installApiFixture(duplicatePage, "p02");
    let duplicateClaims = 0;
    duplicatePage.on("request", request => {
      if (new URL(request.url()).pathname === "/api/experiment-client/claim") duplicateClaims++;
    });
    await duplicatePage.goto(vite.resolvedUrls!.local[0]!);
    await duplicatePage.getByRole("heading", { name: "この画面は別タブで利用中です" }).waitFor();
    assert.equal(duplicateClaims, 0, "duplicate tab must not claim copied credentials");
    await duplicatePage.close();
    assert.equal(await p02Page.getByRole("heading", { name: "活動の案内" }).count(), 1);
    await p02Context.close();

    for (const failure of ["ended", "switched", "expired", "temporary-server", "temporary-network"] as const) {
      const guardContext = await browser.newContext({ viewport: { width, height } });
      await guardContext.addInitScript(token => sessionStorage.setItem("stage1-access-token", token), learnerToken);
      const guardPage = await guardContext.newPage();
      await installApiFixture(guardPage, "p02");
      await guardPage.goto(vite.resolvedUrls!.local[0]!);
      await guardPage.getByRole("button", { name: /練習を開く/ }).click();
      await guardPage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
      const temporary = failure === "temporary-server" || failure === "temporary-network";
      await guardPage.getByRole("button", { name: "＋ 概念", exact: true }).click();
      await guardPage.getByLabel("概念名").fill(`停止前の練習概念-${failure}`);
      await guardPage.getByRole("button", { name: "概念を追加" }).click();
      assert.equal(await guardPage.locator(".concept-node").count(), 1);
      const guardProgressKey = `sbkb-practice-progress-v1:00000000-0000-4000-8000-000000000001:${requestDigest(learnerToken)}:PRIOR`;
      const guardSavedProgress = await guardPage.evaluate((key) => sessionStorage.getItem(key), guardProgressKey);
      assert.ok(guardSavedProgress, `${failure} retains the last locally saved practice record`);
      let canRecover = false;
      await guardPage.route("**/api/sessions/*/flow", route => {
        if (temporary) {
          if (!canRecover) {
            return failure === "temporary-server"
              ? json(route, { error: "safety_lookup_unavailable" }, 503)
              : route.abort("failed");
          }
          return json(route, syntheticSessionFlow("00000000-0000-4000-8000-000000000001", "SBKB_INTEGRATION_V1", false));
        }
        return json(route, {
          error: failure === "ended" ? "experiment_ended" : failure === "switched" ? "experiment_client_stale" : "authentication_required",
        }, failure === "expired" ? 401 : 409);
      });
      await guardPage.evaluate(() => window.dispatchEvent(new Event("focus")));
      if (temporary) {
        await guardPage.getByRole("heading", { name: "接続を再確認しています", exact: true }).waitFor();
        assert.equal(await guardPage.locator(".concept-node").count(), 1);
        assert.equal(await guardPage.getByRole("heading", { name: "利用状態を確認できません" }).count(), 0);
        canRecover = true;
        await guardPage.getByRole("button", { name: "接続状態を再確認" }).click();
        await guardPage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
        assert.equal(await guardPage.locator(".concept-node").count(), 1, "temporary outage preserves local practice state");
      } else {
        await guardPage.getByRole("heading", { name: failure === "ended" ? "実施は終了しました" : "利用状態を確認できません", exact: true }).waitFor();
        assert.equal(await guardPage.getByRole("heading", { name: "操作の練習", exact: true }).count(), 0);
        assert.equal(await guardPage.evaluate((key) => sessionStorage.getItem(key), guardProgressKey), guardSavedProgress, `${failure} stops practice without deleting its saved record`);
      }
      await guardContext.close();
    }

    const corruptPracticeContext = await browser.newContext({ viewport: { width, height } });
    const corruptPriorKey = `sbkb-practice-progress-v1:00000000-0000-4000-8000-000000000001:${requestDigest(learnerToken)}:PRIOR`;
    const legacyCompletionKey = `sbkb-practice-complete-v1:00000000-0000-4000-8000-000000000001:${requestDigest(learnerToken)}`;
    await corruptPracticeContext.addInitScript(({ token, progressKey, completionKey }) => {
      sessionStorage.setItem("stage1-access-token", token);
      sessionStorage.setItem(progressKey, "{broken-json");
      sessionStorage.setItem(completionKey, "1");
    }, { token: learnerToken, progressKey: corruptPriorKey, completionKey: legacyCompletionKey });
    const corruptPracticePage = await corruptPracticeContext.newPage();
    await installApiFixture(corruptPracticePage, "p02");
    await corruptPracticePage.goto(vite.resolvedUrls!.local[0]!);
    await corruptPracticePage.getByRole("heading", { name: "活動の案内" }).waitFor();
    assert.equal(await corruptPracticePage.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(), true, "corrupt practice progress cannot use a stale completion marker to unlock start");
    await corruptPracticePage.getByRole("button", { name: /練習を開く/ }).click();
    await corruptPracticePage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
    assert.ok(await corruptPracticePage.getByRole("alert").count() > 0, "corrupt practice data is explained instead of silently reset");
    corruptPracticePage.once("dialog", dialog => dialog.accept());
    await corruptPracticePage.getByRole("button", { name: "この練習をやり直す", exact: true }).click();
    await corruptPracticePage.getByRole("button", { name: "＋ 概念", exact: true }).click();
    await corruptPracticePage.getByLabel("概念名").fill("初期化後の練習概念");
    await corruptPracticePage.getByRole("button", { name: "概念を追加" }).click();
    assert.equal(await corruptPracticePage.locator(".concept-node").count(), 1, "confirmed reset clears only this invalid practice record");
    assert.equal(await corruptPracticePage.evaluate(key => sessionStorage.getItem(key), legacyCompletionKey), null, "reset also clears the completion marker");
    await corruptPracticeContext.close();

    const failedWriteContext = await browser.newContext({ viewport: { width, height } });
    await failedWriteContext.addInitScript(token => {
      sessionStorage.setItem("stage1-access-token", token);
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key: string, value: string) {
        if (key.startsWith("sbkb-practice-progress-v1:")) throw new DOMException("Synthetic quota failure", "QuotaExceededError");
        originalSetItem.call(this, key, value);
      };
    }, learnerToken);
    const failedWritePage = await failedWriteContext.newPage();
    await installApiFixture(failedWritePage, "p02");
    await failedWritePage.goto(vite.resolvedUrls!.local[0]!);
    await failedWritePage.getByRole("button", { name: /練習を開く/ }).click();
    await failedWritePage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
    await failedWritePage.getByRole("button", { name: "＋ 概念", exact: true }).click();
    await failedWritePage.getByLabel("概念名").fill("保存失敗してはいけない概念");
    await failedWritePage.getByRole("button", { name: "概念を追加" }).click();
    assert.equal(await failedWritePage.locator(".concept-node").count(), 0, "a failed local write does not commit the map change in React state");
    assert.equal(await failedWritePage.locator('.tutorial-task-progress [role="status"]').innerText(), "0 / 3 件達成", "a failed write cannot award the add task");
    assert.match(await failedWritePage.getByRole("alert").innerText(), /保存できませんでした/);
    await failedWritePage.getByRole("button", { name: "案内へ戻る（練習未完了）" }).click();
    await failedWritePage.getByRole("heading", { name: "活動の案内" }).waitFor();
    assert.equal(await failedWritePage.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(), true, "a failed practice write cannot unlock P02");
    await failedWriteContext.close();

    // Initial material fetch 503 is retryable; no new client owner is claimed.
    const retryContext = await browser.newContext({ viewport: { width, height } });
    await retryContext.addInitScript(token => sessionStorage.setItem("stage1-access-token", token), learnerToken);
    const retryPage = await retryContext.newPage();
    await installApiFixture(retryPage, "p02");
    let materialRequests = 0;
    let allowMaterial = false;
    await retryPage.route("**/api/experiment-material", route => {
      materialRequests++;
      return !allowMaterial
        ? json(route, { error: "safety_lookup_unavailable" }, 503)
        : json(route, { sbInstructions: "合成SB案内", kbInstructions: "合成KB案内", integrationInstructions: "合成統合案内" });
    });
    await retryPage.goto(vite.resolvedUrls!.local[0]!);
    await retryPage.getByRole("heading", { name: "接続状態を確認できません", exact: true }).waitFor();
    allowMaterial = true;
    await retryPage.getByRole("heading", { name: "活動の案内" }).waitFor({ timeout: 25000 });
    assert.ok(materialRequests >= 2, "transient material fetch recovers automatically");
    await retryContext.close();

    const startContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await startContext.addInitScript(({ token, completionKey }) => {
      sessionStorage.setItem("stage1-access-token", token);
      // Synthetic fixture: this separate start-flow scenario assumes practice
      // was already completed. Real completion is tested by tutorial gestures.
      sessionStorage.setItem(completionKey, "1");
    }, {
      token: learnerToken,
      completionKey: `sbkb-practice-complete-v1:00000000-0000-4000-8000-000000000001:${requestDigest(learnerToken)}`,
    });
    const startPage = await startContext.newPage();
    await installApiFixture(startPage, "p02");
    await startPage.goto(vite.resolvedUrls!.local[0]!);
    await startPage.getByRole("heading", { name: "活動の案内" }).waitFor();
    assert.equal(
      await startPage.getByRole("button", { name: "セッションを開始", exact: true }).isEnabled(),
      true,
      "previously completed practice unlocks session start",
    );
    await startPage.reload();
    await startPage.getByRole("heading", { name: "活動の案内" }).waitFor();
    assert.equal(
      await startPage.getByRole("button", { name: "セッションを開始", exact: true }).isEnabled(),
      true,
      "same-tab F5 restores the previously completed practice start gate",
    );
    const sessionStart = startPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/sessions/00000000-0000-4000-8000-000000000001/start" &&
        response.request().method() === "POST",
    );
    await startPage.getByRole("button", { name: "セッションを開始", exact: true }).click();
    await sessionStart;
    await startPage.getByRole("button", { name: "開始する", exact: true }).waitFor();
    assert.equal(await startPage.getByRole("heading", { name: "活動の案内" }).count(), 0);
    assert.equal(await startPage.locator(".map-editor-page").count(), 0);
    await startContext.close();

    const legacyContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await legacyContext.addInitScript((token) => {
      sessionStorage.setItem("stage1-access-token", token);
    }, learnerToken);
    const legacyPage = await legacyContext.newPage();
    await installApiFixture(legacyPage, "legacy-session");
    await legacyPage.goto(vite.resolvedUrls!.local[0]!);
    await legacyPage.getByRole("button", { name: "セッションを開始", exact: true }).waitFor();
    assert.equal(await legacyPage.locator(".session-practice-card").count(), 0);
    assert.equal(
      await legacyPage.getByRole("link", { name: "操作の練習", exact: true }).getAttribute("href"),
      "/tutorial",
      "legacy protocol keeps its existing practice link",
    );
    await assertNoHorizontalOverflow(legacyPage, "legacy-session-guide", width);
    await legacyContext.close();

    const tutorialContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    const tutorialPage = await tutorialContext.newPage();
    // The 1440px run completes every practice task *inside* the P02 session,
    // then verifies the same-tab F5/start handoff. The 1366px run also checks
    // the Kit layout at 390px before/after the browser event-path gestures.
    const inlineP02 = width === 1440;
    const p02SessionId = "00000000-0000-4000-8000-000000000001";
    const p02FlowPath = `/api/sessions/${p02SessionId}/flow`;
    const tutorialApiRequests: Array<{ path: string; method: string }> = [];
    const tutorialPracticeBodies: unknown[] = [];
    const tutorialClaimSecrets: string[] = [];
    tutorialPage.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/"))
        tutorialApiRequests.push({ path, method: request.method() });
      if (path === "/api/tutorial/kit-practice/check" && request.method() === "POST") {
        tutorialPracticeBodies.push(request.postDataJSON());
      }
      if (path === "/api/experiment-client/claim")
        tutorialClaimSecrets.push(request.headers()["x-experiment-client"] ?? "");
    });
    if (inlineP02) {
      await installApiFixture(tutorialPage, "p02");
      await tutorialPage.goto(vite.resolvedUrls!.local[0]!);
      await tutorialPage.getByLabel("アクセスコード", { exact: true }).fill(syntheticAccessCode);
      await tutorialPage.getByRole("button", { name: "続行", exact: true }).click();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      assert.equal(
        await tutorialPage.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(),
        true,
        "P02 start is gated before all actual practice operations",
      );
      await tutorialPage.getByRole("button", { name: /練習を開く/ }).click();
    } else {
      await tutorialPage.goto(`${vite.resolvedUrls!.local[0]}tutorial`);
    }
    await installTutorialKitPracticeFixture(tutorialPage);
    await tutorialPage.getByRole("heading", { name: "操作の練習" }).waitFor();
    let practiceRequestIndex = tutorialApiRequests.length;
    let tutorialClaimsBeforePractice = tutorialClaimSecrets.length;
    const activeTutorialPanel = tutorialPage.locator(".tutorial-practice-panel:not([hidden])");
    assert.equal(
      await tutorialPage.locator(".tutorial-practice-note").innerText(),
      "Scratch-Build → Kit-Build → 統合マップの順で、各段階のすべての操作を完了すると次へ進めます。完了した段階へはいつでも戻り、練習内容を続けて確認できます。",
      "practice introduction uses the shorter rehearsal-approved wording",
    );
    if (!inlineP02) assert.deepEqual(tutorialApiRequests, [], "standalone tutorial makes no request before KB assessment");
    assert.equal(
      await tutorialPage.getByRole("button", { name: "練習を終了" }).isDisabled(),
      true,
      "practice cannot end before all three modes are complete",
    );
    assert.equal(
      await tutorialPage.getByRole("button", { name: "この練習をやり直す", exact: true }).count(),
      1,
    );
    await captureBeforeAfter(tutorialPage, "tutorial-prior", width, directory);
    assert.equal(
      await tutorialPage
        .getByRole("button", { name: "Scratch-Buildの練習", exact: true })
        .getAttribute("aria-pressed"),
      "true",
      "初期状態ではScratch-Buildが選択されている",
    );
    assert.equal(await tutorialPage.getByRole("button", { name: "Kit-Buildの練習", exact: true }).isDisabled(), true);
    assert.equal(await tutorialPage.getByRole("button", { name: "統合マップの練習", exact: true }).isDisabled(), true);
    assert.equal(await tutorialPage.getByRole("button", { name: "次へ：Kit-Buildの練習", exact: true }).isDisabled(), true);
    assert.deepEqual(
      await activeTutorialPanel.locator(".tutorial-task-progress ol").innerText(),
      "○ 概念を追加する未完了\n○ 概念を移動する未完了\n○ リンクを接続する未完了",
      "SB practice lists only the three required real actions",
    );
    let sbZoom = await exerciseCanvasZoomControls(activeTutorialPanel);
    let sbWritesBeforeActions = tutorialApiRequests.filter((request) => request.method !== "GET").length;
    await tutorialPage.getByRole("button", { name: "＋ 概念", exact: true }).click();
    await tutorialPage.getByLabel("概念名").fill("合成A");
    await tutorialPage.getByRole("button", { name: "概念を追加" }).click();
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 1);
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "1 / 3 件達成",
      "adding a local SB concept completes only the add task",
    );
    if (inlineP02) {
      const priorKey = `sbkb-practice-progress-v1:${p02SessionId}:${requestDigest(syntheticAccessCode)}:PRIOR`;
      const initialStoredProgress = await tutorialPage.evaluate((key) => sessionStorage.getItem(key), priorKey);
      assert.ok(initialStoredProgress, "the active Session's SB practice map and task progress are saved in this tab");
      await tutorialPage.getByRole("button", { name: "案内へ戻る（練習未完了）" }).click();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      assert.equal(await tutorialPage.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(), true);
      await tutorialPage.getByRole("button", { name: /練習を開く/ }).click();
      await tutorialPage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
      assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 1, "reopening from P02 restores the unfinished SB map");
      assert.equal(await activeTutorialPanel.locator(".concept-node h3").innerText(), "合成A");
      assert.equal(await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(), "1 / 3 件達成");

      await tutorialPage.reload();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      await tutorialPage.getByRole("button", { name: /練習を開く/ }).click();
      await tutorialPage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
      assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 1, "same-tab reload restores the SB map");
      assert.equal(await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(), "1 / 3 件達成");

      await tutorialPage.evaluate((token) => sessionStorage.setItem("stage1-access-token", token), syntheticOtherAccessCode);
      await tutorialPage.reload();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      assert.equal(await tutorialPage.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(), true);
      await tutorialPage.getByRole("button", { name: /練習を開く/ }).click();
      await tutorialPage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
      assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 0, "another authorized Session does not inherit the first Session's map");
      assert.equal(await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(), "0 / 3 件達成");
      await tutorialPage.getByRole("button", { name: "案内へ戻る（練習未完了）" }).click();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();

      await tutorialPage.evaluate((token) => sessionStorage.setItem("stage1-access-token", token), syntheticAccessCode);
      await tutorialPage.reload();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      await tutorialPage.getByRole("button", { name: /練習を開く/ }).click();
      await tutorialPage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
      assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 1, "switching back restores only the original Session's saved map");
      assert.equal(await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(), "1 / 3 件達成");
      const practiceStorage = await tutorialPage.evaluate(() => Object.entries(sessionStorage)
        .filter(([key]) => key.startsWith("sbkb-practice-progress-v1:")));
      assert.equal(practiceStorage.length, 1, "only the SB progress touched in this scenario has been saved");
      assert.ok(practiceStorage[0]?.[0].includes(p02SessionId), "the saved record is scoped to the original Session");
      assert.ok(practiceStorage.every(([key, value]) => !key.includes(syntheticAccessCode) && !key.includes(syntheticOtherAccessCode) && !value.includes(syntheticAccessCode) && !value.includes(syntheticOtherAccessCode)), "practice progress never stores an access code");
      practiceRequestIndex = tutorialApiRequests.length;
      tutorialClaimsBeforePractice = tutorialClaimSecrets.length;
      sbWritesBeforeActions = tutorialApiRequests.filter((request) => request.method !== "GET").length;
      sbZoom = await exerciseCanvasZoomControls(activeTutorialPanel);
    }
    // Keep the first concept and add two more without resetting the local map.
    for (const label of ["合成B", "合成C"]) {
      await tutorialPage.getByRole("button", { name: "＋ 概念", exact: true }).click();
      await tutorialPage.getByLabel("概念名").fill(label);
      await tutorialPage.getByRole("button", { name: "概念を追加" }).click();
    }
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 3);
    await activeTutorialPanel.locator(".concept-node").first().click();
    assert.equal(
      tutorialApiRequests.filter((request) => request.method !== "GET").length,
      sbWritesBeforeActions,
      "zooming and selecting an SB practice concept issue no write request",
    );
    await tutorialPage.getByLabel("概念名").fill("合成A変更");
    await activeTutorialPanel.locator(".map-editor-drawer").getByRole("button", { name: "保存" }).click();
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "1 / 3 件達成",
      "renaming a concept is available but is not an SB practice task",
    );
    const movingNode = activeTutorialPanel.locator(".concept-node").first();
    await movingNode.scrollIntoViewIfNeeded();
    const moving = await movingNode.boundingBox();
    assert.ok(moving, "first SB concept has a bounding box");
    await tutorialPage.mouse.move(moving.x + 30, moving.y + 30);
    await tutorialPage.mouse.down();
    await tutorialPage.mouse.move(moving.x + 100, moving.y + 75, { steps: 6 });
    await tutorialPage.mouse.up();
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "2 / 3 件達成",
      "moving a concept completes the second task",
    );
    await activeTutorialPanel.locator(".concept-node").nth(2).click();
    await activeTutorialPanel.locator(".map-editor-drawer").getByRole("button", { name: "削除" }).click();
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "2 / 3 件達成",
      "deleting a concept is not an SB practice task",
    );
    await tutorialPage.getByRole("button", { name: "＋ リンク", exact: true }).click();
    await tutorialPage.getByLabel("リンクラベル").fill("合成リンク");
    await tutorialPage.getByRole("button", { name: "接続を開始" }).click();

    const connectTemporary = async (source: number, target: number) => {
      await activeTutorialPanel.locator(".link-connector.is-temporary .link-connector-handle.is-source")
        .first().dragTo(activeTutorialPanel.locator(".concept-node").nth(source));
      await activeTutorialPanel.locator(".link-connector.is-temporary .link-connector-handle.is-target")
        .first().dragTo(activeTutorialPanel.locator(".concept-node").nth(target));
      await activeTutorialPanel.locator(".link-connector.is-temporary").first()
        .waitFor({ state: "detached" });
    };
    await connectTemporary(0, 1);
    assert.equal(await sbZoom.percentage.innerText(), "150%", "SB link handles work after zoom and scroll");
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 2);
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "3 / 3 件達成",
      "connecting both endpoints completes the final SB task",
    );
    assert.equal(await tutorialPage.getByRole("button", { name: "統合マップの練習", exact: true }).isDisabled(), true);
    await tutorialPage.getByRole("button", { name: "次へ：Kit-Buildの練習", exact: true }).click();
    await tutorialPage.getByRole("heading", { name: "Kit-Buildの練習" }).waitFor();
    assert.equal(
      await activeTutorialPanel.getByRole("searchbox", { name: "キット一覧を検索" }).count(),
      1,
      "KB practice reuses the production Kit palette",
    );
    assert.match(
      await activeTutorialPanel.locator(".tutorial-practice-description").innerText(),
      /光合成Kitの部品を配置し、一致状況を確認/,
    );
    assert.equal(await tutorialPage.getByRole("button", { name: "Scratch-Buildの練習", exact: true }).isDisabled(), false);
    assert.equal(await tutorialPage.getByRole("button", { name: "統合マップの練習", exact: true }).isDisabled(), true);
    assert.equal(
      await activeTutorialPanel.locator(".tutorial-task-progress [role='status']").innerText(),
      "0 / 4 件達成",
    );
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 2);
    assert.equal(await activeTutorialPanel.locator(".link-connector:not(.is-temporary)").count(), 1);
    await captureBeforeAfter(tutorialPage, "tutorial-kit-build", width, directory);
    let kbZoom = await exerciseCanvasZoomControls(activeTutorialPanel);

    if (width === 1366) {
      await tutorialPage.setViewportSize({ width: 390, height: 844 });
      await assertNoHorizontalOverflow(tutorialPage, "mobile kit before gestures", 390);
      await tutorialPage.setViewportSize({ width, height });
    }
    assert.equal(await activeTutorialPanel.locator(".tutorial-tools form").count(), 0);
    const checkButton = tutorialPage.getByRole("button", { name: "一致状況を確認", exact: true });
    const practiceCheckPath = "/api/tutorial/kit-practice/check";
    const checkResponse = () => tutorialPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === practiceCheckPath &&
        response.request().method() === "POST",
    );

    const initialCheck = checkResponse();
    await checkButton.click();
    assert.equal((await initialCheck).status(), 200, "partial Kit check uses its synthetic fixture");
    assert.equal(
      await activeTutorialPanel.locator(".kit-feedback-result-heading").innerText(),
      "不一致",
    );
    assert.match(
      await activeTutorialPanel.locator(".kit-feedback-dialog-content").innerText(),
      /概念 2\/3、関係 1\/2/,
      "initial partial build reports 2/3 concepts and 1/2 relations",
    );

    const carbonDioxidePart = activeTutorialPanel
      .locator(".kit-palette-part.is-concept")
      .filter({ hasText: "二酸化炭素" });
    assert.equal(await carbonDioxidePart.isEnabled(), true);
    await dispatchSyntheticKitPartDrop(
      tutorialPage,
      "concept",
      "二酸化炭素",
      { x: 760, y: 350 },
    );
    await tutorialPage.waitForFunction(
      () => document.querySelectorAll(".tutorial-practice-panel:not([hidden]) .concept-node").length === 3,
    );
    assert.equal(
      await activeTutorialPanel.locator(".tutorial-task-progress [role='status']").innerText(),
      "0 / 4 件達成",
      "placement alone does not mark assessment or correction complete",
    );

    const neededLinkPart = activeTutorialPanel
      .locator(".kit-palette-part.is-link")
      .filter({ hasText: "必要とする" });
    assert.equal(await neededLinkPart.isEnabled(), true, "the relation palette item is available");
    await dispatchSyntheticKitPartDrop(
      tutorialPage,
      "link",
      "必要とする",
      { x: 760, y: 250 },
    );
    const temporaryLink = activeTutorialPanel.locator(".link-connector.is-temporary");
    await temporaryLink.waitFor({ state: "visible" });
    await connectTemporary(2, 1);
    await temporaryLink.waitFor({ state: "detached" });
    assert.equal(await activeTutorialPanel.locator(".link-connector:not(.is-temporary)").count(), 2);

    const wrongDirectionCheck = checkResponse();
    await checkButton.click();
    assert.equal((await wrongDirectionCheck).status(), 200, "reversed Kit check uses its synthetic fixture");
    assert.equal(
      await activeTutorialPanel.locator(".kit-feedback-result-heading").innerText(),
      "不一致",
    );
    assert.match(
      await activeTutorialPanel.locator(".kit-feedback-dialog-content").innerText(),
      /概念 3\/3、関係 1\/2/,
      "placed relation with reversed endpoints remains 3/3 concepts and 1/2 relations",
    );
    assert.equal(
      await activeTutorialPanel.locator(".tutorial-task-progress [role='status']").innerText(),
      "2 / 4 件達成",
      "a mismatched assessment can be retried and does not complete the practice",
    );

    const retryCheck = checkResponse();
    await checkButton.click();
    assert.equal((await retryCheck).status(), 200, "mismatch can be retried against the synthetic fixture");
    assert.match(
      await activeTutorialPanel.locator(".kit-feedback-dialog-content").innerText(),
      /概念 3\/3、関係 1\/2/,
      "retry keeps the incorrect-direction result",
    );

    const requiredEdge = activeTutorialPanel
      .locator(".link-connector:not(.is-temporary)")
      .filter({ hasText: "必要とする" });
    const photosynthesisNode = activeTutorialPanel
      .locator(".concept-node")
      .filter({ hasText: "光合成" });
    const carbonDioxideNode = activeTutorialPanel
      .locator(".concept-node")
      .filter({ hasText: "二酸化炭素" });
    await requiredEdge.locator(".link-connector-handle.is-source").scrollIntoViewIfNeeded();
    await photosynthesisNode.scrollIntoViewIfNeeded();
    await requiredEdge
      .locator(".link-connector-handle.is-source")
      .dragTo(photosynthesisNode);
    await requiredEdge
      .locator(".link-connector-handle.is-target")
      .dragTo(carbonDioxideNode);
    assert.equal(
      await activeTutorialPanel.locator(".tutorial-task-progress [role='status']").innerText(),
      "3 / 4 件達成",
      "changing both endpoints after mismatch completes only the correction task",
    );
    assert.equal(await activeTutorialPanel.locator(".kit-feedback-result-heading").count(), 0);

    const correctedCheck = checkResponse();
    await checkButton.click();
    assert.equal((await correctedCheck).status(), 200, "corrected Kit check uses its synthetic fixture");
    assert.equal(
      await activeTutorialPanel.locator(".kit-feedback-result-heading").innerText(),
      "一致",
    );
    assert.match(
      await activeTutorialPanel.locator(".kit-feedback-dialog-content").innerText(),
      /概念 3\/3、関係 2\/2/,
      "corrected direction matches all fixed Kit parts",
    );
    assert.equal(
      await activeTutorialPanel.locator(".tutorial-task-progress [role='status']").innerText(),
      "4 / 4 件達成",
    );
    if (inlineP02) {
      await tutorialPage.getByRole("button", { name: "案内へ戻る（練習未完了）" }).click();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      assert.equal(await tutorialPage.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(), true);
      await tutorialPage.getByRole("button", { name: /練習を開く/ }).click();
      await tutorialPage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
      assert.equal(await tutorialPage.getByRole("button", { name: "Kit-Buildの練習", exact: true }).getAttribute("aria-pressed"), "true", "P02 resumes the last saved KB mode");
      assert.equal(await activeTutorialPanel.locator(".tutorial-task-progress [role='status']").innerText(), "4 / 4 件達成", "KB achievements survive returning to P02");
      assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 3, "KB placements survive returning to P02");
      assert.equal(await activeTutorialPanel.locator(".kit-feedback-result-heading").innerText(), "一致", "the saved KB result is shown only for its unchanged judged map");
      kbZoom = await exerciseCanvasZoomControls(activeTutorialPanel);
    }
    assert.equal(await kbZoom.percentage.innerText(), "150%", "KB correction succeeds after zoom and scroll");
    assert.equal(tutorialPracticeBodies.length, 4, "KB uses only the fixed practice check endpoint");
    for (const body of tutorialPracticeBodies) {
      assert.deepEqual(Object.keys(body as object).sort(), ["concepts", "links"]);
      const value = body as { concepts: Array<Record<string, unknown>>; links: Array<Record<string, unknown>> };
      assert.ok(value.concepts.every((item) => Object.keys(item).sort().join(",") === "id,kitConceptItemId"));
      assert.ok(value.links.every((item) => Object.keys(item).sort().join(",") === "id,kitLinkItemId,sourceConceptId,targetConceptId"));
      assert.ok(!JSON.stringify(body).includes("55555555-"), "client request contains no goal concept IDs");
      assert.ok(!JSON.stringify(body).includes("99999999-"), "client request contains no goal link IDs");
    }
    await tutorialPage.getByRole("button", { name: "次へ：統合マップの練習", exact: true }).waitFor();
    if (width === 1366) {
      await tutorialPage.setViewportSize({ width: 390, height: 844 });
      await assertNoHorizontalOverflow(tutorialPage, "mobile kit after gestures", 390);
      await tutorialPage.setViewportSize({ width, height });
    }
    await tutorialPage.getByRole("button", { name: "次へ：統合マップの練習", exact: true }).click();
    await tutorialPage.getByRole("heading", { name: "統合マップの練習" }).waitFor();
    assert.equal(
      await activeTutorialPanel.locator(".tutorial-practice-description").count(),
      2,
      "integration practice explains display-only numbering and origins",
    );
    assert.equal(await activeTutorialPanel.getByRole("searchbox", { name: "キット一覧を検索" }).count(), 0);
    assert.equal(await activeTutorialPanel.locator(".tutorial-task-progress ol li").count(), 3);
    const integrationTasks = await activeTutorialPanel.locator(".tutorial-task-progress ol li").allInnerTexts();
    assert.equal(integrationTasks.length, 3);
    for (const label of ["同名概念を見分ける", "Mergeする", "練習内で提出する"])
      assert.ok(integrationTasks.some((task) => task.includes(label)), `integration practice contains only the required task: ${label}`);
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 2);
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "0 / 3 件達成",
    );
    const practiceSbNode = activeTutorialPanel.locator(
      '.concept-node[data-concept-id="practice-sb-photosynthesis"]',
    );
    const practiceKbNode = activeTutorialPanel.locator(
      '.concept-node[data-concept-id="practice-kb-photosynthesis"]',
    );
    assert.equal(await practiceSbNode.locator("h3").innerText(), "光合成 (1)");
    assert.equal(await practiceKbNode.locator("h3").innerText(), "光合成 (2)");
    assert.match(
      await activeTutorialPanel.getByRole("note").innerText(),
      /SB由来：光合成 \(1\).*KB由来：光合成 \(2\)/,
    );

    const practiceMergePanel = tutorialPage.getByRole("region", { name: "Concept Merge" });
    const practiceMergeButton = practiceMergePanel.getByRole("button", { name: "Merge", exact: true });
    const practiceSubmitButton = tutorialPage.getByRole("button", { name: "練習内で提出", exact: true });
    assert.equal(await practiceMergeButton.isDisabled(), true);
    assert.equal(await practiceSubmitButton.isDisabled(), true);
    const displayedOptions = await practiceMergePanel.getByLabel("Concept A").locator("option").allTextContents();
    assert.ok(displayedOptions.some((option) => option.includes("光合成 (1)")));
    assert.ok(displayedOptions.some((option) => option.includes("光合成 (2)")));

    const integrationZoom = await exerciseCanvasZoomControls(activeTutorialPanel);
    await practiceKbNode.scrollIntoViewIfNeeded();
    const practiceKbBox = await practiceKbNode.boundingBox();
    assert.ok(practiceKbBox, "KB-origin practice concept is visible");
    await tutorialPage.mouse.move(
      practiceKbBox.x + practiceKbBox.width / 2,
      practiceKbBox.y + practiceKbBox.height / 2,
    );
    await tutorialPage.mouse.down();
    await tutorialPage.mouse.move(
      practiceKbBox.x + practiceKbBox.width / 2 + 34,
      practiceKbBox.y + practiceKbBox.height / 2 + 18,
      { steps: 4 },
    );
    await tutorialPage.mouse.up();
    assert.equal(await practiceSbNode.locator("h3").innerText(), "光合成 (1)");
    assert.equal(await practiceKbNode.locator("h3").innerText(), "光合成 (2)");
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "0 / 3 件達成",
      "moving a practice concept does not change its display ordinal or complete a task",
    );
    assert.equal(await integrationZoom.percentage.innerText(), "150%", "integration practice drag works after zoom and scroll");

    await practiceMergePanel.getByLabel("Concept A").selectOption("practice-sb-photosynthesis");
    await practiceMergePanel.getByLabel("Concept B").selectOption("practice-kb-photosynthesis");
    assert.equal(
      await practiceMergePanel.getByLabel("Merge後のlabel").inputValue(),
      "光合成",
      "the display ordinal is not copied into the merge label",
    );
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "1 / 3 件達成",
      "selecting the two origins completes the identification task",
    );
    assert.equal(await practiceSubmitButton.isDisabled(), true);
    tutorialPage.once("dialog", async (dialog) => {
      assert.match(dialog.message(), /「光合成 \(1\)」と「光合成 \(2\)」をMergeし、「光合成」として表示します/);
      await dialog.accept();
    });
    await practiceMergeButton.click();
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 1);
    assert.equal(
      await activeTutorialPanel.locator(".concept-node h3").innerText(),
      "光合成",
      "the merged practice concept keeps the unnumbered saved label",
    );
    assert.equal(await activeTutorialPanel.locator('.concept-node[data-concept-id="practice-sb-photosynthesis"]').count(), 0);
    assert.equal(await activeTutorialPanel.locator('.concept-node[data-concept-id="practice-kb-photosynthesis"]').count(), 0);
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "2 / 3 件達成",
      "only an actual local merge completes the Merge task",
    );
    assert.equal(await practiceSubmitButton.isEnabled(), true);
    if (inlineP02) {
      await tutorialPage.getByRole("button", { name: "案内へ戻る（練習未完了）" }).click();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      assert.equal(await tutorialPage.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(), true);
      await tutorialPage.getByRole("button", { name: /練習を開く/ }).click();
      await tutorialPage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
      assert.equal(await tutorialPage.getByRole("button", { name: "統合マップの練習", exact: true }).getAttribute("aria-pressed"), "true", "P02 resumes the unfinished integration mode");
      assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 1, "the merged practice map is restored");
      assert.equal(await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(), "2 / 3 件達成");
      assert.equal(await practiceSubmitButton.isEnabled(), true, "the saved merge keeps the practice submission available");
    }
    await practiceSubmitButton.click();
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "3 / 3 件達成",
    );
    assert.equal(await tutorialPage.getByRole("button", { name: "練習内で提出済み", exact: true }).isDisabled(), true);
    await activeTutorialPanel.getByText(
      "練習内で提出しました。実験Sessionの提出・研究記録には反映されません。",
    ).waitFor();
    await tutorialPage.getByText("すべてのマップの操作練習が完了しました。").waitFor();
    assert.equal(await tutorialPage.getByRole("button", { name: "練習を終了", exact: true }).isEnabled(), true);
    if (inlineP02) {
      await tutorialPage.getByRole("button", { name: "練習を終了", exact: true }).click();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      assert.equal(await tutorialPage.getByRole("button", { name: "セッションを開始", exact: true }).isEnabled(), true);
      await tutorialPage.getByRole("button", { name: /練習を開く/ }).click();
      await tutorialPage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
      assert.equal(await tutorialPage.getByRole("button", { name: "練習内で提出済み", exact: true }).isDisabled(), true, "P02 re-entry restores the integration practice submission state");
      await activeTutorialPanel.getByText("練習内で提出しました。実験Sessionの提出・研究記録には反映されません。").waitFor();
    }
    await tutorialPage.getByRole("button", { name: "Scratch-Buildの練習", exact: true }).click();
    await tutorialPage.getByRole("heading", { name: "Scratch-Buildの練習" }).waitFor();
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "3 / 3 件達成",
    );
    assert.ok(await activeTutorialPanel.locator(".concept-node").count() > 0, "SB map is retained");
    await tutorialPage.getByRole("button", { name: "Kit-Buildの練習", exact: true }).click();
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "4 / 4 件達成",
    );
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 3, "KB map is retained");
    await tutorialPage.getByRole("button", { name: "統合マップの練習", exact: true }).click();
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "3 / 3 件達成",
    );
    if (inlineP02) {
      tutorialPage.once("dialog", dialog => dialog.accept());
      await tutorialPage.getByRole("button", { name: "この練習をやり直す", exact: true }).click();
      assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 2, "reset restores only the integration practice's initial map");
      assert.equal(await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(), "0 / 3 件達成");
      assert.equal(await tutorialPage.getByRole("button", { name: "練習内で提出", exact: true }).isDisabled(), true, "reset integration practice cannot remain submitted");
      await tutorialPage.getByRole("button", { name: "案内へ戻る（練習未完了）" }).click();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      assert.equal(await tutorialPage.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(), true, "resetting one practice clears the P02 completion gate");
      await tutorialPage.getByRole("button", { name: /練習を開く/ }).click();
      await tutorialPage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
      assert.equal(await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(), "0 / 3 件達成", "reopening resumes the reset integration practice");
      await tutorialPage.getByRole("button", { name: "Scratch-Buildの練習", exact: true }).click();
      assert.equal(await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(), "3 / 3 件達成", "reset does not erase completed SB progress");
      assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 2);
      await tutorialPage.getByRole("button", { name: "Kit-Buildの練習", exact: true }).click();
      assert.equal(await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(), "4 / 4 件達成", "reset does not erase completed KB progress");
      assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 3);
      await tutorialPage.getByRole("button", { name: "統合マップの練習", exact: true }).click();
      await practiceMergePanel.getByLabel("Concept A").selectOption("practice-sb-photosynthesis");
      await practiceMergePanel.getByLabel("Concept B").selectOption("practice-kb-photosynthesis");
      tutorialPage.once("dialog", dialog => dialog.accept());
      await practiceMergeButton.click();
      assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 1);
      await practiceSubmitButton.click();
      assert.equal(await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(), "3 / 3 件達成", "integration progress is restored only by completing Merge and practice submission again");
    }
    if (inlineP02) {
      await tutorialPage.getByRole("button", { name: "Kit-Buildの練習", exact: true }).click();
      const practiceCheckPath = "/api/tutorial/kit-practice/check";
      let releaseLateCheck!: () => void;
      let markLateRequest!: () => void;
      const lateCheckGate = new Promise<void>((resolve) => { releaseLateCheck = resolve; });
      const lateRequestSeen = new Promise<void>((resolve) => { markLateRequest = resolve; });
      await tutorialPage.route(`**${practiceCheckPath}`, async (route) => {
        markLateRequest();
        await lateCheckGate;
        await json(route, { error: "synthetic_delayed_failure" }, 503);
      });
      await checkButton.click();
      await lateRequestSeen;
      await tutorialPage.getByRole("button", { name: "練習を終了", exact: true }).click();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      const lateResponsePromise = tutorialPage.waitForResponse(
        (response) => new URL(response.url()).pathname === practiceCheckPath && response.status() === 503,
      );
      releaseLateCheck();
      const lateResponse = await lateResponsePromise;
      assert.equal(lateResponse.ok(), false);
      assert.equal(await tutorialPage.getByRole("heading", { name: "活動の案内" }).count(), 1);
      assert.equal(await tutorialPage.getByRole("alert").count(), 0, "late practice failure is not shown on P02");
      await tutorialPage.unroute(`**${practiceCheckPath}`);
    }
    if (inlineP02) {
      const allowedPracticeReads = new Set(["/api/experiment-status", p02FlowPath]);
      assert.deepEqual(
        tutorialApiRequests.slice(practiceRequestIndex).filter(
          (request) => !(
            request.method === "GET" && allowedPracticeReads.has(request.path) ||
            request.method === "POST" && request.path === "/api/tutorial/kit-practice/check"
          ),
        ),
        [],
        "actual three-mode P02 practice makes no research writes or unexpected API calls",
      );
      assert.equal(
        tutorialClaimSecrets.length,
        tutorialClaimsBeforePractice,
        "actual practice never registers another experiment client",
      );
    } else {
      assert.deepEqual(
        tutorialApiRequests.filter((request) => request.path !== "/api/tutorial/kit-practice/check"),
        [],
        "standalone practice uses only the fixed Kit check endpoint",
      );
    }
    if (!inlineP02) await tutorialPage.getByRole("button", { name: "練習を終了", exact: true }).click();
    if (inlineP02) {
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      const startButton = tutorialPage.getByRole("button", { name: "セッションを開始", exact: true });
      assert.equal(await startButton.isEnabled(), true, "actual completion unlocks P02 start");
      const completionKey = `sbkb-practice-complete-v1:${p02SessionId}:${requestDigest(syntheticAccessCode)}`;
      assert.equal(
        await tutorialPage.evaluate((key) => sessionStorage.getItem(key), completionKey),
        "1",
        "real practice finish records only the tab-local completion marker",
      );
      assert.equal(
        await tutorialPage.evaluate(() => sessionStorage.getItem("stage1-access-token")),
        syntheticAccessCode,
        "the access token survives actual practice completion",
      );
      const claimSecret = tutorialClaimSecrets.at(-1);
      assert.ok(claimSecret, "P02 has an existing experiment client identity");
      const clientKey = `sbkb-experiment-client-v1:${p02SessionId}`;
      const clientState = await tutorialPage.evaluate((key) => sessionStorage.getItem(key), clientKey);
      assert.ok(clientState, "same-tab client ownership is stored before F5");
      const claimsBeforeF5 = tutorialClaimSecrets.length;
      await tutorialPage.reload();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      assert.ok(tutorialClaimSecrets.length > claimsBeforeF5, "F5 rechecks client ownership");
      assert.equal(tutorialClaimSecrets.at(-1), claimSecret, "F5 reuses the original client identity");
      assert.equal(await tutorialPage.evaluate((key) => sessionStorage.getItem(key), clientKey), clientState);
      assert.equal(await tutorialPage.evaluate((key) => sessionStorage.getItem(key), completionKey), "1");
      assert.equal(await startButton.isEnabled(), true, "actual completion survives F5");

      const startPath = `/api/sessions/${p02SessionId}/start`;
      const requestIndexBeforeStart = tutorialApiRequests.length;
      const started = tutorialPage.waitForResponse(
        (response) => new URL(response.url()).pathname === startPath && response.request().method() === "POST",
      );
      await startButton.click();
      assert.equal((await started).ok(), true, "session starts after real practice and F5");
      await tutorialPage.getByRole("button", { name: "開始する", exact: true }).waitFor();
      assert.deepEqual(
        tutorialApiRequests.slice(requestIndexBeforeStart).filter((request) => request.method !== "GET"),
        [{ path: startPath, method: "POST" }],
        "only the expected session start mutates the synthetic API",
      );
    } else {
      await tutorialPage.waitForURL(vite.resolvedUrls!.local[0]!);
    }
    await tutorialContext.close();

    const homeContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await homeContext.addInitScript(() =>
      sessionStorage.setItem(
        "stage1-access-token",
        "SYNTHETIC_RESEARCHER_TOKEN_ONLY",
      ),
    );
    const homePage = await homeContext.newPage();
    await installApiFixture(homePage, "researcher-populated");
    await homePage.goto(vite.resolvedUrls!.local[0]!);
    await homePage.getByRole("heading", { name: "研究者トップ" }).waitFor();
    assert.equal(await homePage.getByLabel("アクセスコード").count(), 0);
    assert.equal(await homePage.locator(".home-research-primary-grid .home-workflow-card").count(), 2);
    assert.equal(await homePage.getByRole("heading", { name: "教材を管理" }).count(), 1);
    assert.equal(await homePage.getByRole("heading", { name: "実施を管理" }).count(), 1);
    assert.equal(await homePage.getByRole("heading", { name: "実施の結果を確認" }).count(), 1);
    assert.equal(await homePage.getByRole("heading", { name: "システム状態", exact: true }).count(), 1);
    assert.equal(
      await homePage
        .getByRole("link", { name: /教材管理を開く/ })
        .getAttribute("href"),
      "/research/materials",
    );
    assert.equal(
      await homePage
        .getByRole("link", { name: /実施一覧を開く/ })
        .getAttribute("href"),
      "/research/experiment-runs",
    );
    // Researcher home exposes only the current management workflow.
    // Legacy Session data and researcher-only APIs remain available by direct route.
    for (const path of [
      "/research/stage1/new",
      "/research/data-management",
      "/research/events",
      "/research/event-exports",
    ]) {
      assert.equal(
        await homePage.locator(`a[href="${path}"]`).count(),
        0,
        `obsolete researcher-home entry ${path} must be absent`,
      );
    }
    assert.equal(
      await homePage.getByText("旧フローの作成", { exact: true }).count(),
      0,
    );
    assert.equal(
      await homePage.getByText("研究データ・ログ", { exact: true }).count(),
      0,
    );
    assert.equal(
      await homePage.locator('a[href="/research/goal-maps"]').count(),
      1,
    );
    assert.equal(
      await homePage
        .locator('a[href="/research/goal-maps"]')
        .isVisible(),
      true,
    );
    assert.equal(
      await homePage.locator(".research-session-list").count(),
      0,
      "old mixed-protocol Session listing is retired",
    );
    await captureBeforeAfter(
      homePage,
      "researcher-home-populated",
      width,
      directory,
    );
    await homePage.locator('a[href="/research/materials"]').focus();
    assert.equal(
      await homePage
        .locator('a[href="/research/materials"]')
        .evaluate((element) => getComputedStyle(element).outlineStyle),
      "solid",
      "main researcher navigation has a visible keyboard focus",
    );
    await homeContext.close();

    const integrationMapContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await integrationMapContext.addInitScript(() =>
      sessionStorage.setItem(
        "stage1-access-token",
        "SYNTHETIC_RESEARCHER_TOKEN_ONLY",
      ),
    );
    const integrationMapPage = await integrationMapContext.newPage();
    await installApiFixture(integrationMapPage, "researcher-populated");
    const productionMapFixture = await installProductionIntegrationMapFixture(integrationMapPage);
    await integrationMapPage.goto(
      `${vite.resolvedUrls!.local[0]}maps/${productionIntegrationMapId}`,
    );
    await integrationMapPage.getByRole("heading", { name: "Concept マップ", exact: true }).waitFor();
    const productionSbNode = integrationMapPage.locator(
      `.concept-node[data-concept-id="${productionDuplicateConceptIds.sb}"]`,
    );
    const productionKbNode = integrationMapPage.locator(
      `.concept-node[data-concept-id="${productionDuplicateConceptIds.kb}"]`,
    );
    const assertProductionDuplicateOrdinals = async () => {
      assert.equal(await productionSbNode.locator("h3").innerText(), "光合成 (1)");
      assert.equal(await productionKbNode.locator("h3").innerText(), "光合成 (2)");
      const firstOptions = await integrationMapPage
        .getByRole("region", { name: "Concept Merge" })
        .getByLabel("Concept A")
        .locator("option")
        .allTextContents();
      assert.ok(firstOptions.some((option) => option.includes("光合成 (1)")));
      assert.ok(firstOptions.some((option) => option.includes("光合成 (2)")));
    };
    await assertProductionDuplicateOrdinals();
    assert.equal(
      await integrationMapPage.locator(".concept-canvas-view-controls").count(),
      0,
      "researcher Map keeps the existing canvas controls",
    );
    await assertNoHorizontalOverflow(integrationMapPage, "production integration map", width);

    await integrationMapPage.reload();
    await integrationMapPage.getByRole("heading", { name: "Concept マップ", exact: true }).waitFor();
    await assertProductionDuplicateOrdinals();

    const productionMergePanel = integrationMapPage.getByRole("region", { name: "Concept Merge" });
    await productionMergePanel.getByLabel("Concept A").selectOption(productionDuplicateConceptIds.sb);
    await productionMergePanel.getByLabel("Concept B").selectOption(productionDuplicateConceptIds.kb);
    assert.equal(await productionMergePanel.getByLabel("Merge後のlabel").inputValue(), "光合成");
    const productionMergeResponsePromise = integrationMapPage.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/maps/${productionIntegrationMapId}/concepts/merge` &&
      response.request().method() === "POST",
    );
    integrationMapPage.once("dialog", async (dialog) => {
      assert.match(dialog.message(), /「光合成 \(1\)」と「光合成 \(2\)」をMergeし、「光合成」として表示します/);
      await dialog.accept();
    });
    await productionMergePanel.getByRole("button", { name: "Merge", exact: true }).click();
    assert.equal((await productionMergeResponsePromise).status(), 201);
    assert.equal(productionMapFixture.mergeRequests.length, 1);
    const productionMergeBody = productionMapFixture.mergeRequests[0] as {
      conceptIds: string[];
      label: string;
    };
    assert.deepEqual(productionMergeBody.conceptIds, [
      productionDuplicateConceptIds.sb,
      productionDuplicateConceptIds.kb,
    ]);
    assert.equal(productionMergeBody.label, "光合成", "display ordinals are not persisted as the concept name");
    const productionMergedNode = integrationMapPage.locator(
      `.concept-node[data-concept-id="${productionDuplicateConceptIds.merged}"] h3`,
    );
    await productionMergedNode.waitFor();
    assert.equal(await productionMergedNode.innerText(), "光合成");
    assert.equal(await integrationMapPage.locator(".concept-node").count(), 2);
    assert.equal(await productionSbNode.count(), 0);
    assert.equal(await productionKbNode.count(), 0);
    assert.deepEqual(
      productionMapFixture.snapshot().concepts.find((concept) => concept.id === productionDuplicateConceptIds.merged),
      {
        id: productionDuplicateConceptIds.merged,
        mapId: productionIntegrationMapId,
        label: "光合成",
        positionX: 265,
        positionY: 140,
        createdAt: "2026-11-25T01:00:00.000Z",
        updatedAt: "2026-11-25T01:00:00.000Z",
        isMergeResult: true,
      },
    );
    assert.ok(
      productionMapFixture.snapshot().links.every((link) =>
        link.sourceConceptId !== productionDuplicateConceptIds.sb &&
        link.sourceConceptId !== productionDuplicateConceptIds.kb &&
        link.targetConceptId !== productionDuplicateConceptIds.sb &&
        link.targetConceptId !== productionDuplicateConceptIds.kb,
      ),
      "the synthetic Merge response keeps both existing link endpoints attached to the Merge result",
    );
    await assertNoHorizontalOverflow(integrationMapPage, "production integration map after Merge", width);
    await integrationMapContext.close();

    const learnerMapContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await learnerMapContext.addInitScript((token) =>
      sessionStorage.setItem("stage1-access-token", token),
      syntheticAccessCode,
    );
    const learnerMapPage = await learnerMapContext.newPage();
    await installApiFixture(learnerMapPage, "legacy-session");
    const learnerMapFixture = await installProductionIntegrationMapFixture(
      learnerMapPage,
      "00000000-0000-4000-8000-000000000003",
    );
    await learnerMapPage.goto(
      `${vite.resolvedUrls!.local[0]}maps/${productionIntegrationMapId}`,
    );
    await learnerMapPage.getByRole("heading", { name: "Concept マップ", exact: true }).waitFor();
    assert.equal(
      await learnerMapPage.locator(".integration-deadline-status").count(),
      0,
      "no countdown is shown when the Session flow does not provide a deadline",
    );
    const learnerZoom = await exerciseCanvasZoomControls(learnerMapPage);
    const learnerKbNode = learnerMapPage.locator(
      `.concept-node[data-concept-id="${productionDuplicateConceptIds.kb}"]`,
    );
    await learnerKbNode.scrollIntoViewIfNeeded();
    await learnerKbNode.click();
    assert.equal(
      learnerMapFixture.positionRequests.length,
      0,
      "zoom, Fit, scroll, and selecting a concept do not send position PATCH",
    );
    assert.equal(await learnerZoom.percentage.innerText(), "150%");
    await learnerKbNode.scrollIntoViewIfNeeded();
    const learnerKbBox = await learnerKbNode.boundingBox();
    assert.ok(learnerKbBox, "learner Map node remains visible after zoom and scroll");
    const learnerPositionResponse = learnerMapPage.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/concepts/${productionDuplicateConceptIds.kb}/position` &&
      response.request().method() === "PATCH",
    );
    await learnerMapPage.mouse.move(
      learnerKbBox.x + learnerKbBox.width / 2,
      learnerKbBox.y + learnerKbBox.height / 2,
    );
    await learnerMapPage.mouse.down();
    await learnerMapPage.mouse.move(
      learnerKbBox.x + learnerKbBox.width / 2 + 90,
      learnerKbBox.y + learnerKbBox.height / 2 + 60,
      { steps: 6 },
    );
    await learnerMapPage.mouse.up();
    assert.equal((await learnerPositionResponse).status(), 200);
    assert.equal(learnerMapFixture.positionRequests.length, 1);
    const savedLearnerPosition = learnerMapFixture.positionRequests[0]!;
    const savedSnapshotPosition = learnerMapFixture.snapshot().concepts.find(
      (concept) => concept.id === productionDuplicateConceptIds.kb,
    );
    assert.deepEqual(
      savedSnapshotPosition && {
        positionX: savedSnapshotPosition.positionX,
        positionY: savedSnapshotPosition.positionY,
      },
      { positionX: savedLearnerPosition.positionX, positionY: savedLearnerPosition.positionY },
      "synthetic map API stores the exact position sent by the pointer drag",
    );
    await learnerMapPage.reload();
    await learnerMapPage.getByRole("heading", { name: "Concept マップ", exact: true }).waitFor();
    const reloadedLearnerPosition = await learnerMapPage
      .locator(`.concept-node[data-concept-id="${productionDuplicateConceptIds.kb}"]`)
      .evaluate((element) => ({
        left: Number.parseFloat((element as HTMLElement).style.left),
        top: Number.parseFloat((element as HTMLElement).style.top),
      }));
    assert.deepEqual(reloadedLearnerPosition, {
      left: savedLearnerPosition.positionX,
      top: savedLearnerPosition.positionY,
    }, "reload renders the saved API coordinates at the same logical position");
    await learnerMapContext.close();

    for (const mapType of ["PRIOR", "KB"] as const) {
      const mapContext = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      await mapContext.addInitScript((token) =>
        sessionStorage.setItem("stage1-access-token", token),
        syntheticAccessCode,
      );
      const mapPage = await mapContext.newPage();
      await installApiFixture(mapPage, "legacy-session");
      const mapFixture = await installProductionIntegrationMapFixture(
        mapPage,
        "00000000-0000-4000-8000-000000000003",
        mapType,
      );
      await mapPage.goto(`${vite.resolvedUrls!.local[0]}maps/${productionIntegrationMapId}`);
      await mapPage.locator(".concept-canvas-viewport").waitFor();
      await exerciseCanvasZoomControls(mapPage);
      await mapPage.locator(".concept-node").first().click();
      assert.equal(
        mapFixture.positionRequests.length,
        0,
        `${mapType} zoom, Fit, scroll, and selection do not save a position`,
      );
      await mapContext.close();
    }

    const deadlineSessionId = "00000000-0000-4000-8000-000000000003";
    const deadlineStageId = "00000000-0000-4000-8000-000000000022";
    const deadlineMapUrl = new URL(
      "maps/" + productionIntegrationMapId,
      vite.resolvedUrls!.local[0],
    ).toString();
    const canvasTop = async (page: Page) => {
      const box = await page.locator(".concept-canvas-viewport").boundingBox();
      assert.ok(box, "integration canvas is rendered");
      return box.y;
    };
    const assertCanvasTopStable = async (
      page: Page,
      expected: number,
      message: string,
    ) => {
      const actual = await canvasTop(page);
      assert.ok(
        Math.abs(actual - expected) <= 2,
        `${message}: expected ${expected}, received ${actual}`,
      );
    };
    const waitForDeadlineLayoutToSettle = async (
      page: Page,
      stateLabel: string,
    ) => {
      await page.waitForFunction(
        (label) => {
          const selectors = [
            ".map-editor-header",
            ".map-editor-header-actions",
            ".integration-deadline-status",
            'header p[role="status"]:not(.integration-deadline-status)',
            ".session-error",
            ".map-editor-operation-hint",
            ".map-editor-tools",
            ".map-editor-supplement-grid",
            ".concept-canvas-viewport",
            ".map-editor-save-status",
          ];
          const parts = [
            window.innerWidth,
            window.innerHeight,
            document.documentElement.clientWidth,
            window.scrollX.toFixed(2),
            window.scrollY.toFixed(2),
          ];
          for (let index = 0; index < selectors.length; index += 1) {
            const selector = selectors[index];
            const element = document.querySelector(selector);
            if (!element) {
              parts.push(`${selector}:absent`);
              continue;
            }
            const rect = element.getBoundingClientRect();
            parts.push(
              `${selector}:${rect.top.toFixed(2)},${rect.width.toFixed(2)},${rect.height.toFixed(2)},${(element.textContent ?? "").replace(/\s+/g, " ").trim()}`,
            );
          }
          const signature = `${label}:${parts.join("|")}`;
          const probe = window as unknown as Record<string, string | undefined>;
          const previous = probe.__deadlineLayoutProbe;
          if (previous === signature) {
            delete probe.__deadlineLayoutProbe;
            return true;
          }
          probe.__deadlineLayoutProbe = signature;
          return false;
        },
        stateLabel,
        { polling: "raf", timeout: 5000 },
      );
    };
    const readDeadlineLayout = async (page: Page) =>
      page.evaluate(() => {
        const header = document.querySelector(".map-editor-header")?.getBoundingClientRect();
        const headerActions = document.querySelector(".map-editor-header-actions")?.getBoundingClientRect();
        const deadline = document.querySelector(".integration-deadline-status")?.getBoundingClientRect();
        const operationHint = document.querySelector(".map-editor-operation-hint")?.getBoundingClientRect();
        const tools = document.querySelector(".map-editor-tools")?.getBoundingClientRect();
        const supplement = document.querySelector(".map-editor-supplement-grid")?.getBoundingClientRect();
        const canvas = document.querySelector(".concept-canvas-viewport")?.getBoundingClientRect();
        return {
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            clientWidth: document.documentElement.clientWidth,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
          },
          areas: {
            header: header ? { top: header.top, width: header.width, height: header.height } : null,
            headerActions: headerActions ? { top: headerActions.top, width: headerActions.width, height: headerActions.height } : null,
            deadline: deadline ? { top: deadline.top, width: deadline.width, height: deadline.height } : null,
            operationHint: operationHint ? { top: operationHint.top, width: operationHint.width, height: operationHint.height } : null,
            tools: tools ? { top: tools.top, width: tools.width, height: tools.height } : null,
            supplement: supplement ? { top: supplement.top, width: supplement.width, height: supplement.height } : null,
            canvas: canvas ? { top: canvas.top, width: canvas.width, height: canvas.height } : null,
          },
        };
      });
    const assertDeadlineAreasStable = async (
      page: Page,
      expected: Awaited<ReturnType<typeof readDeadlineLayout>>,
      message: string,
    ) => {
      const actual = await readDeadlineLayout(page);
      assert.deepEqual(actual.viewport, expected.viewport, `${message}: viewport and scroll remain stable`);
      for (const name of ["header", "headerActions", "deadline", "operationHint", "tools", "supplement"] as const) {
        const expectedArea = expected.areas[name];
        const actualArea = actual.areas[name];
        assert.ok(expectedArea && actualArea, `${message}: ${name} remains rendered`);
        for (const dimension of ["top", "width", "height"] as const) {
          assert.ok(
            Math.abs(actualArea[dimension] - expectedArea[dimension]) <= 1,
            `${message}: ${name} ${dimension} remains stable (expected ${expectedArea[dimension]}, received ${actualArea[dimension]})`,
          );
        }
      }
      await assertCanvasTopStable(
        page,
        expected.areas.canvas?.top ?? Number.NaN,
        `${message}: canvas remains stable`,
      );
    };
    const countdownContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await countdownContext.addInitScript((token) =>
      sessionStorage.setItem("stage1-access-token", token),
      syntheticAccessCode,
    );
    const countdownPage = await countdownContext.newPage();
    await installApiFixture(countdownPage, "legacy-session");
    const countdownStartedAt = new Date(Date.now() - 5000).toISOString();
    await installProductionIntegrationMapFixture(
      countdownPage,
      deadlineSessionId,
      "INTEGRATION",
      false,
      deadlineStageId,
    );
    await installIntegrationDeadlineFlowFixture(
      countdownPage,
      deadlineSessionId,
      deadlineStageId,
      countdownStartedAt,
      90,
      () => false,
      () => undefined,
    );
    await countdownPage.goto(deadlineMapUrl);
    await countdownPage.locator(".concept-canvas-viewport").waitFor();
    await countdownPage.locator(".integration-deadline-status").waitFor();
    const initialRemaining = await readDisplayedRemainingSeconds(countdownPage);
    assert.ok(initialRemaining > 0 && initialRemaining < 90);
    const initialCanvasTop = await canvasTop(countdownPage);
    await countdownPage.waitForTimeout(1200);
    const afterTickRemaining = await readDisplayedRemainingSeconds(countdownPage);
    assert.ok(afterTickRemaining < initialRemaining);
    await assertCanvasTopStable(
      countdownPage,
      initialCanvasTop,
      "changing countdown digits does not move the canvas",
    );

    await countdownPage.reload();
    await countdownPage.locator(".concept-canvas-viewport").waitFor();
    await countdownPage.locator(".integration-deadline-status").waitFor();
    const afterReloadRemaining =
      await readDisplayedRemainingSeconds(countdownPage);
    assert.ok(
      afterReloadRemaining < initialRemaining,
      "reload recalculates against the same server deadline instead of restarting it",
    );
    const reloadedCanvasTop = await canvasTop(countdownPage);

    await countdownPage.evaluate(() => window.dispatchEvent(new Event("blur")));
    const beforeBackgroundResume =
      await readDisplayedRemainingSeconds(countdownPage);
    await countdownPage.waitForTimeout(1200);
    await countdownPage.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const afterBackgroundResume =
      await readDisplayedRemainingSeconds(countdownPage);
    assert.ok(afterBackgroundResume < beforeBackgroundResume);
    await assertCanvasTopStable(
      countdownPage,
      reloadedCanvasTop,
      "returning from the background recalculates time without moving the canvas",
    );
    await assertNoHorizontalOverflow(
      countdownPage,
      "integration countdown",
      width,
    );
    await countdownContext.close();

    const submissionContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await submissionContext.addInitScript((token) =>
      sessionStorage.setItem("stage1-access-token", token),
      syntheticAccessCode,
    );
    const submissionPage = await submissionContext.newPage();
    await installApiFixture(submissionPage, "legacy-session");
    const submissionFixture = await installProductionIntegrationMapFixture(
      submissionPage,
      deadlineSessionId,
      "INTEGRATION",
      false,
      deadlineStageId,
    );
    let allowAutoSubmission = false;
    const submissionStartedAt = new Date(Date.now() - 1000).toISOString();
    const submissionFlow = await installIntegrationDeadlineFlowFixture(
      submissionPage,
      deadlineSessionId,
      deadlineStageId,
      submissionStartedAt,
      6,
      () => allowAutoSubmission,
      (submittedAt) => submissionFixture.markSubmitted(submittedAt),
    );
    await submissionPage.goto(deadlineMapUrl);
    await submissionPage.locator(".concept-canvas-viewport").waitFor();
    const submissionLabel = submissionPage.locator(
      ".integration-deadline-status",
    );
    await submissionLabel.waitFor();
    await waitForDeadlineLayoutToSettle(submissionPage, "before-deadline");
    const beforeDeadlineRemaining =
      await readDisplayedRemainingSeconds(submissionPage);
    assert.ok(beforeDeadlineRemaining > 0);
    const beforeDeadlineLayout = await readDeadlineLayout(submissionPage);
    await submissionPage.waitForFunction(
      () =>
        document
          .querySelector(".integration-deadline-status")
          ?.textContent?.includes("提出状態を確認中") === true,
      null,
      { timeout: 10000 },
    );
    assert.ok(submissionFlow.requestCount() >= 2);
    assert.equal(
      submissionFixture.snapshot().status,
      "DRAFT",
      "the UI does not show submission before the server confirms it",
    );
    assert.equal(
      await submissionPage.locator(".map-editor-save-status").innerText(),
      "保存済み",
    );
    await waitForDeadlineLayoutToSettle(submissionPage, "deadline-checking");
    await assertDeadlineAreasStable(
      submissionPage,
      beforeDeadlineLayout,
      "zero countdown does not move the canvas",
    );

    allowAutoSubmission = true;
    await submissionPage.waitForFunction(
      () =>
        document.querySelector(".integration-deadline-status")?.textContent ===
        "提出済み",
      null,
      { timeout: 5000 },
    );
    assert.equal(
      submissionFixture.snapshot().status,
      "SUBMITTED",
      "the synthetic server state is submitted before the UI label changes",
    );
    assert.ok(submissionFixture.snapshot().submittedAt);
    assert.equal(
      await submissionPage.locator(".map-editor-save-status").innerText(),
      "提出済み",
    );
    await waitForDeadlineLayoutToSettle(submissionPage, "server-confirmed-submitted");
    await assertDeadlineAreasStable(
      submissionPage,
      beforeDeadlineLayout,
      "changing to server-confirmed submitted status does not move the canvas",
    );
    assert.ok(submissionFlow.requestCount() >= 3);
    await assertNoHorizontalOverflow(
      submissionPage,
      "integration map after deadline submission",
      width,
    );
    await submissionContext.close();

    if (width === 1366) {
      const readOnlyContext = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      await readOnlyContext.addInitScript((token) =>
        sessionStorage.setItem("stage1-access-token", token),
        syntheticAccessCode,
      );
      const readOnlyPage = await readOnlyContext.newPage();
      await installApiFixture(readOnlyPage, "legacy-session");
      const readOnlyFixture = await installProductionIntegrationMapFixture(
        readOnlyPage,
        "00000000-0000-4000-8000-000000000003",
        "INTEGRATION",
        true,
      );
      await readOnlyPage.goto(`${vite.resolvedUrls!.local[0]}maps/${productionIntegrationMapId}`);
      await readOnlyPage.locator(".concept-canvas-viewport").waitFor();
      await exerciseCanvasZoomControls(readOnlyPage);
      assert.equal(
        readOnlyFixture.positionRequests.length,
        0,
        "submitted learner Map zoom is display-only",
      );
      await readOnlyContext.close();
    }
  }

  for (const width of [1366, 1440]) {
    const height = width === 1366 ? 768 : 900;
    const errorContext = await browser.newContext({ viewport: { width, height } });
    const errorPage = await errorContext.newPage();
    await installApiFixture(errorPage, "login-error");
    await errorPage.goto(vite.resolvedUrls!.local[0]!);
    await errorPage.getByLabel("アクセスコード", { exact: true }).fill(syntheticAccessCode);
    await errorPage.getByRole("button", { name: "続行" }).click();
    await errorPage.getByRole("alert").getByText(/コードを確認できませんでした/).waitFor();
    assert.equal(await errorPage.getByRole("heading", { name: "アクセスコードを入力" }).count(), 1);
    await assertNoHorizontalOverflow(errorPage, "login-error", width);
    await errorContext.close();

    let releaseAccessRequest = () => {};
    const pending = new Promise<void>((resolve) => {
      releaseAccessRequest = resolve;
    });
    const pendingContext = await browser.newContext({ viewport: { width, height } });
    const pendingPage = await pendingContext.newPage();
    await installApiFixture(pendingPage, "login-pending", async () => {
      await pending;
    });
    await pendingPage.goto(vite.resolvedUrls!.local[0]!);
    await pendingPage.getByLabel("アクセスコード", { exact: true }).fill(syntheticAccessCode);
    const pendingRequest = pendingPage.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/me",
    );
    await pendingPage.getByRole("button", { name: "続行" }).click();
    await pendingRequest;
    assert.equal(await pendingPage.getByRole("button", { name: "確認中…" }).isDisabled(), true);
    await pendingPage.getByRole("status").getByText("コードを確認しています…").waitFor();
    await assertNoHorizontalOverflow(pendingPage, "login-pending", width);
    releaseAccessRequest();
    await pendingPage.getByRole("heading", { name: "研究者トップ" }).waitFor();
    await pendingContext.close();
  }

  // Narrow-screen smoke test uses isolated API fixtures and never touches a DB.
  // The desktop gesture suite above still covers the full three-mode exercise.
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const mobilePage = await mobileContext.newPage();
  const mobileApiRequests: Array<{ path: string; method: string }> = [];
  mobilePage.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/"))
      mobileApiRequests.push({ path, method: request.method() });
  });
  await installApiFixture(mobilePage, "p02");
  await mobilePage.goto(vite.resolvedUrls!.local[0]!);
  await mobilePage.getByLabel("アクセスコード", { exact: true }).fill(syntheticAccessCode);
  await mobilePage.getByRole("button", { name: "続行", exact: true }).click();
  await mobilePage.getByRole("heading", { name: "活動の案内" }).waitFor();
  await assertNoHorizontalOverflow(mobilePage, "P02 mobile entry", 390);
  assert.equal(
    await mobilePage.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(),
    true,
  );
  const beforeMobilePractice = mobileApiRequests.length;
  await mobilePage.getByRole("button", { name: /練習を開く/ }).click();
  await mobilePage.getByRole("heading", { name: "操作の練習" }).waitFor();
  await assertNoHorizontalOverflow(mobilePage, "mobile practice", 390);
  for (const label of ["Scratch-Buildの練習", "Kit-Buildの練習", "統合マップの練習"]) {
    assert.equal(
      await mobilePage.getByRole("button", { name: label, exact: true }).isVisible(),
      true,
      `${label} is visible at 390px`,
    );
  }
  assert.equal(
    await mobilePage.getByRole("button", { name: "Kit-Buildの練習", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await mobilePage.getByRole("button", { name: "練習を終了", exact: true }).isDisabled(),
    true,
  );
  await mobilePage.getByRole("button", { name: "＋ 概念", exact: true }).click();
  await mobilePage.getByLabel("概念名").fill("390px合成概念");
  await mobilePage.getByRole("button", { name: "概念を追加" }).click();
  assert.equal(await mobilePage.locator(".tutorial-practice-panel:not([hidden]) .concept-node").count(), 1);
  await assertNoHorizontalOverflow(mobilePage, "mobile practice after concept creation", 390);
  const mobilePracticeRequests = mobileApiRequests.slice(beforeMobilePractice);
  assert.deepEqual(
    mobilePracticeRequests.filter((request) => request.method !== "GET"),
    [],
    "mobile practice must not issue API mutations",
  );
  await mobilePage.getByRole("button", { name: "案内へ戻る（練習未完了）" }).click();
  await mobilePage.getByRole("heading", { name: "活動の案内" }).waitFor();
  assert.equal(
    await mobilePage.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(),
    true,
  );
  await assertNoHorizontalOverflow(mobilePage, "P02 mobile return", 390);
  await mobileContext.close();

  console.log(
    `Rehearsal UI: PASS (signed-out code entry without practice card; P02 inline practice/return with unchanged client claims and no learning writes; precompleted start gate survives F5; 390px P02/practice smoke; normal start and historical session compatibility preserved; unpublished/waiting/ended; researcher states; synthetic browser fixtures at 1366x768 and 1440x900; screenshots: ${directory}; real API/DB persistence is verified separately)`,
  );
} finally {
  await browser?.close();
  await vite.close();
  await rm(viteCacheDir, { recursive: true, force: true });
}
