import {
  mkdir,
  readdir,
  stat,
  rm,
  open,
  utimes,
  type FileHandle,
} from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { Pool } from "pg";
import { csvLine } from "./csv.js";
import {
  EXPORT_VERSION,
  commonColumns,
  detailColumns,
  csvRows,
  type ExportFilters,
  type ExportEvent,
  exportFiles,
} from "./event-export-contract.js";
import {
  extractionQuery,
  normaliseEvent,
  type RawExportRow,
} from "./event-export-query.js";
import { dataDictionary } from "./event-export-dictionary.js";
export class ExportLimitError extends Error {}
export type ExportMetadata = {
  exportId: string;
  exportSchemaVersion: number;
  snapshotAt: string;
  expiresAt: string;
  eventCount: number;
  filters: ExportFilters;
  files: { name: string; rows: number | null; bytes: number }[];
  payloadWarnings: number;
  boundaryWarnings: number;
  auditSaved: boolean | null;
};
type Job = {
  directory: string;
  metadata: ExportMetadata;
  ready: boolean;
  readers: number;
  deleting: boolean;
  offsets: number[];
  sessionIds: Set<string>;
};
export class EventExportService {
  readonly jobs = new Map<string, Job>();
  readonly root: string;
  readonly ttlMs: number;
  readonly maxBytes: number;
  readonly maxJobs: number;
  private readonly timer: NodeJS.Timeout;
  constructor(
    private readonly pool: Pool,
    options: {
      root?: string;
      ttlMs?: number;
      maxBytes?: number;
      maxJobs?: number;
    } = {},
  ) {
    this.root = resolve(
      options.root ?? join(tmpdir(), "stage1-event-export-cache"),
    );
    this.ttlMs = options.ttlMs ?? 15 * 60000;
    this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    this.maxJobs = options.maxJobs ?? 4;
    this.timer = setInterval(
      () => void this.sweep().catch(() => undefined),
      60000,
    );
    this.timer.unref();
  }
  private async removeDirectory(path: string) {
    if (dirname(path) !== this.root || !/^[a-f0-9-]{36}$/i.test(basename(path)))
      throw new Error("invalid_export_directory");
    await rm(path, { recursive: true, force: true });
  }
  async sweep() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const [id, job] of this.jobs)
      if (job.ready && Date.parse(job.metadata.expiresAt) <= Date.now())
        await this.delete(id);
    for (const entry of await readdir(this.root, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        /^[a-f0-9-]{36}$/i.test(entry.name) &&
        !this.jobs.has(entry.name)
      ) {
        const path = join(this.root, entry.name);
        const info = await stat(path).catch(() => null);
        if (info && Date.now() - info.mtimeMs > this.ttlMs + 5 * 60000)
          await this.removeDirectory(path);
      }
  }
  async create(filters: ExportFilters, chronological = false) {
    await this.sweep();
    if (this.jobs.size >= this.maxJobs) throw new ExportLimitError("capacity");
    const id = randomUUID(),
      directory = join(this.root, id);
    const metadata: ExportMetadata = {
      exportId: id,
      exportSchemaVersion: EXPORT_VERSION,
      snapshotAt: "",
      expiresAt: "",
      eventCount: 0,
      filters,
      files: [],
      payloadWarnings: 0,
      boundaryWarnings: 0,
      auditSaved: null,
    };
    const job: Job = {
      directory,
      metadata,
      ready: false,
      readers: 0,
      deleting: false,
      offsets: [],
      sessionIds: new Set(filters.sessionIds),
    };
    this.jobs.set(id, job);
    const handles = new Map<string, FileHandle>(),
      sizes = new Map<string, number>(),
      rows: Record<string, number> = {},
      started = Date.now();
    let totalBytes = 0;
    const write = async (name: string, text: string) => {
      const bytes = Buffer.byteLength(text);
      if (totalBytes + bytes > this.maxBytes)
        throw new ExportLimitError("bytes");
      totalBytes += bytes;
      sizes.set(name, (sizes.get(name) ?? 0) + bytes);
      await handles.get(name)!.writeFile(text);
    };
    const client = await this.pool.connect().catch(async (error) => {
      this.jobs.delete(id);
      await this.removeDirectory(directory);
      throw error;
    });
    let transaction = false, identityLock = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      for (const name of [...exportFiles.filter((x) => x !== "bundle.zip"), "view.ndjson"]) {
        handles.set(name, await open(join(directory, name), "wx", 0o600));
      }
      await client.query("SELECT pg_advisory_lock_shared(111011)");
      identityLock = true;
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      transaction = true;

      await client.query("SET LOCAL statement_timeout='30s'");
      metadata.snapshotAt = (
        await client.query("SELECT transaction_timestamp() AS time")
      ).rows[0].time.toISOString();
      const query = extractionQuery(filters, chronological);
      await client.query(
        "DECLARE export_events NO SCROLL CURSOR FOR " + query.text,
        query.values,
      );
      await write(
        "events.json",
        JSON.stringify({
          export_schema_version: EXPORT_VERSION,
          export_id: id,
          snapshot_at: metadata.snapshotAt,
          filters,
        }).slice(0, -1) + ',"events":[',
      );
      for (const [name, cols] of Object.entries({
        "events.csv": commonColumns,
        ...detailColumns,
      })) {
        rows[name] = 0;
        await write(name, "\uFEFF" + cols.join(",") + "\r\n");
      }
      for (;;) {
        if (Date.now() - started > 120000) throw new ExportLimitError("time");
        const batch = await client.query<RawExportRow>(
          "FETCH FORWARD 2 FROM export_events",
        );
        if (!batch.rowCount) break;
        for (const raw of batch.rows) {
          const event = await normaliseEvent(raw, client);
          if (event.session_id) job.sessionIds.add(event.session_id);
          await write(
            "events.json",
            (metadata.eventCount ? "," : "") + JSON.stringify(event),
          );
          job.offsets.push(sizes.get("view.ndjson") ?? 0);
          await write("view.ndjson", JSON.stringify(event) + "\n");
          metadata.eventCount++;
          if (!["EXPORTED", "NO_PAYLOAD"].includes(event.payload_status))
            metadata.payloadWarnings++;
          if (
            ["INVALID_AFTER_BOUNDARY", "MISSING_BOUNDARY"].includes(
              event.boundary_status,
            )
          )
            metadata.boundaryWarnings++;
          for (const [name, row] of Object.entries(csvRows(event))) {
            await write(
              name,
              csvLine(
                row,
                name === "events.csv"
                  ? commonColumns
                  : detailColumns[name as keyof typeof detailColumns],
              ),
            );
            rows[name]++;
          }
        }
      }
      await client.query("CLOSE export_events");
      await client.query("COMMIT");
      transaction = false;
      await write(
        "events.json",
        '],"event_count":' +
          metadata.eventCount +
          ',"payload_warning_count":' +
          metadata.payloadWarnings +
          ',"boundary_warning_count":' +
          metadata.boundaryWarnings +
          "}\n",
      );
      await write("data-dictionary.md", dataDictionary(chronological));
      metadata.expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
      metadata.files = [...sizes].filter(([name]) => name !== "view.ndjson").map(([name, bytes]) => ({
        name,
        bytes,
        rows:
          name === "events.json" ? metadata.eventCount : (rows[name] ?? null),
      }));
      await write("manifest.json", JSON.stringify(metadata, null, 2) + "\n");
      for (const handle of handles.values()) await handle.close();
      handles.clear();
      const zip = new ZipFile();
      zip.on("error", (error) => (zip.outputStream as Readable).destroy(error));
      for (const name of exportFiles.filter((x) => x !== "bundle.zip"))
        zip.addFile(join(directory, name), name, {
          mtime: new Date(metadata.snapshotAt),
        });
      const zipped = pipeline(
        zip.outputStream as Readable,
        createWriteStream(join(directory, "bundle.zip"), {
          flags: "wx",
          mode: 0o600,
        }),
        {
          signal: AbortSignal.timeout(
            Math.max(1, 120000 - (Date.now() - started)),
          ),
        },
      );
      zip.end();
      await zipped;
      const archiveBytes = (await stat(join(directory, "bundle.zip"))).size;
      if (archiveBytes > this.maxBytes)
        throw new ExportLimitError("archive_bytes");
      metadata.files.push(
        {
          name: "manifest.json",
          bytes: sizes.get("manifest.json")!,
          rows: null,
        },
        { name: "bundle.zip", bytes: archiveBytes, rows: null },
      );
      await utimes(directory, new Date(), new Date());
      if (job.deleting) throw new Error("export_invalidated");
      job.ready = true;
      return metadata;
    } catch (error) {
      if (transaction) await client.query("ROLLBACK").catch(() => undefined);
      for (const handle of handles.values())
        await handle.close().catch(() => undefined);
      this.jobs.delete(id);
      await this.removeDirectory(directory);
      throw error;
    } finally {
      if(identityLock) await client.query("SELECT pg_advisory_unlock_shared(111011)");
      client.release();
    }
  }
  get(id: string) {
    const job = this.jobs.get(id);
    if (
      !job?.ready ||
      job.deleting ||
      Date.parse(job.metadata.expiresAt) <= Date.now()
    )
      return null;
    return job;
  }
  async page(id: string, offset: number, limit = 25) {
    const job = this.get(id);
    if (!job) return null;
    job.readers++;
    let handle: FileHandle | undefined;
    try {
      handle = await open(join(job.directory, "view.ndjson"), "r");
      const events: ExportEvent[] = [];
      for (let i=offset; i<Math.min(offset+limit,job.offsets.length); i++) {
        const end = job.offsets[i+1] ?? (await handle.stat()).size;
        const buffer = Buffer.alloc(end-job.offsets[i]);
        await handle.read(buffer,0,buffer.length,job.offsets[i]);
        events.push(JSON.parse(buffer.toString("utf8")) as ExportEvent);
      }
      return {events, next: offset+events.length<job.offsets.length ? offset+events.length : null};
    } finally { await handle?.close(); await this.release(id); }
  }
  async invalidateSessions(ids: string[]) {
    for (const [id,job] of this.jobs) if (ids.some(s=>job.sessionIds.has(s))) await this.delete(id);
    // Files left by a previous process are inaccessible by API but still contain data.
    await mkdir(this.root,{recursive:true,mode:0o700});
    for(const entry of await readdir(this.root,{withFileTypes:true})) {
      if(!entry.isDirectory()||entry.isSymbolicLink()||!/^[a-f0-9-]{36}$/i.test(entry.name)||this.jobs.has(entry.name))continue;
      const path=join(this.root,entry.name);
      const input=createReadStream(join(path,"events.json"),{encoding:"utf8"});
      let tail="",found=false;
      try{for await(const chunk of input){const text=tail+String(chunk).toLowerCase();if(ids.some(id=>text.includes(id.toLowerCase()))){found=true;break;}tail=text.slice(-64);}}finally{input.destroy();}
      if(found)await this.removeDirectory(path);
    }
  }
  async delete(id: string) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.deleting = true;
    if (!job.readers) {
      await this.removeDirectory(job.directory);
      this.jobs.delete(id);
    }
    return true;
  }
  async release(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.readers--;
    if (job.deleting && !job.readers) await this.delete(id);
  }
  async dispose() {
    clearInterval(this.timer);
    for (const id of this.jobs.keys()) await this.delete(id);
  }
}
