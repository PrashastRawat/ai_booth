/**
 * Short display form of a visitor count. Values are truncated, never rounded up, so the
 * display never suggests more visitors than the exact count:
 *   999 -> "999", 1,000 -> "1K", 1,250 -> "1.2K", 12,486 -> "12.4K", 125,000 -> "125K",
 *   1,250,000 -> "1.25M".
 * Display only: keep and compute with the exact integer.
 */
export function formatVisitors(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const n = Math.max(0, Math.trunc(value));
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const tenths = Math.floor(n / 100); // thousands, one decimal, truncated
    return `${trimZero(Math.floor(tenths / 10), tenths % 10, 1)}K`;
  }
  const hundredths = Math.floor(n / 10_000); // millions, two decimals, truncated
  return `${trimZero(Math.floor(hundredths / 100), hundredths % 100, 2)}M`;
}

function trimZero(whole: number, fraction: number, digits: number): string {
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(digits, "0").replace(/0+$/, "")}`;
}
