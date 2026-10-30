import type { Express } from "express";
import type { Pool, PoolClient } from "pg";
import { principalOf } from "./access-control.js";
import { isUuid } from "./delivery-reliability.js";
const numbers = [
  "reportSequence",
  "pending",
  "retrying",
  "acknowledged",
  "capacityLost",
  "expiredLost",
  "rejectedLost",
  "storageLost",
  "attempts",
] as const;
export async function deliverySnapshot(
  db: Pool | PoolClient,
  sessionId: string,
) {
  const reports = await db.query(
    "SELECT * FROM client_delivery_reports WHERE session_id=$1 ORDER BY received_at",
    [sessionId],
  );
  const saved = await db.query(
    "SELECT client_id,count(*)::int AS persisted,max(client_sequence)::text AS last_client_sequence,(max(client_sequence)-count(*))::text AS sequence_gaps FROM client_event_receipts WHERE session_id=$1 GROUP BY client_id",
    [sessionId],
  );
  return {
    clientReported: reports.rows,
    serverVerified: saved.rows,
    missingIsUnknown: true,
  };
}
export function registerDeliveryReports(app: Express, pool: Pool) {
  app.post("/api/sessions/:sessionId/delivery-status", async (req, res) => {
    const p = principalOf(res),
      id = req.params.sessionId,
      b = req.body;
    if (p.role !== "learner" || p.sessionId !== id)
      return res.status(404).json({ error: "not_found" });
    if (
      !b ||
      Object.keys(b).some(
        (k) => !["clientId", "lastResponse", ...numbers].includes(k),
      ) ||
      !isUuid(b.clientId) ||
      numbers.some(
        (k) => !Number.isSafeInteger(b[k]) || b[k] < 0 || b[k] > 1000000000,
      ) ||
      b.reportSequence === 0 ||
      b.retrying > b.pending ||
      ![
        "NONE",
        "ACK",
        "NETWORK",
        "RETRYABLE",
        "REJECTED",
        "STORAGE",
        "SENDING",
      ].includes(b.lastResponse)
    )
      return res.status(400).json({ error: "invalid_delivery_report" });
    try {
      await pool.query(
        "INSERT INTO client_delivery_reports(session_id,client_id,report_sequence,pending,retrying,acknowledged,capacity_lost,expired_lost,rejected_lost,storage_lost,attempts,last_response) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(session_id,client_id) DO UPDATE SET report_sequence=EXCLUDED.report_sequence,pending=EXCLUDED.pending,retrying=EXCLUDED.retrying,acknowledged=EXCLUDED.acknowledged,capacity_lost=EXCLUDED.capacity_lost,expired_lost=EXCLUDED.expired_lost,rejected_lost=EXCLUDED.rejected_lost,storage_lost=EXCLUDED.storage_lost,attempts=EXCLUDED.attempts,last_response=EXCLUDED.last_response,received_at=clock_timestamp() WHERE client_delivery_reports.report_sequence<EXCLUDED.report_sequence",
        [id, b.clientId, ...numbers.map((k) => b[k]), b.lastResponse],
      );
      return res.json({ reportSaved: true });
    } catch {
      return res.status(503).json({ error: "delivery_report_unavailable" });
    }
  });
  app.get(
    "/api/research/sessions/:sessionId/delivery-status",
    async (req, res) => {
      if (
        principalOf(res).role !== "researcher" ||
        !isUuid(req.params.sessionId)
      )
        return res.status(404).json({ error: "not_found" });
      try {
        if (
          !(
            await pool.query("SELECT 1 FROM sessions WHERE id=$1", [
              req.params.sessionId,
            ])
          ).rowCount
        )
          return res.status(404).json({ error: "not_found" });
        return res.json(await deliverySnapshot(pool, req.params.sessionId));
      } catch {
        return res.status(503).json({ error: "delivery_status_unavailable" });
      }
    },
  );
}
