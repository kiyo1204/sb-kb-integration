import { openObservationStreamV3 } from "./observation-stream-v3";

// Entry point for a v3-compatible recovery build. Opening it never upgrades a database.
export function openObservationPreservation() {
  return openObservationStreamV3("preserve");
}
