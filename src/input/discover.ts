/**
 * File discovery.
 *
 * Expands the set of paths given on the command line into a flat list
 * of parseable files. Applies:
 *
 *   - Default ignored directories (node_modules, dist, .git, etc.)
 *   - `.gitignore` at the repo root (when `respectGitignore !== false`)
 *   - Extension allow-list (only .tsx/.jsx/.ts/.js/.html/.htm/.css)
 *   - User exclude patterns (gitignore-style globs — see utils/glob.ts)
 *
 * Entry points:
 *   - `discoverFiles(roots, options)` takes a list of cwd-relative
 *     paths (directories or files) and returns resolved absolute
 *     file paths.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DEFAULT_IGNORED_DIRS, walkFiles } from "../utils/fs.ts";
import { compileGlobs, type GlobMatcher } from "../utils/glob.ts";
import { extension, hasParseableExtension } from "../utils/path.ts";

/**
 * A minimal directory-ignore set used by `discoverExplicitPaths`.
 * The agent opt-ed in by listing these paths explicitly (typically
 * `dist/` or `build/`), so the usual `dist`/`build`/`out`/etc. skips
 * don't apply. `node_modules` and `.git` stay excluded — walking them
 * from a build directory is never the intent and produces nothing but
 * noise.
 */
const EXPLICIT_PATH_IGNORED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);

export interface DiscoverOptions {
  /** User-supplied gitignore-style patterns. */
  readonly excludes?: readonly string[];
  /** When true, skip default test-file exclusions. */
  readonly includeTests?: boolean;
  /**
   * When true, drop the `*.stories.*` / `*.story.*` / `stories/**`
   * entries from the default-excluded patterns so story files reach
   * the scanner. Engaged by `preset: "storybook"` — the preset pairs
   * discovery with framework-aware transparency in
   * `analysis-coverage.ts`, so the stories are scanned but Storybook
   * primitives (`Meta`, `StoryObj`, `StoryFn`, `Story`) don't inflate
   * the opaque-component count. Test / mock / dev-tool patterns stay
   * excluded regardless — those are orthogonal to stories.
   */
  readonly includeStoryFiles?: boolean;
  /** When false, don't auto-load .gitignore. Default true. */
  readonly respectGitignore?: boolean;
}

// The bar for entries in DEFAULT_EXCLUDED_PATTERNS is high: findings in
// the matched path tree must be *definitionally wrong for any consumer*,
// not merely "noisy for a human reviewer," per the AI-first consumer
// doctrine in docs/kb/architecture/ai-first-consumer.md (Default-exclude
// globs are suppression too).
//
// `**\/__mocks__\/**` clears the bar because Jest's `__mocks__` directory
// is a test-runtime injection mechanism — files in it are never loaded
// by the application bundle and never reach a user's browser. A finding
// there is a finding on a file no consumer will ever render. (The
// neighbouring `__tests__` directory does NOT clear the bar — fixture
// JSX and snapshot copy gets copy-pasted into production routinely, and
// an agent reading a `<button>`-without-name finding under `__tests__`
// can dismiss it in one read if it really is test-only. Same for
// `*.test.*`, `*.spec.*`, `*.stories.*`, `stories/`, `dev-tools/`,
// `devtools/` — all dropped in the AI-first-doctrine pass.)
//
// Users can drop the `__mocks__` exclusion via `includeTests: true` —
// that flag is the doctrinally-correct opt-out shape (it widens what
// the scanner sees rather than narrowing what it reports).
const DEFAULT_EXCLUDED_PATTERNS: readonly string[] = ["**/__mocks__/**"];

// Storybook story patterns. Empty after the AI-first-doctrine pass
// dropped story files from the default-excluded list — story files now
// reach the scanner unconditionally, and the `preset: "storybook"`
// machinery still handles framework-aware transparency (Storybook
// primitives like `Meta`, `StoryObj`, `StoryFn`, `Story` render as
// transparent wrappers in `analysis-coverage.ts` so they don't inflate
// the opaque-component count). Retained as an empty set so the
// `includeStoryFiles` plumbing in `buildDirExcludes` and downstream
// MCP tools (`scan_project`, `tools-helpers.ts`) keeps its existing
// shape; the filter is now a no-op.
const STORY_FILE_PATTERNS: ReadonlySet<string> = new Set([]);

/**
 * Opt-in discovery that treats each path as an explicit "please scan
 * this" — bypasses both `.gitignore` and the default-ignored-dirs
 * (`dist`, `build`, `out`, `.next`, …). Used by scan_project's
 * `additionalPaths` param so an agent can point the scanner at
 * post-compile CSS/HTML output a Tailwind or bundler produced. Still
 * honors user excludes from config and the parseable-extension filter
 * — we only widen the dir-level skip.
 */
export async function discoverExplicitPaths(
  paths: readonly string[],
  options: { readonly excludes?: readonly string[] } = {},
): Promise<string[]> {
  const userExcludes = options.excludes ?? [];
  const userMatcher = compileGlobs(userExcludes);
  const out = new Set<string>();
  for (const raw of paths) {
    const absRoot = resolve(raw);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absRoot);
    } catch {
      continue;
    }
    if (info.isFile()) {
      if (hasParseableExtension(absRoot) && !userMatcher.matches(toRel(absRoot, absRoot))) {
        out.add(absRoot);
      }
      continue;
    }
    if (!info.isDirectory()) continue;
    const found = await walkFiles(
      absRoot,
      (filePath) =>
        hasParseableExtension(filePath) && !userMatcher.matches(toRel(filePath, absRoot)),
      EXPLICIT_PATH_IGNORED_DIRS,
    );
    for (const f of found) out.add(f);
  }
  return [...out].sort();
}

