/**
 * Unit tests for `src/mcp/warnings.ts` — the `computeScanWarnings`
 * mapping from scan-meta inputs to the structured `ScanWarningCode[]`
 * surfaced on `scan_project` / `scan` responses.
 *
 * Two invariants guard the silent-success failure mode:
 *   1. Every code fires on its named condition and only its named
 *      condition (over-surfacing is the cheap failure mode per
 *      CLAUDE.md §1 "Failure modes are asymmetric").
 *   2. When NO condition holds, the function returns an empty array so
 *      callers can conditional-spread and omit the field (CLAUDE.md §1
 *      "Ambiguous field shapes are dishonest" — never emit `warnings: []`).
 */

import { describe, expect, it } from "bun:test";
import {
  computeScanWarningDetails,
  computeScanWarnings,
  tokenBudgetTruncatedDetailsField,
  warningsField,
  warningsFieldFromScanMeta,
  warningsFromScanMeta,
} from "../../../src/mcp/warnings.ts";

describe("computeScanWarnings", () => {
  it("returns no codes on a healthy scan", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {},
      filesByExtension: { ".tsx": 40, ".css": 5 },
    });
    expect(codes).toEqual([]);
  });

  it("fires `scanned_zero_files` when filesScanned is zero — the canonical `cwd: wrong-path` silent-success case", () => {
    const codes = computeScanWarnings({
      filesScanned: 0,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(codes).toContain("scanned_zero_files");
  });

  it("fires `root_source_defaulted` when rootSource is `git` (spawn-cwd was auto-promoted without the caller's say-so)", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "git",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(codes).toContain("root_source_defaulted");
  });

  it("fires `root_source_defaulted` when rootSource is `spawn-cwd` (plain spawn directory, no git root either)", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "spawn-cwd",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(codes).toContain("root_source_defaulted");
  });

  it("does NOT fire `root_source_defaulted` when the caller passed cwd (rootSource: explicit)", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(codes).not.toContain("root_source_defaulted");
  });

  it("does NOT fire `root_source_defaulted` when the host declared a root (rootSource: host-root)", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "host-root",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(codes).not.toContain("root_source_defaulted");
  });

  it("does NOT fire `root_source_defaulted` when the tool has no root-resolution step (rootSource: null for `scan`)", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: null,
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(codes).not.toContain("root_source_defaulted");
  });

  // Q-SHARED-NO-CONFIG-WARNING-TINY-REPO: `no_config_found` fires only
  // when (a) the loader walk came back empty, (b) the scan saw ≥ 10
  // files (demo-size scans are the normal case for a missing config),
  // AND (c) the walk saw a `package.json` / ra11y.config.* somewhere —
  // evidence that the walk reached a real Node project root. Otherwise
  // `meta.configSource: null` already carries the only honest signal
  // and the top-level warning is duplicative noise.
  it("fires `no_config_found` when configSource is null, filesScanned ≥ 10, and the walk saw a project marker", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: null,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: true,
    });
    expect(codes).toContain("no_config_found");
  });

  it("does NOT fire `no_config_found` when configSource is undefined (tool did not attempt resolution)", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: undefined,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: true,
    });
    expect(codes).not.toContain("no_config_found");
  });

  it("does NOT fire `no_config_found` on tiny-repo scans (filesScanned < 10) even when configSource is null and the walk saw a marker", () => {
    // Canonical repro: 50projects50days-style standalone dirs (≤ 3
    // files each), bootstrap/jekyll sub-tree demos, website-templates
    // individual dirs — `meta.configSource: null` already tells the
    // agent the loader found nothing; the top-level warning would
    // fire on every such scan as duplicative noise.
    const codes = computeScanWarnings({
      filesScanned: 3,
      rootSource: "explicit",
      configSource: null,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: true,
    });
    expect(codes).not.toContain("no_config_found");
  });

  it("does NOT fire `no_config_found` when the walk saw no project marker (scratch dir, not a Node project)", () => {
    // When the walk completes without finding `package.json` /
    // ra11y.config.*, the absence of a config is the normal shape —
    // the user is scanning a scratch directory, not a project root
    // that's missing a ra11y.config.*. `meta.configSource: null`
    // stays populated for agents that need the bit.
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: null,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: false,
    });
    expect(codes).not.toContain("no_config_found");
  });

  it("does NOT fire `no_config_found` when the probe flag is omitted (caller did not probe — fail-safe to no-warning)", () => {
    // Callers that don't probe (undefined flag) get the conservative
    // outcome: no warning. The code surfaces only on positive proof
    // that the walk reached a Node project root.
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: null,
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(codes).not.toContain("no_config_found");
  });

  it("fires `no_config_found` at the filesScanned boundary (== 10) with the marker present", () => {
    // Boundary test — the predicate is `>= 10`, not `> 10`.
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: null,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: true,
    });
    expect(codes).toContain("no_config_found");
  });

  it("fires `tailwind_detected_css_undercounted` when the css_coverage_thin hint carries detail.tailwindDetected=true and .css files < 3", () => {
    const codes = computeScanWarnings({
      filesScanned: 60,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        // V1-HINTS-STRUCTURED-CODE: the warnings module dispatches on
        // `detail.tailwindDetected` rather than substring-matching text.
        hints: [
          {
            code: "css_coverage_thin",
            text: "Only 1 CSS file(s) scanned vs 60 JSX/HTML file(s). Tailwind usage detected: run the build...",
            detail: { cssFiles: 1, markupFiles: 60, tailwindDetected: true },
          },
        ],
      },
      filesByExtension: { ".tsx": 60, ".css": 1 },
    });
    expect(codes).toContain("tailwind_detected_css_undercounted");
  });

  it("does NOT fire `tailwind_detected_css_undercounted` when Tailwind was detected but CSS coverage is fine", () => {
    const codes = computeScanWarnings({
      filesScanned: 60,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        hints: [
          {
            code: "css_coverage_thin",
            text: "Tailwind usage detected: run the build...",
            detail: { cssFiles: 5, markupFiles: 60, tailwindDetected: true },
          },
        ],
      },
      filesByExtension: { ".tsx": 60, ".css": 5 },
    });
    expect(codes).not.toContain("tailwind_detected_css_undercounted");
  });

  it("does NOT fire `tailwind_detected_css_undercounted` when hints exist but none name Tailwind", () => {
    const codes = computeScanWarnings({
      filesScanned: 60,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        hints: [
          {
            code: "css_coverage_thin",
            text: "Build the site and point scan at the emitted .css...",
            detail: { cssFiles: 0, markupFiles: 60, tailwindDetected: false },
          },
        ],
      },
      filesByExtension: { ".tsx": 60 },
    });
    expect(codes).not.toContain("tailwind_detected_css_undercounted");
  });

  it("fires `template_files_parsed_as_literal` when templateDirectivesFound is populated AND a finding overlaps a directive", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        templateDirectivesFound: ["jinja-or-liquid"],
      },
      filesByExtension: { ".html": 5 },
      templateDirectivesOverlap: true,
    });
    expect(codes).toContain("template_files_parsed_as_literal");
  });

  it("does NOT fire `template_files_parsed_as_literal` when directives present but no finding overlaps", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        templateDirectivesFound: ["jinja-or-liquid"],
      },
      filesByExtension: { ".html": 5 },
      templateDirectivesOverlap: false,
    });
    expect(codes).not.toContain("template_files_parsed_as_literal");
  });

  it("does NOT fire `template_files_parsed_as_literal` when templateDirectivesFound is empty/absent", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { templateDirectivesFound: [] },
      filesByExtension: { ".html": 5 },
    });
    expect(codes).not.toContain("template_files_parsed_as_literal");
  });

  // V1-FRONTMATTER-AS-TEMPLATE-DIRECTIVE-TRIGGER: frontmatter is a
  // parser-level substrate the HTML parser sees as literal text — a
  // Jekyll / Hugo / Eleventy / Astro post header. The warning must
  // fire on its presence regardless of directive-overlap because the
  // corruption is file-wide (not a per-finding line intersection).
  it("fires `template_files_parsed_as_literal` when hasFrontmatterFence is true — no directives or overlap needed", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { hasFrontmatterFence: true },
      filesByExtension: { ".html": 5 },
      // Deliberately no directives, no overlap — frontmatter alone is
      // sufficient evidence per the file-wide substrate argument.
      templateDirectivesOverlap: false,
    });
    expect(codes).toContain("template_files_parsed_as_literal");
  });

  it("fires `template_files_parsed_as_literal` when frontmatter coexists with directives but no overlap — substrate path wins", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        hasFrontmatterFence: true,
        templateDirectivesFound: ["jinja-or-liquid"],
      },
      filesByExtension: { ".html": 5 },
      templateDirectivesOverlap: false,
    });
    expect(codes).toContain("template_files_parsed_as_literal");
  });

  it("does NOT fire `template_files_parsed_as_literal` when hasFrontmatterFence is false and no directive overlap", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { hasFrontmatterFence: false },
      filesByExtension: { ".html": 5 },
    });
    expect(codes).not.toContain("template_files_parsed_as_literal");
  });

  it("fires `extensions_skipped_no_parser` when the coverage block reports a non-empty skippedByExtension map", () => {
    const codes = computeScanWarnings({
      filesScanned: 125,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".astro": 104, ".scss": 122 },
      },
      filesByExtension: { ".tsx": 120, ".css": 5 },
    });
    expect(codes).toContain("extensions_skipped_no_parser");
  });

  it("does NOT fire `extensions_skipped_no_parser` when the map is empty or absent", () => {
    const empty = computeScanWarnings({
      filesScanned: 125,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { skippedByExtension: {} },
      filesByExtension: { ".tsx": 125 },
    });
    const absent = computeScanWarnings({
      filesScanned: 125,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {},
      filesByExtension: { ".tsx": 125 },
    });
    expect(empty).not.toContain("extensions_skipped_no_parser");
    expect(absent).not.toContain("extensions_skipped_no_parser");
  });

  it("fires `parse_errors_present` when parseErrorFileCount is non-zero (partial AST, findings undercounted on those files)", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { parseErrorFileCount: 1 },
      filesByExtension: { ".tsx": 40, ".ts": 2 },
    });
    expect(codes).toContain("parse_errors_present");
  });

  it("does NOT fire `parse_errors_present` when parseErrorFileCount is zero or absent", () => {
    const zero = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { parseErrorFileCount: 0 },
      filesByExtension: { ".tsx": 42 },
    });
    const absent = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {},
      filesByExtension: { ".tsx": 42 },
    });
    expect(zero).not.toContain("parse_errors_present");
    expect(absent).not.toContain("parse_errors_present");
  });

  it("fires `parse_errors_present` when partialParseFileCount is non-zero (errored + findings present, recall degraded)", () => {
    // Motivating case: an .mdx file emitted 14 findings with live
    // line numbers AND had parser errors. The split routed it into
    // `partialParseFileCount`, not `parseErrorFileCount`. The warning
    // must still fire — both buckets mean "findings undercounted on
    // at least one file," which is the signal the warning encodes.
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { partialParseFileCount: 1 },
      filesByExtension: { ".mdx": 1, ".tsx": 41 },
    });
    expect(codes).toContain("parse_errors_present");
  });

  it("fires `parse_errors_present` when both parseErrorFileCount AND partialParseFileCount are non-zero", () => {
    // Union logic: the warning fires once even when both buckets
    // populate (the declaration-order test verifies it only appears
    // once in the `out` array, but this test confirms the union
    // doesn't drop the signal when both conditions hold).
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { parseErrorFileCount: 1, partialParseFileCount: 1 },
      filesByExtension: { ".tsx": 42 },
    });
    expect(codes.filter((c) => c === "parse_errors_present").length).toBe(1);
  });

  it("preserves declaration order when multiple codes fire at once — the Leela-class silent-failure stack", () => {
    // `no_config_found` now requires filesScanned >= 10 AND the probe
    // to have seen a project marker (Q-SHARED-NO-CONFIG-WARNING-TINY-REPO).
    // This test constructs a scan that trips all three codes: a healthy
    // file count AND a defaulted root AND an empty config walk that
    // reached a real Node project root.
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "spawn-cwd",
      configSource: null,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: true,
    });
    expect([...codes]).toEqual(["root_source_defaulted", "no_config_found"]);
  });

  it("fires `scanned_build_artifacts_present` when the caller signals that the detector labeled ≥1 file", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 2 },
      scannedBuildArtifactsPresent: true,
    });
    expect(codes).toContain("scanned_build_artifacts_present");
  });

  it("does NOT fire `scanned_build_artifacts_present` when the flag is false (hand-written CSS only)", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 2 },
      scannedBuildArtifactsPresent: false,
    });
    expect(codes).not.toContain("scanned_build_artifacts_present");
  });

  it("does NOT fire `scanned_build_artifacts_present` when the flag is omitted (tool doesn't run the detector)", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 2 },
    });
    expect(codes).not.toContain("scanned_build_artifacts_present");
  });

  // Content-file skip signal. Canonical repro is the 307-`.md`
  // Jekyll scan that otherwise reads as a clean 20-finding result
  // because the content layer never reached the parser.
  it("fires `content_files_skipped` when .md count crosses the threshold (Jekyll / Hugo / MkDocs profile)", () => {
    const codes = computeScanWarnings({
      filesScanned: 20,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".md": 307 },
      },
      filesByExtension: { ".html": 20 },
    });
    expect(codes).toContain("content_files_skipped");
  });

  it("fires `content_files_skipped` when summed .md + .markdown + .rst cross the threshold (mixed Sphinx + Jekyll profile)", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        // 25 + 15 + 15 = 55 — above the 50 threshold via summation.
        skippedByExtension: { ".md": 25, ".markdown": 15, ".rst": 15 },
      },
      filesByExtension: { ".html": 5 },
    });
    expect(codes).toContain("content_files_skipped");
  });

  it("does NOT fire `content_files_skipped` just below the threshold — a stray bundle of READMEs is not a content-first repo", () => {
    const codes = computeScanWarnings({
      filesScanned: 100,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        // 49 total across the recognized exts — one shy of the threshold.
        skippedByExtension: { ".md": 49 },
      },
      filesByExtension: { ".tsx": 100 },
    });
    expect(codes).not.toContain("content_files_skipped");
  });

  it("fires `content_files_skipped` at the threshold boundary (count === 50)", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".md": 50 },
      },
      filesByExtension: { ".html": 10 },
    });
    expect(codes).toContain("content_files_skipped");
  });

  it("does NOT fire `content_files_skipped` for unrelated extensions even at high volume (e.g., 200 .astro files)", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".astro": 200 },
      },
      filesByExtension: { ".tsx": 10 },
    });
    expect(codes).not.toContain("content_files_skipped");
  });

  // Dominant-ecosystem signal — both
  // absolute (>50 files) AND share (>30% of total skipped) must hold
  // so the code points at template-layer-dominant repos (Rails,
  // Django, Go html/template, Laravel) rather than incidentally-
  // present scripts.
  it("fires `source_language_unsupported` with language=ruby on a Rails-shaped repo (.rb + .haml dominance)", () => {
    // `.erb` used to count toward this signal but is now parseable
    // (V1-PARSER-ERB) — the HTML parser routes `.erb` via the
    // `stripTemplateDirectives` pass, so an ERB-heavy repo no longer
    // surfaces in `skippedByExtension`. `.rb` (pure Ruby) + `.haml`
    // (Ruby template) remain ecosystem-foreign.
    const codes = computeScanWarnings({
      filesScanned: 12,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        // Rails: 80 haml templates + 120 rb files, plus incidental md.
        skippedByExtension: { ".haml": 80, ".rb": 120, ".md": 5 },
      },
      filesByExtension: { ".html": 12 },
    });
    expect(codes).toContain("source_language_unsupported");
  });

  it("does NOT fire `source_language_unsupported` with language=ruby on a Jekyll-shaped repo where only `.erb` + `.md` appear in skippedByExtension", () => {
    // V1-PARSER-ERB regression guard: `.erb` is now parseable, so an
    // `.erb`-heavy skippedByExtension entry is itself an upstream
    // bug (the files should have been parsed). Here we simulate the
    // pre-parser case — 200 `.erb` files mock-classified as skipped
    // — and assert the ruby signal does NOT fire, because `.erb`
    // should not count toward ecosystem-foreign dominance anymore.
    // If this test starts failing, someone has re-added `.erb` to
    // `UNSUPPORTED_LANGUAGE_EXTENSIONS.ruby` without considering
    // that the parser now handles the format.
    const codes = computeScanWarnings({
      filesScanned: 12,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".erb": 200, ".md": 5 },
      },
      filesByExtension: { ".html": 12 },
    });
    expect(codes).not.toContain("source_language_unsupported");
  });

  it("fires `source_language_unsupported` with language=python (Django template layer)", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".py": 300, ".toml": 4 },
      },
      filesByExtension: { ".html": 5 },
    });
    expect(codes).toContain("source_language_unsupported");
  });

  it("does NOT fire `source_language_unsupported` below the absolute threshold (51 files would cross; 50 does not)", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        // 50 .py files tied with itself; count must be STRICTLY > 50.
        skippedByExtension: { ".py": 50 },
      },
      filesByExtension: { ".html": 10 },
    });
    expect(codes).not.toContain("source_language_unsupported");
  });

  it("fires `source_language_unsupported` one over the absolute threshold AND above the share threshold", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        // 51 .py + 40 other: 51/91 ≈ 56% — above the 30% share floor.
        skippedByExtension: { ".py": 51, ".astro": 40 },
      },
      filesByExtension: { ".html": 10 },
    });
    expect(codes).toContain("source_language_unsupported");
  });

  it("does NOT fire `source_language_unsupported` when the absolute bar clears but share is below 30% (ambient scripts in JSX-first repo)", () => {
    const codes = computeScanWarnings({
      filesScanned: 500,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        // 60 .py files alongside 500 skipped non-JSX assets:
        // 60 / 560 ≈ 10.7% — absolute passes, share fails.
        skippedByExtension: { ".py": 60, ".astro": 500 },
      },
      filesByExtension: { ".tsx": 500 },
    });
    expect(codes).not.toContain("source_language_unsupported");
  });

  it("does NOT fire `source_language_unsupported` when no recognized language is present (mixed .astro + .svelte only)", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".astro": 200, ".svelte": 150 },
      },
      filesByExtension: { ".tsx": 10 },
    });
    expect(codes).not.toContain("source_language_unsupported");
  });
});

