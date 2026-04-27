/**
 * Extension-presence probe — answers "does this extension exist anywhere
 * under cwd?" for the per-rule coverage downgrade subkind discriminator.
 *
 * Why this exists. A `coverageConfidence: "low"` row on an extension-
 * gated rule with `eligible === 0` could mean two structurally different
 * things: (a) `extension-absent` — the cwd genuinely contains no files
 * of that extension; (b) `extension-present-but-out-of-scope` — files
 * exist somewhere under cwd but were pruned from the scan by
 * `additionalPaths`, the user's `exclude` list, default build-dir skips
 * (`dist`, `build`, …), or `.gitignore` patterns. The two cases route
 * to different remediations: (a) "add source files of this extension";
 * (b) "broaden additionalPaths or unset the path filter that excluded
 * them." Without the discriminator, the row's remediation steers the
 * agent toward the wrong fix half the time.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` the subkind value
 * must be provable from evidence — the directory walk is deterministic;
 * either the extension exists at the cwd or it doesn't, no heuristic
 * involved. The walk DOES NOT respect `.gitignore` / user-`exclude` /
 * `additionalPaths` because the whole question being answered is "what
 * was the scoped scan blind to?" Skipping infrastructure dirs (`.git`,
 * `node_modules`, `__pycache__`, language-specific virtualenvs) is
 * fine — files of the user's source extensions never live in those
 * locations and walking them is purely cost.
 *
 * Boundedness — the probe is async filesystem work and can fire on
 * every project-rooted scan. `MAX_DEPTH` caps recursion at a sensible
 * monorepo depth (deeply-nested test fixtures inside `tests/` /
 * `__tests__/` are reached within 8 levels on every codebase observed
 * in the field). `MAX_FILES_INSPECTED` short-circuits the walk once we
 * have enough evidence — the probe reports presence/absence per
 * extension, so once every extension of interest is found we can stop.
 *
 * Cache. {@link probeExtensionsAtRoot} caches its result per absolute
 * `root` path so a tool invocation that calls multiple downstream
 * helpers (per-rule subkind adjustment, perhaps later checklist /
 * coverage parity) pays the I/O cost once per process. The cache key
 * is the pair `(root, extensionsKey)` — a sorted-comma-joined extension
 * set — so probes asking different questions don't collide.
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { extension } from "../utils/path.ts";

/**
 * Maximum directory depth the probe will traverse from the root. Beyond
 * this we stop recursing — even monorepos rarely place source files
 * deeper than this, and the cost of walking arbitrarily deep
 * filesystem trees is unbounded otherwise. Deliberately not user-
 * configurable; the probe's job is "did the agent's scope miss
 * something obvious," not "comprehensive depth-first survey."
 */
const MAX_DEPTH = 8;

/**
 * Maximum number of files inspected before short-circuiting. The probe
 * reports a Set of extensions found; once we've inspected enough files
 * to have likely seen every extension that exists, walking further pays
 * no marginal information. Sized to keep total cost bounded on
 * vendor-heavy repos (a 4000-file corpus can churn through this in a
 * few hundred ms — the budget the per-rule coverage downgrade pays).
 */
const MAX_FILES_INSPECTED = 5000;

/**
 * Directory names the probe always skips. Same shape as the discovery
 * walker's `DEFAULT_IGNORED_DIRS` minus the build-output dirs (`dist`,
 * `build`, `out`, `.next`, …) — those are PRECISELY where a Tailwind
 * pre-build's compiled CSS lives and the probe must see them to
 * answer "files exist but were out of scope." `.git` and
 * `node_modules` are never what the agent meant when they say "my
 * project's CSS"; including them would inflate the probe's cost
 * without changing the answer.
 */
const PROBE_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  "venv",
  ".venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "site-packages",
  ".cache",
]);

/**
 * Per-process cache keyed by `<root>::<sorted-comma-extensions>`.
 * Survives across multiple downstream consumers in one tool
 * invocation; resets on process exit (no persistence intent).
 */
const probeCache = new Map<string, ReadonlySet<string>>();

