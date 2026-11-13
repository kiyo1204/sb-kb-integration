import assert from "node:assert/strict";
import type { Page, Request, Response, Locator } from "playwright";

/** TEST ONLY. No URLs, IDs, bodies, headers, labels or exception details in output. */
export async function verifySbPositionSave(
  page: Page,
  node: Locator,
  action: () => Promise<void>,
  options: {
    timeout?: number;
    emit?: (record: Record<string, unknown>) => void;
    readPointer?: () => Promise<boolean>;
  } = {},
) {
  const id = await node.getAttribute("data-concept-id");
  assert.ok(id);
  const path = `/api/concepts/${encodeURIComponent(id)}/position`;
  const matches = (r: Request) =>
    r.method() === "PATCH" && new URL(r.url()).pathname === path;
  let sent = 0,
    failed = 0,
    received = 0;
  const statuses: number[] = [];
  const request = (r: Request) => {
    if (matches(r)) sent++;
  };
  const failure = (r: Request) => {
    if (matches(r)) failed++;
  };
  const response = (r: Response) => {
    if (matches(r.request())) {
      received++;
      if (statuses.length < 5) statuses.push(r.status());
    }
  };
  page.on("request", request);
  page.on("requestfailed", failure);
  page.on("response", response);
  try {
    await page.evaluate((expected) => {
      const state = {
        hit: false,
        handler: (e: Event) => {
          const target = e.target;
          if (
            target instanceof Element &&
            target
              .closest("[data-concept-id]")
              ?.getAttribute("data-concept-id") === expected
          )
            state.hit = true;
        },
      };
      (
        window as unknown as { sbPositionDiagnostic: typeof state }
      ).sbPositionDiagnostic = state;
      window.addEventListener("pointerdown", state.handler, true);
    }, id);
    const moved = page.waitForResponse(
      (r) => matches(r.request()),
      options.timeout === undefined ? {} : { timeout: options.timeout },
    );
    void moved.catch(() => undefined); // An action failure must not leave an unhandled waiter rejection.
    await action();
    assert.equal((await moved).status(), 200);
  } catch (original) {
    let pointerReached: boolean | null = null;
    try {
      const read =
        options.readPointer ??
        (() =>
          page.evaluate(
            () =>
              (window as unknown as { sbPositionDiagnostic?: { hit: boolean } })
                .sbPositionDiagnostic?.hit ?? false,
          ));
      pointerReached = await Promise.race([
        read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
    } catch {
      /* diagnostic failure never replaces original */
    }
    try {
      (options.emit ?? ((record) => console.log(JSON.stringify(record))))({
        check: "sb-position-save",
        pointerReached,
        requests: sent,
        requestFailures: failed,
        responses: received,
        statuses,
        dbCheck: "NOT_PERFORMED",
      });
    } catch {
      /* diagnostic output failure never replaces original */
    }
    throw original;
  } finally {
    page.off("request", request);
    page.off("requestfailed", failure);
    page.off("response", response);
    await Promise.race([
      page
        .evaluate(() => {
          const w = window as unknown as {
            sbPositionDiagnostic?: { handler: (e: Event) => void };
          };
          if (w.sbPositionDiagnostic)
            window.removeEventListener(
              "pointerdown",
              w.sbPositionDiagnostic.handler,
              true,
            );
          delete w.sbPositionDiagnostic;
        })
        .catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
  }
}
