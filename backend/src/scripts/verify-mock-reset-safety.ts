import {verifyMockTestUrl} from "./mock-db.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
const url = process.env.DATABASE_URL!;
const match =
  /^postgres:\/\/stage1mock:[a-f0-9]{64}@127\.0\.0\.1:[0-9]+\/(stage1_mock_[a-z0-9_]+)$/.exec(
    url,
  );
assert.ok(match);
const name = match[1];
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool = new Pool({ connectionString: url });
const env = { ...process.env };
delete env.DATABASE_URL;
function cli(args: string[], extra: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/scripts/mock-db.ts", ...args, "--name", name],
    { env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 },
  );
}
try {
  assert.notEqual(cli(["plan"], { NODE_ENV: "production" }).status, 0);
  assert.notEqual(cli(["plan"], { STAGE1_MOCK_DATA: "UNKNOWN" }).status, 0);
  assert.notEqual(
    cli(["plan"], { DATABASE_URL: "postgres://never-connect.invalid/existing" })
      .status,
    0,
  );
  const plan = cli(["plan"]);
  assert.equal(plan.status, 0, plan.stderr);
  const before = JSON.parse(plan.stdout);
  assert.equal(before.mode, "DRY_RUN");
  assert.equal(
    JSON.parse(cli(["reset"]).stdout).planHash,
    before.planHash,
    "reset without execute must not change data",
  );
  assert.notEqual(cli(["reset", "--execute"]).status, 0);
  assert.notEqual(
    cli([
      "reset",
      "--execute",
      "--confirm-db",
      "some_other_db",
      "--backup-reviewed",
      "--mock-data-only",
      "--confirm-plan",
      before.planHash,
    ]).status,
    0,
  );
  assert.notEqual(
    cli([
      "reset",
      "--execute",
      "--confirm-db",
      name,
      "--backup-reviewed",
      "--mock-data-only",
      "--confirm-plan",
      "bad",
    ]).status,
    0,
  );
  await pool.query("UPDATE stage1_mock_guard.marker SET purpose='REAL_DATA'");
  assert.notEqual(cli(["plan"]).status, 0);
  await pool.query(
    "UPDATE stage1_mock_guard.marker SET purpose='ONLY_SYNTHETIC'",
  );
  const current = await pool.connect();
  try {
    assert.notEqual(
      cli([
        "reset",
        "--execute",
        "--confirm-db",
        name,
        "--backup-reviewed",
        "--mock-data-only",
        "--confirm-plan",
        before.planHash,
      ]).status,
      0,
      "Other DB clients block reset",
    );
  } finally {
    current.release();
  }
  assert.equal(
    JSON.parse(cli(["plan"]).stdout).planHash,
    before.planHash,
    "Rejected reset must preserve data",
  );
  // Old-format fixtures exist only in this dedicated DB; reset never converts them.
  await pool.query("INSERT INTO maps(type) VALUES('PRIOR')");
  const id = (
    await pool.query(
      "SELECT id FROM maps WHERE type='PRIOR' ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO map_operation_logs(map_id,operation_type,target_type,target_id,sequence_number) VALUES($1,'MAP_SAVE','MAP',$1,1)",
    [id],
  );
  const stale = cli([
    "reset",
    "--execute",
    "--confirm-db",
    name,
    "--backup-reviewed",
    "--mock-data-only",
    "--confirm-plan",
    before.planHash,
  ]);
  assert.notEqual(stale.status, 0);
} finally {
  await pool.end();
}
assert.notEqual(
  cli([
    "reset",
    "--execute",
    "--confirm-db",
    name,
    "--backup-reviewed",
    "--mock-data-only",
    "--confirm-plan",
    JSON.parse(cli(["plan"]).stdout).planHash + "stale",
  ]).status,
  0,
);
const fresh = JSON.parse(cli(["plan"]).stdout);
assert.ok(fresh.counts['"public"."map_operation_logs"'] > 0);
const run = cli([
  "reset",
  "--execute",
  "--confirm-db",
  name,
  "--backup-reviewed",
  "--mock-data-only",
  "--confirm-plan",
  fresh.planHash,
]);
assert.equal(run.status, 0, run.stderr);
assert.ok(run.stdout.includes('"convertedLegacyLogs":false'));
const empty = JSON.parse(cli(["plan"]).stdout);
for (const [table, count] of Object.entries(empty.counts))
  assert.equal(count, table === '"public"."research_studies"' ? 1 : 0, table);
console.log(
  "Mock reset protection: production/unknown/URL/confirmation/marker/active client/stale plan refused; dry run preserved data; explicit isolated reset cleared old/new/dependencies without conversion: PASS",
);
