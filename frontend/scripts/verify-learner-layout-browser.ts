// Synthetic display fixtures only. These checks do not connect to an API or DB.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { createServer } from "vite";

const sessionId = "00000000-0000-4000-8000-000000000101";
const stageIds = {
  lesson: "00000000-0000-4000-8000-000000000201",
  prior: "00000000-0000-4000-8000-000000000202",
  kb: "00000000-0000-4000-8000-000000000203",
  integration: "00000000-0000-4000-8000-000000000204",
} as const;
const mapIds = {
  prior: "00000000-0000-4000-8000-000000000301",
  kb: "00000000-0000-4000-8000-000000000302",
  integration: "00000000-0000-4000-8000-000000000303",
} as const;
type Screen = keyof typeof stageIds;
const now = new Date().toISOString();
const startedAt = new Date(Date.now() - 60_000).toISOString();
const stages = (["lesson", "prior", "kb", "integration"] as const).map(
  (screen, orderIndex) => ({
    id: stageIds[screen],
    sessionId,
    stageType: {
      lesson: "LESSON",
      prior: "PRIOR_MAP",
      kb: "KB_MAP",
      integration: "INTEGRATION_MAP",
    }[screen],
    orderIndex,
    status: "IN_PROGRESS",
    startedAt,
    completedAt: null,
    mapId: screen === "lesson" ? null : mapIds[screen],
  }),
);

const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
const directory = join(tmpdir(), "sbkb-learner-layout-20261114");
const captureSuffix = process.env.LEARNER_LAYOUT_CAPTURE_SUFFIX ?? "after";