describe("warningsFromScanMeta", () => {
  it("reads filesScanned + analysisCoverage + filesByExtension out of a formatted.meta block", () => {
    const codes = warningsFromScanMeta({
      meta: {
        filesScanned: 60,
        filesByExtension: { ".tsx": 60, ".css": 1 },
        analysisCoverage: {
          hints: [
            {
              code: "css_coverage_thin",
              text: "Tailwind usage detected: run the build",
              detail: { cssFiles: 1, markupFiles: 60, tailwindDetected: true },
            },
          ],
        },
      },
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
    });
    expect(codes).toContain("tailwind_detected_css_undercounted");
  });

  it("threads `parse_errors_present` through from a formatted.meta analysisCoverage block", () => {
    const codes = warningsFromScanMeta({
      meta: {
        filesScanned: 42,
        filesByExtension: { ".ts": 42 },
        analysisCoverage: { parseErrorFileCount: 2 },
      },
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
    });
    expect(codes).toContain("parse_errors_present");
  });

  it("returns an empty array when the meta block is empty and no other warning conditions hold", () => {
    const codes = warningsFromScanMeta({
      meta: { filesScanned: 10 },
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
    });
    expect(codes).toEqual([]);
  });

  it("fires `storybook_preset_active` when the preset flag is set", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      storybookPresetActive: true,
    });
    expect(codes).toContain("storybook_preset_active");
  });

  it("does not fire `storybook_preset_active` when the flag is absent or false", () => {
    const codesAbsent = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(codesAbsent).not.toContain("storybook_preset_active");

    const codesFalse = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      storybookPresetActive: false,
    });
    expect(codesFalse).not.toContain("storybook_preset_active");
  });

  // Q4-ADDITIONALPATHS-REDUNDANT: `additionalPaths` contributed
  // parseable files, but every one of those files was already in the
  // default-discovered set — the flag did nothing, and the caller
  // needs to distinguish that from "did nothing because the paths
  // were ignored" (the three `skipped` reasons). The pure predicate
  // runs at the call site; this test locks the warning emission on
  // the single boolean input.
  it("fires `redundant_additional_paths` when the flag is true", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      additionalPathsRedundant: true,
    });
    expect(codes).toContain("redundant_additional_paths");
  });

  it("does not fire `redundant_additional_paths` when the flag is absent or false", () => {
    const codesAbsent = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(codesAbsent).not.toContain("redundant_additional_paths");

    const codesFalse = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      additionalPathsRedundant: false,
    });
    expect(codesFalse).not.toContain("redundant_additional_paths");
  });
});

