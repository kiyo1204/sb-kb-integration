// TEST ONLY: existing guarded synthetic DB verifier; no production target.
process.env.VERIFY_EXPERIMENT_ENABLED = "1";
process.env.EXPERIMENT_RESEARCH_CHECKS = "1";
await import("./verify-experiment-learner.js");