/**
 * Well-known no-extension textual filenames the agent triages as
 * source-shaped (license boilerplate, build directives, project
 * metadata). Lumping these under a single `(no-ext)` bucket alongside
 * binary-but-extensionless oddballs hid the source-vs-non-source
 * distinction: an agent reading
 * `warningsDetails.text_source_skipped.extensions: ["(no-ext)"]`
 * could not tell whether the bucket was three LICENSEs or a hash-named
 * Git LFS pointer. Filenames here are matched case-insensitively
 * (canonical case preserved on the wire — `LICENSE`, `Makefile`,
 * `Dockerfile`) and surface inline as their own keys in
 * `skippedByExtension`. Anything else without an extension still falls
 * through to `(no-ext)` so binary-without-extension counts stay
 * distinguishable from named textual files.
 */
const WELL_KNOWN_TEXTUAL_NO_EXT_FILENAMES: ReadonlyMap<string, string> = new Map([
  // License + copyright boilerplate (canonical SPDX / GPL / Apache convention).
  ["license", "LICENSE"],
  ["licence", "LICENCE"],
  ["copying", "COPYING"],
  ["copyright", "COPYRIGHT"],
  ["notice", "NOTICE"],
  ["authors", "AUTHORS"],
  ["contributors", "CONTRIBUTORS"],
  // Project metadata commonly committed without an extension.
  ["readme", "README"],
  ["changelog", "CHANGELOG"],
  ["changes", "CHANGES"],
  ["history", "HISTORY"],
  ["install", "INSTALL"],
  ["news", "NEWS"],
  ["todo", "TODO"],
  ["version", "VERSION"],
  // Build + tooling directives — text-source files the agent often
  // wants to read directly even though ra11y has no parser for them.
  ["makefile", "Makefile"],
  ["gnumakefile", "GNUmakefile"],
  ["dockerfile", "Dockerfile"],
  ["containerfile", "Containerfile"],
  ["jenkinsfile", "Jenkinsfile"],
  ["vagrantfile", "Vagrantfile"],
  ["rakefile", "Rakefile"],
  ["gemfile", "Gemfile"],
  ["procfile", "Procfile"],
  ["brewfile", "Brewfile"],
  ["pipfile", "Pipfile"],
  ["caddyfile", "Caddyfile"],
  ["berksfile", "Berksfile"],
  ["podfile", "Podfile"],
  ["fastfile", "Fastfile"],
  ["appfile", "Appfile"],
  ["cartfile", "Cartfile"],
  ["justfile", "Justfile"],
]);

/**
 * Set of canonical-cased textual no-extension filenames the discovery
 * walker emits as `skippedByExtension` keys (e.g. `LICENSE`, `Makefile`,
 * `Dockerfile`, `README`, `CHANGELOG`). Derived from
 * {@link WELL_KNOWN_TEXTUAL_NO_EXT_FILENAMES} at module-init so the
 * predicate stays in lock-step with the lookup map.
 */
const WELL_KNOWN_TEXTUAL_NO_EXT_CANONICAL: ReadonlySet<string> = new Set(
  WELL_KNOWN_TEXTUAL_NO_EXT_FILENAMES.values(),
);

/**
 * True when {@link token} is a canonical-cased well-known textual
 * no-extension filename (e.g. `LICENSE`, `Makefile`, `Dockerfile`).
 *
 * The discovery walker buckets these inline under their canonical
 * filename rather than the residual `(no-ext)` token so downstream
 * `warningsDetails.text_source_skipped` consumers can route them into
 * the type-honest `noExtensionFiles` slot (separate from the dotted-
 * extension `extensions` slot). This predicate is the one place the
 * partition rule is encoded — both the discovery emitter and the
 * warning summarizer call through it.
 */
export function isWellKnownTextualNoExtFilename(token: string): boolean {
  return WELL_KNOWN_TEXTUAL_NO_EXT_CANONICAL.has(token);
}

/**
 * Subset of {@link DEFAULT_IGNORED_DIRS} the discovery walker tracks
 * for the `default_excluded_artifact_paths` warning channel. Names a
 * directory whose canonical role is "build / generated output" rather
 * than "vendor cache" or "language runtime" — the cases where the
 * agent's silent-miss failure mode is "I scanned the repo but the
 * compiled bundle output was never seen and the response gave me no
 * signal that my scan envelope dropped half the surface."
 *
 * `node_modules`, `.git`, language runtimes (`venv`, `__pycache__`,
 * `.tox`, `.pytest_cache`, etc.), and `vendor` (Go / PHP convention)
 * deliberately stay out of the surfaced set: every consumer expects
 * them excluded, the silent-miss mode does not apply, and walking
 * them shallowly for sampling (even at the cap below) would dominate
 * discovery cost on the canonical big-monorepo profile. See AI-first
 * "Default-exclude globs are suppression too" — the rule is honest
 * surfacing of dropped content, not exhaustive enumeration of every
 * default-excluded path.
 */
