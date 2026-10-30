import assert from "node:assert/strict";
import { safeServerErrorCode } from "../safe-server-error.js";
assert.equal(safeServerErrorCode(new Error("Bearer private-token exception")), "SERVER");
assert.equal(safeServerErrorCode({ code: "23505", detail: "Cookie: private", message: "private exception" }), "23505");
assert.equal(safeServerErrorCode({ code: "password=private" }), "SERVER");
assert.equal(safeServerErrorCode(null), "SERVER");
console.log("Server exception output allowlist: OK");

