// Synthetic UI geometry regression. No live API or rehearsal data is used.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const output = resolve(
  process.env.LINE_ALIGNMENT_OUTPUT ?? "../.local/link-line-alignment",
);
const baseline = process.env.LINE_ALIGNMENT_BASELINE === "1";
const vite = await createServer({
  server: { host: "127.0.0.1", port: 5197, strictPort: true },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const observations: unknown[] = [];
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.addInitScript(() =>
    sessionStorage.setItem("stage1-access-token", "synthetic-line-test-only"),
  );
  const id = (n: number) =>
    `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
  const mapId = id(1);
  const map = {
    id: mapId,
    type: "PRIOR",
    status: "DRAFT",
    title: "MOCK geometry",
    basedOnMapId: null,
    kitDefinitionId: null,
    kitDefinitionName: null,
    sessionStageId: null,
    sessionId: null,
    sessionProtocolKey: "SBKB_INTEGRATION_V1",
    submittedAt: null,
    concepts: [
      [100, 100],
      [100, 500],
      [500, 100],
      [950, 100],
      [500, 500],
      [950, 750],
    ].map(([x, y], i) => ({
      id: id(i + 2),
      mapId,
      label: `MOCK ${i}`,
      positionX: x,
      positionY: y,
      mergedIntoConceptId: null,
    })),
    links: [
      [2, 3, 190, 340],
      [4, 5, 810, 125],
      [6, 7, 810, 660],
    ].map(([s, t, x, y], i) => ({
      id: id(20 + i),
      mapId,
      sourceConceptId: id(s),
      targetConceptId: id(t),
      label: "MOCK relation",
      labelPositionX: x,
      labelPositionY: y,
    })),
    kitConcepts: [],
    kitLinks: [],
  };
  let writes = 0;
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === "/api/me")
      return route.fulfill({ json: { role: "researcher" } });
    if (path === `/api/maps/${mapId}`) return route.fulfill({ json: map });
    if (path.endsWith("/access"))
      return route.fulfill({
        json: {
          allowed: true,
          serverNow: new Date().toISOString(),
          expiresAt: null,
        },
      });
    if (path.endsWith("/undo-redo"))
      return route.fulfill({
        json: { status: "AVAILABLE", canUndo: false, canRedo: false },
      });
    const link = map.links.find((l) => path === `/api/links/${l.id}/position`);
    if (link && req.method() === "PATCH") {
      const body = req.postDataJSON();
      link.labelPositionX = body.labelPositionX;
      link.labelPositionY = body.labelPositionY;
      writes++;
      return route.fulfill({ json: { ...link, sequenceNumber: writes } });
    }
    return route.fulfill({
      status: 404,
      json: { error: "synthetic_not_found" },
    });
  });
  async function inspect(condition: string) {
    await page.locator(".concept-edge-path").first().waitFor();
    const rows = await page.evaluate(() => {
      const labels = [
        ...document.querySelectorAll<HTMLElement>(".link-connector"),
      ];
      const paths = [
        ...document.querySelectorAll<SVGPathElement>(".concept-edge-path"),
      ];
      return labels
        .map((label, i) => {
          const rect = label.getBoundingClientRect();
          const center = {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
          };
          return paths.slice(i * 2, i * 2 + 2).map((path, j) => {
            const numbers = path
              .getAttribute("d")!
              .match(/-?\d+(?:\.\d+)?/g)!
              .map(Number);
            const matrix = path.getScreenCTM()!;
            const a = new DOMPoint(numbers[0], numbers[1]).matrixTransform(
              matrix,
            );
            const b = new DOMPoint(numbers[2], numbers[3]).matrixTransform(
              matrix,
            );
            const cross = Math.abs(
              (center.x - a.x) * (b.y - a.y) - (center.y - a.y) * (b.x - a.x),
            );
            return {
              link: i,
              half: j,
              distanceFromLabelCenter: cross / Math.hypot(b.x - a.x, b.y - a.y),
            };
          });
        })
        .flat();
    });
    observations.push({ condition, rows });
    if (!baseline)
      for (const row of rows)
        assert.ok(
          row.distanceFromLabelCenter < 0.1,
          `${condition}: link ${row.link} half ${row.half} is not collinear with label center`,
        );
    return rows;
  }
  await page.goto(vite.resolvedUrls!.local[0] + `maps/${mapId}`);
  await page.locator(".link-connector-label").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  const initial = await inspect("normal");
  if (baseline)
    assert.ok(
      initial.some((r) => r.link === 0 && r.distanceFromLabelCenter > 5),
      "baseline must reproduce vertical offset",
    );
  await page.locator(".concept-canvas-viewport").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(output, baseline ? "before.png" : "after.png"),
  });
  await page.getByRole("button", { name: "全体表示", exact: true }).click();
  await inspect("fit");
  await page.locator(".concept-canvas-viewport").evaluate((e) => {
    e.scrollLeft = 80;
    e.scrollTop = 40;
  });
  await page.evaluate(() => window.scrollBy(0, 100));
  await inspect("scroll");
  const label = page.locator(".link-connector-label").first();
  await label.scrollIntoViewIfNeeded();
  const b = await label.boundingBox();
  assert.ok(b);
  const original = {
    x: map.links[0].labelPositionX,
    y: map.links[0].labelPositionY,
  };
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 35, b.y + b.height / 2 + 20, {
    steps: 5,
  });
  await inspect("moving");
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/links/${id(20)}/position`) &&
      r.request().method() === "PATCH",
  );
  await page.mouse.up();
  await response;
  await page
    .getByText("リンクの位置を保存しました。", { exact: true })
    .waitFor();
  assert.equal(writes, 1);
  assert.ok(map.links[0].labelPositionX > original.x);
  await inspect("moved");
  await page.reload();
  await inspect("reload");
  for (const protocol of ["STAGE1_4", "STAGE1_5", "STAGE1_6"]) {
    map.sessionProtocolKey = protocol;
    await page.reload();
    await inspect(protocol);
  }
  await writeFile(
    resolve(output, baseline ? "before.json" : "after.json"),
    JSON.stringify(
      {
        synthetic: true,
        baseline,
        browser: browser.version(),
        observations,
        writes,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await vite.close();
}
console.log("Synthetic link line alignment: PASS");
