/**
 * Probe for a Node / ra11y project marker in the same walk-up range the
 * config loader searches. Used by the `no_config_found` warning gate so
 * tiny-repo / demo-size scans — 50projects50days standalone files,
 * bootstrap/jekyll sub-tree demos, website-templates individual dirs —
 * don't fire a warning that duplicates the `meta.configSource: null`
 * signal the agent already sees.
 *
 * Shape invariants (AI-first doctrine, see
 * `docs/kb/architecture/ai-first-consumer.md`):
 *
 *   - Surface, don't suppress. The probe does NOT suppress findings; it
 *     only gates one structured warning code whose signal is already
 *     carried by `meta.configSource`. The finding stream is unchanged.
 *   - Walk range mirrors `src/config/loader.ts::walkUpFrom` exactly —
 *     same stop conditions (`.git` directory or filesystem root) — so
 *     the question "did the search the loader would have done see a
 *     project marker?" has the same reach as the search that produced
 *     `configSource === null`.
 *   - Deterministic and read-only. One `existsSync` call per walked
 *     directory per marker; never reads file contents. Cheap enough to
 *     run on every scan.
 *   - Gate semantics: the `no_config_found` warning fires only when the
 *     walk saw a real Node project root (`package.json` present) AND
 *     the scan actually scanned ≥ 10 files — otherwise the absence of a
 *     ra11y config is the normal shape for demo-size scans and the
 *     warning is duplicative noise.
 *
 * This module sits under `src/mcp/` because the only consumers are the
 * MCP scan-family handlers that build warnings. If a second non-MCP
 * caller ever needs the probe, hoist to `src/utils/`.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Files-scanned threshold below which `no_config_found` is considered
 * duplicative with `configSource: null` in `meta`. Tiny repos and
 * one-off demos (50projects50days standalone files ≤ 3 each,
 * bootstrap/jekyll sub-tree demos, website-templates individual dirs)
 * routinely have no ra11y config and don't need one — the warning
 * fired on every such scan was noise. 10 is the empirical boundary
 * between "demo-size" and "actual project" observed across field
 * reports (Q-SHARED-NO-CONFIG-WARNING-TINY-REPO).
 */
export const NO_CONFIG_FOUND_FILE_COUNT_THRESHOLD = 10;

/**
 * Q-SHARED-NO-CONFIG-WARNING-TINY-REPO predicate. Gates the
 * `no_config_found` emission on evidence that the absence of a config
 * is *signal* — i.e. the walk reached a real Node project root and
 * still came back empty — rather than the normal shape for tiny repos
 * and one-off demos. Three conjoined conditions must hold:
 *
 *   1. `configSource === null` (walk-up completed empty). `undefined`
 *      means the tool didn't attempt resolution; the warning cannot
 *      fire in that case by construction.
 *   2. `filesScanned >= NO_CONFIG_FOUND_FILE_COUNT_THRESHOLD`.
 *      Demo-size scans with a missing config are the normal case; the
 *      warning on every such scan was duplicative noise.
 *   3. `configSearchSawProjectMarker === true`. The walk saw a
 *      `package.json` (or ra11y.config.*) somewhere along the same
 *      directory range the loader searched — proof that the walk
 *      reached a project root, not just a scratch directory. When the
 *      probe didn't run (input omitted) or the probe saw nothing, the
 *      warning drops because `meta.configSource: null` already carries
 *      the only honest signal available.
 *
 * Doctrine: warnings are codes for genuinely out-of-band signals.
 * "configSource is null" is already surfaced on `meta`; the top-level
 * warning earns its place only when that null represents a real gap
 * (Node project with no ra11y config) rather than a benign absence
 * (scratch directory, three-file demo).
 */
export function shouldEmitNoConfigFound(inputs: {
  readonly configSource: string | null | undefined;
  readonly filesScanned: number;
  readonly configSearchSawProjectMarker?: boolean;
}): boolean {
  if (inputs.configSource !== null) return false;
  if (inputs.filesScanned < NO_CONFIG_FOUND_FILE_COUNT_THRESHOLD) return false;
  return inputs.configSearchSawProjectMarker === true;
}

