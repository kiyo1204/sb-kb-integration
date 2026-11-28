import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator } from "playwright";
import { createServer } from "vite";
import { verifyMockTestUrl } from "../../backend/src/scripts/mock-db.js";

await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const api = new URL(process.env.API_BASE_URL ?? "");
const token = process.env.RESEARCHER_API_TOKEN ?? "";
assert.equal(api.hostname, "127.0.0.1");
assert.ok(token.startsWith("mock-only-"));
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

type Concept = { id: string; label: string; positionX: number; positionY: number };
type Link = { id: string; label: string; sourceConceptId: string; targetConceptId: string; labelPositionX: number | null; labelPositionY: number | null };
type Map = { id: string; concepts: Concept[]; links: Link[] };

async function readMap(id: string): Promise<Map> {
  const response = await fetch(new URL(`/api/maps/${id}`, api), { headers });
  assert.equal(response.status, 200);
  return response.json();
}

const cacheDir = await mkdtemp(join(tmpdir(), "goal-map-editor-"));
const vite = await createServer({ cacheDir, server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((value) => sessionStorage.setItem("stage1-access-token", value), token);
  let failPath: string | null = null;
  await page.route("**/api/**", async (route) => {
    const { pathname, search } = new URL(route.request().url());
    if (pathname === failPath && route.request().method() === "PATCH") {
      failPath = null;
      return route.fulfill({ status: 503, json: { message: "TEST ONLY 保存失敗" } });
    }
    return route.fulfill({ response: await route.fetch({ url: new URL(pathname + search, api).href }) });
  });
  const origin = vite.resolvedUrls!.local[0]!;
  const title = `合成ゴール ${randomUUID()}`;
  const list = new URL("/research/goal-maps", origin).href;
  await page.goto(list);
  await page.getByLabel("ゴールマップ名").fill(title);
  await page.getByRole("button", { name: "作成して編集" }).click();
  await page.waitForURL(/\/maps\/[a-f0-9-]+$/);
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const drawer = page.locator(".map-editor-drawer");
  const concept = (label: string) => page.locator(".concept-node").filter({ has: page.getByRole("heading", { name: label, exact: true }) });

  async function addConcept(label: string) {
    await page.getByRole("button", { name: "＋ 概念", exact: true }).click();
    await drawer.getByLabel("概念名").fill(label);
    await drawer.getByRole("button", { name: "概念を追加" }).click();
    await concept(label).waitFor();
  }
  async function dragLabel(link: Locator, dx: number, dy: number) {
    const label = link.locator(".link-connector-label");
    await label.hover({ timeout: 5000 });
    const box = await label.boundingBox();
    assert.ok(box);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const hit = await label.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), { x, y });
    assert.ok(hit, "pointer must start on the link label");
    const start = await link.getAttribute("style");
    await page.mouse.move(x, y);
    await page.mouse.down();
    try {
      await page.mouse.move(x + dx, y + dy, { steps: 6 });
      assert.notEqual(await link.getAttribute("style"), start, "link label must move during dragging");
    } finally {
      await page.mouse.up();
    }
  }
  async function addLink(label: string, source: string, target: string, offsetX: number) {
    await page.getByRole("button", { name: "＋ リンク", exact: true }).click();
    await drawer.getByLabel("リンクラベル").fill(label);
    await drawer.getByRole("button", { name: "接続を開始" }).click();
    const pending = page.locator(".link-connector.is-temporary");
    // All new connectors start at the same location; keep test links apart.
    await dragLabel(pending, offsetX, 0);
    await pending.locator(".is-source").dragTo(concept(source), { targetPosition: { x: 18, y: 18 } });
    await pending.locator(".is-target").dragTo(concept(target), { targetPosition: { x: 18, y: 18 } });
    await pending.waitFor({ state: "detached" });
  }

  for (const label of ["概念A", "概念B", "概念C", "削除する概念"]) await addConcept(label);
  await addLink("保持する関係", "概念A", "概念B", -220);
  await addLink("変更する関係", "概念C", "概念B", 180);
  await addLink("削除する関係", "概念A", "削除する概念", 360);
  const before = await readMap(id);
  const a = before.concepts.find(({ label }) => label === "概念A")!;
  const b = before.concepts.find(({ label }) => label === "概念B")!;
  const c = before.concepts.find(({ label }) => label === "概念C")!;
  const retained = before.links.find(({ label }) => label === "保持する関係")!;
  const edited = before.links.find(({ label }) => label === "変更する関係")!;
  assert.deepEqual([retained.sourceConceptId, retained.targetConceptId], [a.id, b.id]);

  await page.getByRole("link", { name: /ゴールマップ一覧へ戻る/ }).click();
  await page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .getByRole("link", { name: /編集する/ }).click();
  await concept(c.label).click({ position: { x: 18, y: 18 } });
  await drawer.getByLabel("概念名").fill("変更後の概念");
  failPath = `/api/concepts/${c.id}/label`;
  const save = drawer.getByRole("button", { name: "保存", exact: true });
  await save.click();
  await drawer.getByRole("alert").waitFor();
  assert.equal(await drawer.getByLabel("概念名").inputValue(), "変更後の概念");
  assert.deepEqual(await readMap(id), before);
  await save.click();
  const renamed = concept("変更後の概念");
  await renamed.waitFor();
  await drawer.getByRole("button", { name: /閉じる/ }).click();

  await renamed.scrollIntoViewIfNeeded();
  const bounds = await renamed.boundingBox();
  assert.ok(bounds);
  failPath = `/api/concepts/${c.id}/position`;
  await page.mouse.move(bounds.x + 18, bounds.y + 18);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 58, bounds.y + 48, { steps: 5 });
  await page.mouse.up();
  const retryPosition = page.getByRole("button", { name: "位置の保存を再試行" });
  await retryPosition.click();
  await retryPosition.waitFor({ state: "detached" });
  await page.locator(".map-editor-save-status").getByText("保存済み", { exact: true }).waitFor();

  const connector = page.locator(`[data-connector-id="${edited.id}"]`);
  const positionPath = `/api/links/${edited.id}/position`;
  const isPositionPatch = (response: import("playwright").Response) =>
    response.request().method() === "PATCH" && new URL(response.url()).pathname === positionPath;
  const [moveSaved] = await Promise.all([page.waitForResponse(isPositionPatch), dragLabel(connector, 39, 30)]);
  assert.equal(moveSaved.status(), 200);
  await page.getByText("リンクの位置を保存しました。", { exact: true }).waitFor();
  const movedLink = (await readMap(id)).links.find((link) => link.id === edited.id)!;
  assert.notDeepEqual([movedLink.labelPositionX, movedLink.labelPositionY], [edited.labelPositionX, edited.labelPositionY]);
  assert.deepEqual({ ...movedLink, labelPositionX: edited.labelPositionX, labelPositionY: edited.labelPositionY }, edited);

  failPath = positionPath;
  const [failedMove] = await Promise.all([page.waitForResponse(isPositionPatch), dragLabel(connector, -23, 19)]);
  assert.equal(failedMove.status(), 503);
  const rejectedBody = failedMove.request().postDataJSON();
  assert.equal(rejectedBody.mapId, id);
  const retryLinkPosition = page.getByRole("button", { name: "リンク位置の保存を再試行" });
  await retryLinkPosition.waitFor();
  assert.deepEqual((await readMap(id)).links.find((link) => link.id === edited.id), movedLink);
  const retriedMove = page.waitForResponse(isPositionPatch);
  await retryLinkPosition.click();
  assert.equal((await retriedMove).status(), 200);
  await retryLinkPosition.waitFor({ state: "detached" });
  await page.reload();
  await connector.waitFor();
  assert.deepEqual(await connector.evaluate((element) => {
    const style = (element as HTMLElement).style;
    return [parseFloat(style.left), parseFloat(style.top)];
  }), [rejectedBody.labelPositionX, rejectedBody.labelPositionY]);
  const patchPosition = (mapId: string, credentials: Record<string, string> = headers) =>
    fetch(new URL(positionPath, api), {
      method: "PATCH", headers: credentials,
      body: JSON.stringify({ mapId, labelPositionX: 999, labelPositionY: 777 }),
    });
  const secondGoal = await fetch(new URL("/api/research/goal-maps", api), {
    method: "POST", headers,
    body: JSON.stringify({ title: `別ゴール ${randomUUID()}` }),
  });
  assert.equal(secondGoal.status, 201);
  const { id: otherMapId } = await secondGoal.json() as { id: string };
  const beforeDenied = await readMap(id);
  assert.equal((await patchPosition(otherMapId)).status, 404);
  assert.equal((await patchPosition(id, { "Content-Type": "application/json" })).status, 401);
  assert.deepEqual(await readMap(id), beforeDenied);

  await connector.locator(".link-connector-label").click();
  await drawer.getByLabel("リンクラベル").fill("変更後の関係");
  await save.click();
  await connector.getByText("変更後の関係", { exact: true }).waitFor();
  await drawer.getByRole("button", { name: /閉じる/ }).click();
  failPath = `/api/links/${edited.id}/reconnect`;
  await connector.locator(".is-target").dragTo(concept("概念A"), { targetPosition: { x: 18, y: 18 } });
  const retryConnection = page.getByRole("button", { name: "接続の保存を再試行", exact: true });
  await retryConnection.waitFor();
  assert.equal((await readMap(id)).links.find(({ id }) => id === edited.id)?.targetConceptId, b.id);
  await retryConnection.click();
  await page.getByRole("button", { name: `Link ${edited.id}: 変更後の概念 → 変更後の関係 → 概念A` }).waitFor({ state: "attached" });
  const deletedLink = page.locator(".link-connector-label").filter({ hasText: "削除する関係" });
  await deletedLink.click();
  page.once("dialog", (dialog) => void dialog.accept());
  await drawer.getByRole("button", { name: "Linkを削除", exact: true }).click();
  await deletedLink.waitFor({ state: "detached" });
  await concept("削除する概念").click({ position: { x: 18, y: 18 } });
  page.once("dialog", (dialog) => void dialog.accept());
  await drawer.getByRole("button", { name: "削除", exact: true }).click();
  await concept("削除する概念").waitFor({ state: "detached" });

  await page.reload();
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  await renamed.waitFor();
  await page.getByRole("button", { name: `Link ${edited.id}: 変更後の概念 → 変更後の関係 → 概念A` }).waitFor({ state: "attached" });
  const saved = await readMap(id);
  const moved = saved.concepts.find(({ id }) => id === c.id)!;
  assert.notDeepEqual([moved.positionX, moved.positionY], [c.positionX, c.positionY]);
  assert.deepEqual(saved.concepts.find(({ id }) => id === a.id), a);
  assert.deepEqual(saved.concepts.find(({ id }) => id === b.id), b);
  assert.deepEqual(saved.links.find(({ id }) => id === retained.id), retained);
  assert.equal(saved.links.length, 2);
  assert.equal(saved.concepts.length, 3);
  assert.deepEqual(saved.links.filter((link) => link.id === edited.id).map((link) => [link.labelPositionX, link.labelPositionY]),
    [[rejectedBody.labelPositionX, rejectedBody.labelPositionY]]);

  await page.getByLabel("Kit名").fill(`合成Kit ${randomUUID()}`);
  await page.getByRole("button", { name: "Kitとして登録" }).click();
  await page.getByText(/Kit登録後はゴールマップを編集できません/).waitFor();
  assert.equal(await page.getByRole("button", { name: "＋ 概念", exact: true }).count(), 0);
  const lockedPosition = await patchPosition(id);
  assert.equal(lockedPosition.status, 409);
  assert.equal((await lockedPosition.json()).error, "goal_map_kit_source_read_only");
  assert.deepEqual((await readMap(id)).links, saved.links);

  const importedTitle = `合成取込 ${randomUUID()}`;
  const imported = await fetch(new URL("/api/research/goal-maps/import", api), {
    method: "POST",
    headers,
    body: JSON.stringify({
      format: "sb-kb-goal-map",
      schemaVersion: 1,
      goalMap: {
        title: importedTitle,
        concepts: [
          { id: "a", label: "取込A", position: { x: 40, y: 70 } },
          { id: "b", label: "取込B", position: { x: 360, y: 120 } },
        ],
        links: [
          { id: "ab", label: "取込の関係", sourceId: "a", targetId: "b", labelPosition: { x: 260, y: 90 } },
        ],
      },
    }),
  });
  assert.equal(imported.status, 201);
  const { id: importedId } = (await imported.json()) as { id: string };
  const importedBefore = await readMap(importedId);
  assert.deepEqual(importedBefore.links.map(({ labelPositionX, labelPositionY }) => [labelPositionX, labelPositionY]), [[260, 90]]);
  await page.goto(list);
  await page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: importedTitle, exact: true }) })
    .getByRole("link", { name: /内容を確認/ }).click();
  await page.getByText(/Kit登録後はゴールマップを編集できません/).waitFor();
  await page.reload();
  await page.getByText(/Kit登録後はゴールマップを編集できません/).waitFor();
  assert.deepEqual(await readMap(importedId), importedBefore);
  console.log("Goal map Scratch-Build: PASS (isolated API and synthetic PostgreSQL)");
} finally {
  await browser?.close();
  await vite.close();
  await rm(cacheDir, { recursive: true, force: true });
}
