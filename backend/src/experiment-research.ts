import type { Express } from "express";
import type { Pool, PoolClient } from "pg";
import { principalOf } from "./access-control.js";
import {
  buildSessionRawExport,
  type SessionRawExport,
} from "./research-export.js";
import { savedMapState } from "./experiment-research-states.js";
import { csvCell } from "./csv.js";
import {
  respondResearchSafetyError,
  redactResearchOutput,
} from "./research-output-safety.js";
import { writeRunAudit } from "./experiment-run-management.js";

export const EXPERIMENT_RESEARCH_CONTRACT = "sbkb-integration-research-v1";
import { isUuid as uuid } from "./delivery-reliability.js";
export function experimentStateRows(raw: SessionRawExport) {
  const base = {
    outputContract: EXPERIMENT_RESEARCH_CONTRACT,
    protocolKey: raw.session.protocolKey,
    runId: raw.experiment?.runId,
    materialVersionId: raw.experiment?.materialVersionId,
    sessionId: raw.session.id,
    pseudonym: raw.session.participantCode,
    sessionStatus: raw.session.status,
    exportedAt: raw.exportedAt,
  };
  const rows: Array<Record<string, unknown>> = raw.maps.map((map) => ({
    ...base,
    mapId: map.id,
    mapType: map.type,
    point: "SAVED_AT_READ",
    status: "AVAILABLE",
    reason: null,
    recordedAt: raw.exportedAt,
    submissionEventId: null,
    state: savedMapState(map),
  }));
  if (!rows.length)
    rows.push({
      ...base,
      mapId: null,
      mapType: null,
      point: "SAVED_AT_READ",
      status: "UNAVAILABLE",
      reason: "MAP_NOT_CREATED",
      recordedAt: raw.exportedAt,
      state: null,
    });
  if (raw.integrationStates)
    for (const point of ["start", "submission"] as const) {
      const value = raw.integrationStates[point];
      rows.push({
        ...base,
        mapId: raw.integrationStates.mapId,
        mapType: "INTEGRATION",
        point: point === "start" ? "INTEGRATION_START" : "ACCEPTED_SUBMISSION",
        status: value.status,
        reason: value.reason,
        recordedAt:
          "capturedAt" in value ? value.capturedAt : value.submittedAt,
        submissionEventId: "eventId" in value ? value.eventId : null,
        state: value.state,
      });
    }
  return rows;
}
export function experimentStatesCsv(rows: Array<Record<string, unknown>>) {
  const columns = [
    "outputContract",
    "protocolKey",
    "runId",
    "materialVersionId",
    "sessionId",
    "pseudonym",
    "sessionStatus",
    "exportedAt",
    "mapId",
    "mapType",
    "point",
    "status",
    "reason",
    "recordedAt",
    "submissionEventId",
    "state",
  ];
  return (
    "\uFEFF" +
    [
      columns.join(","),
      ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(",")),
    ].join("\r\n") +
    "\r\n"
  );
}

/** Bulk reads share one DB snapshot and the existing request safety budget. No R05 joins. */
export function registerExperimentResearchRoutes(app: Express, pool: Pool) {
  for (const suffix of ["research", "research.json", "research.csv"])
    app.get(
      `/api/research/experiment-runs/:runId/${suffix}`,
      async (req, res) => {
        if (principalOf(res).role !== "researcher")
          return res.status(403).json({ error: "forbidden" });
        const suppliedRunId = req.params.runId;
        if (!uuid(suppliedRunId))
          return res.status(400).json({ error: "invalid_run_id" });
        const runId=suppliedRunId.toLowerCase();
        let client: PoolClient | null = null;
        const rollbackAndRelease=async()=>{
          if(!client)return;
          const held=client;client=null;
          try {await held.query("ROLLBACK");held.release();}
          catch {held.release(true);}
        };
        try {
          client = await pool.connect();
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          const run = (
            await client.query(
              `SELECT id,state,material_version_id AS "materialVersionId",planned_participants AS "plannedParticipants",created_at AS "createdAt" FROM experiment_runs WHERE id=$1`,
              [runId],
            )
          ).rows[0];
          if (!run) {
            await rollbackAndRelease();
            await writeRunAudit(pool, "READ", runId, 404, "not_found");
            return res.status(404).json({ error: "not_found" });
          }
          const ids = (
            await client.query(
              "SELECT session_id FROM experiment_run_sessions WHERE run_id=$1 ORDER BY registered_at,session_id",
              [runId],
            )
          ).rows;
          const sessions: SessionRawExport[] = [];
          for (const row of ids) {
            const result = await buildSessionRawExport(client, row.session_id);
            if (
              result.kind !== "exported" ||
              result.value.session.protocolKey !== "SBKB_INTEGRATION_V1" ||
              result.value.experiment?.runId !== runId
            ) {
              await rollbackAndRelease();
              await writeRunAudit(
                pool,
                "READ",
                runId,
                409,
                "research_data_inconsistent",
              );
              return res
                .status(409)
                .json({
                  error: "research_data_inconsistent",
                  message:
                    "所属または保存データに不整合があります。対象Sessionを確認してください。",
                });
            }
            sessions.push(result.value);
          }
          const data = await redactResearchOutput(
            {
              outputContract: EXPERIMENT_RESEARCH_CONTRACT,
              protocolKey: "SBKB_INTEGRATION_V1",
              run: { ...run, registeredSessions: ids.length },
              sessions,
            },
            client,
          );
          const body = suffix.endsWith(".csv")
            ? experimentStatesCsv(data.sessions.flatMap(experimentStateRows))
            : data;
          await client.query("COMMIT");
          client.release();
          client = null;
          await writeRunAudit(pool, "READ", runId, 200, "ok");
          if (suffix.endsWith(".csv"))
            res
              .set("Content-Type", "text/csv; charset=utf-8")
              .set(
                "Content-Disposition",
                `attachment; filename="run-${runId}-map-states.csv"`,
              );
          if (suffix.endsWith(".json"))
            res.set(
              "Content-Disposition",
              `attachment; filename="run-${runId}-research.json"`,
            );
          return typeof body === "string" ? res.send(body) : res.json(body);
        } catch (error) {
          await rollbackAndRelease();
          // Response and audit use the same fixed safety classification.
          const code = (error as { code?: string })?.code;
          const safety =
            code === "safety_budget_exceeded" ||
            code === "safety_lookup_unavailable";
          const status = code === "safety_budget_exceeded" ? 422 : 503;
          await writeRunAudit(
            pool,
            "READ",
            runId,
            status,
            safety ? code! : "research_unavailable",
          ).catch(() => undefined);
          if (respondResearchSafetyError(res, error)) return;
          return res
            .status(status)
            .json({
              error: "research_unavailable",
              message:
                "研究用データを取得できませんでした。時間をおいて再試行してください。",
            });
        } finally {
          client?.release();
        }
      },
    );
}
