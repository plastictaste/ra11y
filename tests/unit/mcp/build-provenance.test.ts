/**
 * Unit tests for `src/mcp/build-provenance.ts`.
 *
 * The module resolves three fields once per process and merges them
 * into every MCP tool response under `meta`. The invariants below are
 * what keeps the provenance signal honest:
 *
 *   1. `ra11yVersion` is always present and matches `package.json`.
 *   2. `commitHash` is present on a real git checkout and absent when
 *      `.git` is unreachable — conditional-spread per the AI-first
 *      consumer model ("Ambiguous field shapes are dishonest").
 *   3. `bundleMtime` is an ISO-8601 string derived from the bundle's
 *      filesystem mtime, or absent when the stat fails.
 *   4. `annotateBuildProvenance` merges the triple into the response's
 *      top-level `meta` without destroying existing meta fields, and
 *      creates `meta` when absent.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetBuildProvenance,
  __setBundlePathOverride,
  annotateBuildProvenance,
  getBuildProvenance,
} from "../../../src/mcp/build-provenance.ts";
import type { McpToolResult } from "../../../src/mcp/tools-helpers.ts";

const PKG_JSON_URL = new URL("../../../package.json", import.meta.url);

describe("getBuildProvenance", () => {
  afterEach(() => {
    __resetBuildProvenance();
  });

  it("always reports ra11yVersion matching package.json", () => {
    const raw = readFileSync(PKG_JSON_URL, "utf8");
    const pkg = JSON.parse(raw) as { version: string };
    const prov = getBuildProvenance();
    expect(prov.ra11yVersion).toBe(pkg.version);
    expect(typeof prov.ra11yVersion).toBe("string");
    expect(prov.ra11yVersion.length).toBeGreaterThan(0);
  });

  it("omits commitHash when the bundle path has no .git ancestor", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ra11y-prov-nogit-"));
    try {
      // Fake bundle file with no .git anywhere up the walk — /tmp has
      // no .git ancestor on any supported platform.
      const bundlePath = join(tmp, "fake-bundle.js");
      writeFileSync(bundlePath, "// synthetic bundle\n", "utf8");
      __setBundlePathOverride(bundlePath);
      const prov = getBuildProvenance();
      expect(prov.commitHash).toBeUndefined();
      // bundleMtime should still resolve because we stat'd the real file.
      expect(typeof prov.bundleMtime).toBe("string");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolves commitHash from a synthetic .git with symbolic HEAD + loose ref", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ra11y-prov-git-"));
    try {
      // Build a minimal git repo layout with a symbolic HEAD pointing
      // to a loose ref file. No real git commands required — the
      // resolver reads the filesystem directly.
      const gitDir = join(tmp, ".git");
      mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
      writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
      const sha = "0123456789abcdef0123456789abcdef01234567";
      writeFileSync(join(gitDir, "refs", "heads", "main"), `${sha}\n`, "utf8");
      // Place the bundle inside the fake repo so the walk finds .git.
      const bundleDir = join(tmp, "src", "mcp");
      mkdirSync(bundleDir, { recursive: true });
      const bundlePath = join(bundleDir, "fake-bundle.js");
      writeFileSync(bundlePath, "// synthetic bundle\n", "utf8");
      __setBundlePathOverride(bundlePath);
      const prov = getBuildProvenance();
      expect(prov.commitHash).toBe(sha);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolves commitHash from a packed-refs entry when the loose ref is absent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ra11y-prov-packed-"));
    try {
      const gitDir = join(tmp, ".git");
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/feature\n", "utf8");
      const sha = "abcdef0123456789abcdef0123456789abcdef01";
      writeFileSync(
        join(gitDir, "packed-refs"),
        `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/feature\n`,
        "utf8",
      );
      const bundlePath = join(tmp, "bundle.js");
      writeFileSync(bundlePath, "//\n", "utf8");
      __setBundlePathOverride(bundlePath);
      const prov = getBuildProvenance();
      expect(prov.commitHash).toBe(sha);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolves commitHash for a worktree (`.git` is a gitdir-pointer file)", () => {
    // Two temp dirs: the "main repo" (where refs live) and the
    // "worktree" (where .git is a file pointing at the main repo's
    // per-worktree gitdir).
    const main = mkdtempSync(join(tmpdir(), "ra11y-prov-wt-main-"));
    const worktree = mkdtempSync(join(tmpdir(), "ra11y-prov-wt-tree-"));
    try {
      const mainGit = join(main, ".git");
      const wtGitDir = join(mainGit, "worktrees", "feature");
      mkdirSync(join(mainGit, "refs", "heads"), { recursive: true });
      mkdirSync(wtGitDir, { recursive: true });
      const sha = "1111222233334444555566667777888899990000";
      // Main repo has the ref on disk.
      writeFileSync(join(mainGit, "refs", "heads", "feature"), `${sha}\n`, "utf8");
      // Worktree gitdir has its own HEAD + commondir pointer back to
      // the main repo's .git.
      writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/feature\n", "utf8");
      writeFileSync(join(wtGitDir, "commondir"), `${mainGit}\n`, "utf8");
      // Worktree `.git` is a file with `gitdir:` pointing at the
      // per-worktree gitdir.
      writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");
      const bundlePath = join(worktree, "bundle.js");
      writeFileSync(bundlePath, "//\n", "utf8");
      __setBundlePathOverride(bundlePath);
      const prov = getBuildProvenance();
      expect(prov.commitHash).toBe(sha);
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("returns bundleMtime as a valid ISO-8601 timestamp", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ra11y-prov-mtime-"));
    try {
      const bundlePath = join(tmp, "bundle.js");
      writeFileSync(bundlePath, "//\n", "utf8");
      // Pin mtime to a known instant so the assertion is deterministic.
      const when = new Date("2024-03-15T12:34:56.000Z");
      utimesSync(bundlePath, when, when);
      __setBundlePathOverride(bundlePath);
      const prov = getBuildProvenance();
      expect(prov.bundleMtime).toBeDefined();
      expect(prov.bundleMtime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // Round-trip through Date to confirm it parses.
      const parsed = new Date(prov.bundleMtime ?? "");
      expect(Number.isFinite(parsed.getTime())).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("caches the resolution — two calls without a reset return the same object", () => {
    const first = getBuildProvenance();
    const second = getBuildProvenance();
    expect(second).toBe(first); // reference-identical: provenance is immutable per process
  });

  it("omits commitHash when resolving against a tmp bundle (no .git ancestor) — present-when-meaningful", () => {
    // Canonical shape for the npm-install path: bundle lives under
    // `node_modules/@ra11y/core/dist/cli.js`, there's no `.git` on the
    // walk, and the conditional-spread drops the field entirely.
    const tmp = mkdtempSync(join(tmpdir(), "ra11y-prov-npm-"));
    try {
      const bundlePath = join(tmp, "cli.js");
      writeFileSync(bundlePath, "//\n", "utf8");
      __setBundlePathOverride(bundlePath);
      const prov = getBuildProvenance();
      expect(Object.hasOwn(prov, "commitHash")).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("annotateBuildProvenance", () => {
  const makeResult = (payload: unknown): McpToolResult => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });

  beforeEach(() => {
    __resetBuildProvenance();
  });
  afterEach(() => {
    __resetBuildProvenance();
  });

  it("injects ra11yVersion + bundleMtime into meta when meta is absent", () => {
    const result = makeResult({ plan: { notes: 0 }, files: [] });
    const annotated = annotateBuildProvenance(result);
    const parsed = JSON.parse(annotated.content[0]!.text) as {
      meta: { ra11yVersion: string; bundleMtime?: string; commitHash?: string };
    };
    expect(parsed.meta).toBeDefined();
    expect(typeof parsed.meta.ra11yVersion).toBe("string");
    expect(parsed.meta.ra11yVersion.length).toBeGreaterThan(0);
  });

  it("preserves existing meta fields and overlays provenance on top", () => {
    const result = makeResult({
      meta: { filesScanned: 42, configSource: "ra11y.config.ts" },
    });
    const annotated = annotateBuildProvenance(result);
    const parsed = JSON.parse(annotated.content[0]!.text) as {
      meta: { filesScanned: number; configSource: string; ra11yVersion: string };
    };
    expect(parsed.meta.filesScanned).toBe(42);
    expect(parsed.meta.configSource).toBe("ra11y.config.ts");
    expect(parsed.meta.ra11yVersion).toBeDefined();
  });

  it("leaves the result untouched when content[0] is not text", () => {
    const odd: McpToolResult = { content: [] };
    const annotated = annotateBuildProvenance(odd);
    expect(annotated).toBe(odd);
  });

  it("leaves the result untouched when the text payload is not JSON", () => {
    const result: McpToolResult = {
      content: [{ type: "text", text: "not json at all" }],
    };
    const annotated = annotateBuildProvenance(result);
    expect(annotated).toBe(result);
  });

  it("annotates error envelopes too — structuredContent carries a mirrored meta", () => {
    const result: McpToolResult = {
      content: [{ type: "text", text: JSON.stringify({ error: "oops", code: "bad" }) }],
      structuredContent: { code: "bad", message: "oops" },
      isError: true,
    };
    const annotated = annotateBuildProvenance(result);
    // Text payload got meta merged in.
    const parsed = JSON.parse(annotated.content[0]!.text) as {
      error: string;
      meta: { ra11yVersion: string };
    };
    expect(parsed.error).toBe("oops");
    expect(parsed.meta.ra11yVersion).toBeDefined();
    // structuredContent got meta merged in too so agents reading the
    // structured lane see the same provenance signal.
    expect(annotated.structuredContent).toBeDefined();
    const structuredMeta = (annotated.structuredContent as { meta: { ra11yVersion: string } }).meta;
    expect(structuredMeta.ra11yVersion).toBeDefined();
    expect(annotated.isError).toBe(true);
  });

  it("replaces a non-object existing meta (defensive — handler bugs get corrected, not propagated)", () => {
    const result = makeResult({ meta: "oops-not-an-object" });
    const annotated = annotateBuildProvenance(result);
    const parsed = JSON.parse(annotated.content[0]!.text) as {
      meta: { ra11yVersion: string };
    };
    expect(typeof parsed.meta).toBe("object");
    expect(parsed.meta.ra11yVersion).toBeDefined();
  });
});