describe("computeScanWarningDetails (ADR 0023 parallel warningsDetails channel)", () => {
  it("emits an `extensions_skipped_no_parser` payload when the code fired and skippedByExtension is populated", () => {
    const codes = ["extensions_skipped_no_parser"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 125,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".astro": 104, ".scss": 114, ".mdx": 110 },
      },
      filesByExtension: { ".tsx": 125 },
    });
    expect(details.extensions_skipped_no_parser).toBeDefined();
    // Sorted by descending count, ties broken alphabetically.
    expect(details.extensions_skipped_no_parser?.extensions).toEqual([".scss", ".mdx", ".astro"]);
    expect(details.extensions_skipped_no_parser?.topExtension).toBe(".scss");
    expect(details.extensions_skipped_no_parser?.topCount).toBe(114);
    expect(details.extensions_skipped_no_parser?.totalSkipped).toBe(328);
  });

  it("breaks count ties alphabetically (determinism the sort depends on)", () => {
    const codes = ["extensions_skipped_no_parser"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        // All tie at 5; expect alphabetical order in the sorted list.
        skippedByExtension: { ".svelte": 5, ".astro": 5, ".vue": 5 },
      },
      filesByExtension: { ".tsx": 10 },
    });
    expect(details.extensions_skipped_no_parser?.extensions).toEqual([".astro", ".svelte", ".vue"]);
    expect(details.extensions_skipped_no_parser?.topExtension).toBe(".astro");
  });

  it("truncates the `extensions` array to the top 5 but still sums the full distribution into `totalSkipped`", () => {
    const codes = ["extensions_skipped_no_parser"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 1,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: {
          ".a": 100,
          ".b": 90,
          ".c": 80,
          ".d": 70,
          ".e": 60,
          ".f": 50,
          ".g": 40,
        },
      },
      filesByExtension: { ".tsx": 1 },
    });
    expect(details.extensions_skipped_no_parser?.extensions).toHaveLength(5);
    expect(details.extensions_skipped_no_parser?.extensions).toEqual([
      ".a",
      ".b",
      ".c",
      ".d",
      ".e",
    ]);
    // Full distribution still sums — the dense summary doesn't hide the long tail from `totalSkipped`.
    expect(details.extensions_skipped_no_parser?.totalSkipped).toBe(
      100 + 90 + 80 + 70 + 60 + 50 + 40,
    );
  });

  it("returns an empty object when the `extensions_skipped_no_parser` code did NOT fire (no entry for a missing code)", () => {
    const details = computeScanWarningDetails([], {
      filesScanned: 125,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        // Even if the raw map is populated, the caller-decided `codes`
        // list is what drives whether a payload lands — prevents
        // details from leaking out in shapes where the code was
        // deliberately suppressed.
        skippedByExtension: { ".astro": 104 },
      },
      filesByExtension: { ".tsx": 125 },
    });
    expect(details.extensions_skipped_no_parser).toBeUndefined();
    expect(Object.keys(details)).toHaveLength(0);
  });

  it("returns an empty object when the code fired but the map is empty (shouldn't happen in practice — guard against upstream drift)", () => {
    const codes = ["extensions_skipped_no_parser"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 125,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { skippedByExtension: {} },
      filesByExtension: { ".tsx": 125 },
    });
    expect(details.extensions_skipped_no_parser).toBeUndefined();
  });

  it("drops entries whose count is zero or non-numeric (hostile-input defense)", () => {
    const codes = ["extensions_skipped_no_parser"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 1,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".astro": 10, ".scss": 0, ".vue": "lots" as unknown as number },
      },
      filesByExtension: { ".tsx": 1 },
    });
    expect(details.extensions_skipped_no_parser?.extensions).toEqual([".astro"]);
    expect(details.extensions_skipped_no_parser?.totalSkipped).toBe(10);
  });

  it("emits a `content_files_skipped` payload with per-extension breakdown (all three keys present, zero-filled for missing)", () => {
    const codes = ["content_files_skipped"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 20,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".md": 300, ".rst": 7 },
      },
      filesByExtension: { ".html": 20 },
    });
    expect(details.content_files_skipped?.count).toBe(307);
    // Keys always present — consumers never disambiguate absent-vs-zero.
    expect(details.content_files_skipped?.exts).toEqual({
      ".md": 300,
      ".markdown": 0,
      ".rst": 7,
    });
  });

  it("returns no `content_files_skipped` entry when the code did NOT fire (membership-vs-payload invariant)", () => {
    const details = computeScanWarningDetails([], {
      filesScanned: 20,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".md": 307 },
      },
      filesByExtension: { ".html": 20 },
    });
    expect(details.content_files_skipped).toBeUndefined();
  });

  it("emits a `source_language_unsupported` payload with language + fileCount + rounded percentage", () => {
    const codes = ["source_language_unsupported"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 12,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        // Rails: 80 haml + 120 rb = 200 ruby; 5 md; total 205.
        // (`.erb` used to be in the ruby tally but is now parseable;
        // see V1-PARSER-ERB — `.haml` stands in as the skipped Ruby
        // template layer.)
        skippedByExtension: { ".haml": 80, ".rb": 120, ".md": 5 },
      },
      filesByExtension: { ".html": 12 },
    });
    expect(details.source_language_unsupported?.language).toBe("ruby");
    expect(details.source_language_unsupported?.fileCount).toBe(200);
    // 200 / 205 = 0.97560... → 97.6 (rounded to one decimal).
    expect(details.source_language_unsupported?.percentageOfSkipped).toBe(97.6);
  });

  it("returns no `source_language_unsupported` entry when the code did NOT fire", () => {
    const details = computeScanWarningDetails([], {
      filesScanned: 12,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".py": 300 },
      },
      filesByExtension: { ".html": 12 },
    });
    expect(details.source_language_unsupported).toBeUndefined();
  });
});

