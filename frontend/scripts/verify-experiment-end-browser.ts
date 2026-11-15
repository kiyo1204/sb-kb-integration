// TEST ONLY: actual API, browser, researcher confirmation, no research data.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
const base = process.env.API_BASE_URL!,
  token = process.env.EXPERIMENT_BROWSER_TOKEN!,
  run = process.env.EXPERIMENT_BROWSER_RUN!;
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
  const page = await browser.newPage();
  await page.addInitScript("globalThis.__name=(fn)=>fn");
  await page.goto(vite.resolvedUrls!.local[0]);
  await page.locator("#home-access-code").fill(token);
  await page.locator("#home-access-code").press("Enter");
  await page
    .getByRole("button", { name: "セッションを開始", exact: true })
    .click();
  await page.getByRole("button", { name: "開始する", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "視聴を終えて次へ", exact: true })
    .click();
  await page.getByRole("button", { name: "開始する", exact: true }).click();
  await page.locator(".concept-canvas").waitFor();
  const sid = process.env.EXPERIMENT_BROWSER_SESSION!;
  const stage = await page.evaluate(async (id) => {
    const { apiFetch } = await import("/src/auth-client.ts");
    return (await (await apiFetch(`/api/sessions/${id}/flow`)).json())
      .currentStage.id;
  }, sid);
  await page.context().setOffline(true);
  const queued = await page.evaluate(
    async ({ sid, stage }) => {
      const { enqueue } = await import("/src/observation-outbox.ts");
      return enqueue(sid, {
        schemaVersion: 1,
        eventType: "SCREEN_ENTER",
        targetType: "SCREEN",
        stageId: stage,
        outcome: "SUCCESS",
        clientTimeQuality: "OBSERVED",
        clientTimestamp: new Date().toISOString(),
      });
    },
    { sid, stage },
  );
  const ctx = await browser.newContext();
  await ctx.addInitScript(
    (t) => sessionStorage.setItem("stage1-access-token", t),
    process.env.RESEARCHER_API_TOKEN!,
  );
  const research = await ctx.newPage();
  await research.goto(
    vite.resolvedUrls!.local[0] + `research/experiment-runs/${run}`,
  );
  const completedParticipant = research
      .getByRole("row")
      .filter({ hasText: "TEST ONLY browser flow" }),
    endedParticipant = research
      .getByRole("row")
      .filter({ hasText: "TEST ONLY end browser" });
  await completedParticipant.getByText("本人完了", { exact: true }).waitFor();
  await completedParticipant
    .getByText("すべての活動が完了", { exact: true })
    .waitFor();
  assert.equal(
    (await completedParticipant.locator("td").nth(2).innerText()).trim(),
    "4 / 4",
  );
  await endedParticipant.getByText("進行中", { exact: true }).waitFor();
  assert.equal(
    (await endedParticipant.locator("td").nth(1).innerText()).trim(),
    "SB",
  );
  assert.equal(
    (await endedParticipant.locator("td").nth(2).innerText()).trim(),
    "1 / 4",
  );
  let confirmed = false;
  research.on("dialog", async (d) => {
    assert.ok(d.message().includes("未提出"));
    confirmed = true;
    await d.accept();
  });
  const finished = research.waitForResponse(
    (r) => r.url().endsWith("/end") && r.request().method() === "POST",
  );
  await research
    .getByRole("button", { name: "実施を終了", exact: true })
    .click();
  assert.equal((await finished).status(), 200);
  await endedParticipant
    .getByText("実施終了時に進行中", { exact: true })
    .waitFor();
  await endedParticipant.getByText("終了時：SB", { exact: true }).waitFor();
  await endedParticipant
    .getByText(
      "実施終了による停止です。参加者Sessionの状態は変更していません。",
      {
        exact: true,
      },
    )
    .waitFor();
  await completedParticipant.getByText("本人完了", { exact: true }).waitFor();
  assert.equal(
    (await completedParticipant.locator("td").nth(2).innerText()).trim(),
    "4 / 4",
  );
  await page.context().setOffline(false);
  await page
    .getByRole("heading", { name: "実施は終了しました", exact: true })
    .waitFor();
  assert.ok(confirmed);
  assert.equal(await page.locator("svg,canvas,.concept-canvas").count(), 0);
  assert.equal(
    await page.evaluate(
      async ({ sid, queued }) => {
        const { flush, changeState } =
          await import("/src/observation-outbox.ts");
        const { apiFetch } = await import("/src/auth-client.ts");
        await flush(sid, apiFetch);
        return changeState(sid, (s) => s.items.some((i) => i.id === queued));
      },
      { sid, queued },
    ),
    true,
    "unsent observation retained without ACK/deletion",
  );
  await page.reload();
  await page
    .getByRole("heading", { name: "実施は終了しました", exact: true })
    .waitFor();
  assert.equal(await page.locator("svg,canvas").count(), 0);
  // Hold an actual ended-A API response across an in-page identity change.
  // No fabricated end response: route.fetch reaches the real product API first.
  let releaseA!: () => void, reachedA!: () => void;
  const heldA = new Promise<void>((r) => {
    releaseA = r;
  });
  const reached = new Promise<void>((r) => {
    reachedA = r;
  });
  let capturedA = false;
  await page.route("**/api/experiment-material", async (route) => {
    if (capturedA) return route.continue();
    capturedA = true;
    const response = await route.fetch();
    assert.equal(response.status(), 409);
    assert.equal((await response.json()).error, "experiment_ended");
    reachedA();
    await heldA;
    await route.fulfill({ response });
  });
  await page.evaluate(() => {
    (
      window as typeof window & { oldEndedRequest?: Promise<number> }
    ).oldEndedRequest = import("/src/auth-client.ts")
      .then(({ apiFetch }) => apiFetch("/api/experiment-material"))
      .then((r) => r.status);
  });
  await reached;
  await page
    .getByRole("button", { name: "アクセスコードを切り替える", exact: true })
    .click();
  await page
    .locator("#home-access-code")
    .fill(process.env.EXPERIMENT_BROWSER_B_TOKEN!);
  await page.locator("#home-access-code").press("Enter");
  await page
    .getByRole("button", { name: "セッションを開始", exact: true })
    .waitFor();
  const bResearch = await ctx.newPage();
  await bResearch.goto(
    vite.resolvedUrls!.local[0] +
      `research/experiment-runs/${process.env.EXPERIMENT_BROWSER_B_RUN}`,
  );
  const bParticipant = bResearch
    .getByRole("row")
    .filter({ hasText: "TEST ONLY identity B" });
  await bParticipant
    .locator("td")
    .nth(1)
    .getByText("未開始", { exact: true })
    .waitFor();
  await bParticipant
    .locator("td")
    .nth(3)
    .getByText("未開始", { exact: true })
    .waitFor();
  assert.equal(
    (await bParticipant.locator("td").nth(2).innerText()).trim(),
    "0 / 4",
  );
  // Block polls here: the B-specific 409 below must cause the end notice.
  await page.route("**/api/experiment-status", (route) => route.abort());
  releaseA();
  assert.equal(
    await page.evaluate(
      () =>
        (window as typeof window & { oldEndedRequest?: Promise<number> })
          .oldEndedRequest,
    ),
    409,
  );
  assert.equal(
    await page
      .getByRole("heading", { name: "実施は終了しました", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "セッションを開始", exact: true })
    .waitFor();
  await page.unroute("**/api/experiment-material");
  const endB = await fetch(
    base +
      `/api/research/experiment-runs/${process.env.EXPERIMENT_BROWSER_B_RUN}/end`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.RESEARCHER_API_TOKEN!,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ confirmed: true }),
    },
  );
  assert.equal(endB.status, 200);
  await bResearch
    .getByRole("button", { name: "状態を更新", exact: true })
    .click();
  await bParticipant
    .locator("td")
    .nth(1)
    .getByText("実施終了時点で未開始", { exact: true })
    .waitFor();
  await bParticipant
    .locator("td")
    .nth(3)
    .getByText("実施終了時に未開始", { exact: true })
    .waitFor();
  await bParticipant
    .getByText(
      "実施終了による停止です。参加者Sessionの状態は変更していません。",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.evaluate(async () => {
      const { apiFetch } = await import("/src/auth-client.ts");
      return (await apiFetch("/api/experiment-material")).status;
    }),
    409,
  );
  await page
    .getByRole("heading", { name: "実施は終了しました", exact: true })
    .waitFor();
  console.log(
    "Experiment end browser: real R08 confirmation, active Map removed, ended notice after reload, delayed A response isolated from B, current B response stops B PASS",
  );
} finally {
  await browser.close();
  await vite.close();
}