const DEFAULT_EXCLUDED_ARTIFACT_DIR_NAMES: ReadonlySet<string> = new Set([
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  "htmlcov",
  ".nyc_output",
  "target",
]);

/**
 * Per-ignored-dir cap on the file count surfaced under
 * `defaultExcludedArtifactPaths[].fileCount`. The shallow walk that
 * powers the field counts files in lock-step with the walker's
 * recursion; once the count crosses this cap we stop counting (the
 * field name is `fileCount`, not `exactFileCount`, and the cap value
 * is the agent's signal that "this directory has ≥CAP parseable files
 * — the silent skip is non-trivial").
 *
 * Picked at 5000 so a typical compiled `dist/` (a few hundred files) is
 * counted exactly while a worst-case bundler-output directory caps out
 * without burning unbounded I/O on a path the agent will only read for
 * triage. The cap is not a suppression threshold — directories at or
 * above it still surface in the warning's payload; the count is just
 * truncated to `>= 5000` semantics by saturation.
 */
const DEFAULT_EXCLUDED_ARTIFACT_FILE_COUNT_CAP = 5000;

/**
 * Per-ignored-dir cap on the number of sample paths surfaced under
 * `defaultExcludedArtifactPaths[].sampleFiles`. Three is the canonical
 * "agent reads enough to recognize the directory shape but not enough
 * to drown in vendor inventory" choice — the same cardinality
 * `parseErrorTopReasons` and similar telemetry surfaces use.
 */
const DEFAULT_EXCLUDED_ARTIFACT_SAMPLE_CAP = 3;

/**
 * One entry in {@link DiscoveryDiagnostics.defaultExcludedArtifactPaths}.
 * Names a directory that the discovery walker skipped because its name
 * is in {@link DEFAULT_EXCLUDED_ARTIFACT_DIR_NAMES} AND that contains at
 * least one parseable-extension file. The shape is the agent's pivot:
 *
 *   - `path` is the absolute directory path (deterministic across runs
 *     because the walker iterates sorted dir entries).
 *   - `fileCount` is the count of parseable-extension files reachable
 *     under the directory, capped at
 *     {@link DEFAULT_EXCLUDED_ARTIFACT_FILE_COUNT_CAP} so a
 *     pathological bundler-output tree doesn't dominate discovery
 *     time. Counts that hit the cap saturate — agents read "≥ cap"
 *     from the field's documented bound.
 *   - `sampleFiles` is up to
 *     {@link DEFAULT_EXCLUDED_ARTIFACT_SAMPLE_CAP} absolute file paths
 *     the agent can use to recognize the directory shape (canonical
 *     bundler output vs. minified bundle vs. cached HTML, etc.) without
 *     reading the directory itself. Sorted-ascending lexically so the
 *     wire shape is deterministic.
 */
export interface DefaultExcludedArtifactPath {
  readonly path: string;
  readonly fileCount: number;
  readonly sampleFiles: readonly string[];
}

/**
 * Diagnostic signals from the discovery pass that are otherwise
 * invisible to downstream consumers. Every field reports a structural
 * gap the scanner chose not to fix but the agent should know about:
 *
 *   - `skippedByExtension`: files that cleared the dir-ignore + user
 *     exclude filters but were rejected purely because their extension
 *     isn't in `PARSEABLE_EXTENSIONS`. Canonical silent-miss case —
 *     scanning a project with 226 source files but only 125 parseable
 *     reads as "tool covered everything" when the walker dropped
 *     `.astro` / `.scss` / `.vue` at discovery. Map keys are
 *     ext-with-dot (`.astro`) for files with a dotted extension; well-
 *     known textual no-extension filenames (LICENSE, Makefile,
 *     Dockerfile, etc.) surface inline under their canonical filename
 *     so an agent triaging coverage can tell source-shaped no-ext
 *     files apart from the residual `(no-ext)` bucket (binary blobs,
 *     hash-named pointers). Counters are raw file counts.
 *   - `excludedByPatternByExtension`: per-extension counts of files
 *     that have a parseable extension but were filtered by
 *     {@link DEFAULT_EXCLUDED_PATTERNS}, `.gitignore`, or user-supplied
 *     `exclude` globs. Closes the per-extension accounting axis when
 *     `meta.filesByExtension` undercounts ground-truth file totals
 *     because gitignore- and user-excluded matches were silently
 *     dropped. Together with `filesByExtension` (parsed) and
 *     `skippedByExtension` (unparseable) plus `sourcemapFiles.length`,
 *     this field closes the per-extension accounting invariant for
 *     files reachable under the dir-ignore set: parsed + skipped +
 *     excludedByPattern + sourcemap = the raw walker count. Map keys
 *     are ext-with-dot (`.scss`); counters are raw file counts. Per
 *     AI-first "Verbose meta is signal, not clutter," the channel
 *     surfaces deliberately-suppressed parseable files so an agent
 *     triaging "11 .css scanned but the repo has 47" can tell the
 *     remainder went through `.gitignore`/excludes (visible) rather
 *     than vanishing through a parser-routing bug (invisible).
 *   - `sourcemapFiles`: absolute paths of `.map` sourcemap files the
 *     walker considered (cleared dir-ignore + user-excludes) and
 *     rejected on the parseable-extension check. Routed into a
 *     dedicated bucket rather than `skippedByExtension` so the
 *     conventional sourcemap-exclusion is declared explicitly per
 *     `docs/kb/architecture/ai-first-consumer.md` "Routing skips that
 *     drop content are the symmetric twin of suppression" — the
 *     exclusion is conventionally correct (sourcemaps aren't authored
 *     a11y source), but a silent skip is indistinguishable from "tool
 *     never saw the file" from the agent's seat. Surfaced via the
 *     `sourcemap_files_excluded` warning code with `count` + `topPaths`
 *     so an agent can audit the exclusion. Sorted-ascending paths so
 *     the wire shape is deterministic across runs.
 *   - `defaultExcludedArtifactPaths`: per-directory entries naming
 *     every {@link DEFAULT_EXCLUDED_ARTIFACT_DIR_NAMES} match that
 *     contained at least one parseable-extension file. Surfaced under
 *     the dedicated `default_excluded_artifact_paths` warning so an
 *     agent triaging "0 findings on a Next.js / Vite repo" can tell
 *     "the scanner saw 1240 parseable files under `.next/` and
 *     dropped them" from "the codebase is genuinely small." Per
 *     AI-first "Default-exclude globs are suppression too" the
 *     surface is honest enumeration of dropped content, not a
 *     suppression channel. Sorted by directory path so the wire is
 *     deterministic.
 */
