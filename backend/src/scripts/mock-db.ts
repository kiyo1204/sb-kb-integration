import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const home = join(root, ".local", "mock-reset");
export const quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
type Manifest = {
  version: 1;
  name: string;
  containerId: string;
  nonce: string;
};
function docker(args: string[]) {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("docker_unavailable_or_request_rejected");
  }
}
function environment() {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.STAGE1_MOCK_DATA !== "ONLY_SYNTHETIC"
  )
    throw new Error("require_development_and_ONLY_SYNTHETIC");
}
export function parse(args: string[]) {
  const flags = new Map<string, string>();
  const action = args[0]?.startsWith("--") ? "plan" : (args.shift() ?? "plan");
  if (
    ![
      "create",
      "plan",
      "reset",
      "migrate",
      "seed",
      "check",
      "safety",
      "suite",
      "scale",
      "serve",
    ].includes(action)
  )
    throw new Error("unknown_action");
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (
      ![
        "--name",
        "--execute",
        "--confirm-db",
        "--confirm-plan",
        "--backup-reviewed",
        "--mock-data-only",
      ].includes(k) ||
      flags.has(k)
    )
      throw new Error("unknown_or_duplicate_option");
    if (["--execute", "--backup-reviewed", "--mock-data-only"].includes(k))
      flags.set(k, "true");
    else {
      const v = args[++i];
      if (!v || v.startsWith("--")) throw new Error("missing_option");
      flags.set(k, v);
    }
  }
  const name = flags.get("--name");
  if (!name || !/^stage1_mock_[a-z0-9_]{1,32}$/.test(name))
    throw new Error("require_stage1_mock_database_name");
  if (action !== "reset" && flags.has("--execute"))
    throw new Error("execute_only_for_reset");
  return { action, flags, name };
}
async function create(name: string, flags: Map<string, string>) {
  if (flags.get("--mock-data-only") !== "true")
    throw new Error("synthetic_attestation_required");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = join(home, name + ".json");
  try {
    await readFile(file);
    throw new Error("manifest_already_exists");
  } catch (e) {
    if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT"))
      throw e;
  }
  const nonce = randomBytes(32).toString("hex"),
    password = randomBytes(32).toString("hex");
  const id = docker([
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    "stage1.purpose=isolated-mock-reset",
    "--label",
    "stage1.nonce=" + nonce,
    "-e",
    "POSTGRES_DB=" + name,
    "-e",
    "POSTGRES_USER=stage1mock",
    "-e",
    "POSTGRES_PASSWORD=" + password,
    "-p",
    "127.0.0.1::5432",
    "postgres:17-alpine",
  ]);
  const manifest: Manifest = { version: 1, name, containerId: id, nonce };
  await writeFile(file, JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  for (let i = 0; i < 40; i++) {
    try {
      docker(["exec", id, "pg_isready", "-U", "stage1mock", "-d", name]);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const { pool } = connect(manifest);
  try {
    await pool.query(
      `CREATE SCHEMA stage1_mock_guard;CREATE TABLE stage1_mock_guard.marker(singleton boolean PRIMARY KEY CHECK(singleton),purpose text NOT NULL,nonce text NOT NULL,system_identifier text NOT NULL);`,
    );
    await pool.query(
      "INSERT INTO stage1_mock_guard.marker SELECT true,'ONLY_SYNTHETIC',$1,system_identifier::text FROM pg_control_system()",
      [nonce],
    );
  } finally {
    await pool.end();
  }
  console.log(
    JSON.stringify({
      created: name,
      containerId: id,
      environment: "development / ONLY_SYNTHETIC",
      next: "migrate, seed, plan; no existing DATABASE_URL was used",
    }),
  );
}
function connect(m: Manifest) {
  if (
    m.version !== 1 ||
    !/^stage1_mock_[a-z0-9_]{1,32}$/.test(m.name) ||
    !/^[a-f0-9]{64}$/.test(m.containerId) ||
    !/^[a-f0-9]{64}$/.test(m.nonce)
  )
    throw new Error("invalid_manifest");
  const inspected = JSON.parse(docker(["inspect", m.containerId]))[0];
  const labels = inspected.Config.Labels;
  const ports = inspected.NetworkSettings.Ports?.["5432/tcp"];
  if (
    inspected.Id !== m.containerId ||
    inspected.Name !== "/" + m.name ||
    !inspected.State.Running ||
    labels?.["stage1.purpose"] !== "isolated-mock-reset" ||
    labels?.["stage1.nonce"] !== m.nonce ||
    inspected.HostConfig.Binds?.length ||
    !Array.isArray(ports) ||
    ports.length !== 1 ||
    ports[0].HostIp !== "127.0.0.1" ||
    !/^[0-9]+$/.test(ports[0].HostPort)
  )
    throw new Error("not_dedicated_loopback_mock_container");
  const env = inspected.Config.Env as string[];
  const find = (key: string) =>
    env.find((s) => s.startsWith(key + "="))?.slice(key.length + 1);
  if (find("POSTGRES_DB") !== m.name || find("POSTGRES_USER") !== "stage1mock")
    throw new Error("container_database_mismatch");
  const password = find("POSTGRES_PASSWORD");
  if (!password || !/^[a-f0-9]{64}$/.test(password))
    throw new Error("unexpected_mock_credentials");
  const url = `postgres://stage1mock:${password}@127.0.0.1:${ports[0].HostPort}/${m.name}`;
  return {
    pool: new Pool({
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: 5000,
    }),
    url,
    password,
  };
}
export function verificationReportPath(kind:"suite-results"|"scale-results"|"invariants"){
 const prefix=process.env.RESEARCH_CHECK_REPORT_PREFIX??"issue13";
 if(!/^[a-z0-9-]{1,50}$/.test(prefix))throw new Error("invalid_verification_report_prefix");
 return join(root,"docs",prefix+"-"+kind+".json");
}
export async function verifyMockTestUrl(url:string){
 const parsed=new URL(url);const name=parsed.pathname.slice(1);
 if(!/^stage1_mock_[a-z0-9_]{1,32}$/.test(name)||parsed.hostname!=="127.0.0.1")throw new Error("not_mock_test_database");
 const m=JSON.parse(await readFile(join(home,name+".json"),"utf8")) as Manifest;
 const actual=connect(m);try{if(actual.url!==url)throw new Error("mock_test_url_mismatch");const c=await actual.pool.connect();try{await guard(c,m);}finally{c.release();}}finally{await actual.pool.end();}
}
async function guard(c: PoolClient, m: Manifest) {
  const x = (
    await c.query(
      "SELECT current_database() db,current_user role,g.purpose,g.nonce,g.system_identifier,(SELECT system_identifier::text FROM pg_control_system()) actual FROM stage1_mock_guard.marker g WHERE singleton",
    )
  ).rows;
  if (
    x.length !== 1 ||
    x[0].db !== m.name ||
    x[0].role !== "stage1mock" ||
    x[0].purpose !== "ONLY_SYNTHETIC" ||
    x[0].nonce !== m.nonce ||
    x[0].system_identifier !== x[0].actual
  )
    throw new Error("database_guard_mismatch");
  const schemas = (
    await c.query(
      "SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN('information_schema','public','research_identity','stage1_mock_guard')",
    )
  ).rows;
  if (schemas.length) throw new Error("unexpected_database_schema");
}
async function tables(c: PoolClient) {
  const rows = (
    await c.query(
      "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN('public','research_identity') AND tablename<>'pgmigrations' ORDER BY schemaname,tablename",
    )
  ).rows;
  return rows.map((x) => quote(x.schemaname) + "." + quote(x.tablename));
}
async function snapshot(c: PoolClient, m: Manifest) {
  const counts: Record<string, number> = {},
    fingerprints: string[] = [];
  for (const t of await tables(c)) {
    const x = (
      await c.query(
        `SELECT count(*)::int n,md5(coalesce(string_agg(md5(to_jsonb(x)::text),',' ORDER BY md5(to_jsonb(x)::text)),'')) fingerprint FROM ${t} x`,
      )
    ).rows[0];
    counts[t] = x.n;
    fingerprints.push(t + ":" + x.fingerprint);
  }
  return {
    database: m.name,
    environment: "development / ONLY_SYNTHETIC",
    counts,
    planHash: digest([m.containerId, m.nonce, counts, fingerprints]),
    warning:
      "IRREVERSIBLE mock data reset. Stop API, review a backup, and copy this plan hash. No log conversion.",
  };
}
function child(script: string, url: string, password: string) {
  const token =
    script === "serve"
      ? process.env.RESEARCHER_API_TOKEN
      : "mock-only-" +
        createHash("sha256")
          .update(password + ":researcher")
          .digest("hex");
  if (!token || !token.startsWith("mock-only-") || token.length < 32)
    throw new Error("require_local_mock_researcher_code");
  const scripts: Record<string, string> = {
    migrate: "db:migrate",
    seed: "db:seed:dev",
    check: "test:mock-reset-new-stream",
    safety: "test:mock-reset-safety",
    suite: "test:research-event-suite",
    scale: "test:event-scale",
    serve: "dev",
  };
  const npmCli =
    process.env.npm_execpath ??
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const result = spawnSync(
    process.execPath,
    [
      npmCli,
      "run",
      scripts[script],
      ...(script === "migrate" ? ["--", "up"] : []),
    ],
    {
      cwd: join(root, "backend"),
      env: {
        ...process.env,
        DATABASE_URL: url,
        RESEARCHER_API_TOKEN: token,
        API_BIND_ADDRESS: "127.0.0.1",
        STAGE1_EXPORT_CACHE_ROOT: join(
          home,
          new URL(url).pathname.slice(1),
          "exports",
        ),
      },
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    console.error(JSON.stringify({mockChildStatus:result.status,signal:result.signal,spawnFailed:!!result.error}));
    throw new Error("mock_child_failed");
  }
}
export async function main(args: string[]) {
  environment();
  const { action, flags, name } = parse([...args]);
  if (process.env.DATABASE_URL)
    throw new Error("unset_DATABASE_URL_existing_targets_are_not_supported");
  if (action === "create") return create(name, flags);
  const manifest = JSON.parse(
    await readFile(join(home, name + ".json"), "utf8"),
  ) as Manifest;
  if (manifest.name !== name) throw new Error("manifest_name_mismatch");
  const { pool, url, password } = connect(manifest);
  const c = await pool.connect();
  let released = false;
  try {
    await guard(c, manifest);
    if (["migrate", "seed", "check", "safety", "suite", "scale", "serve"].includes(action)) {
      c.release();
      released = true;
      await pool.end();
      child(action, url, password);
      return;
    }
    await c.query("BEGIN");
    await c.query(
      "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s'",
    );
    if (action === "reset" && flags.has("--execute")) {
      if (
        flags.get("--confirm-db") !== name ||
        !flags.has("--backup-reviewed") ||
        !flags.has("--mock-data-only") ||
        !flags.has("--confirm-plan")
      )
        throw new Error("require_confirm_db_plan_backup_and_mock_attestation");
      const other = (
        await c.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
        )
      ).rows[0].n;
      if (other)
        throw new Error("stop_all_other_database_clients_before_reset");
      const ts = await tables(c);
      if (!ts.length) throw new Error("migrate_before_reset");
      await c.query("LOCK TABLE " + ts.join(",") + " IN ACCESS EXCLUSIVE MODE");
      const plan = await snapshot(c, manifest);
      console.log(
        JSON.stringify({ ...plan, mode: "EXECUTION_PRECHECK" }, null, 2),
      );
      if (plan.planHash !== flags.get("--confirm-plan"))
        throw new Error("plan_changed_run_dry_run_again");
      await guard(c, manifest);
      await connect(manifest).pool.end();
      await c.query("TRUNCATE TABLE " + ts.join(",") + " RESTART IDENTITY");
      if (ts.includes('"public"."research_studies"'))
        await c.query(
          "INSERT INTO research_studies(id) VALUES('11111111-1111-4111-8111-111111111119')",
        );
      const cache = join(home, name, "exports");
      const info = await lstat(cache).catch(() => null);
      if (info?.isSymbolicLink()) throw new Error("unsafe_mock_cache");
      if (info) {
        const realCache = await realpath(cache),
          realRoot = await realpath(root);
        const expected = join(
          realRoot,
          ".local",
          "mock-reset",
          name,
          "exports",
        );
        if (
          realCache.toLowerCase() !== expected.toLowerCase() ||
          basename(realCache) !== "exports"
        )
          throw new Error("unsafe_mock_cache");
        await rm(realCache, { recursive: true });
      }
      await c.query("COMMIT");
      console.log(
        JSON.stringify({
          reset: name,
          convertedLegacyLogs: false,
          next: "seed, check; use serve only for mock development",
        }),
      );
    } else {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      console.log(
        JSON.stringify(
          { ...(await snapshot(c, manifest)), mode: "DRY_RUN" },
          null,
          2,
        ),
      );
      await c.query("ROLLBACK");
    }
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    if (!released) {
      c.release();
      await pool.end();
    }
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((e) => {
    const allowed = [
      "docker_unavailable_or_request_rejected",
      "require_development_and_ONLY_SYNTHETIC",
      "unknown_action",
      "unknown_or_duplicate_option",
      "missing_option",
      "require_stage1_mock_database_name",
      "execute_only_for_reset",
      "synthetic_attestation_required",
      "manifest_already_exists",
      "invalid_manifest",
      "not_dedicated_loopback_mock_container",
      "container_database_mismatch",
      "unexpected_mock_credentials",
      "database_guard_mismatch",
      "unexpected_database_schema",
      "mock_child_failed",
      "unset_DATABASE_URL_existing_targets_are_not_supported",
      "manifest_name_mismatch",
      "require_confirm_db_plan_backup_and_mock_attestation",
      "stop_all_other_database_clients_before_reset",
      "migrate_before_reset",
      "plan_changed_run_dry_run_again",
    ];
    console.error(
      allowed.includes(e?.message)
        ? e.message
        : "mock_reset_refused_or_failed_no_credentials_printed",
    );
    process.exitCode = 1;
  });