try {
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL ?? "msedge",
    headless: true,
  });
  const activeBrowser = browser;
  await mkdir(directory, { recursive: true });
  const screens = (Object.keys(stageIds) as Screen[]).filter(
    (screen) =>
      !process.env.LEARNER_LAYOUT_SCREEN ||
      process.env.LEARNER_LAYOUT_SCREEN === screen,
  );
  for (const width of [1366, 1440]) {
    for (const screen of screens) {
      const context = await activeBrowser.newContext({
        viewport: { width, height: 768 },
      });
      await context.addInitScript(() =>
        sessionStorage.setItem(
          "stage1-access-token",
          "TEST_ONLY_SYNTHETIC_TOKEN",
        ),
      );
      const page = await context.newPage();
      await page.addInitScript("globalThis.__name = (fn) => fn;");
      await page.route("**/api/**", async (route) => {
        const { pathname } = new URL(route.request().url());
        let body: unknown = {};
        if (pathname === "/api/me") {
          body = {
            role: "learner",
            sessionId,
            protocolKey: "SBKB_INTEGRATION_V1",
            flowAvailable: true,
            runState: "RUNNING",
          };
        } else if (pathname === "/api/experiment-client/claim") {
          body = {
            clientId: "00000000-0000-4000-8000-000000000401",
            ownership: "OWNED",
            deviceGeneration: 1,
          };
        } else if (pathname === "/api/experiment-material") {
          body = {
            sbInstructions: "合成のSB説明",
            kbInstructions: "合成のKB説明",
            integrationInstructions: "合成の統合説明",
          };
        } else if (pathname === `/api/sessions/${sessionId}/flow`) {
          const currentStage = stages.find(
            (stage) => stage.id === stageIds[screen],
          )!;
          body = {
            session: {
              id: sessionId,
              status: "IN_PROGRESS",
              startedAt,
              completedAt: null,
              protocolKey: "SBKB_INTEGRATION_V1",
              lessonVideoUrl: "https://example.test/synthetic-video.mp4",
              researchKitDefinitionId: "00000000-0000-4000-8000-000000000501",
              studyGroup: null,
              groupActivitySeconds: 900,
            },
            serverNow: now,
            currentMapSubmitted: false,
            currentIntegrationMapExists: screen === "integration",
            currentMapAutoSubmittedAt: null,
            stages,
            currentStage,
            nextStage: stages[stages.indexOf(currentStage) + 1] ?? null,
          };
        } else if (
          pathname.startsWith("/api/maps/") &&
          !pathname.endsWith("/undo-redo") &&
          !pathname.endsWith("/access")
        ) {
          const id = pathname.split("/")[3];
          const mapType =
            id === mapIds.prior
              ? "PRIOR"
              : id === mapIds.kb
                ? "KB"
                : "INTEGRATION";
          const stageId =
            id === mapIds.prior
              ? stageIds.prior
              : id === mapIds.kb
                ? stageIds.kb
                : stageIds.integration;
          body = {
            id,
            type: mapType,
            status: "DRAFT",
            title: null,
            createdAt: now,
            submittedAt: null,
            basedOnMapId: null,
            kitDefinitionId:
              mapType === "PRIOR"
                ? null
                : "00000000-0000-4000-8000-000000000501",
            kitDefinitionName: mapType === "PRIOR" ? null : "合成Kit",
            sessionStageId: stageId,
            sessionId,
            sessionStageStatus: "IN_PROGRESS",
            sessionProtocolKey: "SBKB_INTEGRATION_V1",
            concepts: [
              {
                id: `${id}-concept-1`,
                label: "合成概念A",
                positionX: 170,
                positionY: 150,
                createdAt: now,
                updatedAt: now,
                isSeed: mapType === "PRIOR",
              },
              {
                id: `${id}-concept-2`,
                label: "合成概念B",
                positionX: 500,
                positionY: 280,
                createdAt: now,
                updatedAt: now,
                isSeed: false,
              },
            ],
            links: [],
            kitLinks:
              mapType === "KB"
                ? Array.from({ length: 9 }, (_, index) => ({
                    kitLinkItemId: `synthetic-link-${index + 1}`,
                    label: `合成関係${index + 1}`,
                    used: false,
                  }))
                : [],
            kitConcepts:
              mapType === "KB"
                ? Array.from({ length: 9 }, (_, index) => ({
                    kitConceptItemId: `synthetic-part-${index + 1}`,
                    label: `合成部品${index + 1}`,
                    imported: false,
                  }))
                : [],
            availableKitDefinitions: [],
          };
        } else if (pathname.endsWith("/undo-redo")) {
          const id = pathname.split("/")[3];
          body = {
            mapId: id,
            status: "AVAILABLE",
            sequenceNumber: 0,
            canUndo: false,
            canRedo: false,
            undoOperation: null,
            redoOperation: null,
            reason: null,
          };
        } else if (pathname.endsWith("/access")) {
          body = { access: "ALLOWED" };
        } else if (pathname.endsWith("/kit-graph-signature")) {
          body = { mapSignature: "synthetic" };
        } else if (pathname.endsWith("/events")) {
          body = {
            logSaved: true,
            eventId: "00000000-0000-4000-8000-000000000601",
            sequenceNumber: "1",
          };
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });
      await page.route("https://example.test/synthetic-video.mp4", (route) =>
        route.fulfill({
          status: 200,
          contentType: "video/mp4",
          body: Buffer.alloc(0),
        }),
      );

      const path =
        screen === "lesson"
          ? `/sessions/${sessionId}`
          : `/maps/${mapIds[screen]}`;
      await page.goto(new URL(path, vite.resolvedUrls!.local[0]!).toString());
      const expectedHeading = {
        lesson: "STEP 1：授業動画",
        prior: "STEP 2：Scratch-Build",
        kb: "STEP 3：Kit-Build",
        integration: "STEP 4：統合",
      }[screen];
      await page
        .getByRole("heading", { name: expectedHeading, exact: true })
        .waitFor();
      if (screen !== "lesson") {
        try {
          await page
            .locator(".concept-canvas-viewport")
            .waitFor({ timeout: 5000 });
        } catch (error) {
          console.error(
            `fixture state for ${screen}: ${(await page.locator("body").innerText()).slice(0, 600)}`,
          );
          await page.screenshot({
            path: join(directory, `${screen}-fixture-failure.png`),
            fullPage: true,
          });
          throw error;
        }
        await page
          .getByRole("status", { name: "保存済み" })
          .waitFor()
          .catch(async () => {
            await page.getByText("保存済み", { exact: true }).waitFor();
          });
      }
      const metrics = await page.evaluate(() => {
        const rect = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const r = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            right: r.right,
            bottom: r.bottom,
            display: style.display,
            visible:
              r.width > 0 && r.height > 0 && style.visibility !== "hidden",
          };
        };
        return {
          viewportWidth: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          title: rect(screenSelector(".map-editor-title")),
          toolbar: rect(screenSelector(".map-editor-header-actions")),
          palette: rect(screenSelector(".kit-palette")),
          guidance: rect(screenSelector(".experiment-state-guidance")),
          operationHint: rect(screenSelector(".map-editor-operation-hint")),
          canvas: rect(screenSelector(".concept-canvas-viewport")),
          saveStatus: rect(screenSelector(".map-editor-save-status")),
          palettePartLists: Array.from(
            document.querySelectorAll(".kit-palette-list"),
            (element) => {
              const style = getComputedStyle(element);
              return {
                overflowX: style.overflowX,
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
                itemCount: element.children.length,
              };
            },
          ),
          lessonVideo: rect(screenSelector(".stage1-video-player")),
          buttons: Array.from(
            document.querySelectorAll(".map-editor-header-actions button"),
            (e) => {
              const r = e.getBoundingClientRect();
              return {
                text: e.textContent?.trim(),
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                right: r.right,
                bottom: r.bottom,
                visible: r.width > 0 && r.height > 0,
                textFits: e.scrollWidth <= e.clientWidth + 1,
              };
            },
          ),
          links: Array.from(
            document.querySelectorAll(".map-editor-header-actions a"),
            (e) => {
              const r = e.getBoundingClientRect();
              return {
                text: e.textContent?.trim(),
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                right: r.right,
                bottom: r.bottom,
                visible: r.width > 0 && r.height > 0,
                textFits: e.scrollWidth <= e.clientWidth + 1,
              };
            },
          ),
        };
        function screenSelector(selector: string) {
          return selector;
        }
      });
      assert.ok(
        metrics.documentWidth <= width,
        `${screen} at ${width}: horizontal overflow`,
      );
      if (screen !== "lesson") {
        assert.ok(
          metrics.canvas?.visible,
          `${screen} at ${width}: canvas must be visible`,
        );
        assert.ok(
          metrics.toolbar?.visible,
          `${screen} at ${width}: toolbar must be visible`,
        );
        assert.ok(
          metrics.buttons.every(
            (button) => !button.visible || button.right <= width,
          ),
          `${screen} at ${width}: toolbar button clipped`,
        );
        assert.ok(
          metrics.buttons.every((button) => !button.visible || button.textFits),
          `${screen} at ${width}: toolbar button text clipped`,
        );
        assert.ok(
          metrics.links.every(
            (link) => !link.visible || (link.right <= width && link.textFits),
          ),
          `${screen} at ${width}: toolbar link clipped`,
        );
        assert.ok(
          metrics.saveStatus?.visible,
          `${screen} at ${width}: save state must be visible`,
        );
        assert.ok(
          metrics.buttons.every((button, index) =>
            metrics.buttons
              .slice(index + 1)
              .every(
                (other) =>
                  !button.visible ||
                  !other.visible ||
                  button.right <= other.x ||
                  other.right <= button.x ||
                  button.bottom <= other.y ||
                  other.bottom <= button.y,
              ),
          ),
          `${screen} at ${width}: toolbar buttons overlap`,
        );
        if (screen === "kb") {
          assert.ok(
            metrics.palette?.visible && metrics.palette.height <= 170,
            `KB at ${width}: palette should follow the P06 compact two-row layout`,
          );
          assert.ok(
            metrics.palette.bottom < metrics.canvas.y,
            `KB at ${width}: palette and canvas must not overlap`,
          );
          assert.equal(metrics.palettePartLists.length, 2);
          assert.ok(
            metrics.palettePartLists.every((list) => list.itemCount === 9),
            `KB at ${width}: synthetic palette must contain enough items to exercise scrolling`,
          );
          assert.ok(
            metrics.palettePartLists.every(
              (list) =>
                (list.overflowX === "auto" || list.overflowX === "scroll") &&
                list.scrollWidth > list.clientWidth,
            ),
            `KB at ${width}: part rows must retain independent horizontal scrolling`,
          );
        }
        if (screen === "prior")
          assert.ok(
            metrics.canvas.height <= 576,
            `SB at ${width}: viewport should match P05 height`,
          );
      } else {
        assert.ok(
          metrics.lessonVideo?.visible,
          `lesson at ${width}: video area must be visible`,
        );
      }
      await page.screenshot({
        path: join(directory, `${screen}-${width}-${captureSuffix}.png`),
      });
      await page.screenshot({
        path: join(directory, `${screen}-${width}-full-${captureSuffix}.png`),
        fullPage: true,
      });
      await context.close();
      console.log(JSON.stringify({ screen, width, metrics }));
    }
  }
  console.log(
    `Learner lesson/SB/KB/integration synthetic browser layout: PASS; screenshots: ${directory}`,
  );
} finally {
  await browser?.close();
  await vite.close();
}
