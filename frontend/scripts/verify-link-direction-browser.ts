// Synthetic API responses exercise the real shared Map editor; no database is used.
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { createServer } from "vite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? "msedge", headless: true });
const dir = process.env.LINK_DIRECTION_SCREENSHOTS ?? join(tmpdir(), "sbkb-link-direction");
await mkdir(dir, { recursive: true });
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
async function drag(page: Page, handle: string, concept: string) {
  const h = await page.locator(handle).boundingBox(), c = await page.locator(`[data-concept-id="${concept}"]`).boundingBox();
  assert.ok(h && c);
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 10 });
}
try {
  for (const [type, protocol] of [["PRIOR", "SBKB_INTEGRATION_V1"], ["KB", "SBKB_INTEGRATION_V1"], ["INTEGRATION", "SBKB_INTEGRATION_V1"], ["PRIOR", "STAGE1_4"], ["KB", "STAGE1_5"], ["INTEGRATION", "STAGE1_6"]]) {
    const map = { id: id(1), type, status: "DRAFT", title: "MOCK direction", basedOnMapId: null, kitDefinitionId: id(9), kitDefinitionName: "MOCK Kit", sessionStageId: null, sessionId: null, sessionProtocolKey: protocol, submittedAt: null,
      concepts: [2, 3, 4].map((n, i) => ({ id: id(n), mapId: id(1), label: `MOCK Concept ${n}`, positionX: 80 + i * 310, positionY: 100, mergedIntoConceptId: null })),
      links: [] as Array<Record<string, unknown>>, kitConcepts: [], kitLinks: [{ kitLinkItemId: id(8), label: "MOCK relation", used: false }], availableKitDefinitions: [] };
    let creates = 0, reconnects = 0;
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(() => sessionStorage.setItem("stage1-access-token", "mock-only-browser-fixture-not-a-real-code"));
    await page.route("**/api/**", async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (path === "/api/me") return route.fulfill({ json: { role: "researcher" } });
      if (path === `/api/maps/${id(1)}`) return route.fulfill({ json: map });
      if (path.endsWith("/access")) return route.fulfill({ json: { allowed: true, serverNow: new Date().toISOString(), expiresAt: null } });
      if (path.endsWith("/undo-redo")) return route.fulfill({ json: { status: "AVAILABLE", canUndo: false, canRedo: false, sequenceNumber: creates + reconnects } });
      if (req.method() === "POST" && (path.endsWith("/links") || path.endsWith(`/kit-links/${id(8)}`))) {
        const body = req.postDataJSON(); creates++;
        const saved = { id: id(7), mapId: id(1), label: "MOCK relation", kitLinkItemId: type === "KB" ? id(8) : null, ...body, createdAt: new Date().toISOString() };
        map.links.push(saved); map.kitLinks[0].used = true;
        return route.fulfill({ status: 201, json: saved });
      }
      if (path.endsWith("/position")) { Object.assign(map.links[0], req.postDataJSON()); return route.fulfill({ json: { id: id(7), mapId: id(1), ...req.postDataJSON() } }); }
      if (path.endsWith("/reconnect")) { reconnects++; Object.assign(map.links[0], req.postDataJSON()); return route.fulfill({ json: { ...map.links[0], updatedAt: new Date().toISOString() } }); }
      return route.fulfill({ status: 404, json: { error: "mock_not_found" } });
    });
    await page.goto(vite.resolvedUrls!.local[0] + "maps/" + id(1));
    async function add() {
      if (type === "KB") {
        const p = await page.locator(".kit-palette-part.is-link").boundingBox(), c = await page.locator(".concept-canvas").boundingBox(); assert.ok(p && c);
        await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2); await page.mouse.down(); await page.mouse.move(c.x + 400, c.y + 280, { steps: 12 }); await page.mouse.up();
      } else {
        await page.getByRole("button", { name: "＋ リンク", exact: true }).click(); await page.getByLabel("リンクラベル", { exact: true }).fill("MOCK relation"); await page.getByRole("button", { name: "接続を開始", exact: true }).click();
      }
      await page.locator(".is-temporary").waitFor();
    }
    await add();
    await page.locator(".temporary-connector-cancel").click();
    assert.equal(creates, 0);
    await add();
    await drag(page, ".is-temporary .is-source", id(2));
    // Escape during a drag over a valid target must not commit on the following pointerup.
    await page.keyboard.press("Escape");
    if (process.env.LINK_DIRECTION_BASELINE) {
      console.log(JSON.stringify({ baseline: true, escapeLeavesPreview: await page.locator(".connection-preview-path[marker-mid]").count() === 1 }));
      await page.mouse.up(); await page.close(); break;
    }
    assert.equal(await page.locator(".connection-preview-path[marker-mid]").count(), 0);
    await page.mouse.up(); assert.equal(creates, 0);
    assert.equal(await page.locator(".is-temporary .is-source.is-connected").count(), 0);
    // Native pointercancel also leaves the temporary endpoint unchanged.
    await drag(page, ".is-temporary .is-source", id(2));
    await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 })));
    await page.mouse.up(); assert.equal(creates, 0);
    for (const [end, n] of [["source", 2], ["target", 3]] as const) {
      await drag(page, `.is-temporary .is-${end}`, id(n));
      const preview = page.locator(".connection-preview-path[marker-mid]"); assert.equal(await preview.count(), 1);
      assert.equal(await page.locator(".link-connector-handle.is-connecting").count(), 1);
      assert.equal(await page.locator(".concept-node.is-connection-target").count(), 1);
      const nums = (await preview.getAttribute("d"))!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      const expected = await page.locator(`[data-concept-id="${id(n)}"]`).evaluate(node => {
        const canvas = node.closest(".concept-canvas") as HTMLElement;
        const bounds = canvas.getBoundingClientRect(), target = node.getBoundingClientRect();
        return [(target.x + target.width / 2 - bounds.x) * canvas.offsetWidth / bounds.width, (target.y + target.height / 2 - bounds.y) * canvas.offsetHeight / bounds.height];
      });
      const index = end === "source" ? 0 : 4;
      assert.ok(Math.abs(nums[index] - expected[0]) < 2 && Math.abs(nums[index + 1] - expected[1]) < 2, "arrow runs from the source pointer to the relation, or from the relation to the target pointer, including leftward connections");
      await page.screenshot({ path: join(dir, `${type}-${protocol}-${end}.png`) });
      await page.mouse.up();
    }
    await page.locator(".is-temporary").waitFor({ state: "detached" });
    assert.equal(creates, 1); assert.equal(map.links[0].sourceConceptId, id(2)); assert.equal(map.links[0].targetConceptId, id(3));
    const saved = `[data-connector-id="${id(7)}"]`;
    await drag(page, `${saved} .is-target`, id(4)); await page.keyboard.press("Escape"); await page.mouse.up(); assert.equal(reconnects, 0); assert.equal(map.links[0].targetConceptId, id(3));
    const changed = page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/reconnect"));
    await drag(page, `${saved} .is-target`, id(4)); await page.mouse.up();
    assert.equal((await changed).status(), 200); assert.equal(reconnects, 1);
    await page.reload(); await page.locator(saved).waitFor(); assert.equal(map.links[0].sourceConceptId, id(2)); assert.equal(map.links[0].targetConceptId, id(4));
    console.log(JSON.stringify({ type, protocol, creation: "PASS", preview: "PASS", cancel: "PASS", reconnect: "PASS", fixtureReload: "PASS" })); await page.close();
  }
} finally { await browser.close(); await vite.close(); }