/**
 * Project-marker filenames the probe considers evidence of a real Node
 * toolchain. `package.json` is the canonical Node manifest; the ra11y
 * config filenames are included so a project that ships an
 * `ra11y.config.*` without a `package.json` (rare but possible — an
 * all-tooling "config dotfiles" repo) still gets the warning when no
 * config loaded for some transient reason.
 *
 * Kept in sync with `src/config/loader.ts::CONFIG_FILENAMES` + the
 * canonical Node manifest from
 * `src/mcp/ecosystem-detect.ts::NODE_MARKER`. A new ra11y config
 * filename added to the loader must be added here too.
 */
const PROJECT_MARKER_FILENAMES = [
  "package.json",
  "ra11y.config.ts",
  "ra11y.config.js",
  "ra11y.config.mjs",
  "ra11y.config.json",
] as const;

/**
 * Returns `true` when the walk from `cwd` up to the filesystem root (or
 * the first `.git` directory) sees any {@link PROJECT_MARKER_FILENAMES}
 * entry at any walked directory. Returns `false` otherwise.
 *
 * The walk-up semantics match `src/config/loader.ts::walkUpFrom` exactly
 * — stop at `.git` or filesystem root, check each walked directory.
 * This keeps the probe anchored to the same directory range the config
 * loader already searched, so a positive result from this probe
 * corresponds one-to-one with "the loader's walk saw a real Node
 * project root and still returned no config."
 *
 * @param cwd Starting directory. Caller is responsible for ensuring the
 *            path exists — the probe uses `existsSync` per-directory
 *            and returns `false` when the start dir doesn't resolve any
 *            marker, which is the honest "no project here" shape.
 */
export function sawProjectMarkerInWalk(cwd: string): boolean {
  let dir = resolve(cwd);
  while (true) {
    for (const filename of PROJECT_MARKER_FILENAMES) {
      if (existsSync(join(dir, filename))) return true;
    }
    if (existsSync(join(dir, ".git"))) return false;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * resolves the nearest STRICT
 * ancestor of `cwd` that carries one of {@link PROJECT_MARKER_FILENAMES}
 * (a `ra11y.config.*` or `package.json`). Returns the absolute path of
 * that ancestor directory, or `undefined` when no strict ancestor up to
 * the first `.git` directory or the filesystem root carries a marker.
 *
 * "Strict ancestor" — markers AT `cwd` itself are intentionally ignored.
 * The doctrine surface is "did you mean a parent dir?", so a marker at
 * `cwd` is not evidence that the user pointed at the wrong place; it's
 * the normal shape for an empty-but-correct scan target. Only a marker
 * upstairs answers the misrooted question.
 *
 * Walk-up semantics mirror {@link sawProjectMarkerInWalk} exactly except
 * for the initial-dir skip — same stop conditions (`.git` directory or
 * filesystem root), same marker list. Anchoring to the same range the
 * config loader walks keeps the predicate honest: a positive result
 * corresponds one-to-one with "the loader saw a real project marker
 * upstairs and the caller landed on a leaf with no parseable files."
 *
 * Read-only and deterministic; one `existsSync` per walked directory
 * per marker. Cheap enough to run on every empty-files scan branch.
 *
 * @param cwd Starting directory. Caller is responsible for ensuring the
 *            path resolves; the probe uses `existsSync` per-directory
 *            and returns `undefined` on any unreachable / no-marker
 *            walk.
 */
export function nearestConfigAncestorPath(cwd: string): string | undefined {
  let dir = resolve(cwd);
  // Skip the starting dir itself — strict-ancestor semantics.
  const parent = dirname(dir);
  if (parent === dir) return undefined;
  dir = parent;
  while (true) {
    for (const filename of PROJECT_MARKER_FILENAMES) {
      if (existsSync(join(dir, filename))) return dir;
    }
    if (existsSync(join(dir, ".git"))) return undefined;
    const next = dirname(dir);
    if (next === dir) return undefined;
    dir = next;
  }
}
