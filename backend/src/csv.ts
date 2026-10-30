/** RFC 4180 cells; text that spreadsheet software may execute is explicitly text. */
export function csvCell(value: unknown): string {
  const text =
    value == null
      ? ""
      : value instanceof Date
        ? value.toISOString()
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
  const dangerous =
    typeof value !== "number" &&
    (/^[\s\p{Cf}\p{Cc}]*[=+\-@＝＋－＠]/u.test(text) || /^[\t\r\n]/.test(text));
  return '"' + (dangerous ? "'" : "") + text.replaceAll('"', '""') + '"';
}
export function csvLine(
  row: Record<string, unknown>,
  columns: readonly string[],
) {
  return columns.map((k) => csvCell(row[k])).join(",") + "\r\n";
}
