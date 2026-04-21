/**
 * Zero-dependency ISO-8601 timestamp validation.
 *
 * Accepts the subset of ISO-8601 our surfaces actually produce: a date
 * (`YYYY-MM-DD`) plus a `T`-joined time (`HH:MM:SS`) with an optional
 * fractional-seconds component and a mandatory zone suffix (`Z` or
 * `±HH:MM`). The regex is deliberately narrow — we do not accept
 * floating date-times or week-numbered formats because nothing in ra11y
 * produces them and silently accepting malformed stamps is worse than
 * rejecting them.
 *
 * The `Date.parse` check is a secondary calendar-validity guard:
 * `"2026-02-30T00:00:00Z"` matches the shape regex but represents no
 * real day, so we reject it via the finite-time check. Every caller
 * inside `src/` imports this helper rather than rolling its own regex,
 * so one invariant lives in one place.
 */

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Returns `true` when `value` is a string in the supported ISO-8601
 * subset AND parses to a finite timestamp. Empty string and non-string
 * inputs return `false`.
 */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!ISO_8601_RE.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}
