// TEST ONLY: fresh browser contexts; no runtime queues or credentials are read.
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { createServer } from "vite";
import { resolve } from "node:path";
const real = process.env.OBSERVATION_FIXTURES
  ? JSON.parse(process.env.OBSERVATION_FIXTURES)
  : null;
const vite = await createServer({
  cacheDir: resolve("../.local/origin-context/vite"),
  plugins: [
    {
      name: "observation-test-harness",
      resolveId(id) {
        if (id === "/__observation_harness") return "\0observation-harness";
      },
      load(id) {
        if (id === "\0observation-harness")
          return 'import * as react from "react"; import * as dom from "react-dom/client"; export {react,dom};';
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 0,
    ...(real
      ? {
          proxy: {
            "/api": { target: process.env.API_BASE_URL!, changeOrigin: true },
          },
        }
      : {}),
  },
});
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
const gates = new Set<() => void>(),
  tasks = new Set<Promise<void>>();
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
const stage = "33333333-3333-4333-8333-333333333333";
async function modules(page: Page) {
  await page.goto(vite.resolvedUrls!.local[0]);
  await page.evaluate(async () => {
    const w = window as any;
    const harness = await import("/__observation_harness");
    w.mods = {
      auth: await import("/src/auth-client.ts"),
      outbox: await import("/src/observation-outbox.ts"),
      events: await import("/src/learning-events.ts"),
      react: harness.react,
      dom: harness.dom,
    };
  });
}
async function bind(page: Page, s: any) {
  await page.evaluate((s) => {
    const w = window as any,
      a = w.mods.auth;
    a.setAccessToken(s.code);
    w.owner = a.registerExperimentClientOwner(s.sessionId);
    a.bindExperimentClient(
      { secret: s.secret, generation: s.generation, clientId: s.clientId },
      w.owner,
    );
  }, s);
}
async function read(page: Page, sid: string) {
  return page.evaluate(async (sid) => {
    const db = await new Promise<IDBDatabase>((ok, no) => {
      const q = indexedDB.open("stage1-observation-outbox");
      q.onupgradeneeded = () => {
        q.transaction!.abort();
        no(Error("unexpected_create"));
      };
      q.onsuccess = () => ok(q.result);
      q.onerror = () => no(q.error);
    });
    try {
      return await new Promise<any>((ok, no) => {
        const q = db
          .transaction("sessions", "readonly")
          .objectStore("sessions")
          .get(sid);
        q.onsuccess = () => ok(q.result);
        q.onerror = () => no(q.error);
      });
    } finally {
      db.close();
    }
  }, sid);
}
async function send(page: Page, sid: string, contextName?: string) {
  return page.evaluate(
    ({ sid, contextName, stage }) => {
      const w = window as any;
      return w.mods.events.sendObservedLearningEvent(
        sid,
        { eventType: "SCREEN_ENTER", targetType: "SCREEN", stageId: stage },
        false,
        contextName ? w[contextName] : undefined,
      );
    },
    {
      sid,
      contextName,
      stage: real ? real.find((x: any) => x.sessionId === sid).stageId : stage,
    },
  );
}
try {
  const page = await browser.newPage();
  await page.addInitScript("globalThis.__name = fn => fn");
  if (real) {
    let delayed = false,
      release = () => {},
      arrived = () => {};
    const entered = new Promise<void>((r) => {
      arrived = r;
    });
    await page.route("**/api/**", (route) => {
      const task = (async () => {
        if (
          delayed &&
          new URL(route.request().url()).pathname ===
            `/api/sessions/${real[0].sessionId}/events`
        ) {
          delayed = false;
          const response = await route.fetch();
          assert.equal(response.status(), 201);
          const gate = new Promise<void>((r) => {
            release = r;
            gates.add(r);
          });
          arrived();
          await gate;
          gates.delete(release);
          await route.fulfill({ response });
        } else await route.continue();
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return task;
    });
    await modules(page);
    await bind(page, real[0]);
    assert.equal(await send(page, real[0].sessionId), true);
    await page.evaluate(() => {
      const w = window as any;
      w.oldOwner = w.owner;
      w.contextA = w.mods.auth.captureObservationContext(
        w.owner.sessionId,
        true,
      );
    });
    delayed = true;
    const pending = send(page, real[0].sessionId, "contextA");
    await entered;
    await bind(page, real[1]);
    assert.equal(await send(page, real[1].sessionId), true);
    release();
    assert.equal(
      await pending,
      false,
      "late A response is not accepted in B context",
    );
    assert.equal(await send(page, real[0].sessionId, "contextA"), false);
    const held = await read(page, real[0].sessionId);
    assert.equal(held.items.length, 2);
    assert.ok(
      held.items.every(
        (x: any) =>
          x.experimentOrigin.clientId === real[0].clientId &&
          x.experimentOrigin.generation === real[0].generation,
      ),
    );
    assert.equal(held.acknowledged, 1);
    const identity = held.items.map((x: any) => ({
      id: x.id,
      order: x.order,
      origin: x.experimentOrigin,
    }));
    await bind(page, real[0]);
    assert.equal(await send(page, real[0].sessionId), true);
    const done = await read(page, real[0].sessionId);
    assert.equal(done.items.length, 0);
    assert.equal(done.acknowledged, 4);
    assert.equal(done.clientId, held.clientId);
    assert.equal(done.next, held.next + 1);
    if (process.send)
      process.send({
        keys: identity.map((x: any) => x.id),
        sessionId: real[0].sessionId,
        expectedReceipts: 2,
      });
    console.log(
      "PASS real API: current ACK, delayed A response held across B login, original cleanup origin, exact-key replay without duplicate ACK",
    );
  } else {
    let identity = A,
      mode = "offline",
      release = () => {},
      arrived = () => {},
      eventCount = 0,
      delayClaim = false;
    let entered = new Promise<void>((r) => {
      arrived = r;
    });
    const originA = {
      sessionId: A,
      code: "mock-only-" + "a".repeat(40),
      secret: "a".repeat(43),
      generation: 2,
      clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    const originB = {
      sessionId: B,
      code: "mock-only-" + "b".repeat(40),
      secret: "b".repeat(43),
      generation: 8,
      clientId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    await page.route("**/api/**", (route) => {
      const task = (async () => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/experiment-client/claim") {
          const a =
            route.request().headers().authorization ===
            `Bearer ${originA.code}`;
          if (a && delayClaim) {
            const gate = new Promise<void>((r) => {
              release = r;
              gates.add(r);
            });
            arrived();
            await gate;
            gates.delete(release);
          }
          return route.fulfill({
            json: {
              ownership: "OWNED",
              clientId: a ? originA.clientId : originB.clientId,
              deviceGeneration: a ? 2 : 8,
            },
          });
        }
        if (path === "/api/experiment-material")
          return route.fulfill({
            status: 409,
            json: { error: "experiment_not_running" },
          });
        if (path === "/api/me")
          return route.fulfill({
            json: { role: "learner", sessionId: identity },
          });
        if (path.endsWith("/events")) {
          eventCount++;
          if (mode === "offline") return route.abort("internetdisconnected");
          if (mode === "delay") {
            const gate = new Promise<void>((r) => {
              release = r;
              gates.add(r);
            });
            arrived();
            await gate;
            gates.delete(release);
          }
          return route.fulfill({
            status: mode === "ended" ? 409 : 201,
            json:
              mode === "ended"
                ? { error: "experiment_ended" }
                : {
                    logSaved: true,
                    eventId: crypto.randomUUID(),
                    sequenceNumber: String(eventCount),
                  },
          });
        }
        return route.fulfill({ json: { reportSaved: true } });
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return task;
    });
    await modules(page);
    await bind(page, originA);
    await page.evaluate(
      ({ sid, stage }) => {
        const w = window as any,
          R = w.mods.react;
        w.failures = { A: 0, B: 0 };
        w.host = document.createElement("div");
        document.body.replaceChildren(w.host);
        w.root = w.mods.dom.createRoot(w.host);
        w.Harness = ({ sid, stage, map, required = true }: any) => {
          const post = w.mods.events.useObservedLearningScreen(
            sid,
            stage,
            map,
            true,
            () => {
              w.failures[sid.startsWith("111") ? "A" : "B"]++;
            },
            required,
          );
          w.poster = post;
          return R.createElement("p", null, "synthetic observation screen");
        };
        w.root.render(R.createElement(w.Harness, { sid, stage }));
      },
      { sid: A, stage },
    );
    await page.waitForFunction(() => !!(window as any).poster);
    await page.waitForFunction(() => (window as any).failures.A > 0);
    const first = await read(page, A);
    assert.ok(first.items.length >= 1);
    await page.evaluate(
      ({ sid, stage }) => {
        const w = window as any;
        w.root.render(
          w.mods.react.createElement(w.Harness, {
            sid,
            stage,
            map: "66666666-6666-4666-8666-666666666666",
          }),
        );
      },
      { sid: A, stage },
    );
    await page.waitForFunction(async (sid) => {
      const db = await new Promise<IDBDatabase>((ok) => {
        const q = indexedDB.open("stage1-observation-outbox");
        q.onsuccess = () => ok(q.result);
      });
      try {
        return await new Promise<boolean>((ok) => {
          const q = db
            .transaction("sessions", "readonly")
            .objectStore("sessions")
            .get(sid);
          q.onsuccess = () =>
            ok(
              q.result.items.some(
                (x: any) =>
                  x.event.mapId === "66666666-6666-4666-8666-666666666666",
              ),
            );
        });
      } finally {
        db.close();
      }
    }, A);
    await page.evaluate(() => {
      const w = window as any;
      w.contextA = w.mods.auth.captureObservationContext(
        w.owner.sessionId,
        true,
      );
      w.oldOwner = w.owner;
    });
    identity = B;
    await bind(page, originB);
    await page.evaluate(
      ({ sid, stage }) => {
        const w = window as any;
        w.root.render(w.mods.react.createElement(w.Harness, { sid, stage }));
      },
      { sid: B, stage },
    );
    await page.waitForFunction(() => (window as any).failures.B > 0);
    const after = await read(page, A);
    assert.ok(
      after.items.some((x: any) => x.event.eventType === "SCREEN_LEAVE"),
    );
    assert.ok(
      after.items.every(
        (x: any) =>
          x.experimentOrigin?.clientId === originA.clientId &&
          x.experimentOrigin.generation === 2,
      ),
    );
    for (const item of first.items) {
      const retained = after.items.find((x: any) => x.id === item.id);
      assert.equal(retained.id, item.id);
      assert.equal(retained.order, item.order);
      assert.deepEqual(retained.event, item.event);
      assert.deepEqual(retained.experimentOrigin, item.experimentOrigin);
    }
    assert.ok(
      after.items.some(
        (x: any) =>
          x.event.eventType === "SCREEN_LEAVE" &&
          x.event.mapId === "66666666-6666-4666-8666-666666666666",
      ),
    );
    assert.equal(after.clientId, first.clientId);
    assert.equal(
      await page.evaluate(() => {
        const w = window as any;
        w.mods.auth.releaseExperimentClientOwner(w.oldOwner);
        return w.mods.auth.captureObservationContext(w.owner.sessionId, true)
          .origin.clientId;
      }),
      originB.clientId,
    );
    // Promise resolved after Stage change must not notify the new Stage.
    mode = "delay";
    entered = new Promise<void>((r) => {
      arrived = r;
    });
    const p = page.evaluate(
      ({ stage }) =>
        (window as any).poster({
          eventType: "VIDEO_PLAY",
          targetType: "VIDEO",
          stageId: stage,
        }),
      { stage },
    );
    await entered;
    const bBefore = await page.evaluate(() => (window as any).failures.B);
    await page.evaluate(
      ({ sid }) => {
        const w = window as any;
        w.root.render(
          w.mods.react.createElement(w.Harness, {
            sid,
            stage: "44444444-4444-4444-8444-444444444444",
          }),
        );
      },
      { sid: B },
    );
    mode = "online";
    release();
    await p;
    assert.equal(
      await page.evaluate(() => (window as any).failures.B),
      bBefore,
    );
    // Missing new-protocol origin fails visibly; never substitutes A/B origin.
    await page.evaluate(() => {
      const w = window as any;
      w.root.unmount();
      w.mods.auth.bindExperimentClient(null, w.owner);
    });
    const missing = await page.evaluate(
      ({ sid, stage }) => {
        const w = window as any;
        return w.mods.events.sendObservedLearningEvent(
          sid,
          { eventType: "VIDEO_PLAY", targetType: "VIDEO", stageId: stage },
          false,
          w.mods.auth.captureObservationContext(sid, true),
        );
      },
      { sid: B, stage },
    );
    assert.equal(missing, false);
    assert.equal(
      await page.evaluate(async (sid) => {
        try {
          await (window as any).mods.outbox.queueStatus(sid);
          return false;
        } catch {
          return true;
        }
      }, B),
      true,
    );
    const serialized =
      JSON.stringify(await read(page, A)) + JSON.stringify(await read(page, B));
    assert.ok(
      !serialized.includes(originA.code) &&
        !serialized.includes(originA.secret) &&
        !serialized.includes(originB.code) &&
        !serialized.includes(originB.secret),
    );
    // Legacy observations still permit no experiment origin.
    const legacy = "55555555-5555-4555-8555-555555555555";
    identity = legacy;
    await page.evaluate(() => {
      const w = window as any;
      w.mods.auth.clearAccessToken();
      w.mods.auth.setAccessToken("mock-only-legacy-" + "c".repeat(32));
    });
    mode = "offline";
    await send(page, legacy);
    assert.ok(
      (await read(page, legacy)).items.every(
        (x: any) => x.experimentOrigin === undefined,
      ),
    );
    // A late ended response may not end B after the binding has changed.
    await bind(page, originA);
    mode = "delay";
    entered = new Promise<void>((r) => {
      arrived = r;
    });
    await page.evaluate(() => {
      const w = window as any;
      w.ended = 0;
      window.addEventListener("experiment-ended", () => w.ended++);
    });
    const late = page.evaluate(() =>
      (window as any).mods.auth
        .apiFetch("/api/sessions/test/events", { method: "POST" })
        .then((r: Response) => r.status),
    );
    await entered;
    await bind(page, originB);
    mode = "ended";
    release();
    assert.equal(await late, 409);
    assert.equal(await page.evaluate(() => (window as any).ended), 0);
    // Mount the actual registration component: A's late claim must not bind over B.
    delayClaim = true;
    entered = new Promise<void>((r) => {
      arrived = r;
    });
    await page.evaluate(
      async ({ s }) => {
        const w = window as any;
        w.ExperimentPage = (
          await import("/src/ExperimentLearnerPage.tsx")
        ).default;
        w.mods.auth.setAccessToken(s.code);
        w.root = w.mods.dom.createRoot(w.host);
        w.root.render(
          w.mods.react.createElement(w.ExperimentPage, {
            key: "A",
            sessionId: s.sessionId,
            flowMode: "enabled",
          }),
        );
      },
      { s: originA },
    );
    await entered;
    await page.evaluate(
      ({ s }) => {
        const w = window as any;
        w.mods.auth.setAccessToken(s.code);
        w.root.render(
          w.mods.react.createElement(w.ExperimentPage, {
            key: "B",
            sessionId: s.sessionId,
            flowMode: "enabled",
          }),
        );
      },
      { s: originB },
    );
    await page.waitForFunction(
      (sid) =>
        (window as any).mods.auth.captureObservationContext(sid, true)
          .origin !== null,
      B,
    );
    release();
    await page
      .getByRole("heading", { name: "実施の開始を待っています", exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(
        (sid) =>
          (window as any).mods.auth.captureObservationContext(sid, true).origin
            ?.clientId,
        B,
      ),
      originB.clientId,
    );
    await page.evaluate(() => (window as any).root.unmount());
    console.log(
      "PASS synthetic React/IndexedDB: captured cleanup owner, old release ignored, Stage response isolation, missing origin failure, legacy/no secrets, stale ended notification ignored",
    );
  }
} finally {
  for (const release of gates) release();
  await Promise.allSettled([...tasks]);
  await browser.close();
  await vite.close();
}
