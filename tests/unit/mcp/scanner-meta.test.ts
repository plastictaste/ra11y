/**
 * Unit tests for the `no_config_found` warning-detail summarizer and
 * its candidate-paths helper in `src/mcp/scanner-meta.ts`.
 *
 * Doctrine (`docs/kb/architecture/ai-first-consumer.md`):
 *   - "Empty `warningsDetails.<code>: {}` is dishonest" — the
 *     `no_config_found` payload must always ship actionable specifics
 *     when the summarizer has a valid `searchedFrom` input. The
 *     candidate paths the loader walked through are that signal.
 *   - "Verbose meta is signal, not clutter — `configSearchedFrom` is
 *     present-when-meaningful" — the `searchedFrom` scalar drops only
 *     when it would echo `cwd` / `scanned.root` /
 *     `dirname(scanned.file)` already on the response.
 *
 * The helper enumerates the cross-product of every ancestor directory
 * (bounded depth, no I/O) × `CONFIG_FILENAMES`. That keeps the warning
 * payload pure-over-its-inputs while giving the agent a list of paths
 * to triage against — "did the loader miss an existing config at an
 * unexpected name?" or "should I bootstrap a new one?".
 */

import { describe, expect, it } from "bun:test";
import { CONFIG_FILENAMES } from "../../../src/config/loader.ts";
import type { ScannedEnvelope } from "../../../src/mcp/scanned-envelope.ts";
import {
  noConfigFoundSearchedPaths,
  noConfigFoundWarningDetail,
} from "../../../src/mcp/scanner-meta.ts";

describe("noConfigFoundSearchedPaths", () => {
  it("enumerates the cross-product of ancestor dirs × CONFIG_FILENAMES with the search base first", () => {
    const out = noConfigFoundSearchedPaths("/proj/sub");
    // The leading slice is the per-filename precedence list at the
    // immediate search base — the agent reads the first candidate as
    // "this is what the loader would have looked for first."
    expect(out.length).toBeGreaterThan(0);
    expect(out.slice(0, CONFIG_FILENAMES.length)).toEqual([
      "/proj/sub/ra11y.config.ts",
      "/proj/sub/ra11y.config.js",
      "/proj/sub/ra11y.config.mjs",
      "/proj/sub/ra11y.config.json",
    ]);
    // The walk-up continues to the parent dir before the bound kicks in.
    expect(out).toContain("/proj/ra11y.config.ts");
  });

  it("returns an empty array on empty / blank input — the summarizer falls through to the truncation sentinel", () => {
    expect(noConfigFoundSearchedPaths("")).toEqual([]);
  });

  it("never overflows past the depth bound on pathologically nested input", () => {
    // 12-segment path × 4 filenames could produce 48 entries if the
    // walk were unbounded. The cap (8 dirs × 4 filenames = 32) keeps
    // the payload dense.
    const deep = "/a/b/c/d/e/f/g/h/i/j/k/l/m";
    const out = noConfigFoundSearchedPaths(deep);
    expect(out.length).toBeLessThanOrEqual(8 * CONFIG_FILENAMES.length);
    expect(out.length).toBeGreaterThan(0);
  });

  it("terminates at filesystem root rather than looping", () => {
    // The walk-up stops when posixDirname returns the same path
    // (filesystem root) — the helper must not emit duplicates or loop.
    const out = noConfigFoundSearchedPaths("/");
    expect(out).toEqual([
      "/ra11y.config.ts",
      "/ra11y.config.js",
      "/ra11y.config.mjs",
      "/ra11y.config.json",
    ]);
  });
});

describe("noConfigFoundWarningDetail — searchedPaths is always populated", () => {
  it("ships `{ searchedFrom, searchedPaths }` when the search base adds signal", () => {
    const detail = noConfigFoundWarningDetail({
      searchedFrom: "/proj/root",
      callerCwd: "/elsewhere",
      scannedRoot: "/elsewhere/tree",
    });
    expect(detail).toHaveProperty("searchedFrom", "/proj/root");
    expect(detail).toHaveProperty("searchedPaths");
    const paths = (detail as { searchedPaths: readonly string[] }).searchedPaths;
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain("/proj/root/ra11y.config.ts");
  });

  it("drops `searchedFrom` when it echoes callerCwd but keeps `searchedPaths`", () => {
    const detail = noConfigFoundWarningDetail({
      searchedFrom: "/proj/cwd",
      callerCwd: "/proj/cwd",
    });
    expect(detail).not.toHaveProperty("searchedFrom");
    expect(detail).toHaveProperty("searchedPaths");
    const paths = (detail as { searchedPaths: readonly string[] }).searchedPaths;
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain("/proj/cwd/ra11y.config.ts");
  });

  it("drops `searchedFrom` when it echoes scannedRoot but keeps `searchedPaths`", () => {
    const detail = noConfigFoundWarningDetail({
      searchedFrom: "/proj/root",
      scannedRoot: "/proj/root",
    });
    expect(detail).not.toHaveProperty("searchedFrom");
    expect(detail).toHaveProperty("searchedPaths");
  });

  it("drops `searchedFrom` when it echoes scanned.root via the envelope shape", () => {
    const scanned: ScannedEnvelope = { mode: "project", root: "/proj/root" };
    const detail = noConfigFoundWarningDetail({
      searchedFrom: "/proj/root",
      scanned,
    });
    expect(detail).not.toHaveProperty("searchedFrom");
    expect(detail).toHaveProperty("searchedPaths");
  });

  it("drops `searchedFrom` when it echoes dirname(scanned.file) via the file-mode envelope", () => {
    const scanned: ScannedEnvelope = { mode: "file", file: "/proj/sub/index.html" };
    const detail = noConfigFoundWarningDetail({
      searchedFrom: "/proj/sub",
      scanned,
    });
    expect(detail).not.toHaveProperty("searchedFrom");
    expect(detail).toHaveProperty("searchedPaths");
    const paths = (detail as { searchedPaths: readonly string[] }).searchedPaths;
    expect(paths).toContain("/proj/sub/ra11y.config.ts");
  });

  it("payload always carries `searchedPaths` non-empty when invoked with a valid searchedFrom — the warning is never shipped with empty specifics", () => {
    // Doctrine: "Empty `warningsDetails.<code>: {}` is dishonest."
    // Every code path through `noConfigFoundWarningDetail` (with a
    // non-empty `searchedFrom`) returns a payload with at least one
    // candidate path the agent can triage against.
    const variants = [
      { searchedFrom: "/a/b" },
      { searchedFrom: "/a/b", callerCwd: "/a/b" },
      { searchedFrom: "/a/b", scannedRoot: "/a/b" },
      { searchedFrom: "/a/b", callerCwd: "/x/y", scannedRoot: "/x/z" },
      {
        searchedFrom: "/a/b",
        scanned: { mode: "project" as const, root: "/a/b" },
      },
    ];
    for (const args of variants) {
      const detail = noConfigFoundWarningDetail(args);
      const paths = (detail as { searchedPaths?: readonly string[] }).searchedPaths;
      expect(paths).toBeDefined();
      expect((paths ?? []).length).toBeGreaterThan(0);
    }
  });
});
