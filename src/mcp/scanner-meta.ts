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

import { CONFIG_FILENAMES } from "../config/loader.ts";
import { posixDirname, posixJoin } from "../utils/path.ts";
import type { ScannedEnvelope } from "./scanned-envelope.ts";

/**
 * Bound on the walk-up depth the {@link noConfigFoundSearchedPaths}
 * helper enumerates from the loader's search base. The config loader
 * walks until it hits a `.git` directory or the filesystem root —
 * detecting `.git` would require I/O, which the warning-detail
 * summarizer is pure-over-its-inputs by design. A cap on the
 * enumeration keeps the candidate-paths list bounded for deeply nested
 * search bases (a 12-segment path × 4 filenames = 48 entries, which
 * dilutes the actionable signal). Eight levels covers the typical
 * `/Users/<u>/projects/<repo>/<sub>...` shape without overflowing on
 * pathological inputs.
 */
const SEARCHED_PATHS_MAX_DEPTH = 8;

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
 * Enumerates the candidate file paths the config loader would have
 * consulted on its walk-up from {@link searchBase}, matching
 * `src/config/loader.ts`'s `walkUpFrom` discovery semantics
 * (`join(dir, filename)` for every `CONFIG_FILENAMES` entry at every
 * ancestor dir). Bounded by {@link SEARCHED_PATHS_MAX_DEPTH} so deeply
 * nested search bases don't overflow the candidate list — the loader's
 * real stop conditions (`.git` directory present, or
 * `posixDirname(dir) === dir` at the filesystem root) require I/O,
 * which this helper avoids by design.
 *
 * Returns the cross-product as a POSIX-normalized array, ordered
 * depth-shallowest-first (the search base, then each parent), with the
 * per-dir slice ordered by {@link CONFIG_FILENAMES} precedence
 * (`.ts` → `.js` → `.mjs` → `.json`). An agent reading the warning
 * payload sees the most-likely-intended path first.
 *
 * Empty / blank input returns the empty array — callers gate the
 * summarizer on a non-empty search base before invoking, and the
 * payload-builder downstream falls through to the truncation sentinel
 * when this returns empty.
 */
export function noConfigFoundSearchedPaths(searchBase: string): readonly string[] {
  if (typeof searchBase !== "string" || searchBase.length === 0) return [];
  const out: string[] = [];
  let dir = searchBase;
  for (let depth = 0; depth < SEARCHED_PATHS_MAX_DEPTH; depth++) {
    for (const filename of CONFIG_FILENAMES) {
      out.push(posixJoin(dir, filename));
    }
    const parent = posixDirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * Computes the `warningsDetails.no_config_found` payload. Always
 * surfaces the {@link noConfigFoundSearchedPaths candidate paths the
 * config loader walked through} — the actionable triage signal that
 * lets the agent decide whether to bootstrap a config or whether the
 * search missed an existing file at an unexpected name. The
 * `searchedFrom` echo of the search base is folded in only when it
 * carries new signal (same present-when-meaningful predicate as the
 * meta-channel sibling {@link configSearchedFromField}): when the
 * walk-up base equals the caller's `cwd`, the resolved `scanned.root`,
 * or `posixDirname(scanned.file)` (all already on the response), the
 * scalar drops and `searchedPaths` carries the load-bearing context.
 *
 * Closes the "Empty `warningsDetails.<code>: {}` is dishonest" doctrine
 * bullet for `no_config_found`: the prior shape returned
 * `{}` whenever the search base would have echoed an existing field,
 * leaving an agent reading the warning name with zero specifics
 * (`searchedPaths` absent, no candidate filenames to triage against).
 * The new shape ships `searchedPaths` on every fire — the bare warning
 * code never carries an empty payload again.
 *
 * Two return shapes (both always carry `searchedPaths`):
 *
 *   - `{ searchedFrom, searchedPaths }` when the search base adds
 *     signal beyond the response's existing root / cwd / file echoes.
 *   - `{ searchedPaths }` when `searchedFrom` would just echo
 *     `callerCwd` / `scannedRoot` / `posixDirname(scanned.file)`. The
 *     payload is still actionable — the agent has the per-dir
 *     candidate filenames the loader looked for.
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
}):
  | { readonly searchedFrom: string; readonly searchedPaths: readonly string[] }
  | { readonly searchedPaths: readonly string[] } {
  const { searchedFrom, callerCwd, scannedRoot, scanned } = args;
  const searchedPaths = noConfigFoundSearchedPaths(searchedFrom);
  if (callerCwd !== undefined && callerCwd === searchedFrom) return { searchedPaths };
  if (scannedRoot !== undefined && scannedRoot === searchedFrom) return { searchedPaths };
  if (scanned !== undefined) {
    if (scanned.mode === "project" && scanned.root === searchedFrom) return { searchedPaths };
    if (scanned.mode === "file" && scanned.file !== undefined) {
      if (posixDirname(scanned.file) === searchedFrom) return { searchedPaths };
    }
  }
  return { searchedFrom, searchedPaths };
}
