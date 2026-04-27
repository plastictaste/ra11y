/**
 * Build-provenance annotation for MCP responses.
 *
 * Per-response identity signal: every tool result carries the ra11y
 * version + git commit + bundle mtime that produced it, so an agent
 * can cross-check the running build against any expected version
 * without a separate roundtrip. The systemic guard against
 * shipped-but-stale `dist/` lives in `scripts/check-mcp-dist-freshness.ts`
 * (precommit + CI gate ensures `dist/cli.js` matches `src/` on every
 * landed commit); the per-response signal here is what the agent reads
 * to confirm which build is answering.
 *
 * Injects three fields under the top-level `meta` of every MCP tool
 * response:
 *   - `ra11yVersion: string` — package.json version (always present).
 *   - `commitHash?: string` — git HEAD SHA when resolvable (conditional
 *     spread; omitted on non-git deployments, e.g. installs from npm).
 *   - `bundleMtime: string` — ISO timestamp of the running bundle/entry
 *     script's mtime. When the stat fails (bundle path inaccessible),
 *     the field is omitted via conditional spread rather than emitted
 *     as an empty string (CLAUDE.md §1 "Ambiguous field shapes are
 *     dishonest").
 *
 * Present-when-meaningful shape: `commitHash` and `bundleMtime` are
 * conditional-spread. `ra11yVersion` is always present — it's read at
 * module load and cannot fail at annotation time.
 *
 * Resolution is done once at module init and cached — provenance is
 * immutable within a process lifetime. Re-stat'ing per-call would cost
 * a syscall on every tool response for no signal: an installed
 * end-user's `dist/cli.js` does not change for the lifetime of the
 * MCP subprocess.
 *
 * Git commit resolution reads `.git/HEAD` and follows refs directly
 * rather than shelling out to `git rev-parse HEAD` — shell-out would
 * fork a subprocess per server lifetime AND requires `git` on PATH
 * where users may run the npm install without it. The resolver handles
 * the three layouts it's likely to meet:
 *   - `.git/` is a directory (regular checkout): read `.git/HEAD`.
 *   - `.git` is a file (worktree): parse `gitdir: <path>` → read
 *     `<path>/HEAD`, resolve refs via the main-repo `.git/` via the
 *     `commondir` pointer.
 *   - `.git` absent: return undefined.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.ts";
import type { McpToolResult } from "./tools-helpers.ts";

/** Cached provenance snapshot — resolved once at module init. */
interface BuildProvenance {
  readonly ra11yVersion: string;
  readonly commitHash?: string;
  readonly bundleMtime?: string;
}

let cached: BuildProvenance | null = null;

/**
 * Test-only override for the bundle path used by the next provenance
 * resolution. Leave `null` in production — real resolution walks via
 * `import.meta.url`. Setting this lets a test point the resolver at a
 * synthetic fixture directory so the git / mtime paths can be
 * exercised without mutating the real checkout.
 */
let overrideBundlePath: string | null = null;

/**
 * Resolves the filesystem path of the running bundle/entry script.
 * When ra11y is installed and run via `dist/cli.js`, `import.meta.url`
 * resolves to the bundled entry; in dev (`bun src/cli.ts`) it resolves
 * to this source file. Either way the mtime of the resolved path is a
 * valid "when was the running code written" signal. Returns `null`
 * when the URL scheme is not `file:` (custom loaders, data URLs).
 */
function resolveBundlePath(): string | null {
  try {
    const u = new URL(import.meta.url);
    if (u.protocol !== "file:") return null;
    return fileURLToPath(u);
  } catch {
    return null;
  }
}

/**
 * Walks upward from `startDir` looking for a `.git` entry. Returns the
 * absolute path to that entry (either the directory or the file form),
 * or `null` if none was found before hitting the filesystem root.
 */
