// Loaded only by verify-map-failure-retry in a dedicated child process, never by the app.
import { Pool } from "pg";
import { verifyMockTestUrl } from "../mock-db.js";
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const original = Pool.prototype.connect;
Pool.prototype.connect = function (
  this: Pool,
  ...args: Parameters<typeof original>
) {
  if (new Error().stack?.includes("respondToMapFailure")) {
    process.stdout.write("MOCK_MAP_LOG_CONNECTION_REJECTED\n");
    return Promise.reject(
      new Error("MOCK_PRIVATE_CONNECTION_PASSWORD_DO_NOT_EXPOSE"),
    );
  }
  return Reflect.apply(original, this, args);
} as typeof original;
