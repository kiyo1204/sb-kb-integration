import { checkResearchConnectionFailure } from "./experiment-research-failure-checks.js";
await checkResearchConnectionFailure();
process.env.EXPERIMENT_RESEARCH_CHECKS = "1";
await import("./verify-experiment-learner.js");
