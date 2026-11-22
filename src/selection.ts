/**
 * Parses page ranges like "3-12, 15, 20-" (1-based, inclusive; an open end runs to the
 * last page) into 0-based page indexes. Returns null if the text doesn't make sense.
 */
export function parseRange(text: string, count: number): number[] | null {
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const out = new Set<number>();
  for (const part of parts) {
    const m = part.match(/^(\d*)\s*[-–—]\s*(\d*)$|^(\d+)$/);
    if (!m) return null;
    const from = m[3] ? Number(m[3]) : m[1] ? Number(m[1]) : 1;
    const to = m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : count;
    if (from < 1 || to < from) return null;
    for (let n = from; n <= Math.min(to, count); n++) out.add(n - 1);
  }
  return [...out].sort((a, b) => a - b);
}

/** Describes indexes as page numbers, joining runs: [2, 3, 4, 9] → "3–5, 10". */
export function describe(indexes: number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < indexes.length; ) {
    let j = i;
    while (j + 1 < indexes.length && indexes[j + 1] === indexes[j] + 1) j++;
    runs.push(i === j ? `${indexes[i] + 1}` : `${indexes[i] + 1}–${indexes[j] + 1}`);
    i = j + 1;
  }
  return runs.join(", ");
}

/** Every index from the first selected to the last, or null for fewer than two selected. */
export function span(selected: number[]): number[] | null {
  if (selected.length < 2) return null;
  const lo = Math.min(...selected);
  const hi = Math.max(...selected);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** Odd or even page numbers (counting from 1, as shown) among `indexes`. */
export const byParity = (indexes: number[], parity: "odd" | "even") =>
  indexes.filter((i) => (i + 1) % 2 === (parity === "odd" ? 1 : 0));
