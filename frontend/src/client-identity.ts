import { sha256 } from "@noble/hashes/sha2.js";
export class SecureRandomUnavailableError extends Error {
  constructor() {
    super(
      "安全な乱数を生成できないため、保存要求を送信していません。ブラウザーの対応状況を確認してください。",
    );
    this.name = "SecureRandomUnavailableError";
  }
}
// IDs only: authentication codes and secrets use their existing generators.
export function newClientId() {
  const source = globalThis.crypto;
  try {
    if (typeof source?.randomUUID === "function") return source.randomUUID();
    if (typeof source?.getRandomValues !== "function")
      throw new SecureRandomUnavailableError();
    const a = source.getRandomValues(new Uint8Array(16));
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
  } catch {
    throw new SecureRandomUnavailableError();
  }
}
export function requestDigest(value: string) {
  return Array.from(sha256(new TextEncoder().encode(value)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
