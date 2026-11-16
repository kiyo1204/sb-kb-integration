import assert from "node:assert/strict";
import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
process.env.RESEARCHER_API_TOKEN ??= randomBytes(32).toString("hex");
const { configuredExperimentLearnerMode, initializeExperimentPreview, experimentLearnerEnabled, experimentLearnerMode } = await import("../experiment-execution.js");
assert.equal(configuredExperimentLearnerMode({}), "disabled");
assert.equal(configuredExperimentLearnerMode({ STAGE1_EXPERIMENT_LEARNER_ENABLED: "0" }), "disabled");
assert.equal(configuredExperimentLearnerMode({ STAGE1_EXPERIMENT_LEARNER_ENABLED: "1" }), "enabled");
assert.equal(configuredExperimentLearnerMode({ STAGE1_EXPERIMENT_LEARNER_PREVIEW: "1" }), "preview");
for (const value of ["", "true", "yes", "2", " 1"])
  for (const key of ["STAGE1_EXPERIMENT_LEARNER_ENABLED", "STAGE1_EXPERIMENT_LEARNER_PREVIEW"])
    assert.throws(() => configuredExperimentLearnerMode({ [key]: value }), /experiment_flow_invalid_configuration/);
assert.throws(() => configuredExperimentLearnerMode({ STAGE1_EXPERIMENT_LEARNER_ENABLED: "1", STAGE1_EXPERIMENT_LEARNER_PREVIEW: "1" }), /experiment_flow_conflicting_configuration/);
// Compose injects ENABLED=0 by default: only two enabled values conflict.
for (const enabled of [undefined, "0", "1"]) {
  for (const preview of [undefined, "0", "1"]) {
    const env: NodeJS.ProcessEnv = {};
    if (enabled !== undefined) env.STAGE1_EXPERIMENT_LEARNER_ENABLED = enabled;
    if (preview !== undefined) env.STAGE1_EXPERIMENT_LEARNER_PREVIEW = preview;
    if (enabled === "1" && preview === "1")
      assert.throws(() => configuredExperimentLearnerMode(env), /experiment_flow_conflicting_configuration/);
    else assert.equal(configuredExperimentLearnerMode(env), enabled === "1" ? "enabled" : preview === "1" ? "preview" : "disabled");
  }
}
const saved = { ...process.env };
try {
  delete process.env.STAGE1_EXPERIMENT_LEARNER_PREVIEW;
  delete process.env.STAGE1_EXPERIMENT_LEARNER_ENABLED;
  const unavailable = { query: async () => { throw new Error("test database unavailable"); } } as unknown as Pool;
  await initializeExperimentPreview(unavailable);
  assert.equal(experimentLearnerEnabled(), false);
  process.env.STAGE1_EXPERIMENT_LEARNER_ENABLED = "1";
  await assert.rejects(initializeExperimentPreview(unavailable), /experiment_flow_schema_unavailable/);
  assert.equal(experimentLearnerEnabled(), false);
  const missingMigration = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  await assert.rejects(initializeExperimentPreview(missingMigration), /experiment_flow_schema_unavailable/);
  assert.equal(experimentLearnerEnabled(), false);
  const schema = { query: async () => ({ rows: [], rowCount: 1 }) } as unknown as Pool;
  await initializeExperimentPreview(schema);
  assert.equal(experimentLearnerMode(), "enabled");
  process.env.STAGE1_EXPERIMENT_LEARNER_ENABLED = "0";
  process.env.STAGE1_EXPERIMENT_LEARNER_PREVIEW = "1";
  process.env.DATABASE_URL = "postgres://test:test@db/test";
  process.env.NODE_ENV = "development";
  process.env.STAGE1_MOCK_DATA = "ONLY_SYNTHETIC";
  await assert.rejects(initializeExperimentPreview(schema), /experiment_preview_requires_isolated_mock/);
  assert.equal(experimentLearnerEnabled(), false, "failed reinitialization resets capability");
  process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1/stage1_mock_config";
  for (const marker of [undefined, { purpose: "OTHER", nonce: "a".repeat(64) }, { purpose: "ONLY_SYNTHETIC", nonce: "bad" }]) {
    const invalidMarker = { query: async () => ({ rows: marker ? [marker] : [], rowCount: 1 }) } as unknown as Pool;
    await assert.rejects(initializeExperimentPreview(invalidMarker), /experiment_preview_requires_isolated_mock/);
    assert.equal(experimentLearnerEnabled(), false);
  }
  const validPreview = { query: async () => ({ rows: [{ purpose: "ONLY_SYNTHETIC", nonce: "a".repeat(64) }], rowCount: 1 }) } as unknown as Pool;
  await initializeExperimentPreview(validPreview);
  assert.equal(experimentLearnerMode(), "preview", "explicit ENABLED=0 does not block preview=1");
} finally { process.env = saved; }
console.log("Experiment flow configuration: PASS");