describe("warningsField (ADR 0023 composite warnings + warningsDetails shape)", () => {
  it("emits both `warnings` and `warningsDetails` when a code with a structured payload fires", () => {
    const out = warningsField({
      filesScanned: 125,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".astro": 104 },
      },
      filesByExtension: { ".tsx": 125 },
    });
    expect(out.warnings).toEqual(["extensions_skipped_no_parser"]);
    expect(out.warningsDetails?.extensions_skipped_no_parser?.topExtension).toBe(".astro");
    expect(out.warningsDetails?.extensions_skipped_no_parser?.totalSkipped).toBe(104);
  });

  it("emits `warnings` alone when every fired code is presence-only (no payload mirror exists)", () => {
    const out = warningsField({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: null,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: true,
    });
    // Only `no_config_found` fires; presence-only code with no payload.
    expect(out.warnings).toEqual(["no_config_found"]);
    // `warningsDetails` must be omitted (never `{}`) per "present-when-meaningful."
    expect(out.warningsDetails).toBeUndefined();
  });

  it("omits both fields on a clean scan (no `warnings: []` and no `warningsDetails: {}`)", () => {
    const out = warningsField({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {},
      filesByExtension: { ".tsx": 42 },
    });
    expect(out.warnings).toBeUndefined();
    expect(out.warningsDetails).toBeUndefined();
  });

  it("threads warningsDetails through `warningsFieldFromScanMeta` identically to `warningsField`", () => {
    const out = warningsFieldFromScanMeta({
      meta: {
        filesScanned: 125,
        filesByExtension: { ".tsx": 125 },
        analysisCoverage: {
          skippedByExtension: { ".scss": 114, ".astro": 104 },
        },
      },
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
    });
    expect(out.warnings).toContain("extensions_skipped_no_parser");
    expect(out.warningsDetails?.extensions_skipped_no_parser?.topExtension).toBe(".scss");
    expect(out.warningsDetails?.extensions_skipped_no_parser?.extensions).toEqual([
      ".scss",
      ".astro",
    ]);
  });

  it("emits a `response_token_budget_truncated` payload via the dedicated helper when the density cap trims files", () => {
    // Density-cap settlement is decided at the budget-merge call site,
    // not from scan meta — so the payload goes through its own
    // spreadable fragment helper rather than `computeScanWarningDetails`.
    // The fragment carries both the pre-density file count (what the
    // cap saw entering) and the post-density count (what survived).
    const out = tokenBudgetTruncatedDetailsField({
      requestedLimit: 50,
      effectiveLimit: 10,
    });
    // Q-SHARED-LIMIT-REQUEST-VS-EFFECTIVE: the payload carries
    // `reason: "token_density"` as a constant — the warning code only
    // fires on the density cap, so the reason is determinate, but the
    // field is always present so consumers branching on either the
    // top-level `pageClipReason` or this `warningsDetails` reason use
    // the same enum.
    expect(out.warningsDetails.response_token_budget_truncated).toEqual({
      requestedLimit: 50,
      effectiveLimit: 10,
      reason: "token_density",
    });
    // Shape: `warningsDetails` is the only top-level key — the
    // fragment is designed to spread directly into a response body
    // alongside `warnings: [...]` without fighting object-spread
    // semantics.
    expect(Object.keys(out)).toEqual(["warningsDetails"]);
  });

  it("`warnings[]` membership and `warningsDetails` keys never disagree — the code is both fired and mirrored (set-membership invariant)", () => {
    const out = warningsField({
      filesScanned: 42, // above the no_config_found threshold
      rootSource: "spawn-cwd", // fires root_source_defaulted (no payload)
      configSource: null, // fires no_config_found (no payload) w/ marker
      configSearchSawProjectMarker: true,
      analysisCoverage: {
        skippedByExtension: { ".scss": 5 }, // fires extensions_skipped_no_parser (with payload)
      },
      filesByExtension: undefined,
    });
    expect(out.warnings).toContain("extensions_skipped_no_parser");
    expect(out.warningsDetails?.extensions_skipped_no_parser).toBeDefined();
    // No stray keys — only payload-bearing codes show up under warningsDetails.
    expect(Object.keys(out.warningsDetails ?? {})).toEqual(["extensions_skipped_no_parser"]);
  });

  it("Jekyll scan emits content_files_skipped + extensions_skipped_no_parser together with matching payloads", () => {
    // Canonical Jekyll repro: 307 .md files + 20 html files parsed.
    const out = warningsField({
      filesScanned: 20,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".md": 307 },
      },
      filesByExtension: { ".html": 20 },
    });
    expect(out.warnings).toContain("content_files_skipped");
    expect(out.warnings).toContain("extensions_skipped_no_parser");
    expect(out.warningsDetails?.content_files_skipped?.count).toBe(307);
    expect(out.warningsDetails?.extensions_skipped_no_parser?.topExtension).toBe(".md");
  });
});