/**
 * Probes `root` for the presence of any extension in {@link extensions}.
 *
 * Walks the directory tree iteratively up to {@link MAX_DEPTH} levels,
 * counting an extension as "present" the first time a file with that
 * extension is seen. Short-circuits once every requested extension has
 * been found OR {@link MAX_FILES_INSPECTED} is hit. The walk does NOT
 * respect `.gitignore` / user-`exclude` / `additionalPaths` filters —
 * those are exactly the filters whose effect the probe is trying to
 * detect. Infrastructure dirs ({@link PROBE_SKIP_DIRS}) are skipped
 * for cost reasons; users never put source files in `node_modules/` or
 * `.git/`.
 *
 * Cwd missing or unreadable → returns an empty set. The caller then
 * sees no extensions present and the row stays at the conservative
 * `extension-absent` branch (we can't claim presence we couldn't
 * verify).
 *
 * Returns the set of `extensions` (lowercased, dot-prefixed) that were
 * found anywhere under root. Extensions in {@link extensions} that did
 * not appear are absent from the result Set — the caller diffs the
 * input vs the output to learn which extensions were absent.
 */
export async function probeExtensionsAtRoot(
  root: string,
  extensions: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  if (extensions.size === 0) return new Set();
  const wanted = new Set([...extensions].map((e) => e.toLowerCase()));
  const cacheKey = `${root}::${[...wanted].sort().join(",")}`;
  const cached = probeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const found = new Set<string>();
  await walkProbe(root, wanted, found);
  probeCache.set(cacheKey, found);
  return found;
}

/**
 * Test-only escape hatch — clears the per-process cache. Production
 * code should never call this; the cache is keyed on the request
 * shape and is safe to keep.
 */
export function _resetExtensionPresenceProbeCache(): void {
  probeCache.clear();
}

/**
 * State tracked by the iterative walk so the per-directory inner
 * loop can be hoisted into a separate helper without re-passing five
 * positional args. The cap is `inspected.value === MAX_FILES_INSPECTED`;
 * boxed in an object so the inner loop can mutate it.
 */
interface WalkState {
  readonly stack: { dir: string; depth: number }[];
  readonly inspected: { value: number };
  readonly found: Set<string>;
  readonly wanted: ReadonlySet<string>;
}

/**
 * Iterative walk implementation. Mutates {@link WalkState.found} in
 * place; exits as soon as every wanted extension has been seen or the
 * file budget is exhausted.
 */
async function walkProbe(
  root: string,
  wanted: ReadonlySet<string>,
  found: Set<string>,
): Promise<void> {
  // Confirm the root itself is reachable; otherwise return silently and
  // the caller routes to the conservative branch.
  try {
    const st = await stat(root);
    if (!st.isDirectory()) return;
  } catch {
    return;
  }
  const state: WalkState = {
    stack: [{ dir: root, depth: 0 }],
    inspected: { value: 0 },
    found,
    wanted,
  };
  while (state.stack.length > 0) {
    const next = state.stack.pop();
    if (next === undefined) break;
    if (shouldStopWalk(state)) return;
    if (next.depth > MAX_DEPTH) continue;
    if (await processDirectory(next.dir, next.depth, state)) return;
  }
}

/**
 * Reads one directory's entries, queues sub-directories on the
 * walk stack, and updates {@link WalkState.found} when files match a
 * wanted extension. Returns `true` when the walk should terminate
 * (every wanted extension found or the file budget exhausted),
 * otherwise `false`.
 */
async function processDirectory(dir: string, depth: number, state: WalkState): Promise<boolean> {
  // The Dirent overload `readdir` picks at the call site is the
  // buffer-element variant under the inferred `Awaited<ReturnType>`,
  // which has the wrong element type for our string usage. Pin the
  // shape explicitly so the inner `entry.name.startsWith(…)` calls
  // resolve through the string overload — same fix the discovery
  // walker (src/utils/fs.ts) uses for the identical reason.
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || PROBE_SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      state.stack.push({ dir: full, depth: depth + 1 });
      continue;
    }
    if (!entry.isFile()) continue;
    state.inspected.value += 1;
    const ext = extension(full).toLowerCase();
    if (ext.length > 0 && state.wanted.has(ext)) state.found.add(ext);
    if (shouldStopWalk(state)) return true;
  }
  return false;
}

/**
 * True when the walk has answered its question (every wanted
 * extension is in {@link WalkState.found}) or hit the file-inspection
 * budget. Centralized so the outer loop and the inner per-directory
 * helper share one termination predicate.
 */
function shouldStopWalk(state: WalkState): boolean {
  if (allWantedFound(state.wanted, state.found)) return true;
  return state.inspected.value >= MAX_FILES_INSPECTED;
}

/**
 * Has every requested extension been found yet? Used as the early-exit
 * gate so the walk stops as soon as the probe's question is answered.
 */
function allWantedFound(wanted: ReadonlySet<string>, found: ReadonlySet<string>): boolean {
  if (found.size < wanted.size) return false;
  for (const w of wanted) if (!found.has(w)) return false;
  return true;
}
