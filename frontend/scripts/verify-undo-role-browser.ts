import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11",
  mapId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12",
  linkId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13";
try {
  for (const role of ["researcher", "learner"] as const) {
    const context = await browser.newContext();
    await context.addInitScript(() =>
      sessionStorage.setItem(
        "stage1-access-token",
        "mock-browser-fixture-no-real-credential",
      ),
    );
    let links = [
      {
        id: linkId,
        mapId,
        sourceConceptId: "a",
        targetConceptId: "b",
        label: "MOCK 関係",
      },
    ];
    let actions: string[] = [];
    const state = () => ({
      status: "AVAILABLE",
      sequenceNumber: 3 + actions.length,
      canUndo: links.length > 0,
      canRedo: links.length === 0,
      undoOperation: links.length
        ? { id: linkId, operationType: "ADD_LINK" }
        : null,
      redoOperation: links.length
        ? null
        : { id: linkId, operationType: "ADD_LINK" },
    });
    const page = await context.newPage();
    await page.route("**/api/**", async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path === "/api/me")
        return route.fulfill({ json: { role, sessionId } });
      if (path === `/api/maps/${mapId}`)
        return route.fulfill({
          json: {
            id: mapId,
            type: "PRIOR",
            status: "DRAFT",
            sessionId,
            sessionStageId: null,
            sessionProtocolKey: "STAGE1_6",
            sessionStageStatus: "IN_PROGRESS",
            submittedAt: null,
            kitDefinitionId: null,
            kitConcepts: [],
            kitLinks: [],
            concepts: [
              { id: "a", label: "MOCK A", positionX: 100, positionY: 100 },
              { id: "b", label: "MOCK B", positionX: 500, positionY: 100 },
            ],
            links,
          },
        });
      if (path === `/api/maps/${mapId}/access`)
        return route.fulfill({
          json: {
            allowed: true,
            serverNow: new Date().toISOString(),
            expiresAt: null,
          },
        });
      if (path === `/api/maps/${mapId}/undo-redo`) {
        if (req.method() === "GET") return route.fulfill({ json: state() });
        if (role === "researcher")
          return route.fulfill({
            status: 403,
            json: { error: "learner_action_required" },
          });
        const action = req.postDataJSON().action;
        actions.push(action);
        if (action === "UNDO") links = [];
        else
          links = [
            {
              id: linkId,
              mapId,
              sourceConceptId: "a",
              targetConceptId: "b",
              label: "MOCK 関係",
            },
          ];
        return route.fulfill({ json: { state: state() } });
      }
      return route.fulfill({ status: 404, json: { error: "mock_not_found" } });
    });
    const historyLoaded = page.waitForResponse(
      (r) => r.url().endsWith("/undo-redo") && r.request().method() === "GET",
    );
    await page.goto(vite.resolvedUrls!.local[0] + "maps/" + mapId);
    await historyLoaded;
    await page
      .locator(`[data-connector-id="${linkId}"] .link-connector-label`)
      .waitFor();
    if (role === "researcher") {
      assert.equal(
        await page
          .getByRole("button", { name: "元に戻す", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "やり直す", exact: true })
          .count(),
        0,
      );
      assert.deepEqual(actions, []);
    } else {
      const undo = page.getByRole("button", { name: "元に戻す", exact: true });
      await undo.waitFor();
      await undo.click();
      await page.getByText("操作を元に戻しました。", { exact: true }).waitFor();
      assert.equal(
        await page.locator(`[data-connector-id="${linkId}"]`).count(),
        0,
      );
      await page.getByRole("button", { name: "やり直す", exact: true }).click();
      await page.getByText("操作をやり直しました。", { exact: true }).waitFor();
      assert.deepEqual(actions, ["UNDO", "REDO"]);
      await page
        .locator(`[data-connector-id="${linkId}"] .link-connector-label`)
        .waitFor();
    }
    await context.close();
  }
  console.log(
    "Scratch Map UI role contract: researcher has no Undo/Redo controls; learner Link Undo/Redo remains available: PASS",
  );
} finally {
  await browser.close();
  await vite.close();
}