// Q6-BUDGET-UNDER-VENDOR-NOISE — vendor-CSS dominance signal.
// Canonical repro: a website-templates scan where bootstrap.css
// + font-awesome.css emit the bulk of the findings and the
// response's file budget is consumed by unactionable vendor
// noise. The warning is additive — findings stay in `files[]`.
describe("computeScanWarnings — vendor_css_dominates_findings", () => {
  it("fires when vendor-CSS findings dominate the scan (≥50% share, ≥200 total findings, topVendorFile present)", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4, ".html": 38 },
      vendorCssNoise: {
        totalFindingsCount: 25000,
        vendorFindingsCount: 17000,
        topVendorFile: { path: "vendor/bootstrap.css", findingsCount: 5458 },
      },
    });
    expect(codes).toContain("vendor_css_dominates_findings");
  });

  it("does NOT fire below the absolute floor of 200 total findings (trivial scan where 2/2 sit on a .min.css is not a dominance regime)", () => {
    const codes = computeScanWarnings({
      filesScanned: 3,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 1 },
      vendorCssNoise: {
        totalFindingsCount: 2,
        vendorFindingsCount: 2,
        topVendorFile: { path: "dist/app.min.css", findingsCount: 2 },
      },
    });
    expect(codes).not.toContain("vendor_css_dominates_findings");
  });

  it("does NOT fire when vendor findings are non-zero but below the 50% share threshold (hand-authored dominant)", () => {
    const codes = computeScanWarnings({
      filesScanned: 40,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
      vendorCssNoise: {
        // 90 / 500 = 18% — vendor presence is real but not the
        // dominance regime. `scanned_build_artifacts_present`
        // already names the vendor file; this code stays silent.
        totalFindingsCount: 500,
        vendorFindingsCount: 90,
        topVendorFile: { path: "vendor/bootstrap.css", findingsCount: 50 },
      },
    });
    expect(codes).not.toContain("vendor_css_dominates_findings");
  });

  it("does NOT fire when vendorCssNoise is omitted (tool didn't run the build-artifact detector)", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
    });
    expect(codes).not.toContain("vendor_css_dominates_findings");
  });

  it("fires at exactly the share floor (50% on the nose — threshold is `>=`, not strict `>`)", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 2 },
      vendorCssNoise: {
        totalFindingsCount: 400,
        vendorFindingsCount: 200,
        topVendorFile: { path: "vendor/bootstrap.css", findingsCount: 180 },
      },
    });
    expect(codes).toContain("vendor_css_dominates_findings");
  });
});

