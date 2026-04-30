/**
 * scan_project's slim-envelope `nextStep` + `nextStepStructured`
 * builder. Extracted from `scan-project-budget.ts` so that file stays
 * under the 500-effective-line budget enforced by
 * `scripts/check-limits.ts`.
 *
 * The slim envelope fires when the post-density-cap response still
 * crosses the host's hard ceiling (see `oversize-envelope.ts`). The
 * recovery surface MUST differ from `scan_project` itself — routing
 * back to the failing tool with cosmetically narrower args still
 * exercises the same envelope budget that just couldn't fit. See the
 * "NextStep prioritization on truncated/bulk responses" doctrine
 * bullet in `docs/kb/architecture/ai-first-consumer.md`.
 */

import type { ScanFormatted } from "./tools-helpers.ts";

/**
 * Prose for the slim envelope's nextStep. Names the cross-tool routing
 * the structured next-call performs AND the manual `scan_project`
 * narrowing knobs available for callers who want the full file detail
 * back rather than the cross-surface pivot.
 */
export const SLIM_NEXT_STEP_PROSE =
  "The full response was over the MCP host's token ceiling, so per-file findings were dropped to keep the envelope routable. " +
  "The structured next-call routes to a different surface (`scan_file` on the top-impact non-vendor file, or `coverage` for the manual-review angle) " +
  "rather than re-issuing `scan_project` against the same scope that just over-flowed. " +
  "Alternatively re-call `scan_project` with a narrower scope to recover the full file detail: pass a tighter `cwd` (a single subdirectory), " +
  "use `restrictToPaths` to scope to a specific file set, or use `additionalPaths` to scan only a few targeted paths. " +
  "For a bulk-corpus first-pass, prefer the upcoming `summaryOnly` mode when it lands.";

/**
 * Structured nextStep for the slim envelope. Points at a DIFFERENT
 * surface than `scan_project` — routing back to the tool that just
 * blew the host envelope is the canonical "NextStep prioritization on
 * truncated/bulk responses" doctrine miss: the agent following the
 * structured next-call lands on the same surface that failed. Two
 * routing arms close the matrix:
 *
 *   1. **Top non-vendor file exists** → `scan_file` with
 *      `args: { path: <highest-finding-count source file> }`. The
 *      file is picked from `formatted.files[]` (full pre-drop list),
 *      excluding paths the build-artifact classifier flagged as
 *      vendor. Highest `findings.length` wins on a strict majority;
 *      a clean tie collapses into the fallback. `scan_file` is the
 *      single-file findings surface — it carries its own paging and
 *      per-file slim envelope, so it cannot inherit the same bulk-
 *      corpus blow-up.
 *
 *   2. **No non-vendor file** (every file vendor-classified, file
 *      list empty, or top-finding tie) → `coverage` with
 *      `args: { cwd: <caller's cwd> }`. Coverage is the manual-
 *      review-half angle: it returns the criteria-coverage matrix
 *      and `manualWithCandidates`, neither of which traverses the
 *      per-file files[] envelope. Echoing `cwd` here is honest
 *      because we're crossing tool surfaces.
 */
export function buildSlimNextStepStructured(args: {
  readonly formatted: ScanFormatted;
  readonly params: Record<string, unknown>;
  readonly isVendor: (path: string) => boolean;
}): {
  readonly tool: string;
  readonly args: Record<string, unknown>;
} {
  const { formatted, params, isVendor } = args;
  const topFile = pickTopNonVendorFile(formatted.files, isVendor);
  if (topFile !== undefined) {
    return { tool: "scan_file", args: { path: topFile } };
  }
  // No addressable single-file target → pivot to `coverage` (the
  // manual-review-half surface). Coverage's cwd-resolution mirrors
  // scan_project's host-root fallback, so omitting cwd when the
  // caller didn't pass one keeps the structured args forward-
  // progressing rather than fabricating a guessed cwd.
  const cwd = typeof params["cwd"] === "string" ? (params["cwd"] as string) : undefined;
  return {
    tool: "coverage",
    args: cwd === undefined ? {} : { cwd },
  };
}

/**
 * Picks the single non-vendor file with the highest `findings.length`
 * from `formatted.files[]` (full pre-drop inventory). Returns the
 * relative path; `undefined` when no non-vendor file exists, every
 * non-vendor file ties at the top finding count (alphabetical-winner
 * routing is the failure mode the doctrine "NextStep prioritization on
 * truncated/bulk responses must avoid first-by-filename routing"
 * guards against), or the inventory is empty.
 *
 * "Top-impact subtree" in the backlog wording maps to "the file with
 * the most rule fires" — narrowing to that file gives the agent the
 * highest concentration of actionable findings on the recovery call.
 */
export function pickTopNonVendorFile(
  files: readonly ScanFormatted["files"][number][],
  isVendor: (path: string) => boolean,
): string | undefined {
  let topPath: string | undefined;
  let topCount = -1;
  let tie = false;
  for (const file of files) {
    if (isVendor(file.path)) continue;
    const count = file.findings.length;
    if (count > topCount) {
      topPath = file.path;
      topCount = count;
      tie = false;
    } else if (count === topCount) {
      tie = true;
    }
  }
  if (topPath === undefined) return undefined;
  if (tie) return undefined;
  return topPath;
}
