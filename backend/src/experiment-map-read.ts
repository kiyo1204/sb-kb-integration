import type { Request, Response } from "express";
import { Client, type Pool, type PoolClient } from "pg";
import { principalOf } from "./access-control.js";
import { experimentPreviewEnabled } from "./experiment-execution.js";
import {
  lockCurrentExperimentClient,
  ParticipantAccessError,
} from "./experiment-participant-access.js";

class MapReadStopped extends Error {
  constructor() {
    super("map_read_stopped");
  }
}
/** Internal limits; no HTTP caller can select them. Tests use shorter leases. */
type Limits = { timeoutMs?: number; statementMs?: number };
/** Starts at helper entry, including this helper's pool wait. Earlier auth
 * middleware is outside this lease. finish means handed to Node's transport,
 * never browser receipt or erasure of data already sent. */
export async function withExperimentMapRead(
  pool: Pool,
  req: Request,
  res: Response,
  read: (db: Pool | PoolClient) => Promise<unknown>,
  limits: Limits = {},
) {
  const actor = principalOf(res);
  if (actor.role !== "learner" || !actor.experiment) return read(pool);
  const timeoutMs = limits.timeoutMs ?? 30000,
    statementMs = limits.statementMs ?? 10000;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(statementMs) ||
    statementMs <= 0
  )
    throw new MapReadStopped();
  const deadline = performance.now() + timeoutMs;
  const signal = new AbortController();
  let client: PoolClient | undefined,
    began = false,
    released = false,
    finished = false;
  let pid: number | undefined,
    active = false,
    cancellation: Promise<void> | undefined;
  let settle!: () => void;
  const sent = new Promise<void>((r) => {
    settle = r;
  });
  const remaining = () => Math.ceil(deadline - performance.now());
  const check = () => {
    if (signal.signal.aborted || res.destroyed || remaining() <= 0) {
      stop();
      throw new MapReadStopped();
    }
  };
  const discard = () => {
    if (!client || released) return;
    released = true;
    // Never return a socket with a pending query/aborted lease to the pool.
    client.connection.stream.destroy();
    client.release(true);
  };
  const stop = () => {
    if (signal.signal.aborted) return;
    signal.abort();
    res.destroy();
    settle();
    if (!client) return;
    if (active && pid) {
      // Independent connection: cancellation cannot wait for the exhausted
      // data pool. Target stays checked out until cancellation has finished.
      cancellation = (async () => {
        const control = new Client({
          ...pool.options,
          connectionTimeoutMillis: 1000,
          query_timeout: 1000,
          statement_timeout: 1000,
        });
        control.on("error", () => {
          /* Fixed failure; no exception/credential log. */
        });
        try {
          await control.connect();
          await control.query("SELECT pg_cancel_backend($1)", [pid]);
        } catch {
          /* Remaining server statement timeout + forced disconnect are fallback. */
        } finally {
          const ended = control.end().catch(() => undefined);
          control.connection.stream.destroy();
          await ended;
          discard();
        }
      })();
      // Attach immediately, including cancellation/cleanup failures.
      cancellation = cancellation.catch(() => {
        discard();
      });
    } else discard();
  };
  const finish = () => {
    finished = true;
    settle();
  };
  const close = () => {
    if (!finished) stop();
    else settle();
  };
  res.once("finish", finish);
  res.once("close", close);
  res.once("error", stop);
  const timer = setTimeout(stop, timeoutMs);
  timer.unref();
  try {
    check();
    // A timed-out queued acquisition has no SQL to cancel. Its late callback
    // releases the unused client; public pg Pool has no queue-removal API.
    client = await new Promise<PoolClient>((resolve, reject) => {
      let settled = false;
      const abort = () => {
        if (!settled) {
          settled = true;
          reject(new MapReadStopped());
        }
      };
      signal.signal.addEventListener("abort", abort, { once: true });
      pool.connect((error, acquired) => {
        signal.signal.removeEventListener("abort", abort);
        if (settled || signal.signal.aborted) {
          acquired?.release();
          return;
        }
        settled = true;
        if (error || !acquired) reject(error ?? new MapReadStopped());
        else resolve(acquired);
      });
      if (signal.signal.aborted) abort();
    });
    client.on("error", onClientError);
    check();
    const raw = client.query.bind(client);
    const execute = async (...args: unknown[]) => {
      check();
      active = true;
      try {
        return await Reflect.apply(raw, client, args);
      } finally {
        active = false;
      }
    };
    await execute("BEGIN");
    began = true;
    await execute("SELECT set_config('statement_timeout',$1,true)", [
      String(Math.max(1, Math.min(statementMs, remaining()))),
    ]);
    pid = Number((await execute("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const query = (async (...args: unknown[]) => {
      check();
      await execute("SELECT set_config('statement_timeout',$1,true)", [
        String(Math.max(1, Math.min(statementMs, remaining()))),
      ]);
      return execute(...args);
    }) as PoolClient["query"];
    const db = new Proxy(client, {
      get(target, key) {
        if (key === "query") return query;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const run = await lockCurrentExperimentClient(
      db,
      actor.experiment,
      req.header("X-Experiment-Client"),
      Number(req.header("X-Experiment-Generation")),
    );
    if (run.state === "ENDED")
      throw new ParticipantAccessError("experiment_ended", 409);
    if (!experimentPreviewEnabled() || run.state !== "RUNNING")
      throw new ParticipantAccessError("experiment_not_running", 409);
    check();
    await read(db);
    if (!finished && !res.destroyed) await sent;
  } catch (error) {
    if (res.headersSent && !finished) stop();
    throw error;
  } finally {
    clearTimeout(timer);
    res.off("finish", finish);
    res.off("close", close);
    res.off("error", stop);
    if (cancellation) await cancellation;
    if (client && !released) {
      if (signal.signal.aborted) discard();
      else {
        const cleanupTimer = setTimeout(
          discard,
          Math.max(1, Math.min(1000, remaining())),
        );
        cleanupTimer.unref();
        try {
          if (began) await client.query("ROLLBACK");
        } catch {
          discard();
        } finally {
          clearTimeout(cleanupTimer);
        }
        if (!released) {
          released = true;
          client.release();
        }
      }
    }
    if (client && !signal.signal.aborted) client.off("error", onClientError);
  }
  function onClientError() {
    stop();
  }
}