describe("computeScanWarningDetails — vendor_css_dominates_findings payload", () => {
  it("emits the payload with vendorFindingsCount, totalFindings, percentageOfFindings (1-decimal), and topVendorFile", () => {
    const details = computeScanWarningDetails(["vendor_css_dominates_findings"] as const, {
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
      vendorCssNoise: {
        totalFindingsCount: 24772,
        vendorFindingsCount: 17098,
        topVendorFile: { path: "vendor/font-awesome.css", findingsCount: 8940 },
      },
    });
    expect(details.vendor_css_dominates_findings).toBeDefined();
    expect(details.vendor_css_dominates_findings?.vendorFindingsCount).toBe(17098);
    expect(details.vendor_css_dominates_findings?.totalFindings).toBe(24772);
    // 17098 / 24772 ≈ 0.69022… → 69.0 after one-decimal rounding.
    expect(details.vendor_css_dominates_findings?.percentageOfFindings).toBe(69);
    expect(details.vendor_css_dominates_findings?.topVendorFile.path).toBe(
      "vendor/font-awesome.css",
    );
    expect(details.vendor_css_dominates_findings?.topVendorFile.findingsCount).toBe(8940);
  });

  it("omits the payload when the code fired but topVendorFile is absent (payload without a concrete pivot is weaker than the bare code)", () => {
    const details = computeScanWarningDetails(["vendor_css_dominates_findings"] as const, {
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
      vendorCssNoise: {
        totalFindingsCount: 500,
        vendorFindingsCount: 300,
      },
    });
    expect(details.vendor_css_dominates_findings).toBeUndefined();
  });

  it("omits the payload when vendorCssNoise is absent entirely", () => {
    const details = computeScanWarningDetails(["vendor_css_dominates_findings"] as const, {
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
    });
    expect(details.vendor_css_dominates_findings).toBeUndefined();
  });
});

