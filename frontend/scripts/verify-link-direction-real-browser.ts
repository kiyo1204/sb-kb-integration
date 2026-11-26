// Real learner authentication, product API and guarded disposable PostgreSQL.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
const base = process.env.API_BASE_URL!,
  sid = process.env.DIRECTION_SESSION!,
  run = process.env.DIRECTION_RUN!,
  mapId = process.env.DIRECTION_MAP!,
  code = process.env.DIRECTION_CODE!,
  researcher = process.env.RESEARCHER_API_TOKEN!;
const [a, b, c] = JSON.parse(process.env.DIRECTION_CONCEPTS!) as string[];
const vite = await createServer({
  server: {
    host: "127.0.0.1",
    port: 0,
    proxy: { "/api": { target: base, changeOrigin: true } },
  },
});
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(15000);
  await page.addInitScript(
    (t) => sessionStorage.setItem("stage1-access-token", t),
    code,
  );
  async function research(path: string, body?: unknown) {
    const r = await fetch(base + "/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + researcher,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(r.ok);
    return r.json();
  }
  let learnerHeaders: Record<string, string> = {};
  page.on("request", (r) => {
    if (
      r.method() === "GET" &&
      new URL(r.url()).pathname === `/api/maps/${mapId}`
    )
      learnerHeaders = r.headers();
  });
  const snapshot = async () => {
    const r = await page.request.get(base + `/api/maps/${mapId}`, {
      headers: learnerHeaders,
    });
    assert.equal(r.status(), 200);
    const m = await r.json();
    return m.links.map(
      (l: {
        id: string;
        sourceConceptId: string;
        targetConceptId: string;
        label: string;
      }) => ({
        id: l.id,
        source: l.sourceConceptId,
        target: l.targetConceptId,
        label: l.label,
      }),
    );
  };
  const fullSnapshot = async () => {
    const r = await page.request.get(base + `/api/maps/${mapId}`, {
      headers: learnerHeaders,
    });
    assert.equal(r.status(), 200);
    return r.json();
  };
  // A new browser needs one explicit researcher-approved screen transfer.
  // Later full navigations are same-tab reloads and must retain that ownership.
  let approvedClientId: string | null = null;
  const isClaimResponse = (r: import("playwright").Response) =>
    new URL(r.url()).pathname === "/api/experiment-client/claim" &&
    r.request().method() === "POST";
  async function enter() {
    const claimPromise = page.waitForResponse(isClaimResponse);
    await page.goto(vite.resolvedUrls!.local[0] + "maps/" + mapId);
    const claimResponse = await claimPromise;
    const claim = await claimResponse.json();
    if (approvedClientId === null) {
      assert.equal(claimResponse.status(), 409, "a second client needs explicit approval");
      assert.equal(claim.ownership, "PENDING");
      await page
        .getByRole("heading", { name: "この画面では利用できません", exact: true })
        .waitFor();
      const clientId = (
        await page.locator(".session-card code").innerText()
      ).trim();
      assert.equal(clientId, claim.clientId, "show the pending client identity");
      const p = (
        await research(`/research/experiment-runs/${run}/participants`)
      ).participants.find((p: { id: string }) => p.id === sid);
      await research(
        `/research/experiment-runs/${run}/participants/${sid}/client-switch`,
        { clientId, expectedDeviceGeneration: p.deviceGeneration },
      );
      const acceptedPromise = page.waitForResponse(isClaimResponse);
      await page
        .getByRole("button", { name: "接続状態を更新", exact: true })
        .click();
      const accepted = await acceptedPromise;
      assert.equal(accepted.status(), 200, "approved screen can claim ownership");
      const acceptedClaim = await accepted.json();
      assert.equal(acceptedClaim.ownership, "OWNED");
      assert.equal(acceptedClaim.clientId, clientId);
      approvedClientId = clientId;
    } else {
      assert.equal(claimResponse.status(), 200, "same-tab navigation remains available");
      assert.equal(claim.ownership, "OWNED");
      assert.equal(claim.clientId, approvedClientId, "same-tab client must be reused");
    }
    await page.locator(".concept-canvas").waitFor();
  }
  async function add() {
    await page.getByRole("button", { name: "＋ リンク", exact: true }).click();
    await page
      .getByLabel("リンクラベル", { exact: true })
      .fill("MOCK direction new " + mapId);
    await page.getByRole("button", { name: "接続を開始", exact: true }).click();
  }
  async function drag(selector: string, id: string) {
    await page.getByRole("button", { name: "全体表示", exact: true }).click();
    const handle = page.locator(selector),
      target = page.locator(`[data-concept-id="${id}"]`);
    await handle.scrollIntoViewIfNeeded();
    const h = await handle.boundingBox();
    assert.ok(h);
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page
      .locator(".connection-preview-path[marker-mid]")
      .waitFor({ state: "attached" });
    await target.scrollIntoViewIfNeeded();
    const t = await target.boundingBox();
    assert.ok(t);
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 12 });
  }

  const mutations: string[] = [];
  let positionPatches = 0;
  const positionPatchStatuses: number[] = [];
  page.on("request", (r) => {
    if (
      (r.method() === "POST" &&
        new URL(r.url()).pathname === `/api/maps/${mapId}/links`) ||
      (r.method() === "PATCH" && r.url().endsWith("/reconnect"))
    )
      mutations.push(r.method());
    if (
      r.method() === "PATCH" &&
      /^\/api\/links\/[^/]+\/position$/.test(new URL(r.url()).pathname)
    )
      positionPatches++;
  });
  page.on("response", (r) => {
    if (/^\/api\/links\/[^/]+\/position$/.test(new URL(r.url()).pathname))
      positionPatchStatuses.push(r.status());
  });
  await enter();
  const initial = await snapshot();
  await add();
  await drag(".is-temporary .is-source", a);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.deepEqual(await snapshot(), initial);
  assert.equal(mutations.length, 0);
  // Whole-link cancellation has its own existing telemetry endpoint, not a mutation.
  const cancelled = page.waitForResponse((r) =>
    r.url().includes("/operation-cancellations/ADD_LINK"),
  );
  await page.locator(".temporary-connector-cancel").click();
  assert.ok((await cancelled).ok());
  assert.deepEqual(await snapshot(), initial);
  await add();
  async function addNodeKeepingPending() {
    const pending = page.locator(".is-temporary");
    const read = () =>
      pending.evaluate((el) => ({
        id: el.getAttribute("data-connector-id"),
        text: el.textContent,
        left: (el as HTMLElement).style.left,
        top: (el as HTMLElement).style.top,
        source: el
          .querySelector(".is-source")
          ?.classList.contains("is-connected"),
        target: el
          .querySelector(".is-target")
          ?.classList.contains("is-connected"),
      }));
    const before = await read();
    const persisted = await snapshot();
    await page.getByRole("button", { name: "＋ 概念", exact: true }).click();
    assert.deepEqual(await read(), before);
    await page
      .getByRole("button", { name: "キャンセル", exact: true })
      .last()
      .click();
    assert.deepEqual(await read(), before);
    await page.getByRole("button", { name: "＋ 概念", exact: true }).click();
    await page
      .getByLabel("概念名", { exact: true })
      .fill("MOCK pending preserve");
    const created = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === `/api/maps/${mapId}/concepts`,
    );
    await page.getByRole("button", { name: "概念を追加", exact: true }).click();
    assert.equal((await created).status(), 201);
    await page.locator(".map-editor-drawer-form").waitFor({ state: "hidden" });
    assert.deepEqual(await read(), before);
    assert.deepEqual(
      await snapshot(),
      persisted,
      "node creation does not mutate persisted links",
    );
  }
  await addNodeKeepingPending();
  await drag(".is-temporary .is-target", b);
  await page.mouse.up();
  await addNodeKeepingPending();
  await page.locator(".temporary-connector-cancel").click();
  await add();
  await drag(".is-temporary .is-source", a);
  await page.mouse.up();
  await addNodeKeepingPending();
  const created = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === `/api/maps/${mapId}/links`,
  );
  await drag(".is-temporary .is-target", b);
  await page.mouse.up();
  const createdResponse = await created;
  assert.equal(createdResponse.status(), 201);
  const link = await createdResponse.json();
  assert.equal(link.sourceConceptId, a);
  assert.equal(link.targetConceptId, b);
  await page.locator(".is-temporary").waitFor({ state: "detached" });
  const savedBeforeNode = await snapshot();
  await page.getByRole("button", { name: "＋ 概念", exact: true }).click();
  await page.getByLabel("概念名", { exact: true }).fill("MOCK with saved link");
  const nodeResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/concepts"),
  );
  await page.getByRole("button", { name: "概念を追加", exact: true }).click();
  assert.equal((await nodeResponse).status(), 201);
  await page.locator(".map-editor-drawer-form").waitFor({ state: "hidden" });
  assert.deepEqual(
    await snapshot(),
    savedBeforeNode,
    "fully connected saved links survive node creation",
  );
  await enter();
  const saved = `[data-connector-id="${link.id}"]`;
  async function moveReconnectLabel(deltaX: number, deltaY: number) {
    await page.getByRole("button", { name: "全体表示", exact: true }).click();
    const connector = page.locator(saved + ".is-reconnecting"),
      label = connector.locator(".link-connector-label");
    const before = await connector.evaluate((el) => ({
      left: (el as HTMLElement).style.left,
      top: (el as HTMLElement).style.top,
    }));
    const bounds = await label.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width / 2 + deltaX,
      bounds.y + bounds.height / 2 + deltaY,
      { steps: 8 },
    );
    await page.mouse.up();
    const after = await connector.evaluate((el) => ({
      left: (el as HTMLElement).style.left,
      top: (el as HTMLElement).style.top,
    }));
    assert.notDeepEqual(after, before, "the reconnect draft link body moves");
    assert.equal(await label.innerText(), link.label);
    return {
      before,
      after,
      point: {
        x: Number.parseFloat(after.left),
        y: Number.parseFloat(after.top),
      },
    };
  }
  await page.locator(saved).waitFor();
  let row = (await snapshot()).find((l: { id: string }) => l.id === link.id);
  assert.equal(row.source, a);
  assert.equal(row.target, b);
  const before = await snapshot();
  await drag(saved + " .is-target", c);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.deepEqual(await snapshot(), before);
  assert.equal(mutations.length, 1);
  const closeDrawer = page.getByRole("button", {
    name: "Drawerを閉じる",
    exact: true,
  });
  if (await closeDrawer.count()) await closeDrawer.click();
  const reconnected = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith("/reconnect"),
  );
  await drag(saved + " .is-target", c);
  if (process.env.DIRECTION_SCREENSHOT)
    await page.screenshot({
      path: process.env.DIRECTION_SCREENSHOT,
      fullPage: true,
    });
  await page.mouse.up();
  assert.equal((await reconnected).status(), 200);
  await enter();
  await page.locator(saved).waitFor();
  row = (await snapshot()).find((l: { id: string }) => l.id === link.id);
  assert.equal(row.source, a);
  assert.equal(row.target, c);
  assert.equal(mutations.length, 2);
  // The rendered saved edge and its endpoints are derived from the real GET response.
  assert.equal(
    await page
      .locator(`${saved} .is-source`)
      .getAttribute("data-endpoint-label"),
    "始点",
  );
  assert.equal(
    await page
      .locator(`${saved} .is-target`)
      .getAttribute("data-endpoint-label"),
    "矢印の先",
  );
  if (process.env.DIRECTION_SCREENSHOT)
    await page.screenshot({
      path: process.env.DIRECTION_SCREENSHOT,
      fullPage: true,
    });
  await add();
  await enter();
  assert.equal(
    await page.locator(".is-temporary").count(),
    0,
    "full navigation discards unsaved temporary state",
  );
  assert.equal(mutations.length, 2);
  const fullMap = await page.request.get(base + `/api/maps/${mapId}`, { headers: learnerHeaders });
  const originalMap = await fullMap.json();
  if (originalMap.type === "PRIOR" || originalMap.type === "INTEGRATION") {
    const original = originalMap.links.find((l: { id: string }) => l.id === link.id);
    await page.locator(saved + " .link-connector-label").dblclick();
    await page.getByRole("region", { name: "保存済みリンクの接続編集" }).waitFor();
    assert.equal(mutations.length, 2);
    const expectedLinks = [
      { id: link.id, source: a, target: c, label: link.label },
      ...before.filter((l: { id: string }) => l.id !== link.id),
    ];

    const sortById = (x: { id: string }, y: { id: string }) =>
      x.id.localeCompare(y.id);

    assert.deepEqual(
      (await snapshot()).sort(sortById),
      expectedLinks.sort(sortById),
    );
    await drag(saved + " .is-source", b); await page.mouse.up();
    assert.equal(mutations.length, 2);
    assert.equal((await snapshot()).find((l: {id:string})=>l.id===link.id).source, a);
    const patched = page.waitForResponse(r => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/links/${link.id}/reconnect`);
    await drag(saved + " .is-target", c); await page.mouse.up();
    const patchedResponse=await patched;
    assert.deepEqual(patchedResponse.request().postDataJSON().expectedConnection,{sourceConceptId:a,targetConceptId:c});
    assert.equal(patchedResponse.status(), 200);
    await page.locator(".is-reconnecting").waitFor({ state: "detached" });
    const current = await (await page.request.get(base + `/api/maps/${mapId}`, { headers: learnerHeaders })).json();
    const after = current.links.find((l: { id: string }) => l.id === link.id);
    for (const key of ["id", "mapId", "label", "labelPositionX", "labelPositionY", "kitLinkItemId", "provenance"]) assert.deepEqual(after[key], original[key]);
    assert.equal(after.sourceConceptId, b); assert.equal(after.targetConceptId, c);
    assert.equal(mutations.length, 3);
    const undo = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/undo-redo"));
    await page.getByRole("button", { name: "元に戻す", exact: true }).click(); assert.equal((await undo).status(), 200);
    await page.locator(saved).waitFor();
    assert.equal((await snapshot()).find((l: { id: string }) => l.id === link.id).source, a);
    const redo = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/undo-redo"));
    await page.getByRole("button", { name: "やり直す", exact: true }).click(); assert.equal((await redo).status(), 200);
    await enter(); await page.locator(saved).waitFor();
    assert.equal((await snapshot()).find((l: { id: string }) => l.id === link.id).source, b);
    // Keep GET real; send a competing legitimate request just before the UI PATCH.
    await page.locator(saved+" .link-connector-label").dblclick();
    await page.getByRole("region",{name:"保存済みリンクの接続編集"}).waitFor();
    await page.route(`**/api/links/${link.id}/reconnect`,async route=>{
      assert.deepEqual(route.request().postDataJSON().expectedConnection,{sourceConceptId:b,targetConceptId:c});
      const competing=await page.request.patch(base+`/api/links/${link.id}/reconnect`,{
        headers:{...learnerHeaders,"Idempotency-Key":crypto.randomUUID()},
        data:{sourceConceptId:a,targetConceptId:c,clientTimestamp:new Date().toISOString()},
      });
      assert.equal(competing.status(),200);
      await route.continue();
    },{times:1});
    await drag(saved+" .is-source",a);await page.mouse.up();
    const conflictReply=page.waitForResponse(r=>r.request().method()==="PATCH"&&new URL(r.url()).pathname===`/api/links/${link.id}/reconnect`);
    await drag(saved+" .is-target",b);await page.mouse.up();
    const conflictResponse=await conflictReply;assert.equal(conflictResponse.status(),409);
    assert.equal((await conflictResponse.json()).error,"link_connection_conflict");
    const pending=page.getByRole("region",{name:"保存済みリンクの接続編集"});
    await pending.getByRole("alert").waitFor();assert.match(await pending.innerText(),/接続編集中・未保存/);
    assert.equal(await page.getByRole("button",{name:"接続の保存を再試行",exact:true}).count(),0);
    assert.equal((await snapshot()).find((l:{id:string})=>l.id===link.id).source,a);
    await page.getByRole("button",{name:"接続編集を取消",exact:true}).click();
    await page.locator(".is-reconnecting").waitFor({state:"detached"});
    assert.equal((await snapshot()).find((l:{id:string})=>l.id===link.id).source,a);
    // A disconnected or one-sided draft can be moved, then cancelled without writes.
    if (originalMap.type === "PRIOR") {
      const beforeCancel = await fullSnapshot(),
        beforeCancelLink = beforeCancel.links.find((l: { id: string }) => l.id === link.id),
        positionCountBeforeCancel = positionPatches,
        mutationCountBeforeCancel = mutations.length;
      await page.locator(saved + " .link-connector-label").dblclick();
      await pending.waitFor();
      assert.equal(await page.locator(saved + " .is-connected").count(), 0);
      const cancelledMove = await moveReconnectLabel(28, 18);
      await drag(saved + " .is-source", b);
      await page.mouse.up();
      assert.equal(positionPatches, positionCountBeforeCancel);
      assert.equal(mutations.length, mutationCountBeforeCancel);
      assert.deepEqual(
        (await fullSnapshot()).links.find((l: { id: string }) => l.id === link.id),
        beforeCancelLink,
        "detached/one-sided movement does not change the saved link",
      );
      await page.getByRole("button", { name: "接続編集を取消", exact: true }).click();
      await page.locator(".is-reconnecting").waitFor({ state: "detached" });
      assert.equal(positionPatches, positionCountBeforeCancel);
      assert.deepEqual(
        (await fullSnapshot()).links.find((l: { id: string }) => l.id === link.id),
        beforeCancelLink,
        "cancelling restores the saved connection and position",
      );

      // Complete both endpoints; only then should the same ID and new position save.
      const positionCountBeforeSave = positionPatches,
        mutationCountBeforeSave = mutations.length;
      await page.locator(saved + " .link-connector-label").dblclick();
      await pending.waitFor();
      const savedMove = await moveReconnectLabel(36, 24);
      await drag(saved + " .is-source", b);
      await page.mouse.up();
      assert.equal(positionPatches, positionCountBeforeSave);
      assert.equal(mutations.length, mutationCountBeforeSave);
      const reconnectSaved = page.waitForResponse(
        (r) => r.request().method() === "PATCH" &&
          new URL(r.url()).pathname === `/api/links/${link.id}/reconnect`,
      );
      const positionSaved = page.waitForResponse(
        (r) => r.request().method() === "PATCH" &&
          new URL(r.url()).pathname === `/api/links/${link.id}/position`,
      );
      await drag(saved + " .is-target", c);
      await page.mouse.up();
      const reconnectResponse = await reconnectSaved,
        positionResponse = await positionSaved;
      assert.equal(reconnectResponse.status(), 200);
      assert.equal(positionResponse.status(), 200);
      await page.locator(".is-reconnecting").waitFor({ state: "detached" });
      const afterSaveMap = await fullSnapshot(),
        afterSave = afterSaveMap.links.find((l: { id: string }) => l.id === link.id);
      for (const key of ["id", "mapId", "label", "kitLinkItemId", "provenance"])
        assert.deepEqual(afterSave[key], original[key]);
      assert.equal(afterSave.sourceConceptId, b);
      assert.equal(afterSave.targetConceptId, c);
      assert.equal(afterSave.labelPositionX, savedMove.point.x);
      assert.equal(afterSave.labelPositionY, savedMove.point.y);
      assert.equal(positionPatches, positionCountBeforeSave + 1);
      assert.equal(positionPatchStatuses.at(-1), 200);
      await enter();
      const afterSuccessfulReload = await fullSnapshot(),
        reloadedSaved = afterSuccessfulReload.links.find((l: { id: string }) => l.id === link.id),
        renderedSaved = await page.locator(saved).evaluate((el) => ({
          left: Number.parseFloat((el as HTMLElement).style.left),
          top: Number.parseFloat((el as HTMLElement).style.top),
        }));
      assert.equal(reloadedSaved.labelPositionX, renderedSaved.left);
      assert.equal(reloadedSaved.labelPositionY, renderedSaved.top);

      // The next position request fails after a successful real reconnect PATCH.
      const stablePosition = {
        x: reloadedSaved.labelPositionX,
        y: reloadedSaved.labelPositionY,
      };
      await page.locator(saved + " .link-connector-label").dblclick();
      await pending.waitFor();
      await moveReconnectLabel(22, 15);
      await drag(saved + " .is-source", a);
      await page.mouse.up();
      const positionCountBeforeFailure = positionPatches;
      await page.route(
        `**/api/links/${link.id}/position`,
        (route) => route.fulfill({
          status: 503,
          json: { error: "synthetic_position_save_failure" },
        }),
        { times: 1 },
      );
      const reconnectAfterMove = page.waitForResponse(
        (r) => r.request().method() === "PATCH" &&
          new URL(r.url()).pathname === `/api/links/${link.id}/reconnect`,
      );
      const failedPosition = page.waitForResponse(
        (r) => r.request().method() === "PATCH" &&
          new URL(r.url()).pathname === `/api/links/${link.id}/position`,
      );
      await drag(saved + " .is-target", c);
      await page.mouse.up();
      assert.equal((await reconnectAfterMove).status(), 200);
      assert.equal((await failedPosition).status(), 503);
      assert.equal(positionPatches, positionCountBeforeFailure + 1);
      assert.equal(positionPatchStatuses.at(-1), 503);
      await page.locator(".is-reconnecting").waitFor({ state: "detached" });
      await page.getByText(
        "接続は保存しましたが、リンク位置の保存を確認できません。再読み込みして状態を確認してください。",
        { exact: true },
      ).waitFor();
      await page.getByText(/^リンク位置の保存を確認できません。/).waitFor();
      const afterFailureMap = await fullSnapshot(),
        afterFailure = afterFailureMap.links.find((l: { id: string }) => l.id === link.id);
      assert.equal(afterFailure.id, link.id);
      assert.equal(afterFailure.sourceConceptId, a);
      assert.equal(afterFailure.targetConceptId, c);
      assert.equal(afterFailure.label, original.label);
      assert.deepEqual(afterFailure.provenance, original.provenance);
      assert.equal(afterFailure.labelPositionX, stablePosition.x);
      assert.equal(afterFailure.labelPositionY, stablePosition.y);
      await enter();
      const afterFailureReload = await fullSnapshot(),
        reloadedFailure = afterFailureReload.links.find((l: { id: string }) => l.id === link.id),
        renderedFailure = await page.locator(saved).evaluate((el) => ({
          left: Number.parseFloat((el as HTMLElement).style.left),
          top: Number.parseFloat((el as HTMLElement).style.top),
        }));
      assert.equal(reloadedFailure.sourceConceptId, a);
      assert.equal(reloadedFailure.targetConceptId, c);
      assert.equal(reloadedFailure.labelPositionX, stablePosition.x);
      assert.equal(reloadedFailure.labelPositionY, stablePosition.y);
      assert.equal(renderedFailure.left, stablePosition.x);
      assert.equal(renderedFailure.top, stablePosition.y);
      console.log("PASS real SB reconnect movement", JSON.stringify({
        linkId: link.id,
        cancelledDraftPosition: cancelledMove.point,
        successfulReconnectPosition: savedMove.point,
        successfulPositionStatus: 200,
        failedFollowupPositionStatus: 503,
        savedEndpointsAfterFailure: ["source", "target"],
        reloadShowsPersistedPosition: true,
      }));
      assert.deepEqual(
        positionPatchStatuses,
        [200, 200, 503],
        "initial link position and completed reconnect save; failed follow-up position is rejected",
      );
      console.log("REAL_LINK_POSITION_PATCH_STATUSES", JSON.stringify(positionPatchStatuses));
    } else {
      // Only an explicit fresh edit captures the newly saved connection.
      await page.locator(saved+" .link-connector-label").dblclick();
      await pending.waitFor();await drag(saved+" .is-source",b);await page.mouse.up();
      const fresh=page.waitForResponse(r=>r.request().method()==="PATCH"&&r.url().endsWith("/reconnect"));
      await drag(saved+" .is-target",c);await page.mouse.up();assert.equal((await fresh).status(),200);
      await page.locator(".is-reconnecting").waitFor({state:"detached"});
      await enter();await page.locator(saved).waitFor();assert.equal((await snapshot()).find((l:{id:string})=>l.id===link.id).source,b);
    }
    console.log("PASS real API conflict: same-screen concurrent update, conditional 409, retained unsaved draft, no retry, explicit cancel refresh and fresh edit/reload");
    console.log(
      `PASS real ${originalMap.type} saved-link draft: zero writes before completion, same ID and metadata, direction/reload, Undo/Redo`,
    );
  } else {
    await page.locator(saved + " .link-connector-label").dblclick();
    assert.equal(await page.locator(".is-reconnecting").count(), 0);
    assert.equal(await page.getByRole("button", { name: "接続を編集", exact: true }).count(), 0);
  }
  console.log(
    "PASS real learner Map browser: pending retention and completed links through node create, reload, reconnect; navigation clears temporary state; create/reload, reconnect/reload, Esc then pointerup unchanged, separate cancellation telemetry",
  );
} finally {
  await browser.close();
  await vite.close();
}