function findDotGit(startDir: string): string | null {
  let dir = startDir;
  // Walk up until we either find `.git` or stop making progress
  // (`dirname` returns the same path at the root).
  for (;;) {
    const candidate = join(dir, ".git");
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // not here, try parent
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Given a path to a `.git` entry (either the directory form or the
 * worktree-file form with `gitdir: <path>`), returns:
 *   - `gitDir`: where HEAD lives for this worktree.
 *   - `commonDir`: where refs/ and packed-refs live. For a regular
 *     checkout, same as `gitDir`. For a worktree, resolved via the
 *     `commondir` file so `refs/heads/<branch>` lookups hit the main
 *     repo's ref store.
 *
 * Returns null on malformed input.
 */
function resolveGitDirs(dotGitPath: string): { gitDir: string; commonDir: string } | null {
  try {
    const stat = statSync(dotGitPath);
    if (stat.isDirectory()) {
      return { gitDir: dotGitPath, commonDir: dotGitPath };
    }
  } catch {
    return null;
  }
  // Worktree case: `.git` is a file containing `gitdir: <path>`.
  let raw: string;
  try {
    raw = readFileSync(dotGitPath, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(raw);
  if (match === null) return null;
  const rawPath = match[1];
  if (rawPath === undefined) return null;
  const gitDir = isAbsolute(rawPath) ? rawPath : resolvePath(dirname(dotGitPath), rawPath);
  // The per-worktree gitdir has a `commondir` file pointing back to
  // the main repo's .git. Without it, refs/heads/<branch> lookups
  // would miss because per-worktree gitdir has no refs/ tree of its
  // own beyond HEAD.
  let commonDir = gitDir;
  try {
    const rawCommon = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    commonDir = isAbsolute(rawCommon) ? rawCommon : resolvePath(gitDir, rawCommon);
  } catch {
    // `commondir` absent → this is a regular repo with a file-form
    // `.git` (uncommon but valid), or something broke. Fall back to
    // gitDir itself; ref lookups will succeed iff refs live there.
  }
  return { gitDir, commonDir };
}

/**
 * Searches `packed-refs` under `commonDir` for an entry matching
 * `ref` and returns the paired SHA. Returns `undefined` if the file is
 * unreadable, the ref is not listed, or the SHA is malformed.
 *
 * Extracted from {@link readHeadSha} to keep that function within the
 * cognitive-complexity budget — packed-refs parsing is a self-contained
 * loop whose only input is the target ref name.
 */
function readPackedRefSha(commonDir: string, ref: string): string | undefined {
  let packed: string;
  try {
    packed = readFileSync(join(commonDir, "packed-refs"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of packed.split("\n")) {
    if (line.length === 0 || line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space === -1) continue;
    const sha = line.slice(0, space);
    const refName = line.slice(space + 1).trim();
    if (refName === ref && /^[0-9a-f]{40,64}$/i.test(sha)) return sha;
  }
  return undefined;
}

/**
 * Reads HEAD and returns the resolved SHA. HEAD can be:
 *   - A symbolic ref (`ref: refs/heads/main\n`) — follow it via the
 *     `commonDir` ref store, falling back to `packed-refs`.
 *   - A detached SHA (`<40 hex>\n`) — return as-is.
 * Returns `undefined` on any read/parse failure.
 */
function readHeadSha(gitDir: string, commonDir: string): string | undefined {
  let head: string;
  try {
    head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return undefined;
  }
  const refMatch = /^ref:\s*(.+?)\s*$/.exec(head);
  if (refMatch === null) {
    // Detached HEAD — should be a SHA.
    return /^[0-9a-f]{40,64}$/i.test(head) ? head : undefined;
  }
  const ref = refMatch[1];
  if (ref === undefined) return undefined;
  // First try the loose ref file.
  try {
    const sha = readFileSync(join(commonDir, ref), "utf8").trim();
    if (/^[0-9a-f]{40,64}$/i.test(sha)) return sha;
  } catch {
    // fall through to packed-refs
  }
  return readPackedRefSha(commonDir, ref);
}

/**
 * Resolves the commit hash of the ra11y build by walking up from the
 * bundle path to find `.git`. We deliberately root the search at the
 * bundle's location (not `process.cwd()`) because the commit hash
 * should describe "which build of ra11y is running," not "which repo
 * is the agent working in." A published npm install will have no
 * `.git/` anywhere on the walk — that's the intended path for the
 * conditional spread to drop the field entirely.
 */
function resolveCommitHash(bundlePath: string | null): string | undefined {
  if (bundlePath === null) return undefined;
  const dotGit = findDotGit(dirname(bundlePath));
  if (dotGit === null) return undefined;
  const dirs = resolveGitDirs(dotGit);
  if (dirs === null) return undefined;
  return readHeadSha(dirs.gitDir, dirs.commonDir);
}

/**
 * Resolves the bundle mtime as an ISO-8601 string. Returns `undefined`
 * on stat failure (bundle path inaccessible), which causes the field
 * to be conditional-spread out of the response rather than emitted
 * as an ambiguous empty string (CLAUDE.md §1 "Ambiguous field shapes
 * are dishonest").
 */
function resolveBundleMtime(bundlePath: string | null): string | undefined {
  if (bundlePath === null) return undefined;
  try {
    const stat = statSync(bundlePath);
    return new Date(stat.mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Resolves the provenance triple once and caches it. Subsequent calls
 * return the same object — provenance is immutable for the lifetime of
 * this process. Exported so tests can reset + re-resolve against a
 * synthetic bundle path via {@link __resetBuildProvenance}.
 */
export function getBuildProvenance(): BuildProvenance {
  if (cached !== null) return cached;
  const bundlePath = overrideBundlePath ?? resolveBundlePath();
  const commitHash = resolveCommitHash(bundlePath);
  const bundleMtime = resolveBundleMtime(bundlePath);
  cached = {
    ra11yVersion: VERSION,
    ...(commitHash === undefined ? {} : { commitHash }),
    ...(bundleMtime === undefined ? {} : { bundleMtime }),
  };
  return cached;
}

/**
 * Test-only reset — clears the cached snapshot so the next
 * {@link getBuildProvenance} call re-resolves. Not exported from the
 * package barrel; tests import from this module directly.
 */
export function __resetBuildProvenance(): void {
  cached = null;
  overrideBundlePath = null;
}

/**
 * Test-only bundle-path override. Pointing the resolver at a synthetic
 * fixture directory lets a test exercise the `.git` walk / mtime stat
 * paths without mutating the real ra11y checkout. Clears automatically
 * via {@link __resetBuildProvenance}.
 */
export function __setBundlePathOverride(path: string | null): void {
  overrideBundlePath = path;
  cached = null;
}

/**
 * Merges the build-provenance triple into the response's top-level
 * `meta` object, creating `meta` if absent. Called from the server
 * dispatch seam on every tool result (success OR error envelope) so
 * the agent can cross-check the running build without relying on any
 * individual handler to thread provenance through.
 *
 * Shape handling:
 *   - `content[0].text` is parsed as JSON. If parsing fails or the
 *     payload isn't a plain object, the result is returned unchanged.
 *   - Existing `meta` fields are preserved; provenance fields overlay
 *     any same-name keys (a handler that pre-populated them gets
 *     overwritten with the authoritative value).
 *   - `structuredContent` is mirrored too — agents reading the
 *     structured lane still need provenance to cross-check.
 */
export function annotateBuildProvenance(result: McpToolResult): McpToolResult {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return result;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return result;
  const provenance = getBuildProvenance();
  const payload = parsed as Record<string, unknown>;
  const existingMeta =
    typeof payload["meta"] === "object" &&
    payload["meta"] !== null &&
    !Array.isArray(payload["meta"])
      ? (payload["meta"] as Record<string, unknown>)
      : {};
  const mergedMeta: Record<string, unknown> = { ...existingMeta, ...provenance };
  payload["meta"] = mergedMeta;
  const nextText = JSON.stringify(payload);
  const remaining = result.content.slice(1);
  const nextStructured =
    result.structuredContent === undefined
      ? undefined
      : mergeProvenanceIntoStructured(result.structuredContent, provenance);
  return {
    ...result,
    content: [{ type: "text", text: nextText }, ...remaining],
    ...(nextStructured === undefined ? {} : { structuredContent: nextStructured }),
  };
}

/**
 * Mirrors the provenance merge into a `structuredContent` object's
 * `meta` lane. Non-object `meta` values are replaced; pre-existing
 * `meta` fields are preserved and the provenance triple overlays them.
 * The input object is not mutated.
 */
function mergeProvenanceIntoStructured(
  structured: Record<string, unknown>,
  provenance: BuildProvenance,
): Record<string, unknown> {
  const existingMeta =
    typeof structured["meta"] === "object" &&
    structured["meta"] !== null &&
    !Array.isArray(structured["meta"])
      ? (structured["meta"] as Record<string, unknown>)
      : {};
  return {
    ...structured,
    meta: { ...existingMeta, ...provenance },
  };
}
