import assert from "node:assert/strict";
import { chromium } from "playwright";
import { diagnoseLinkWait } from "./link-wait-diagnostic.js";
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.addInitScript("globalThis.__name = (fn) => fn;");
  await page.goto("about:blank");
  await page.setContent(
    '<button class="source">PRIVATE_SENTINEL</button><div class="concept-canvas"></div>',
  );
  const records: unknown[] = [];
  const emit = (record: unknown) => {
    records.push(record);
  };
  await diagnoseLinkWait(
    page,
    "kb-drop",
    ".source",
    ".missing",
    async () => {},
    emit,
  );
  assert.equal(records.length, 0);
  for (const kind of ["kb-drop", "integration-preview"] as const) {
    await assert.rejects(
      diagnoseLinkWait(
        page,
        kind,
        ".source",
        ".missing",
        async () => {
          await page.locator(".source").click();
          if (kind === "kb-drop") {
            await page.locator(".source").dispatchEvent("dragstart");
            await page.locator(".concept-canvas").dispatchEvent("drop");
          }
          await page.locator(".missing").waitFor({ timeout: 100 });
        },
        emit,
      ),
      /Timeout/,
    );
    const r = records.at(-1) as {
      state: {
        events: {
          pointerReached: number;
          dragstart: number;
          canvasDrop: number;
        };
        source: { count: number };
        result: { count: number };
      };
    };
    assert.equal(r.state.events.pointerReached, 1);
    assert.equal(r.state.events.dragstart, kind === "kb-drop" ? 1 : 0);
    assert.equal(r.state.events.canvasDrop, kind === "kb-drop" ? 1 : 0);
    assert.equal(r.state.source.count, 1);
    assert.equal(r.state.result.count, 0);
  }
  const original = new Error("original");
  let caught: unknown;
  try {
    await diagnoseLinkWait(
      page,
      "kb-drop",
      ".source",
      ".missing",
      async () => {
        throw original;
      },
      () => {
        throw new Error("output failed");
      },
    );
  } catch (e) {
    caught = e;
  }
  assert.equal(caught, original);
  try {
    await diagnoseLinkWait(
      page,
      "kb-drop",
      ".source",
      ".missing",
      async () => {
        await page.close();
        throw original;
      },
      emit,
    );
  } catch (e) {
    caught = e;
  }
  assert.equal(caught, original);
  assert.ok(!JSON.stringify(records).includes("PRIVATE_SENTINEL"));
  console.log(
    "PASS link diagnostics: silent success; isolated KB/preview timeout; bounded element/event state; original error retained after output/read failure",
  );
} finally {
  await browser.close();
}
