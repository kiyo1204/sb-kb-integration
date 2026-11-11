// TEST ONLY preload: delay the real HTTP transport, not product authorization.
import { ServerResponse } from "node:http";
import pg from "pg";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { setInterval, clearInterval } from "node:timers";
const dir = process.env.EXPERIMENT_READ_TEST_GATE_DIR;
if (!dir || process.env.STAGE1_MOCK_DATA !== "ONLY_SYNTHETIC")
  throw new Error("response_gate_requires_mock");
const original = ServerResponse.prototype.end;
ServerResponse.prototype.end = function (...args) {
  let config;
  try {
    config = JSON.parse(readFileSync(join(dir, "gate.json"), "utf8"));
  } catch {
    return Reflect.apply(original, this, args);
  }
  if (
    this.req.method !== "GET" ||
    this.req.url !== config.path ||
    this.statusCode !== 200
  )
    return Reflect.apply(original, this, args);
  writeFileSync(join(dir, "entered"), "held-before-transport");
  this.once("finish", () =>
    writeFileSync(join(dir, "finished"), "transport-finished"),
  );
  const timer = setInterval(() => {
    if (this.destroyed) {
      clearInterval(timer);
      return;
    }
    if (existsSync(join(dir, "release"))) {
      clearInterval(timer);
      Reflect.apply(original, this, args);
    }
  }, 10);
  timer.unref();
  this.once("close", () => clearInterval(timer));
  return this;
};

// Test-only SQL latency before each real product SELECT, enabled only by a
// synthetic fixture's local gate file. No product configuration/API switch.
const rawQuery = pg.Client.prototype.query;
let started = 0,
  completed = 0;
pg.Client.prototype.query = function (...args) {
  let c;
  try {
    c = JSON.parse(readFileSync(join(dir, "gate.json"), "utf8"));
  } catch {
    return Reflect.apply(rawQuery, this, args);
  }
  const sql = args[0],
    values = args[1];
  if (
    c.mode === "slow_sql" &&
    typeof sql === "string" &&
    Array.isArray(values) &&
    values[0] === c.map &&
    [
      "mapCreatedAt",
      "labelPositionX",
      "goal_link.label,",
      "source.label,",
    ].some((x) => sql.includes(x))
  ) {
    return (async () => {
      started++;
      writeFileSync(join(dir, "sql-started"), "started");
      writeFileSync(
        join(dir, "sql-trace"),
        JSON.stringify({ started, completed }),
      );
      await Reflect.apply(rawQuery, this, ["SELECT pg_sleep(9)"]);
      completed++;
      writeFileSync(
        join(dir, "sql-trace"),
        JSON.stringify({ started, completed }),
      );
      return Reflect.apply(rawQuery, this, args);
    })();
  }
  return Reflect.apply(rawQuery, this, args);
};
