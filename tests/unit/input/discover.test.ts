/**
 * File-discovery tests, focused on `.gitignore` walk-up semantics
 * introduced for. The invariants these guard:
 *
 *   - Subpath scans honor ancestor `.gitignore` files (walked up to
 *     the git root), so `scan_project({ cwd: repo })` and
 *     `scan_project({ cwd: repo/sub })` produce the same findings for
 *     the same tree.
 *   - Full-repo scans (cwd === gitRoot) are unchanged — the walk-up
 *     loop no-ops when repoRoot === scanRoot.
 *   - Non-git directories don't get a walk-up; behavior matches the
 *     pre-walk-up implementation.
 *   - Multi-layer gitignore precedence: rules accumulate from the
 *     repo root down; anchored ancestor patterns outside the scan
 *     root are discarded, not misapplied.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { discoverFiles, discoverFilesWithDiagnostics } from "../../../src/input/discover.ts";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "ra11y-discover-"));
}

/**
 * `discoverFiles` returns POSIX-normalized absolute paths so cross-
 * platform string comparisons stay honest. Tests still hold the temp-
 * dir prefix in native form (from `mkdtempSync`), so we normalize the
 * prefix to POSIX before slicing it off the discovered path.
 */
function posixDir(dir: string): string {
  return dir.split(/[\\/]/).join("/");
}

/**
 * Build a POSIX-shaped expected absolute path. Mirrors `join(dir, ...segments)`
 * but normalizes the result so it matches the POSIX-shaped paths
 * `discoverFilesWithDiagnostics` returns on Windows.
 */
function posixJoin(dir: string, ...segments: string[]): string {
  return [posixDir(dir), ...segments.flatMap((s) => s.split(/[\\/]/))].join("/");
}

