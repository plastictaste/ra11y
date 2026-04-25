/**
 * Unit tests for `src/mcp/additional-paths-classifier.ts`.
 *
 * The classifier turns caller-supplied `additionalPaths` entries into
 * per-path skip reasons so `filesAdded: 0` doesn't silently conflate
 * "path absent" with "path present but unparseable" with "path
 * excluded." The invariant the tests defend:
 *
 *   Every passed `additionalPaths` entry resolves to EITHER
 *   `filesAdded > 0` for the overall scan OR appears in
 *   `additionalPathsScanned.skipped[]` with a named reason — never
 *   silently nothing.
 *
 * Specifically covers the fourth `no-parseable-files` reason
 * (V1-ADDITIONAL-PATHS-PRESENT-BUT-UNPARSEABLE): prior versions fell
 * through without a skip entry when a directory held ≥1 file but none
 * were parseable. The Ruby-only directory case
 * (`additionalPaths: ["rake/"]` on a `.rb`-only tree) is the canonical
 * silent-skip the new reason closes.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdditionalPathSkip,
  additionalPathsScannedField,
  classifyAdditionalPathSkips,
} from "../../../src/mcp/additional-paths-classifier.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "ra11y-additional-paths-classifier-"));
}

describe("classifyAdditionalPathSkips", () => {
  it("emits `not-found` for a path that does not exist on disk", () => {
    const root = makeRoot();
    const out = classifyAdditionalPathSkips(["rake/"], root, []);
    expect(out).toEqual([{ path: "rake/", reason: "not-found" }]);
  });

  it("emits `unsupported-extension` for a file whose extension has no parser", () => {
    const root = makeRoot();
    writeFileSync(join(root, "notes.txt"), "plain text");
    const out = classifyAdditionalPathSkips(["notes.txt"], root, []);
    expect(out).toEqual([{ path: "notes.txt", reason: "unsupported-extension" }]);
  });

  it("emits `excluded-by-glob` when a path matches a configured exclude pattern", () => {
    const root = makeRoot();
    mkdirSync(join(root, "generated"), { recursive: true });
    writeFileSync(join(root, "generated", "out.css"), ".foo {}");
    const out = classifyAdditionalPathSkips(["generated"], root, ["generated/**", "generated"]);
    expect(out).toEqual([{ path: "generated", reason: "excluded-by-glob" }]);
  });

  // V1-ADDITIONAL-PATHS-PRESENT-BUT-UNPARSEABLE: the canonical case.
  // Directory exists, holds files, but every file's extension falls
  // outside the parser set. Prior to this fix the classifier fell
  // through silently and `filesAdded: 0` was indistinguishable from a
  // path the scanner ignored. The `no-parseable-files` reason names
  // the condition and the extensions payload tells the agent which
  // language the directory holds so it can decide whether to (a) fix
  // the path, (b) request parser coverage, or (c) drop the flag.
  it("emits `no-parseable-files` with an extension histogram when a directory holds only unparseable files", () => {
    const root = makeRoot();
    mkdirSync(join(root, "rake"), { recursive: true });
    writeFileSync(join(root, "rake", "tasks.rb"), "task :foo do; end");
    writeFileSync(join(root, "rake", "helpers.rb"), "module Helpers; end");
    writeFileSync(join(root, "rake", "README"), "docs");

    const out = classifyAdditionalPathSkips(["rake/"], root, []);
    expect(out).toHaveLength(1);
    const [entry] = out;
    expect(entry?.path).toBe("rake/");
    expect(entry?.reason).toBe("no-parseable-files");
    // Narrow the discriminated union before reading `extensions`.
    if (entry?.reason === "no-parseable-files") {
      expect(entry.extensions[".rb"]).toBe(2);
      expect(entry.extensions[""]).toBe(1); // README — extensionless
      // No parseable extension keys in the histogram.
      expect(Object.keys(entry.extensions).some((k) => k === ".ts" || k === ".tsx")).toBe(false);
    }
  });

  it("recurses into nested directories when counting extensions", () => {
    const root = makeRoot();
    mkdirSync(join(root, "rake", "lib", "tasks"), { recursive: true });
    writeFileSync(join(root, "rake", "lib", "tasks", "deploy.rb"), "# deploy");
    writeFileSync(join(root, "rake", "lib", "tasks", "build.rb"), "# build");

    const out = classifyAdditionalPathSkips(["rake"], root, []);
    const entry = out[0];
    expect(entry?.reason).toBe("no-parseable-files");
    if (entry?.reason === "no-parseable-files") {
      expect(entry.extensions[".rb"]).toBe(2);
    }
  });

  it("does NOT emit `no-parseable-files` when the directory contains at least one parseable file", () => {
    const root = makeRoot();
    mkdirSync(join(root, "mixed"), { recursive: true });
    writeFileSync(join(root, "mixed", "app.tsx"), "export const App = () => null;");
    writeFileSync(join(root, "mixed", "script.rb"), "# ruby");

    const out = classifyAdditionalPathSkips(["mixed"], root, []);
    // The directory contributed (or at least could contribute) a
    // parseable file — that's either filesAdded > 0 or the redundancy
    // case, neither of which belongs under `skipped`.
    expect(out).toEqual([]);
  });

  it("does NOT emit `no-parseable-files` for an empty directory", () => {
    const root = makeRoot();
    mkdirSync(join(root, "empty"), { recursive: true });
    const out = classifyAdditionalPathSkips(["empty"], root, []);
    // Empty directory: totalFiles === 0, so the "≥1 file but none
    // parseable" predicate is false. No skip entry. `filesAdded: 0`
    // is the honest summary and the `redundant_additional_paths`
    // warning path does not fire either (nothing resolved).
    expect(out).toEqual([]);
  });

  it("preserves caller order across a mix of skip reasons", () => {
    const root = makeRoot();
    writeFileSync(join(root, "app.tsx"), "export const App = () => null;");
    mkdirSync(join(root, "rake"), { recursive: true });
    writeFileSync(join(root, "rake", "tasks.rb"), "task :foo");
    writeFileSync(join(root, "notes.txt"), "plain");

    const out = classifyAdditionalPathSkips(
      ["does-not-exist", "rake/", "notes.txt", "app.tsx"],
      root,
      [],
    );
    // Ordering-of-present-entries invariant: skip entries appear in
    // the same relative order as their input positions, and the
    // parseable `app.tsx` entry (no skip) simply doesn't appear.
    expect(out.map((e) => e.path)).toEqual(["does-not-exist", "rake/", "notes.txt"]);
    expect(out.map((e) => e.reason)).toEqual([
      "not-found",
      "no-parseable-files",
      "unsupported-extension",
    ]);
  });
});

describe("additionalPathsScannedField", () => {
  it("returns an empty object when no additionalPaths were supplied", () => {
    const root = makeRoot();
    const field = additionalPathsScannedField({
      additionalPaths: [],
      filesAdded: 0,
      root,
      excludes: [],
    });
    expect(field).toEqual({});
  });

  it("includes the skipped array when at least one path was classified", () => {
    const root = makeRoot();
    const field = additionalPathsScannedField({
      additionalPaths: ["does-not-exist"],
      filesAdded: 0,
      root,
      excludes: [],
    });
    expect(field.additionalPathsScanned).toBeDefined();
    expect(field.additionalPathsScanned?.skipped).toEqual([
      { path: "does-not-exist", reason: "not-found" },
    ]);
    expect(field.additionalPathsScanned?.paths).toEqual(["does-not-exist"]);
    expect(field.additionalPathsScanned?.filesAdded).toBe(0);
  });

  it("omits `skipped` when every path contributed (per-path resolution, not caller count)", () => {
    const root = makeRoot();
    writeFileSync(join(root, "app.tsx"), "export const App = () => null;");
    const field = additionalPathsScannedField({
      additionalPaths: ["app.tsx"],
      filesAdded: 1,
      root,
      excludes: [],
    });
    expect(field.additionalPathsScanned?.skipped).toBeUndefined();
  });

  // Core invariant the backlog item asks the test suite to defend.
  // Any input entry must be visible to the agent EITHER as a
  // contribution to `filesAdded > 0` OR as a named `skipped[]` entry
  // — the silent "path present but contributed nothing" shape is the
  // dishonest zero-output-success case the classifier exists to
  // prevent.
  it("invariant: every additionalPaths entry resolves to filesAdded>0 OR a skipped[] entry", () => {
    const root = makeRoot();
    writeFileSync(join(root, "app.tsx"), "export const App = () => null;");
    mkdirSync(join(root, "rake"), { recursive: true });
    writeFileSync(join(root, "rake", "tasks.rb"), "task :foo");
    writeFileSync(join(root, "notes.txt"), "plain text");
    mkdirSync(join(root, "generated"), { recursive: true });
    writeFileSync(join(root, "generated", "out.css"), ".foo {}");

    const paths = [
      "does-not-exist", // not-found
      "rake/", // no-parseable-files
      "notes.txt", // unsupported-extension
      "generated", // excluded-by-glob
      "app.tsx", // parseable — counts via filesAdded
    ];
    // filesAdded would be ≥1 in a real scan because app.tsx is
    // parseable; the test asserts classification, not filesAdded
    // semantics.
    const field = additionalPathsScannedField({
      additionalPaths: paths,
      filesAdded: 1,
      root,
      excludes: ["generated/**", "generated"],
    });
    const skipped = field.additionalPathsScanned?.skipped ?? [];
    const skippedPaths = new Set(skipped.map((e: AdditionalPathSkip) => e.path));

    // Every non-parseable path must appear in skipped[]; the one
    // parseable file is covered by filesAdded > 0 and legitimately
    // omitted from skipped.
    for (const p of paths) {
      if (p === "app.tsx") continue;
      expect(skippedPaths.has(p)).toBe(true);
    }
    // Parseable files must NOT appear in skipped[] — they'd
    // double-count against the silent-nothing invariant.
    expect(skippedPaths.has("app.tsx")).toBe(false);
  });
});
