/** Plain-text table with left-aligned columns; numbers are right-aligned. */
export function table(headers: string[], rows: (string | number)[][]): string {
  const cells = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, col) => Math.max(...cells.map((r) => (r[col] ?? "").length)));
  const numeric = headers.map(
    (_, col) => rows.length > 0 && rows.every((r) => typeof r[col] === "number"),
  );
  const line = (row: string[]): string =>
    row
      .map((cell, col) => {
        const width = widths[col] ?? 0;
        return numeric[col] ? cell.padStart(width) : cell.padEnd(width);
      })
      .join("  ")
      .trimEnd();
  return [
    line(headers),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map((r) => line(r.map(String))),
  ].join("\n");
}

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

export const percent = (part: number, whole: number): string =>
  whole === 0 ? "0%" : `${Math.round((100 * part) / whole)}%`;