/** Marks a directory as a git repo root without actually initializing git. */
function markGitRoot(dir: string): void {
  mkdirSync(join(dir, ".git"), { recursive: true });
  // A bare `.git/HEAD` is enough for us — our detector just stats `.git`.
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

function write(path: string, content = "// noop\n"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Sums the values of a per-extension count record. Used by the
 * accounting invariant test — kept inline so the test harness can
 * read the assertion ("parsed + skipped + excludedByPattern +
 * sourcemap = raw walker count") in one place without a side trip
 * to a utility module.
 */
function sumValues(counts: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const value of Object.values(counts)) total += value;
  return total;
}

describe("discoverFiles .gitignore walk-up", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("subpath scan honors root .gitignore", async () => {
    // Repo layout:
    //   repo/.gitignore            -> "dist/"
    //   repo/src/app/page.tsx      (kept)
    //   repo/src/app/dist/gen.tsx  (excluded by root .gitignore)
    markGitRoot(dir);
    write(join(dir, ".gitignore"), "dist/\n");
    write(join(dir, "src", "app", "page.tsx"));
    write(join(dir, "src", "app", "dist", "gen.tsx"));
    write(join(dir, "src", "app", "dist", "nested", "more.tsx"));

    const found = await discoverFiles([join(dir, "src", "app")]);
    const rel = found.map((p) => p.slice(posixDir(dir).length + 1));

    expect(rel).toEqual(["src/app/page.tsx"]);
  });

  it("full-repo scan is unchanged when cwd === gitRoot", async () => {
    markGitRoot(dir);
    write(join(dir, ".gitignore"), "dist/\n");
    write(join(dir, "src", "app", "page.tsx"));
    write(join(dir, "dist", "bundle.tsx"));

    const fromRoot = await discoverFiles([dir]);
    const relFromRoot = fromRoot.map((p) => p.slice(posixDir(dir).length + 1)).sort();

    // Sanity: `dist/` excluded by root .gitignore, page.tsx kept.
    expect(relFromRoot).toEqual(["src/app/page.tsx"]);

    // And a subpath scan under the same tree agrees on the files that
    // overlap — invariant the walk-up is meant to deliver.
    const fromSubpath = await discoverFiles([join(dir, "src", "app")]);
    const relFromSubpath = fromSubpath.map((p) => p.slice(posixDir(dir).length + 1)).sort();
    expect(relFromSubpath).toEqual(["src/app/page.tsx"]);
  });

  it("non-git directory: walk-up does nothing, existing behavior intact", async () => {
    // No .git marker — resolveGitRoot returns null, no ancestor walk.
    write(join(dir, "src", "app", "page.tsx"));
    write(join(dir, "src", "app", "dist", "bundle.tsx"));

    const found = await discoverFiles([join(dir, "src", "app")]);
    const rel = found.map((p) => p.slice(posixDir(dir).length + 1)).sort();

    // Both surface — no .gitignore anywhere, nothing to exclude. `dist`
    // is a DEFAULT_IGNORED_DIRS entry, so the directory walker skips it.
    // That behavior is pre-existing and unrelated to the walk-up fix.
    expect(rel).toEqual(["src/app/page.tsx"]);
  });

  it("composes multiple intervening .gitignore files correctly", async () => {
    // Repo layout mirrors a monorepo shape:
    //   repo/.gitignore               -> "logs/"
    //   repo/packages/.gitignore      -> "build/"
    //   repo/packages/web/src/page.tsx (kept)
    //   repo/packages/web/src/build/gen.tsx  (excluded by packages/.gitignore)
    //   repo/packages/web/src/logs/trace.tsx (excluded by root .gitignore)
    //   repo/packages/web/src/app/app.tsx    (kept)
    markGitRoot(dir);
    write(join(dir, ".gitignore"), "logs/\n");
    write(join(dir, "packages", ".gitignore"), "build/\n");
    const scanRoot = join(dir, "packages", "web", "src");
    write(join(scanRoot, "page.tsx"));
    write(join(scanRoot, "app", "app.tsx"));
    write(join(scanRoot, "build", "gen.tsx"));
    write(join(scanRoot, "logs", "trace.tsx"));

    const found = await discoverFiles([scanRoot]);
    const rel = found.map((p) => p.slice(posixDir(dir).length + 1)).sort();

    expect(rel).toEqual(["packages/web/src/app/app.tsx", "packages/web/src/page.tsx"]);
  });

  it("anchored ancestor patterns outside the scan root are discarded", async () => {
    // `/other-pkg/` at the repo root only matches `repo/other-pkg/`.
    // When scanning `repo/web`, that pattern must NOT translate into
    // a matcher that would accidentally exclude e.g. `repo/web/other-pkg/`.
    markGitRoot(dir);
    write(join(dir, ".gitignore"), "/other-pkg/\n");
    const scanRoot = join(dir, "web");
    write(join(scanRoot, "page.tsx"));
    write(join(scanRoot, "other-pkg", "file.tsx"));

    const found = await discoverFiles([scanRoot]);
    const rel = found.map((p) => p.slice(posixDir(dir).length + 1)).sort();

    expect(rel).toEqual(["web/other-pkg/file.tsx", "web/page.tsx"]);
  });

  it("anchored ancestor patterns inside the scan root are re-anchored", async () => {
    // `/web/generated/` in the repo root .gitignore refers specifically
    // to `repo/web/generated/`. When we scan `repo/web`, that should
    // become anchored `/generated/` from the scan-root perspective —
    // i.e., a deeper unrelated "generated" dir inside the scan tree
    // still gets scanned. (We use "generated" because "build" lives in
    // DEFAULT_IGNORED_DIRS and would bias the test by other means.)
    markGitRoot(dir);
    write(join(dir, ".gitignore"), "/web/generated/\n");
    const scanRoot = join(dir, "web");
    write(join(scanRoot, "page.tsx"));
    write(join(scanRoot, "generated", "bundle.tsx"));
    write(join(scanRoot, "nested", "generated", "side.tsx"));

    const found = await discoverFiles([scanRoot]);
    const rel = found.map((p) => p.slice(posixDir(dir).length + 1)).sort();

    // Only repo/web/generated is excluded; a deeper unrelated
    // `generated` dir isn't, because the anchor was at
    // `repo/web/generated`.
    expect(rel).toEqual(["web/nested/generated/side.tsx", "web/page.tsx"]);
  });

  it("unanchored root pattern still matches when scanning a subpath", async () => {
    // `node_modules` (unanchored) should match `web/node_modules/foo`.
    markGitRoot(dir);
    write(join(dir, ".gitignore"), "custom-dir\n");
    const scanRoot = join(dir, "web");
    write(join(scanRoot, "page.tsx"));
    write(join(scanRoot, "custom-dir", "bundle.tsx"));
    write(join(scanRoot, "nested", "custom-dir", "bundle.tsx"));

    const found = await discoverFiles([scanRoot]);
    const rel = found.map((p) => p.slice(posixDir(dir).length + 1)).sort();

    expect(rel).toEqual(["web/page.tsx"]);
  });

  it("respectGitignore:false skips the walk-up entirely", async () => {
    markGitRoot(dir);
    write(join(dir, ".gitignore"), "dist/\n");
    const scanRoot = join(dir, "src", "app");
    write(join(scanRoot, "page.tsx"));
    write(join(scanRoot, "dist", "gen.tsx"));

    const found = await discoverFiles([scanRoot], { respectGitignore: false });
    const rel = found.map((p) => p.slice(posixDir(dir).length + 1)).sort();

    // `dist` is still excluded by DEFAULT_IGNORED_DIRS — that's the
    // directory-walker behavior, not the gitignore. So we assert on
    // the file that would only survive if the walk-up also no-ops.
    expect(rel).toContain("src/app/page.tsx");
    // And confirm nothing from dist surfaces (DEFAULT_IGNORED_DIRS does
    // its job; the invariant here is that respectGitignore:false
    // doesn't crash on a git repo).
    expect(rel).not.toContain("src/app/dist/gen.tsx");
  });

  // Anchors the visited-set guard: discovery should terminate on any
  // path, including one where we never hit a .git.
  it("terminates cleanly when no .git marker is found up to the FS root", async () => {
    // tmpdir has no .git above it (unless the user's tmpdir is somehow
    // inside a repo — unlikely on macOS/Linux). Just asserting we
    // don't hang is the contract.
    write(join(dir, "page.tsx"));
    const found = await discoverFiles([dir]);
    expect(found.map((p) => basename(p))).toEqual(["page.tsx"]);
  });
});

describe("discoverFilesWithDiagnostics", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts files skipped because their extension isn't parseable", async () => {
    // Simulates the Bootstrap shape: mixed-language repo where many
    // source files have extensions PARSEABLE_EXTENSIONS doesn't cover.
    write(join(dir, "page.tsx"));
    write(join(dir, "Button.svelte"));
    write(join(dir, "app.vue"));
    write(join(dir, "Layout.svelte"));
    write(join(dir, "README"));

    const result = await discoverFilesWithDiagnostics([dir]);
    const rel = result.files.map((p) => p.slice(posixDir(dir).length + 1)).sort();
    expect(rel).toEqual(["page.tsx"]);
    // README surfaces under its canonical filename rather than lumping
    // into `(no-ext)` so an agent triaging coverage can tell source-
    // shaped no-ext files apart from binary-without-extension blobs.
    expect(result.diagnostics.skippedByExtension).toEqual({
      README: 1,
      ".svelte": 2,
      ".vue": 1,
    });
  });

  it("splits well-known textual no-extension filenames into named buckets", async () => {
    // Each entry surfaces inline under its canonical filename so the
    // `(no-ext)` bucket stays reserved for hash-named blobs and other
    // genuinely unidentifiable extensionless files. Names match case-
    // insensitively but emit canonical-case keys.
    write(join(dir, "page.tsx"));
    write(join(dir, "LICENSE"));
    write(join(dir, "Makefile"));
    write(join(dir, "Dockerfile"));
    write(join(dir, "NOTICE"));
    write(join(dir, "Rakefile"));
    write(join(dir, "weird-blob")); // residual no-ext bucket

    const result = await discoverFilesWithDiagnostics([dir]);
    const rel = result.files.map((p) => p.slice(posixDir(dir).length + 1)).sort();
    expect(rel).toEqual(["page.tsx"]);
    expect(result.diagnostics.skippedByExtension).toEqual({
      "(no-ext)": 1,
      LICENSE: 1,
      Makefile: 1,
      Dockerfile: 1,
      NOTICE: 1,
      Rakefile: 1,
    });
  });

  it("matches well-known textual no-extension filenames case-insensitively (canonical case on the wire)", async () => {
    // Lowercase `license` lands in the same bucket as canonical
    // `LICENSE` — agents reading the wire shape see one stable key
    // regardless of how the file is committed.
    const sub = join(dir, "lower");
    write(join(sub, "license"));
    write(join(dir, "page.tsx"));

    const result = await discoverFilesWithDiagnostics([dir]);
    expect(result.diagnostics.skippedByExtension).toEqual({ LICENSE: 1 });
  });

  it("returns an empty skip map for clean all-parseable directories", async () => {
    write(join(dir, "page.tsx"));
    write(join(dir, "styles.css"));
    write(join(dir, "page.html"));

    const result = await discoverFilesWithDiagnostics([dir]);
    expect(result.files.length).toBe(3);
    expect(result.diagnostics.skippedByExtension).toEqual({});
  });

  it("does not count files rejected by default excludes or gitignore", async () => {
    // __mocks__/ rejects via DEFAULT_EXCLUDED_PATTERNS (user exclude),
    // not via the extension check — must not surface in
    // skippedByExtension, otherwise the warning fires on intentional
    // suppression.
    markGitRoot(dir);
    write(join(dir, ".gitignore"), "bundle.tsx\n");
    write(join(dir, "page.tsx"));
    write(join(dir, "__mocks__", "fs.ts"));
    write(join(dir, "bundle.tsx"));
    // Still count a true extension skip so we know the filter
    // distinguishes the two paths.
    write(join(dir, "Card.svelte"));

    const result = await discoverFilesWithDiagnostics([dir]);
    expect(result.diagnostics.skippedByExtension).toEqual({ ".svelte": 1 });
    // The two pattern-rejected parseable files (.ts in __mocks__,
    // .tsx via gitignore) DO surface under the dedicated channel —
    // closing the per-extension accounting axis without polluting the
    // "we never had a parser for this" surface.
    expect(result.diagnostics.excludedByPatternByExtension).toEqual({
      ".ts": 1,
      ".tsx": 1,
    });
  });

  it("counts parseable files filtered by gitignore under excludedByPatternByExtension", async () => {
    // Closes the per-extension accounting axis exposed by V1-FILES-BY-
    // EXTENSION-GROUND-TRUTH-UNDERCOUNT: when `meta.filesByExtension`
    // undercounts ground-truth file totals because a `.gitignore`
    // pattern silently dropped parseable-extension files, the agent
    // reads the deficit as a parser-routing bug; with this channel,
    // the agent reads "parsed + excludedByPattern = ground truth."
    //
    // Note: the test fixture uses a directory name that is NOT in
    // `DEFAULT_IGNORED_DIRS` (`generated/`, not `dist/` or `build/`),
    // because `DEFAULT_IGNORED_DIRS` is checked at the entry-name
    // level before gitignore matters. `dist/` etc. land in
    // `defaultExcludedArtifactPaths` instead — a separate
    // already-surfaced channel.
    markGitRoot(dir);
    write(join(dir, ".gitignore"), "generated/\n");
    write(join(dir, "src", "page.css"));
    write(join(dir, "src", "app.js"));
    write(join(dir, "generated", "compiled.css"));
    write(join(dir, "generated", "compiled.js"));
    write(join(dir, "generated", "deeper", "extra.css"));

    const result = await discoverFilesWithDiagnostics([dir]);
    expect(result.diagnostics.excludedByPatternByExtension).toEqual({
      ".css": 2,
      ".js": 1,
    });
  });

  it("counts user-excluded parseable files under excludedByPatternByExtension", async () => {
    // The user's `excludes` array is a separate channel from
    // `.gitignore`, but the silent-drop axis is the same — a parseable
    // file that matches a user exclude was never going to reach the
    // parser, and the agent needs to see it in the accounting bucket.
    write(join(dir, "src", "page.tsx"));
    write(join(dir, "third-party", "third.tsx"));
    write(join(dir, "third-party", "third.css"));
    write(join(dir, "src", "page.css"));

    const result = await discoverFilesWithDiagnostics([dir], {
      excludes: ["third-party/**"],
    });
    expect(result.diagnostics.excludedByPatternByExtension).toEqual({
      ".css": 1,
      ".tsx": 1,
    });
  });

  it("returns empty excludedByPatternByExtension when no parseable files are pattern-rejected", async () => {
    // Present-when-meaningful: the discovery layer always populates
    // the field with an empty record so downstream consumers can
    // unconditionally key into it; the surfacing layer
    // (`analysis-coverage.ts`) is what gates on emptiness for the
    // wire shape. The behavior is symmetric with `skippedByExtension`.
    write(join(dir, "page.tsx"));
    write(join(dir, "styles.css"));

    const result = await discoverFilesWithDiagnostics([dir]);
    expect(result.diagnostics.excludedByPatternByExtension).toEqual({});
  });

  it("closes the per-extension accounting invariant on a corpus with mixed drop axes", async () => {
    // Invariant: parsed + skipped + excludedByPattern + sourcemap
    // equals the raw walker count (under the dir-ignore set) — the
    // load-bearing assertion the V1-FILES-BY-EXTENSION-GROUND-TRUTH-
    // UNDERCOUNT backlog item names. Hits every drop axis the agent
    // should see for a parseable extension under directories the
    // walker actually descends into (i.e. not in `DEFAULT_IGNORED_DIRS`).
    // `dist/` / `build/` / `node_modules/` etc. are intentionally
    // omitted: those are dir-level skips already surfaced through
    // `defaultExcludedArtifactPaths` (build artifacts) or are
    // universal caches every consumer expects unsurfaced.
    //
    //   - parsed: src/page.css, src/app.tsx
    //   - skipped (non-parseable ext): src/note.txt
    //   - excludedByPattern (gitignore): generated/compiled.css, generated/big.tsx
    //   - excludedByPattern (DEFAULT_EXCLUDED_PATTERNS): __mocks__/fs.ts
    //   - excludedByPattern (user exclude): third-party/lib.tsx
    //   - sourcemap: assets/app.css.map
    markGitRoot(dir);
    write(join(dir, ".gitignore"), "generated/\n");
    write(join(dir, "src", "page.css"));
    write(join(dir, "src", "app.tsx"));
    write(join(dir, "src", "note.txt"));
    write(join(dir, "generated", "compiled.css"));
    write(join(dir, "generated", "big.tsx"));
    write(join(dir, "__mocks__", "fs.ts"));
    write(join(dir, "third-party", "lib.tsx"));
    write(join(dir, "assets", "app.css.map"));

    const result = await discoverFilesWithDiagnostics([dir], {
      excludes: ["third-party/**"],
    });

    // Closure: the four surfaced buckets sum to the raw walker count
    // under the dir-ignore set. We compute by hand here because the
    // `DEFAULT_IGNORED_DIRS` predicate also lives in the walker, but
    // the fixture deliberately uses directory names outside that set
    // so every visited file lands in exactly one of the four buckets.
    const parsed = result.files.length;
    const skipped = sumValues(result.diagnostics.skippedByExtension);
    const excludedByPattern = sumValues(result.diagnostics.excludedByPatternByExtension);
    const sourcemap = result.diagnostics.sourcemapFiles.length;

    expect(parsed).toBe(2);
    expect(skipped).toBe(1);
    expect(excludedByPattern).toBe(4);
    expect(sourcemap).toBe(1);
    // Invariant: every file the walker considered under the dir-ignore
    // set lands in exactly one of the four buckets.
    expect(parsed + skipped + excludedByPattern + sourcemap).toBe(8);
  });

  it("includes test/spec/story/dev-tools files in discovery by default", async () => {
    // Per the AI-first consumer doctrine (Default-exclude globs are
    // suppression too), only `__mocks__/` clears the
    // definitionally-wrong-for-any-consumer bar. Test fixtures, spec
    // files, Storybook stories, and dev-tools / devtools directories
    // all surface to the scanner so an agent can dismiss false
    // positives in one read; a real a11y bug in test JSX (which gets
    // copy-pasted into production routinely) reaches the agent rather
    // than being silently filtered.
    write(join(dir, "page.tsx"));
    write(join(dir, "page.test.tsx"));
    write(join(dir, "page.spec.ts"));
    write(join(dir, "page.stories.tsx"));
    write(join(dir, "page.story.jsx"));
    write(join(dir, "__tests__", "Form.tsx"));
    write(join(dir, "stories", "Button.tsx"));
    write(join(dir, "dev-tools", "panel.tsx"));
    write(join(dir, "devtools", "inspector.tsx"));
    // __mocks__ remains excluded by default — it's a Jest-runtime
    // injection mechanism and never reaches a user's browser.
    write(join(dir, "__mocks__", "fs.ts"));

    const result = await discoverFilesWithDiagnostics([dir]);
    const rel = result.files.map((p) => p.slice(posixDir(dir).length + 1)).sort();
    expect(rel).toEqual([
      "__tests__/Form.tsx",
      "dev-tools/panel.tsx",
      "devtools/inspector.tsx",
      "page.spec.ts",
      "page.stories.tsx",
      "page.story.jsx",
      "page.test.tsx",
      "page.tsx",
      "stories/Button.tsx",
    ]);
  });

  it("includeTests:true drops the __mocks__ default exclusion too", async () => {
    // The opt-out flag widens what the scanner sees: it disables every
    // default exclusion, including the lone surviving `__mocks__/` rule.
    write(join(dir, "page.tsx"));
    write(join(dir, "__mocks__", "fs.ts"));

    const defaultRun = await discoverFiles([dir]);
    const defaultRel = defaultRun.map((p) => p.slice(posixDir(dir).length + 1)).sort();
    expect(defaultRel).toEqual(["page.tsx"]);

    const includeRun = await discoverFiles([dir], { includeTests: true });
    const includeRel = includeRun.map((p) => p.slice(posixDir(dir).length + 1)).sort();
    expect(includeRel).toEqual(["__mocks__/fs.ts", "page.tsx"]);
  });

  it("routes `.map` sourcemap files into a dedicated bucket rather than skippedByExtension", async () => {
    // Sourcemap exclusion is conventionally correct (generator output,
    // not authored a11y source) but a silent skip is indistinguishable
    // from "tool never saw the file." Discovery routes `.map` files
    // into `sourcemapFiles` so the `sourcemap_files_excluded` warning
    // can declare the exclusion explicitly. The skip map carries no
    // `.map` key — that channel is reserved for parser-routable
    // skips.
    write(join(dir, "page.tsx"));
    write(join(dir, "assets/app.css.map"));
    write(join(dir, "assets/vendor.js.map"));
    write(join(dir, "Card.svelte"));

    const result = await discoverFilesWithDiagnostics([dir]);
    expect(result.diagnostics.skippedByExtension).toEqual({ ".svelte": 1 });
    expect(result.diagnostics.sourcemapFiles).toEqual([
      posixJoin(dir, "assets/app.css.map"),
      posixJoin(dir, "assets/vendor.js.map"),
    ]);
  });

  it("returns sourcemapFiles ascending lexically so the wire shape is deterministic", async () => {
    // Walker iteration order varies across filesystems; the discovery
    // helper sorts the field before returning so consumers
    // (warningsDetails.sourcemap_files_excluded.topPaths) get a stable
    // head slice run-to-run.
    write(join(dir, "page.tsx"));
    write(join(dir, "z.css.map"));
    write(join(dir, "a.css.map"));
    write(join(dir, "m.css.map"));

    const result = await discoverFilesWithDiagnostics([dir]);
    expect(result.diagnostics.sourcemapFiles).toEqual([
      posixJoin(dir, "a.css.map"),
      posixJoin(dir, "m.css.map"),
      posixJoin(dir, "z.css.map"),
    ]);
  });

  it("returns an empty sourcemapFiles list when the discovery walk encounters none", async () => {
    write(join(dir, "page.tsx"));
    write(join(dir, "styles.css"));

    const result = await discoverFilesWithDiagnostics([dir]);
    expect(result.diagnostics.sourcemapFiles).toEqual([]);
  });

  it("surfaces every default-excluded build-artifact directory that contained a parseable file", async () => {
    // The walker silently skips `dist/`, `build/`, `.next/`, etc.
    // (per DEFAULT_IGNORED_DIRS). Without the diagnostic, an agent
    // calling scan_project against a Next.js / Vite repo gets
    // `findings: []` with no signal that the compiled output was
    // dropped at the directory level — the canonical "Default-exclude
    // globs are suppression too" silent-miss shape. The diagnostic
    // surfaces every matched directory carrying ≥ 1 parseable file
    // with a deterministic `{path, fileCount, sampleFiles}` shape.
    write(join(dir, "src", "page.tsx"));
    write(join(dir, "dist", "bundle.js"));
    write(join(dir, "dist", "page.html"));
    write(join(dir, ".next", "static", "chunk.js"));
    // node_modules is in DEFAULT_IGNORED_DIRS but is intentionally
    // NOT in the surfaced subset — agents already expect it dropped.
    write(join(dir, "node_modules", "lib", "index.js"));

    const result = await discoverFilesWithDiagnostics([dir]);
    const paths = result.diagnostics.defaultExcludedArtifactPaths;
    expect(paths.map((e) => e.path)).toEqual([posixJoin(dir, ".next"), posixJoin(dir, "dist")]);
    const distEntry = paths.find((e) => e.path === posixJoin(dir, "dist"));
    expect(distEntry?.fileCount).toBe(2);
    expect(distEntry?.sampleFiles.length).toBeGreaterThan(0);
    expect(distEntry?.sampleFiles.length).toBeLessThanOrEqual(3);
    for (const sample of distEntry?.sampleFiles ?? []) {
      expect(sample.startsWith(posixJoin(dir, "dist"))).toBe(true);
    }
    // Universal cache dirs stay out of the surfaced subset by design.
    expect(paths.find((e) => e.path === posixJoin(dir, "node_modules"))).toBeUndefined();
  });

  it("drops default-excluded directories that contain no parseable files", async () => {
    // An empty `dist/` (or one containing only binary-asset files
    // that don't match PARSEABLE_EXTENSIONS) shouldn't fire the
    // warning — the silent miss only applies when the scanner
    // dropped plausibly authorable a11y surface. Sourcemap-only
    // directories drop too because `.map` isn't a parseable
    // extension.
    write(join(dir, "src", "page.tsx"));
    write(join(dir, "dist", "logo.png"));
    write(join(dir, "build", "bundle.js.map"));

    const result = await discoverFilesWithDiagnostics([dir]);
    expect(result.diagnostics.defaultExcludedArtifactPaths).toEqual([]);
  });

  it("returns defaultExcludedArtifactPaths sorted by directory path", async () => {
    write(join(dir, "src", "page.tsx"));
    write(join(dir, "out", "bundle.js"));
    write(join(dir, "build", "bundle.js"));
    write(join(dir, "dist", "bundle.js"));

    const result = await discoverFilesWithDiagnostics([dir]);
    const paths = result.diagnostics.defaultExcludedArtifactPaths.map((e) => e.path);
    expect(paths).toEqual([posixJoin(dir, "build"), posixJoin(dir, "dist"), posixJoin(dir, "out")]);
  });
});
