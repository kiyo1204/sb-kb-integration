// Only called by verify-observation-origin after its disposable DB check.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Pool } from "pg";
import { digest } from "../delivery-reliability.js";

type Screen = {
  sessionId: string;
  code: string;
  stageId: string;
  secret: string;
  clientId: string;
  generation: number;
};
type Descriptor = {
  eventKey: string;
  clientStreamId: string;
  clientSequence: string;
  requestHash: string;
};

const route = (sessionId: string) =>
  "/api/sessions/" + sessionId + "/observation-receipts/query";
const json = { "Content-Type": "application/json" };
const headers = (screen: Screen) => ({
  ...json,
  Authorization: "Bearer " + screen.code,
  "X-Experiment-Client": screen.secret,
  "X-Experiment-Generation": String(screen.generation),
});

async function snapshot(pool: Pool) {
  const tables = [
    "research_events",
    "client_event_receipts",
    "research_event_counters",
    "client_delivery_reports",
    "operation_receipts",
    "research_identity.device_deletions",
    "experiment_access_audit",
    "experiment_access_operations",
    "experiment_client_candidates",
    "experiment_participant_access",
    "experiment_retired_credentials",
    "experiment_runs",
  ];
  return Promise.all(
    tables.map(
      async (table) =>
        (
          await pool.query(
            "SELECT count(*)::int AS count, md5(coalesce(string_agg(h, ',' ORDER BY h), '')) AS hash" +
              " FROM (SELECT md5(to_jsonb(t)::text) AS h FROM " +
              table +
              " t) fingerprints",
          )
        ).rows[0],
    ),
  );
}