export interface DiscoveryDiagnostics {
  readonly skippedByExtension: Readonly<Record<string, number>>;
  readonly excludedByPatternByExtension: Readonly<Record<string, number>>;
  readonly sourcemapFiles: readonly string[];
  readonly defaultExcludedArtifactPaths: readonly DefaultExcludedArtifactPath[];
}

/**
 * Like {@link discoverFiles} but also returns per-extension counts of
 * files the walker considered (cleared dir-ignore + user-excludes) and
 * then rejected because the extension isn't parseable.
 * `DEFAULT_EXCLUDED_PATTERNS`, `.gitignore`, and user-`exclude`
 * rejections are NOT counted — those are intentional suppressions
 * surfaced elsewhere, not silent parser gaps.
 *
 * Build-artifact directories from {@link DEFAULT_EXCLUDED_ARTIFACT_DIR_NAMES}
 * are surfaced separately under
 * {@link DiscoveryDiagnostics.defaultExcludedArtifactPaths} — those are
 * silent skips of plausibly authored output (compiled bundles, generated
 * HTML) the agent benefits from knowing existed even though the scanner
 * deliberately did not parse them. Distinct from the skipped-extension
 * channel: that one names parser-routing gaps; this one names
 * directory-level suppressions.
 */
export async function discoverFilesWithDiagnostics(
  roots: readonly string[],
  options: DiscoverOptions = {},
): Promise<{ readonly files: string[]; readonly diagnostics: DiscoveryDiagnostics }> {
  const userExcludes = options.excludes ?? [];
  const gitignore = options.respectGitignore === false ? [] : await loadGitignoreForRoots(roots);
  const dirPatterns = buildDirExcludes(
    userExcludes,
    gitignore,
    options.includeTests === true,
    options.includeStoryFiles === true,
  );
  const dirMatcher = compileGlobs(dirPatterns);
  const userMatcher = compileGlobs([...userExcludes, ...gitignore]);
  const out = new Set<string>();
  const skippedByExtension = new Map<string, number>();
  const excludedByPatternByExtension = new Map<string, number>();
  const sourcemapFiles = new Set<string>();
  const ignoredArtifactDirs = new Set<string>();

  for (const raw of roots) {
    const absRoot = resolve(raw);
    const found = await discoverOne(
      absRoot,
      userMatcher,
      dirMatcher,
      skippedByExtension,
      excludedByPatternByExtension,
      sourcemapFiles,
      ignoredArtifactDirs,
    );
    for (const f of found) out.add(f);
  }

  // Walk each surfaced ignored-artifact-dir shallowly to count parseable
  // files and capture sample paths. Walked AFTER the main discovery pass
  // so the cap on file count + sample size bounds total I/O even on
  // bundler-output trees with thousands of files.
  const defaultExcludedArtifactPaths = await summarizeIgnoredArtifactDirs(ignoredArtifactDirs);

  return {
    files: [...out].sort(),
    diagnostics: {
      skippedByExtension: Object.fromEntries(
        [...skippedByExtension.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      excludedByPatternByExtension: Object.fromEntries(
        [...excludedByPatternByExtension.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      sourcemapFiles: [...sourcemapFiles].sort(),
      defaultExcludedArtifactPaths,
    },
  };
}

/**
 * Walks every surfaced ignored-artifact directory shallowly to count
 * parseable-extension files and capture up to
 * {@link DEFAULT_EXCLUDED_ARTIFACT_SAMPLE_CAP} sample paths. Returns one
 * entry per directory that contained at least one parseable file; empty
 * directories drop conservatively so the warning channel stays
 * present-when-meaningful (the directory's mere existence isn't the
 * silent miss — the agent already expects `dist/` to exist on most
 * repos). Caps total I/O via
 * {@link DEFAULT_EXCLUDED_ARTIFACT_FILE_COUNT_CAP} so a multi-thousand-
 * file bundler tree doesn't dominate discovery latency.
 *
 * Entries are sorted by absolute path so the wire shape is deterministic
 * across runs.
 */
async function summarizeIgnoredArtifactDirs(
  dirs: ReadonlySet<string>,
): Promise<readonly DefaultExcludedArtifactPath[]> {
  const out: DefaultExcludedArtifactPath[] = [];
  for (const dirPath of dirs) {
    const entry = await summarizeIgnoredArtifactDir(dirPath);
    if (entry !== null) out.push(entry);
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function summarizeIgnoredArtifactDir(
  dirPath: string,
): Promise<DefaultExcludedArtifactPath | null> {
  const accumulator: ArtifactDirAccumulator = {
    samples: [],
    fileCount: 0,
  };
  // Recursive walk bounded by the count cap. We honor the same nested
  // `DEFAULT_IGNORED_DIRS` set as the main walker so a
  // `dist/node_modules` doesn't blow the cap on a single directory.
  const stack: string[] = [dirPath];
  while (stack.length > 0) {
    if (accumulator.fileCount >= DEFAULT_EXCLUDED_ARTIFACT_FILE_COUNT_CAP) break;
    const cur = stack.pop();
    if (cur === undefined) break;
    await processArtifactDir(cur, accumulator, stack);
  }
  if (accumulator.fileCount === 0) return null;
  accumulator.samples.sort();
  return {
    path: dirPath,
    fileCount: accumulator.fileCount,
    sampleFiles: accumulator.samples,
  };
}

interface ArtifactDirAccumulator {
  readonly samples: string[];
  fileCount: number;
}

/**
 * Reads a single directory entry list during the artifact-dir walk and
 * folds children into the accumulator. Subdirectories that match
 * {@link DEFAULT_IGNORED_DIRS} are not pushed (preserving the main
 * walker's nested-ignore semantics so a `dist/node_modules` doesn't
 * dominate the cap); other subdirectories are pushed onto the stack.
 * Parseable-extension files bump the count and (within the per-dir
 * cap) contribute a sample path.
 *
 * Extracted from {@link summarizeIgnoredArtifactDir} so the orchestrator
 * stays under the lint cap as the walk's branch count accretes.
 */
async function processArtifactDir(
  cur: string,
  acc: ArtifactDirAccumulator,
  stack: string[],
): Promise<void> {
  // `readdir(..., { withFileTypes: true })` overload returns
  // `Dirent<string>[]` — the default-overload type
  // `Awaited<ReturnType<typeof readdir>>` resolves to the buffer
  // overload, so we name the shape explicitly. Same pattern used in
  // `src/utils/fs.ts walk`.
  let children: Dirent<string>[];
  try {
    children = await readdir(cur, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    if (acc.fileCount >= DEFAULT_EXCLUDED_ARTIFACT_FILE_COUNT_CAP) return;
    addArtifactChild(cur, child, acc, stack);
  }
}

/**
 * Folds a single child directory entry into the accumulator. Returns
 * void because the caller's cap-check guards the stack-push and
 * fileCount mutation; the helper is straight-line so the lint
 * cognitive-complexity score stays linear in branch count.
 */
function addArtifactChild(
  cur: string,
  child: Dirent<string>,
  acc: ArtifactDirAccumulator,
  stack: string[],
): void {
  if (child.isDirectory()) {
    if (DEFAULT_IGNORED_DIRS.has(child.name)) return;
    stack.push(join(cur, child.name));
    return;
  }
  if (!child.isFile()) return;
  const childPath = join(cur, child.name);
  if (!hasParseableExtension(childPath)) return;
  acc.fileCount += 1;
  if (acc.samples.length < DEFAULT_EXCLUDED_ARTIFACT_SAMPLE_CAP) {
    acc.samples.push(childPath);
  }
}

/** Resolves every input path into a flat list of parseable files. */
export async function discoverFiles(
  roots: readonly string[],
  options: DiscoverOptions = {},
): Promise<string[]> {
  const { files } = await discoverFilesWithDiagnostics(roots, options);
  return files;
}

/**
 * Routes a discovery-rejected file into the appropriate diagnostic
 * bucket. `.map` sourcemap files land in the dedicated `sourcemapFiles`
 * collector rather than `skippedByExtension` so the
 * `sourcemap_files_excluded` warning declares the conventional
 * sourcemap exclusion explicitly (per `docs/kb/architecture/ai-first-consumer.md`
 * "Routing skips that drop content are the symmetric twin of
 * suppression"). All other rejections increment {@link counts}: empty-
 * extension files split two ways — well-known textual filenames
 * (LICENSE, Makefile, Dockerfile, …) bucket inline under their
 * canonical filename so an agent reading
 * `warningsDetails.text_source_skipped.extensions` can tell source-
 * shaped no-ext files apart from residual binary or hash-named
 * oddballs; anything else without an extension still lands under
 * `(no-ext)` so the map key is always non-empty.
 */
function recordExtensionSkip(
  counts: Map<string, number>,
  sourcemapFiles: Set<string>,
  filePath: string,
): void {
  const ext = extension(filePath);
  if (ext === SOURCEMAP_EXTENSION) {
    sourcemapFiles.add(filePath);
    return;
  }
  const key = ext === "" ? noExtensionKey(filePath) : ext;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Records a file that has a parseable extension but was filtered out
 * by `.gitignore`, user-supplied excludes, or
 * {@link DEFAULT_EXCLUDED_PATTERNS}. Bucketed by the file's dotted
 * extension so the agent reading
 * `analysisCoverage.excludedByPatternByExtension` can answer "of the
 * 60 .js files my repo has, how many did the scanner intentionally
 * skip via patterns?" without re-walking the tree. Sibling to
 * {@link recordExtensionSkip}: that one captures parser-routing
 * gaps, this one captures pattern-driven suppressions, and together
 * the two buckets close the per-extension accounting invariant for
 * files reachable under the dir-ignore set.
 */
function recordExcludedByPattern(counts: Map<string, number>, filePath: string): void {
  const ext = extension(filePath);
  // Caller gates on `hasParseableExtension(filePath)`, so `ext` is
  // always a non-empty dotted extension here. Defensive: fall back to
  // the canonical `(no-ext)` bucket if the contract ever drifts.
  const key = ext === "" ? "(no-ext)" : ext;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Sourcemap file extension — `.map` per the canonical sourcemap-v3
 * convention (`<name>.css.map`, `<name>.js.map`, `<name>.map`).
 * Lower-cased so a `.MAP` from a Windows-authored repo classifies the
 * same way; matches the lower-cased output of {@link extension}.
 */
const SOURCEMAP_EXTENSION = ".map";

/**
 * Resolves the bucket key for a file with no dotted extension. Returns
 * the canonical-cased filename when {@link basename} matches a known
 * textual filename (case-insensitively); otherwise returns the
 * `(no-ext)` fallback bucket. Centralized so the predicate stays in one
 * place and the case-folding contract (lowercase lookup, canonical-case
 * output) doesn't drift.
 */
function noExtensionKey(filePath: string): string {
  const name = basename(filePath);
  const canonical = WELL_KNOWN_TEXTUAL_NO_EXT_FILENAMES.get(name.toLowerCase());
  return canonical ?? "(no-ext)";
}

/**
 * Merges default test-file patterns with user excludes for directory
 * walks. `includeTests: true` drops every default. `includeStoryFiles:
 * true` narrows that override to the story-file subset so the preset
 * engages only the Storybook-specific unfilter without dragging tests
 * / mocks / dev-tools back in.
 */
function buildDirExcludes(
  userExcludes: readonly string[],
  gitignore: readonly string[],
  includeTests: boolean,
  includeStoryFiles: boolean,
): readonly string[] {
  if (includeTests) return [...gitignore, ...userExcludes];
  const defaults = includeStoryFiles
    ? DEFAULT_EXCLUDED_PATTERNS.filter((p) => !STORY_FILE_PATTERNS.has(p))
    : DEFAULT_EXCLUDED_PATTERNS;
  return [...defaults, ...gitignore, ...userExcludes];
}

/**
 * Loads `.gitignore` patterns for each scan root.
 *
 * When a scan root is inside a git repository, every `.gitignore` file
 * between the git root and the scan root also applies — same semantics
 * git itself uses. Without the walk-up, `scan_project({ cwd: <repo> })`
 * and `scan_project({ cwd: <repo>/<subdir> })` would produce different
 * findings for the same tree (the subpath call wouldn't see the root
 * `.gitignore` excluding `dist/` etc.), leading agents to mis-attribute
 * regressions when comparing across `cd` boundaries.
 *
 * Patterns from ancestor `.gitignore` files are translated to be
 * relative to the scan root, then dropped if their anchor falls outside
 * the scan root entirely (an anchored `/dist` at the git root can
 * never match a file under `<repo>/src/app/`).
 *
 * Nested files *inside* the scan root are also collected one level
 * deep — common for monorepos where `frontend/.gitignore` lists build
 * artefacts. Deeper descent isn't followed.
 */
async function loadGitignoreForRoots(roots: readonly string[]): Promise<readonly string[]> {
  const patterns: string[] = [];
  const gitRootCache = new Map<string, string | null>();
  for (const raw of roots) {
    const abs = resolve(raw);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(abs);
    } catch {
      continue;
    }
    const scanRoot = info.isDirectory() ? abs : join(abs, "..");
    const repoRoot = await resolveGitRoot(scanRoot, gitRootCache);
    if (repoRoot !== null && repoRoot !== scanRoot) {
      await collectAncestorGitignores(repoRoot, scanRoot, patterns);
    }
    await collectGitignores(scanRoot, "", patterns);
  }
  return patterns;
}

/**
 * Walks up from `start` looking for a `.git` entry (directory for
 * normal repos, file for worktrees/submodules). Returns the absolute
 * path of the containing directory, or null if we hit the filesystem
 * root without finding one. Results are memoized by input directory so
 * a multi-root scan only pays the walk-up cost once per repo.
 */
async function resolveGitRoot(
  start: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const cached = cache.get(start);
  if (cached !== undefined) return cached;
  const visited: string[] = [];
  let current = start;
  // `dirname("/") === "/"` on posix; use that as the loop terminator.
  while (true) {
    const cachedCurrent = cache.get(current);
    if (cachedCurrent !== undefined) return memoize(cache, visited, cachedCurrent);
    visited.push(current);
    if (await hasGitEntry(current)) return memoize(cache, visited, current);
    const parent = dirname(current);
    if (parent === current) return memoize(cache, visited, null);
    current = parent;
  }
}

/** Returns true if `<dir>/.git` exists as a directory or a file (worktree/submodule). */
async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    const st = await stat(join(dir, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/** Writes `resolved` into every entry of `visited` and returns it. */
function memoize(
  cache: Map<string, string | null>,
  visited: readonly string[],
  resolved: string | null,
): string | null {
  for (const v of visited) cache.set(v, resolved);
  return resolved;
}

/**
 * Reads every `.gitignore` from `repoRoot` down the directory chain
 * to (but not including) `scanRoot`, translating each pattern to be
 * relative to `scanRoot`. Patterns whose anchor falls outside
 * `scanRoot` are dropped.
 */
async function collectAncestorGitignores(
  repoRoot: string,
  scanRoot: string,
  out: string[],
): Promise<void> {
  const chain = ancestorChain(repoRoot, scanRoot);
  for (const dir of chain) {
    await readAncestorIgnoreInto(dir, scanRoot, out);
  }
}

/**
 * Returns `[repoRoot, repoRoot/a, repoRoot/a/b, ...]` — every directory
 * between `repoRoot` (inclusive) and `scanRoot` (exclusive) in order
 * from shallowest to deepest.
 */
function ancestorChain(repoRoot: string, scanRoot: string): readonly string[] {
  const rel = relative(repoRoot, scanRoot);
  if (rel === "" || rel.startsWith("..")) return [];
  const parts = rel.split(/[\\/]/).filter((p) => p.length > 0);
  const out: string[] = [repoRoot];
  let acc = repoRoot;
  // The last segment *is* scanRoot, which is collected separately.
  for (let i = 0; i < parts.length - 1; i += 1) {
    acc = join(acc, parts[i] ?? "");
    out.push(acc);
  }
  return out;
}

/**
 * Reads `<dir>/.gitignore` and emits scan-root-relative patterns.
 *
 * The translation handles three cases:
 *   - Unanchored pattern (e.g. `dist/`): applies at any depth under
 *     `dir`. Since `scanRoot` is under `dir`, the same pattern still
 *     applies at any depth under `scanRoot`. Emit unchanged.
 *   - Anchored pattern (leading `/`, or contains a slash): rooted at
 *     `dir`. Only matches files under `scanRoot` if the anchored path
 *     starts with the dir→scanRoot relative prefix. Strip that prefix
 *     and re-anchor; drop if the anchor points elsewhere.
 */
async function readAncestorIgnoreInto(dir: string, scanRoot: string, out: string[]): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(dir, ".gitignore"), "utf8");
  } catch {
    return;
  }
  const relDirToScan = relative(dir, scanRoot)
    .split(/[\\/]/)
    .filter((p) => p.length > 0);
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
    const translated = translateAncestorPattern(line, relDirToScan);
    if (translated !== null) out.push(translated);
  }
}

/**
 * Rewrites an ancestor-level gitignore pattern to be relative to the
 * scan root, or returns null if the pattern's anchor puts it outside
 * the scan root (e.g., `/other-pkg/` at repo root when we're scanning
 * `/repo/frontend/`).
 */
function translateAncestorPattern(pattern: string, relDirToScan: readonly string[]): string | null {
  const hadLeadingSlash = pattern.startsWith("/");
  const trailingSlash = pattern.endsWith("/") ? "/" : "";
  const body = pattern.replace(/^\//, "").replace(/\/$/, "");
  const containsSlash = body.includes("/");
  // Per gitignore(5): a slash anywhere in the pattern (except at end) makes
  // it rooted at the `.gitignore`'s directory. A leading `**/` is the one
  // documented exception — it means "at any depth," i.e. unanchored.
  const leadingDoubleStar = body.startsWith("**/");
  const isAnchored = (hadLeadingSlash || containsSlash) && !leadingDoubleStar;

  if (!isAnchored) {
    // Unanchored (including leading `**/`): matches anywhere below the
    // originating dir, which includes anywhere below the scan root.
    // Preserve verbatim.
    return pattern;
  }

  const segments = body.split("/");
  // Must start with the dir→scanRoot path prefix; otherwise the
  // pattern anchors outside the scan root and can't match any file
  // we enumerate.
  for (let i = 0; i < relDirToScan.length; i += 1) {
    if (segments[i] !== relDirToScan[i]) return null;
  }
  const remainder = segments.slice(relDirToScan.length);
  if (remainder.length === 0) {
    // Pattern anchored at the scan root itself — e.g., `/src/app` at
    // the repo root when scanning `/repo/src/app`. The scan root *is*
    // the excluded path; nothing under it would even be a candidate
    // to scan. Emit an anchored `*` so the matcher rejects every file
    // uniformly rather than silently leaking.
    return `/*${trailingSlash}`;
  }
  return `/${remainder.join("/")}${trailingSlash}`;
}

/** Reads .gitignore at `dir` (prefixed with `prefix` when nested) and recurses one level. */
async function collectGitignores(dir: string, prefix: string, out: string[]): Promise<void> {
  await readIgnoreFileInto(dir, prefix, out);
  // Only recurse one level from the root to avoid an expensive full walk.
  if (prefix !== "") return;
  let entries: Awaited<ReturnType<typeof stat>>;
  try {
    entries = await stat(dir);
  } catch {
    return;
  }
  if (!entries.isDirectory()) return;
  const { readdir } = await import("node:fs/promises");
  const children = await readdir(dir, { withFileTypes: true });
  for (const entry of children) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
    await readIgnoreFileInto(join(dir, entry.name), entry.name, out);
  }
}

async function readIgnoreFileInto(dir: string, prefix: string, out: string[]): Promise<void> {
  try {
    const text = await readFile(join(dir, ".gitignore"), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
      out.push(prefix === "" ? line : prefixPattern(prefix, line));
    }
  } catch {
    // No .gitignore in this directory — fine.
  }
}

/** Prefixes a nested gitignore pattern with its parent directory. */
function prefixPattern(prefix: string, pattern: string): string {
  // An anchored pattern like `/storybook-static` in frontend/.gitignore
  // becomes `frontend/storybook-static` at the scan root.
  const stripped = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  return `${prefix}/${stripped}`;
}

/**
 * Resolves a single root path into matching files, accumulating
 * per-extension rejection counts for files the walker actually
 * considered (cleared dir-ignore + user-excludes) but failed the
 * parseable-extension check. Exclusion patterns from
 * `DEFAULT_EXCLUDED_PATTERNS` / `.gitignore` / user excludes are
 * deliberately not counted — they're intentional suppressions, not
 * silent parser gaps.
 *
 * Build-artifact directories matched by
 * {@link DEFAULT_EXCLUDED_ARTIFACT_DIR_NAMES} are recorded in
 * {@link ignoredArtifactDirs} so the caller can shallow-walk them for
 * the `default_excluded_artifact_paths` warning channel without
 * re-walking the source tree.
 */
async function discoverOne(
  abs: string,
  userMatcher: GlobMatcher,
  dirMatcher: GlobMatcher,
  skippedByExtension: Map<string, number>,
  excludedByPatternByExtension: Map<string, number>,
  sourcemapFiles: Set<string>,
  ignoredArtifactDirs: Set<string>,
): Promise<readonly string[]> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(abs);
  } catch {
    return [];
  }
  if (info.isFile()) {
    // Explicit file paths bypass default test-file exclusions, but still
    // honor the user's own excludes. A user-excluded parseable file is
    // recorded under `excludedByPatternByExtension` so the per-extension
    // accounting invariant (parsed + skipped + excludedByPattern +
    // sourcemap = raw walker count) holds for explicit-file roots too.
    if (userMatcher.matches(toRel(abs, abs))) {
      if (hasParseableExtension(abs)) recordExcludedByPattern(excludedByPatternByExtension, abs);
      return [];
    }
    if (hasParseableExtension(abs)) return [abs];
    recordExtensionSkip(skippedByExtension, sourcemapFiles, abs);
    return [];
  }
  if (info.isDirectory()) {
    return walkFiles(
      abs,
      (filePath) => hasParseableExtension(filePath) && !dirMatcher.matches(toRel(filePath, abs)),
      DEFAULT_IGNORED_DIRS,
      {
        // Fires for files that passed the dir-level ignore set AND
        // failed the inline filter. The filter is parseable-extension
        // AND not-pattern-excluded, so a rejection means one of:
        //   - parseable + pattern-excluded → `excludedByPatternByExtension`
        //   - non-parseable + not-pattern-excluded → `skippedByExtension`
        //   - non-parseable + pattern-excluded → neither bucket (the
        //     extension gap is moot once the pattern excludes the file)
        // The split keeps the per-extension accounting invariant
        // honest: every file the walker considered lands in exactly
        // one diagnostic bucket OR survives into `out`.
        onRejected: (filePath) => {
          const patternMatch = dirMatcher.matches(toRel(filePath, abs));
          if (patternMatch) {
            if (hasParseableExtension(filePath)) {
              recordExcludedByPattern(excludedByPatternByExtension, filePath);
            }
            return;
          }
          recordExtensionSkip(skippedByExtension, sourcemapFiles, filePath);
        },
        // Fires once per directory the walker skipped because its name
        // is in DEFAULT_IGNORED_DIRS. We narrow to the build-artifact
        // subset (DEFAULT_EXCLUDED_ARTIFACT_DIR_NAMES) so the warning
        // channel surfaces canonical silent-miss vectors without
        // burning I/O on universal cache dirs an agent already knows
        // are excluded.
        onIgnoredDir: (dirPath) => {
          if (DEFAULT_EXCLUDED_ARTIFACT_DIR_NAMES.has(basename(dirPath))) {
            ignoredArtifactDirs.add(dirPath);
          }
        },
      },
    );
  }
  return [];
}

/** Path we compare against patterns — POSIX `/` and relative to the scan root. */
function toRel(filePath: string, root: string): string {
  return relative(root, filePath).split(/[\\/]/).join("/");
}

/** Joins a root and a relative sub-path. Exported for tests. */
export function joinRoot(root: string, sub: string): string {
  return join(root, sub);
}
