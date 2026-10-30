export function safeServerErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && ["23503", "23505", "23514", "40001", "40P01", "ECONNREFUSED", "ECONNRESET"].includes(code) ? code : "SERVER";
}

