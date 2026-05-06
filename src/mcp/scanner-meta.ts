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
