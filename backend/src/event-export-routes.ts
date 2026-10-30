import type { Express } from "express";
import type { Pool } from "pg";
import { join } from "node:path";
import { principalOf } from "./access-control.js";
import { isUuid } from "./delivery-reliability.js";
import { recordAudit } from "./server-audit.js";
import {
  EventExportService,
  ExportLimitError,
} from "./event-export-service.js";
import { eventTargets } from "./research-events.js";
import { parseFilters, exportFiles } from "./event-export-contract.js";
export function registerEventExportRoutes(
  app: Express,
  pool: Pool,
  service = new EventExportService(pool),
) {
  app.get("/api/research/event-exports/catalog", (_req, res) => {
    if (principalOf(res).role !== "researcher")
      return res.status(403).json({ error: "forbidden" });
    return res.json({ eventTypes: Object.keys(eventTargets) });
  });
  app.get("/api/research/event-views/:exportId", async (req,res) => {
    if (principalOf(res).role !== "researcher") return res.status(403).json({error:"forbidden"});
    const offset = req.query.offset ?? "0";
    if (!isUuid(req.params.exportId) || typeof offset !== "string" || !/^(0|[1-9][0-9]{0,8})$/.test(offset) || Object.keys(req.query).some(k => !["offset","detail"].includes(k)) || (req.query.detail !== undefined && req.query.detail !== "1")) return res.status(400).json({error:"invalid_cursor"});
    try {
      const page = await service.page(req.params.exportId,Number(offset), req.query.detail === "1" ? 1 : 25);
      if (!page) return res.status(404).json({error:"snapshot_expired"});
      return res.set("Cache-Control","no-store").json({...page, events: req.query.detail === "1" ? page.events : page.events.map(event => ({...event,before:undefined,after:undefined,details:undefined}))});
    } catch { return res.status(503).json({error:"event_view_unavailable"}); }
  });
  app.post(["/api/research/event-exports", "/api/research/event-views"], async (req, res) => {
    if (principalOf(res).role !== "researcher")
      return res.status(403).json({ error: "forbidden" });
    const body = req.body,
      filters =
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        Object.keys(body).length === 1
          ? parseFilters(body.filters)
          : null;
    if (!filters) {
      const saved = await recordAudit(
        pool,
        { eventType: "RESEARCH_EXPORT" },
        "RESEARCHER",
        "REJECTED",
        "VALIDATION",
      ).catch(() => false);
      return res
        .status(400)
        .set("X-Research-Event-Saved", String(saved))
        .json({
          error: "invalid_export_filters",
          message:
            "出力条件を確認してください。日時はタイムゾーン付き、終了は開始より後にしてください。",
        });
    }
    try {
      const result = await service.create(filters, req.path.endsWith("event-views"));
      result.auditSaved = await recordAudit(
        pool,
        {
          eventType: "RESEARCH_EXPORT",
          ...(filters.sessionIds.length === 1
            ? { sessionId: filters.sessionIds[0] }
            : {}),
        },
        "RESEARCHER",
        "SUCCESS",
        undefined,
        "event-export:" + result.exportId,
      ).catch(() => false);
      return res
        .status(201)
        .set("X-Research-Event-Saved", String(result.auditSaved))
        .json(result);
    } catch (error) {
      const limited =
        error instanceof ExportLimitError ||
        !!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "57014"
        );
      const saved = await recordAudit(
        pool,
        { eventType: "RESEARCH_EXPORT" },
        "RESEARCHER",
        "FAILURE",
        "SERVER",
      ).catch(() => false);
      return res
        .status(limited ? 413 : 503)
        .set("X-Research-Event-Saved", String(saved))
        .json({
          error: limited ? "export_limit" : "event_export_unavailable",
          message: limited
            ? "一時出力の容量・時間・件数上限に達しました。条件を絞るか、前の一時出力を削除して再度お試しください。"
            : "出力を作成できませんでした。接続とシステムの状態を確認してください。",
          logSaved: saved,
        });
    }
  });
  app.get("/api/research/event-exports/:exportId/:file", async (req, res) => {
    if (principalOf(res).role !== "researcher")
      return res.status(403).json({ error: "forbidden" });
    if (!isUuid(req.params.exportId) || !exportFiles.includes(req.params.file))
      return res.status(404).json({ error: "not_found" });
    const job = service.get(req.params.exportId);
    if (!job)
      return res
        .status(404)
        .json({
          error: "export_expired_or_missing",
          message:
            "一時出力がありません。有効期限を確認して作り直してください。",
        });
    job.readers++;
    return res
      .set("Cache-Control", "no-store")
      .set("X-Research-Event-Saved", String(job.metadata.auditSaved))
      .download(
        join(job.directory, req.params.file),
        req.params.file,
        {dotfiles:"allow"},
        (error) => {
          void service.release(req.params.exportId).catch(() => undefined);
          if (error && !res.headersSent)
            res.status(404).json({ error: "export_download_failed" });
        },
      );
  });
  app.delete("/api/research/event-exports/:exportId", async (req, res) => {
    if (principalOf(res).role !== "researcher")
      return res.status(403).json({ error: "forbidden" });
    if (!isUuid(req.params.exportId) || !service.get(req.params.exportId))
      return res.status(404).json({ error: "not_found" });
    try {
      await service.delete(req.params.exportId);
      return res.json({ temporaryExportDeleted: true });
    } catch {
      return res.status(503).json({ error: "export_cleanup_failed" });
    }
  });
  return service;
}
