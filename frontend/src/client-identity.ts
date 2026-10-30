import { sha256 } from "@noble/hashes/sha2.js";
// getRandomValues works in the existing HTTP LAN mode; no credentials are used.
export function newClientId() {
  const a = crypto.getRandomValues(new Uint8Array(16));
  a[6] = (a[6] & 15) | 64;
  a[8] = (a[8] & 63) | 128;
  const h = Array.from(a, (x) => x.toString(16).padStart(2, "0")).join("");
  return (
    h.slice(0, 8) +
    "-" +
    h.slice(8, 12) +
    "-" +
    h.slice(12, 16) +
    "-" +
    h.slice(16, 20) +
    "-" +
    h.slice(20)
  );
}
export function requestDigest(value: string) {
  return Array.from(sha256(new TextEncoder().encode(value)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