describe("warningsField — vendor_css_dominates_findings", () => {
  it("pairs the warning code with its structured payload on a website-templates-shaped scan", () => {
    const out = warningsField({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4, ".html": 38 },
      scannedBuildArtifactsPresent: true,
      vendorCssNoise: {
        totalFindingsCount: 24772,
        vendorFindingsCount: 17098,
        topVendorFile: { path: "vendor/font-awesome.css", findingsCount: 8940 },
      },
    });
    expect(out.warnings).toContain("vendor_css_dominates_findings");
    expect(out.warnings).toContain("scanned_build_artifacts_present");
    expect(out.warningsDetails?.vendor_css_dominates_findings).toBeDefined();
    expect(out.warningsDetails?.vendor_css_dominates_findings?.topVendorFile.path).toBe(
      "vendor/font-awesome.css",
    );
  });
});

// Q-SHARED-META-ARRAY-BUDGET-CAP: the top-level presence bit an agent
// reads without descending into `meta`. Fires only when at least one
// meta path-array was trimmed; drops conservatively when the input
// is omitted or `false` (callers that didn't participate in the cap
// regime stay unaffected).
describe("computeScanWarnings — response_meta_truncated", () => {
  it("fires when metaArrayTruncated is true", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      metaArrayTruncated: true,
    });
    expect(codes).toContain("response_meta_truncated");
  });

  it("does NOT fire when metaArrayTruncated is false (every capped array fit)", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      metaArrayTruncated: false,
    });
    expect(codes).not.toContain("response_meta_truncated");
  });

  it("does NOT fire when metaArrayTruncated is omitted (caller didn't opt in)", () => {
    // Derivative-tool callers that don't participate in the cap regime
    // stay unaffected — the warning drops conservatively.
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(codes).not.toContain("response_meta_truncated");
  });
});

