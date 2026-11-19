import express, { type Express, type RequestHandler } from "express";
import type { Pool, PoolClient } from "pg";
import { accessControl, principalOf } from "./access-control.js";
import { isUuid } from "./delivery-reliability.js";
import { experimentLearnerEnabled } from "./experiment-execution.js";
import {
  ParticipantAccessError,
  readCurrentExperimentClient,
} from "./experiment-participant-access.js";
import { learnerObservedEventTypes } from "./research-events.js";

const path = "/api/sessions/:sessionId/observation-receipts/query";
const unavailable = { error: "observation_receipt_lookup_unavailable" };
const invalid = { error: "invalid_observation_receipt_query" };

type Descriptor = {
  eventKey: string;
  clientStreamId: string;
  clientSequence: string;
  requestHash: string;
};
type Receipt = {
  key: string;
  stream: string;
  client_sequence: string;
  request_hash: string;
  consistent: boolean;
  event_type: string | null;
};

function closedObject(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function descriptors(body: unknown): Descriptor[] | null {
  if (
    !closedObject(body, ["contractVersion", "items"]) ||
    body.contractVersion !== 1 ||
    !Array.isArray(body.items) ||
    body.items.length < 1 ||
    body.items.length > 50
  )
    return null;

  const items: Descriptor[] = [];
  const eventKeys = new Set<string>(),
    positions = new Set<string>();
  for (const item of body.items as unknown[]) {
    if (
      !closedObject(item, [
        "eventKey",
        "clientStreamId",
        "clientSequence",
        "requestHash",
      ]) ||
      !isUuid(item.eventKey) ||
      !isUuid(item.clientStreamId) ||
      typeof item.clientSequence !== "string" ||
      !/^[1-9][0-9]{0,14}$/.test(item.clientSequence) ||
      typeof item.requestHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.requestHash)
    )
      return null;
    // PostgreSQL UUID comparison ignores case. The submitted hash still binds
    // the original stream header spelling used by the event writer.
    const eventKey = item.eventKey.toLowerCase(),
      clientStreamId = item.clientStreamId.toLowerCase();
    const position = clientStreamId + ":" + item.clientSequence;
    if (eventKeys.has(eventKey) || positions.has(position)) return null;
    eventKeys.add(eventKey);
    positions.add(position);
    items.push({
      eventKey,
      clientStreamId,
      clientSequence: item.clientSequence,
      requestHash: item.requestHash,
    });
  }
  return items;
}

async function lookup(
  client: PoolClient,
  sessionId: string,
  items: Descriptor[],
) {
  const receipts = await client.query<Receipt>(
    `
    SELECT r.event_key AS key, r.client_id AS stream, r.client_sequence::text, r.request_hash,
           (e.event_id IS NOT NULL AND e.sequence_number=r.sequence_number
             AND e.schema_version=1 AND e.actor_type='LEARNER') AS consistent,
           e.event_type
      FROM client_event_receipts r
      LEFT JOIN research_events e ON e.event_id=r.event_id AND e.session_id=r.session_id
     WHERE r.session_id=$1::uuid AND r.event_key=ANY($2::uuid[])
  `,
    [sessionId, items.map((item) => item.eventKey)],
  );
  const byKey = new Map(receipts.rows.map((row) => [row.key, row]));
  return items.map((item) => {
    const receipt = byKey.get(item.eventKey);
    if (
      !receipt ||
      receipt.stream !== item.clientStreamId ||
      receipt.client_sequence !== item.clientSequence ||
      receipt.request_hash !== item.requestHash
    )
      return { status: "NOT_CONFIRMED" };
    if (
      !receipt.consistent ||
      !learnerObservedEventTypes.has(receipt.event_type ?? "")
    )
      throw new Error("receipt_inconsistent");
    return { status: "MATCHED" };
  });
}

function rateLimits() {
  const windows = new Map<string, { attempts: number; until: number }>();
  const active = new Set<string>();
  return (sessionId: string) => {
    const now = performance.now();
    const window = windows.get(sessionId);
    if (
      active.has(sessionId) ||
      (window && now < window.until && window.attempts >= 30)
    )
      return false;
    if (!window || now >= window.until) {
      for (const [id, stored] of windows)
        if (now >= stored.until) windows.delete(id);
      if (windows.size >= 1024) return false;
      windows.set(sessionId, { attempts: 1, until: now + 60_000 });
    } else window.attempts += 1;
    active.add(sessionId);
    return () => {
      active.delete(sessionId);
    };
  };
}

export function registerObservationReceiptLookup(app: Express, pool: Pool) {
  const acquire = rateLimits();
  let inflight = 0;
  const admit: RequestHandler = (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (inflight >= 8) {
      res.status(429).json({ error: "observation_receipt_query_limited" });
      return;
    }
    inflight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inflight -= 1;
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
  const json = express.json({ limit: 16 * 1024 });
  const parse: RequestHandler = (req, res, next) => {
    json(req, res, (error: { type?: string } | undefined) => {
      if (!error) {
        next();
        return;
      }
      if (error.type === "entity.too.large") res.status(413).json(invalid);
      else res.status(400).json(invalid);
    });
  };

  app.post(
    path,
    admit,
    accessControl(pool, "observationReceipts"),
    parse,
    async (req, res) => {
      const actor = principalOf(res);
      if (actor.role !== "learner" || !actor.experiment)
        return res.status(404).json({ error: "not_found" });
      const items = descriptors(req.body);
      if (!items) return res.status(400).json(invalid);
      const release = acquire(actor.sessionId);
      if (!release)
        return res
          .status(429)
          .json({ error: "observation_receipt_query_limited" });

      let client: PoolClient | undefined;
      let discard = false;
      try {
        client = await pool.connect();
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query("SET LOCAL statement_timeout='2s'");
        const row = await readCurrentExperimentClient(
          client,
          actor.experiment,
          req.header("X-Experiment-Client"),
          Number(req.header("X-Experiment-Generation")),
        );
        if (row.state === "ENDED")
          throw new ParticipantAccessError("experiment_ended", 409);
        if (!experimentLearnerEnabled())
          throw new ParticipantAccessError(
            "experiment_learner_flow_unavailable",
            409,
          );
        if (row.state !== "RUNNING")
          throw new ParticipantAccessError("experiment_not_running", 409);
        const results = await lookup(client, actor.sessionId, items);
        await client.query("COMMIT");
        return res.json({ contractVersion: 1, results });
      } catch (error) {
        if (client) {
          try {
            await client.query("ROLLBACK");
          } catch {
            discard = true;
          }
        }
        if (error instanceof ParticipantAccessError)
          return res.status(error.status).json({ error: error.code });
        return res.status(503).json(unavailable);
      } finally {
        client?.release(discard);
        release();
      }
    },
  );
}
