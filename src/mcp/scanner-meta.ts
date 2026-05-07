/**
 * Shared meta-block + warnings shape for tools that run the scanner.
 *
 * Every MCP tool whose handler invokes `runScan` (directly or via the
 * scan-family helpers) ships a `meta` block carrying the same load-
 * bearing scan-confidence telemetry: `filesScanned`, `configSource`,
 * `rootSource`, `rulesEvaluated`, plus the conditional `configSearchedFrom`
 * spread. Drift between tools on the same input is silent (the agent
 * reads one headline, budgets against it, and notices the disagreement
 * only by chance when the next call returns a different shape) — see
 * `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
 * invariant" for the doctrine.
 *
 * Closes:
 * - — coverage now ships a meta block.
 * - — every tool routes its
 *     warnings through the same input shape, so the same scanner state
 *     produces the same warning code set on every surface.
 * - — the
 *     {@link configSearchedFromField} helper widens the omit predicate
 *     so the field never echoes an input the agent already has
 *     (caller-supplied `cwd`, the resolved `scanned.root`, or
 *     `posixDirname(scanned.file)`).
 *
 * Pure over its inputs; no I/O, no global state.
 */

import { posixDirname } from "../utils/path.ts";
import type { ScannedEnvelope } from "./scanned-envelope.ts";

/**
 * Computes the conditional-spread `configSearchedFrom` field. The
 * field carries scan-confidence signal ONLY when its value names a
 * directory the agent can't otherwise read off the response. Three
 * shapes echo an input the agent already has and so must be omitted:
 *
 *   1. `searchBase` equals the caller-supplied `cwd` — the agent
 *      passed the value, the loader walked up from it, no new signal.
 *   2. `searchBase` equals `scanned.root` (project-mode scans) — the
 *      resolved root already rides on the response.
 *   3. `searchBase` equals `posixDirname(scanned.file)` (file-mode scans
 *      where the loader walked up from the file's parent dir) — the
 *      agent computes that with one path operation.
 *
 * Returns the spreadable fragment `{ configSearchedFrom?: string }` so
 * callers fold it into a `meta` literal with one spread.
 */
export function configSearchedFromField(args: {
  /** The directory the loader's walk-up started from. */
  readonly searchBase: string | undefined;
  /** Caller-supplied `cwd` from tool params. */
  readonly callerCwd?: string | undefined;
  /** The `scanned` envelope already on the response. */
  readonly scanned?: ScannedEnvelope;
}): { readonly configSearchedFrom?: string } {
  const { searchBase, callerCwd, scanned } = args;
  if (searchBase === undefined || searchBase.length === 0) return {};
  if (callerCwd !== undefined && callerCwd === searchBase) return {};
  if (scanned !== undefined) {
    if (scanned.mode === "project" && scanned.root === searchBase) return {};
    if (scanned.mode === "file" && scanned.file !== undefined) {
      if (posixDirname(scanned.file) === searchBase) return {};
    }
  }
  return { configSearchedFrom: searchBase };
}

/**
 * Computes the `warningsDetails.no_config_found` payload, applying the
 * same present-when-meaningful predicate as {@link configSearchedFromField}
 * to the warning-channel sibling of `meta.configSearchedFrom`.
 *
 * The original warning detail shape — `{ searchedFrom: <cwd> }` shipped
 * unconditionally — duplicated context the agent already had on the
 * response. On `scan_project`, `searchedFrom` always equaled
 * `meta.scanned.root`; on `scan` and the other project-rooted tools
 * (`coverage`, `checklist`, `propose_baseline`, `propose_config`,
 * `list_suppressions`, `scan_diff`, `vpat`), it always equaled the
 * caller-supplied `cwd`. Per `docs/kb/architecture/ai-first-consumer.md`
 * "Verbose meta is signal, not clutter — `configSearchedFrom` is
 * present-when-meaningful, omitted when it would just echo the caller's
 * `cwd` or a `scanned.root` already in the response," the warning-
 * channel detail must apply the same omit predicate the meta-channel
 * field already does.
 *
 * Two return shapes:
 *
 *   - `{ searchedFrom: <path> }` when the value adds signal (the search
 *     base differs from `callerCwd`, `scannedRoot`, and any
 *     `posixDirname(scanned.file)` the file-mode scan-file surface
 *     would expose).
 *   - `{}` (empty record) when the value would echo an input already on
 *     the response. The schema slot for `no_config_found` is widened to
 *     `{ searchedFrom: string } | BinaryPresenceMarker` so the empty
 *     shape is honestly typed — the bare warning code stays the
 *     signal, and `meta.scanned.root` / the caller's `cwd` /
 *     `dirname(meta.scanned.file)` carry the search base for any
 *     agent that wants the canonical answer.
 *
 * The empty record is NOT a "missing payload" sentinel — it's the
 * "no payload by design on this surface" shape that binary-presence
 * codes (`scanned_zero_files`, `tailwind_detected_css_undercounted`,
 * etc.) emit. The disambiguating fall-through truncation sentinel
 * applies only when the summarizer was called with `searchedFrom`
 * undefined (no input to compare); when the summarizer has a value but
 * elects to drop it as redundant, the empty record is the honest
 * shape.
 */
export function noConfigFoundWarningDetail(args: {
  /** The absolute path the config loader walked from. */
  readonly searchedFrom: string;
  /** Caller-supplied `cwd` from tool params. */
  readonly callerCwd?: string | undefined;
  /** The resolved scan root (for project-mode scans). */
  readonly scannedRoot?: string | undefined;
  /**
   * The `scanned` envelope already on the response. Optional when
   * the caller has already projected the relevant value via
   * {@link callerCwd} / {@link scannedRoot}; the envelope-shape variant
   * is here so file-mode tools (`scan_file`) can pass the envelope
   * directly and let the helper compute `posixDirname(scanned.file)`
   * for the file-mode echo case.
   */
  readonly scanned?: ScannedEnvelope;
}): { readonly searchedFrom: string } | Record<string, never> {
  const { searchedFrom, callerCwd, scannedRoot, scanned } = args;
  if (callerCwd !== undefined && callerCwd === searchedFrom) return {};
  if (scannedRoot !== undefined && scannedRoot === searchedFrom) return {};
  if (scanned !== undefined) {
    if (scanned.mode === "project" && scanned.root === searchedFrom) return {};
    if (scanned.mode === "file" && scanned.file !== undefined) {
      if (posixDirname(scanned.file) === searchedFrom) return {};
    }
  }
  return { searchedFrom };
}