// V1-WARNINGS-DETAILS-CROSS-SURFACE-REGRESSION: the payload-vs-binary
// contract on `ScanWarningDetails` says every fired warning code is
// either payload-bearing (its slot on the interface is populated when
// the code fires AND the predicate's data is non-degenerate) OR
// binary-presence (no slot on the interface; the bare code carries
// the entire signal). The doctrine line in
// `docs/kb/architecture/ai-first-consumer.md`: "warningsDetails
// carries quantitative signal the agent uses to decide what next.
// Bare codes carry binary signal. Both honest; the schema must
// document which."
//
// This block exercises the contract on the full set of codes flagged
// in the originating field report (`response_token_budget_truncated`,
// `no_config_found`, `scanned_build_artifacts_present`,
// `extensions_skipped_no_parser`, `parse_errors_present`,
// `source_language_unsupported`, `template_files_parsed_as_literal`)
// — half the report's claim was that only one of seven carried a
// payload; the contract now is "three carry quantitative payloads
// from the start (tokens / extensions / source-language), two more
// were enriched here (build-artifacts / parse-errors), and two are
// honestly binary (no-config / template-literal)." Together they
// pin the cross-surface invariant so the regression cannot reopen
// silently.
describe("V1-WARNINGS-DETAILS-CROSS-SURFACE-REGRESSION — payload-vs-binary contract", () => {
  it("payload-bearing codes always emit a `warningsDetails` entry on a fire — `parse_errors_present`", () => {
    const out = warningsField({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { parseErrorFileCount: 3, partialParseFileCount: 1 },
      filesByExtension: { ".tsx": 42 },
    });
    expect(out.warnings).toContain("parse_errors_present");
    expect(out.warningsDetails?.parse_errors_present).toBeDefined();
    expect(out.warningsDetails?.parse_errors_present?.parseErrorFileCount).toBe(3);
    expect(out.warningsDetails?.parse_errors_present?.partialParseFileCount).toBe(1);
  });

  it("payload-bearing codes always emit a `warningsDetails` entry on a fire — `scanned_build_artifacts_present`", () => {
    const out = warningsField({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
      scannedBuildArtifactsPresent: true,
      scannedBuildArtifactsSummary: {
        count: 17,
        topPath: "vendor/bootstrap/bootstrap.css",
      },
    });
    expect(out.warnings).toContain("scanned_build_artifacts_present");
    expect(out.warningsDetails?.scanned_build_artifacts_present).toBeDefined();
    expect(out.warningsDetails?.scanned_build_artifacts_present?.count).toBe(17);
    expect(out.warningsDetails?.scanned_build_artifacts_present?.topPath).toBe(
      "vendor/bootstrap/bootstrap.css",
    );
  });

  it("`scanned_build_artifacts_present` fires bare without a payload when only the binary flag is supplied (caller can't compute the count)", () => {
    // Derivative tools that know "at least one artifact was scanned"
    // but didn't materialize the entries list still emit the bare
    // code — surface-don't-suppress doctrine. The payload is
    // present-when-meaningful; absence here means "caller didn't
    // know, not zero." The bare code keeps the agent honest about
    // the presence; the count just isn't lifted onto the top-level
    // channel until a caller wires the summary.
    const out = warningsField({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
      scannedBuildArtifactsPresent: true,
    });
    expect(out.warnings).toContain("scanned_build_artifacts_present");
    expect(out.warningsDetails?.scanned_build_artifacts_present).toBeUndefined();
  });

  it("binary-presence codes never emit a `warningsDetails` entry — `no_config_found`", () => {
    // `no_config_found` is the canonical binary code: the bare
    // emission IS the entire signal — `meta.configSource: null`
    // already carries the same bit, and the warning's prose names
    // the remediation. There's no follow-on quantity an agent
    // would branch on differently. The contract: never a slot on
    // `ScanWarningDetails`, never an entry on the wire.
    const out = warningsField({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: null,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: true,
    });
    expect(out.warnings).toContain("no_config_found");
    expect(out.warningsDetails).toBeUndefined();
  });

  it("binary-presence codes never emit a `warningsDetails` entry — `template_files_parsed_as_literal`", () => {
    // `template_files_parsed_as_literal` is binary too: the
    // directive list lives in `meta.analysisCoverage.templateDirectivesFound`
    // and the code's prose names the dispatch (overlap or
    // frontmatter fence). A count of directives or fence presence
    // bit doesn't change the agent's next action — read the file,
    // confirm the parse-as-literal regime, decide whether to add a
    // pragma — the bare code IS the entire top-level signal.
    const out = warningsField({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        templateDirectivesFound: ["jinja-or-liquid"],
      },
      filesByExtension: { ".html": 5 },
      templateDirectivesOverlap: true,
    });
    expect(out.warnings).toContain("template_files_parsed_as_literal");
    expect(
      (out.warningsDetails as Record<string, unknown> | undefined)?.[
        "template_files_parsed_as_literal"
      ],
    ).toBeUndefined();
  });

  it("the membership-vs-payload invariant holds when the seven canonical regression codes all fire on one response", () => {
    // Construct a Frankenstein response that fires every code from
    // the regression item (minus the density-cap code which only
    // the budget pipeline triggers). Asserts the three payload-
    // bearing codes get their slots populated and the two binary
    // codes get NO slot — the contract is symmetric: payload-bearing
    // codes carry their slot on every fire, binary codes never do.
    const out = warningsField({
      filesScanned: 250,
      rootSource: "explicit",
      configSource: null,
      configSearchSawProjectMarker: true,
      analysisCoverage: {
        parseErrorFileCount: 4,
        partialParseFileCount: 2,
        skippedByExtension: { ".astro": 80, ".rb": 120, ".haml": 60, ".md": 5 },
        templateDirectivesFound: ["jinja-or-liquid"],
      },
      filesByExtension: { ".tsx": 250, ".css": 4 },
      scannedBuildArtifactsPresent: true,
      scannedBuildArtifactsSummary: {
        count: 17,
        topPath: "vendor/bootstrap/bootstrap.css",
      },
      templateDirectivesOverlap: true,
    });
    // All seven codes from the regression item are in `warnings[]`.
    const codes = out.warnings ?? [];
    expect(codes).toContain("no_config_found");
    expect(codes).toContain("extensions_skipped_no_parser");
    expect(codes).toContain("parse_errors_present");
    expect(codes).toContain("source_language_unsupported");
    expect(codes).toContain("scanned_build_artifacts_present");
    expect(codes).toContain("template_files_parsed_as_literal");
    // Payload-bearing slots populated for every fired code that has
    // a slot.
    expect(out.warningsDetails?.extensions_skipped_no_parser).toBeDefined();
    expect(out.warningsDetails?.parse_errors_present).toBeDefined();
    expect(out.warningsDetails?.source_language_unsupported).toBeDefined();
    expect(out.warningsDetails?.scanned_build_artifacts_present).toBeDefined();
    // Binary codes never produce a slot — explicit absence check
    // against the payload map keys keeps the contract symmetric
    // (no stray `no_config_found` / `template_files_parsed_as_literal`
    // shape ever leaks through).
    const detailsKeys = Object.keys(out.warningsDetails ?? {});
    expect(detailsKeys).not.toContain("no_config_found");
    expect(detailsKeys).not.toContain("template_files_parsed_as_literal");
  });

  it("the membership-vs-payload invariant: every key on `warningsDetails` corresponds to a fired code in `warnings[]`", () => {
    // Drives `computeScanWarningDetails` directly with codes that
    // were NOT emitted (empty `codes` arg) — the helper must NOT
    // leak any payload, even when the inputs would otherwise let
    // a `summarize*` helper succeed. Prevents a refactor from
    // detaching the gate that keeps the two channels in lock-step.
    const details = computeScanWarningDetails([], {
      filesScanned: 250,
      rootSource: "explicit",
      configSource: null,
      configSearchSawProjectMarker: true,
      analysisCoverage: {
        parseErrorFileCount: 4,
        partialParseFileCount: 2,
        skippedByExtension: { ".astro": 80, ".rb": 120 },
      },
      filesByExtension: { ".tsx": 250 },
      scannedBuildArtifactsPresent: true,
      scannedBuildArtifactsSummary: { count: 17, topPath: "vendor/x.css" },
    });
    expect(Object.keys(details)).toHaveLength(0);
  });
});