export async function verifyReceiptLookup(options: {
  base: string;
  researcher: string;
  runId: string;
  pool: Pool;
  fixtures: Screen[];
  browser: (
    fixture: Record<string, string>,
    script: string,
  ) => Promise<unknown>;
}) {
  const {
    base,
    researcher,
    runId,
    pool,
    fixtures: [old, other],
    browser,
  } = options;
  function call(path: string, h: Record<string, string>, body: unknown) {
    return fetch(base + path, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
  }
  async function research(path: string, body: unknown) {
    const r = await call(
      "/api/research/experiment-runs/" + runId + path,
      {
        ...json,
        Authorization: "Bearer " + researcher,
        "Idempotency-Key": randomUUID(),
      },
      body,
    );
    assert.equal(r.status, 200, "researcher management action");
    return r.json();
  }
  function eventFor(screen: Screen) {
    return {
      schemaVersion: 1,
      eventType: "VIDEO_SEEK",
      targetType: "VIDEO",
      stageId: screen.stageId,
      outcome: "SUCCESS",
      clientTimeQuality: "OBSERVED",
      clientTimestamp: "2026-11-18T08:00:00.000Z",
      details: { fromSeconds: 0, toSeconds: 1.25 },
    };
  }
  function prepare(screen: Screen) {
    const event = eventFor(screen),
      stream = randomUUID(),
      seq = "1",
      key = randomUUID();
    return {
      event,
      headers: {
        ...headers(screen),
        "X-Experiment-Origin-Client": screen.clientId,
        "X-Experiment-Origin-Generation": String(screen.generation),
        "X-Client-Stream-Id": stream,
        "X-Client-Sequence": seq,
        "Idempotency-Key": key,
      },
      item: {
        eventKey: key,
        clientStreamId: stream,
        clientSequence: seq,
        requestHash: digest({ event, stream, order: seq }),
      },
    };
  }
  const first = prepare(old);
  const eventPath = "/api/sessions/" + old.sessionId + "/events";
  // Observe the real API's durable 201, but close the sender's connection before any ACK.
  let observedStatus = 0;
  const proxy = createServer(async (_req, res) => {
    try {
      observedStatus = (await call(eventPath, first.headers, first.event))
        .status;
    } catch {
      observedStatus = 0;
    } finally {
      res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = proxy.address();
    assert(address && typeof address !== "string");
    await assert.rejects(
      fetch("http://127.0.0.1:" + address.port, { method: "POST" }),
    );
    assert.equal(
      observedStatus,
      201,
      "API saved the request before its response was lost",
    );
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }

  const foreign = prepare(other);
  assert.equal(
    (
      await call(
        "/api/sessions/" + other.sessionId + "/events",
        foreign.headers,
        foreign.event,
      )
    ).status,
    201,
  );
  let before = await snapshot(pool);
  async function query(
    screen: Screen,
    items: Descriptor[],
    status: number,
    expected: unknown,
    target = screen.sessionId,
  ) {
    const response = await call(route(target), headers(screen), {
      contractVersion: 1,
      items,
    });
    assert.equal(response.status, status, "receipt lookup HTTP status");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), expected);
  }
  const result = (...states: string[]) => ({
    contractVersion: 1,
    results: states.map((status) => ({ status })),
  });
  await query(old, [first.item], 200, result("MATCHED"));
  const changed = {
    ...first.item,
    requestHash: digest({
      event: {
        ...first.event,
        details: { ...first.event.details, toSeconds: 2 },
      },
      stream: first.item.clientStreamId,
      order: first.item.clientSequence,
    }),
  };
  for (const item of [
    changed,
    { ...first.item, clientStreamId: randomUUID() },
    { ...first.item, clientSequence: "2" },
    { ...first.item, eventKey: randomUUID() },
    foreign.item,
  ])
    await query(old, [item], 200, result("NOT_CONFIRMED"));
  for (const target of [other.sessionId, randomUUID()]) {
    await query(old, [foreign.item], 404, { error: "not_found" }, target);
  }
  assert.equal(
    (
      await call(
        route(old.sessionId),
        { ...json, Authorization: "Bearer " + researcher },
        { contractVersion: 1, items: [first.item] },
      )
    ).status,
    404,
  );
  const invalid = { error: "invalid_observation_receipt_query" };
  for (const body of [
    { contractVersion: 1, items: [] },
    { contractVersion: 1, items: [first.item, first.item] },
    {
      contractVersion: 1,
      items: [
        first.item,
        {
          ...first.item,
          eventKey: randomUUID(),
          clientStreamId: first.item.clientStreamId.toUpperCase(),
        },
      ],
    },
    { contractVersion: 1, items: [{ ...first.item, event: first.event }] },
    { contractVersion: 1, items: Array(51).fill(first.item) },
  ]) {
    const r = await call(route(old.sessionId), headers(old), body);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), invalid);
  }
  for (const [body, status] of [
    ["{bad-json", 400],
    [JSON.stringify({ padding: "X".repeat(17 * 1024) }), 413],
  ] as const) {
    const r = await fetch(base + route(old.sessionId), {
      method: "POST",
      headers: headers(old),
      body,
    });
    assert.equal(r.status, status);
    assert.deepEqual(await r.json(), invalid);
  }
  const blocking = await pool.connect();
  try {
    await blocking.query("BEGIN");
    await blocking.query(
      "LOCK TABLE client_event_receipts IN ACCESS EXCLUSIVE MODE",
    );
    await query(old, [first.item], 503, {
      error: "observation_receipt_lookup_unavailable",
    });
  } finally {
    try {
      await blocking.query("ROLLBACK");
    } finally {
      blocking.release();
    }
  }
  await query(old, [first.item], 200, result("MATCHED"));
  assert.deepEqual(
    await snapshot(pool),
    before,
    "read/no match/invalid/timeout leave DB rows unchanged",
  );

  const reissued = await research(
    "/participants/" + old.sessionId + "/code/reissue",
    { expectedCredentialGeneration: 1 },
  );
  const freshSecret = randomBytes(32).toString("base64url");
  const unreconciled = {
    ...old,
    code: reissued.issuedCode,
    secret: freshSecret,
    generation: reissued.deviceGeneration,
  };
  before = await snapshot(pool);
  await query(old, [first.item], 401, { error: "experiment_code_invalidated" });
  await query(unreconciled, [first.item], 409, {
    error: "experiment_client_stale",
  });
  assert.deepEqual(await snapshot(pool), before);
  const claim = await call(
    "/api/experiment-client/claim",
    headers(unreconciled),
    {},
  );
  assert.equal(claim.status, 200);
  const current = { ...unreconciled, clientId: (await claim.json()).clientId };
  const second = prepare(current);
  assert.equal(
    (await call(eventPath, second.headers, second.event)).status,
    201,
  );
  before = await snapshot(pool);
  await query(
    current,
    [first.item, second.item],
    200,
    result("MATCHED", "MATCHED"),
  );
  const { details, ...observed } = first.event;
  void details;
  const vectors = [
    { ...observed, eventType: "SCREEN_ENTER", targetType: "SCREEN" },
    {
      ...observed,
      eventType: "SCREEN_LEAVE",
      targetType: "SCREEN",
      mapId: randomUUID(),
    },
    ...["STAGE_PAUSE", "STAGE_RESUME"].map((eventType) => ({
      ...observed,
      eventType,
      targetType: "STAGE",
      outcome: "UNKNOWN",
      reasonCode: "UNKNOWN",
    })),
    ...["VIDEO_PLAY", "VIDEO_PAUSE", "VIDEO_COMPLETE"].map((eventType) => ({
      ...observed,
      eventType,
    })),
    {
      ...observed,
      eventType: "FEEDBACK_DISPLAY",
      targetType: "FEEDBACK",
      mapId: randomUUID(),
    },
  ].map((event, index) => {
    const stream = first.item.clientStreamId.toUpperCase(),
      order = String(index + 1);
    return { event, stream, order, expected: digest({ event, stream, order }) };
  });
  await browser(
    {
      OBSERVATION_RECEIPT_FIXTURE: JSON.stringify({
        current,
        first,
        second,
        changed,
        vectors,
      }),
    },
    "verify-observation-receipt-browser.ts",
  );
  assert.deepEqual(
    await snapshot(pool),
    before,
    "browser receipt proof did not write",
  );

  const switchSecret = randomBytes(32).toString("base64url");
  const candidate = await call(
    "/api/experiment-client/claim",
    headers({ ...current, secret: switchSecret }),
    {},
  );
  assert.equal(candidate.status, 409);
  const clientId = (await candidate.json()).clientId;
  const switched = await research(
    "/participants/" + old.sessionId + "/client-switch",
    { clientId, expectedDeviceGeneration: current.generation },
  );
  const active = {
    ...current,
    secret: switchSecret,
    clientId,
    generation: switched.deviceGeneration,
  };
  before = await snapshot(pool);
  await query(current, [first.item], 409, { error: "experiment_client_stale" });
  await query(active, [first.item], 200, result("MATCHED"));
  assert.deepEqual(await snapshot(pool), before);
  await research("/end", { confirmed: true });
  before = await snapshot(pool);
  await query(active, [first.item], 409, { error: "experiment_ended" });
  assert.deepEqual(await snapshot(pool), before);
  console.log(
    "PASS receipt API: lost ACK, reissue, exact/not confirmed, invalid/oversize, isolation, timeout recovery, stale screen, end, immutable DB",
  );
}
