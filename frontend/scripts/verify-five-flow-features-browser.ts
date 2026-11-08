// Real API from the isolated mock suite, synthetic fixtures only.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import type { FiveFlowFeatures } from "../../backend/src/five-flow-features.js";
const base = process.env.API_BASE_URL!,
  token = process.env.RESEARCHER_API_TOKEN!;
assert.ok(base && ["127.0.0.1", "localhost"].includes(new URL(base).hostname));
assert.ok(token);
async function read(path: string) {
  const r = await fetch(base + "/api" + path, {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(r.status, 200);
  return r.json();
}
const list = await read("/research/stage1/sessions");
let fixture: FiveFlowFeatures | undefined;
for (const s of list.sessions.filter(
  (s: { protocolKey: string; status: string }) =>
    s.protocolKey === "STAGE1_5" && s.status === "COMPLETED",
)) {
  const f = (await read(
    `/research/stage1/sessions/${s.id}/descriptive-features`,
  )) as FiveFlowFeatures;
  if (f.completion.status === "AVAILABLE") {
    fixture = f;
    break;
  }
}
assert.ok(
  fixture,
  "Run the five-flow-composite or session-flow-survey fixture in this isolated suite first",
);
const f = fixture;
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
  });
  await page.addInitScript(
    (value) => sessionStorage.setItem("stage1-access-token", value),
    token,
  );
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: base + url.pathname + url.search,
    });
    await route.fulfill({ response });
  });
  await page.goto(
    vite.resolvedUrls!.local[0] + `research/stage1/${f.sessionId}/analysis`,
  );
  const panel = page.getByRole("region", { name: "新5活動の記述的特徴量" });
  await panel.waitFor();
  assert.ok((await panel.innerText()).includes(f.featureVersion));
  assert.ok((await panel.innerText()).includes(f.protocolKey));
  assert.ok((await panel.innerText()).includes(f.completion.eventId!));
  assert.ok((await panel.innerText()).includes(f.completion.submittedAt!));
  const displayedGroups = await panel
    .locator("table")
    .nth(1)
    .locator("tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) =>
        Array.from(row.querySelectorAll("td"), (cell) => cell.textContent),
      ),
    );
  assert.deepEqual(
    displayedGroups,
    f.operationResults.rows.map((r) => [
      r.historySource,
      r.actorType,
      r.outcome,
      String(r.count),
    ]),
  );
  for (const point of ["start", "completion", "delta"] as const)
    assert.deepEqual(
      (
        await panel
          .locator(`[data-feature-point="${point}"] td`)
          .allTextContents()
      ).slice(0, 3),
      [
        f[point].activeConcepts,
        f[point].hiddenMergeSources,
        f[point].links,
      ].map((v) => (v === null ? "算出不可" : String(v))),
    );
  for (const r of f.operationResults.rows)
    assert.ok((await panel.innerText()).includes(r.outcome));
  const downloading = page.waitForEvent("download");
  await panel.getByRole("button", { name: "新5活動の特徴量CSVを出力" }).click();
  const download = await downloading;
  const stream = await download.createReadStream();
  let csv = "";
  for await (const chunk of stream) csv += chunk.toString();
  // All fields of this contract contain only IDs, codes, timestamps and numbers.
  const lines = csv
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(",").map((v) => v.replace(/^"|"$/g, "")));
  const columns = lines.shift()!;
  const rows = lines.map((values) =>
    Object.fromEntries(columns.map((key, i) => [key, values[i]])),
  );
  for (const point of ["start", "completion", "delta"] as const) {
    const r = rows.find((r) => r.aggregationPoint === point)!;
    assert.equal(r.featureVersion, f.featureVersion);
    assert.equal(r.protocolKey, f.protocolKey);
    for (const key of [
      "activeConcepts",
      "hiddenMergeSources",
      "links",
    ] as const)
      assert.equal(r[key], f[point][key] === null ? "" : String(f[point][key]));
    assert.equal(r.capturedAt, f.start.capturedAt ?? "");
    assert.equal(r.submittedAt, f.completion.submittedAt ?? "");
    assert.equal(r.submissionEventId, f.completion.eventId ?? "");
    assert.equal(r.submissionEventType, f.completion.eventType ?? "");
    assert.equal(
      r.submissionEventServerTimestamp,
      f.completion.serverTimestamp ?? "",
    );
  }
  console.log(
    "Isolated real API + Edge: feature version/protocol/points/counts, submission identity, actor/outcome groups and downloaded CSV agree: PASS",
  );
} finally {
  await browser.close();
  await vite.close();
}
