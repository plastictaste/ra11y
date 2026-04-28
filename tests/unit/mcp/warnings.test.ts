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
        // the warnings module dispatches on
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

  it("fires `template_files_parsed_as_literal` when templateInterpolationFound is populated AND a finding overlaps a directive", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        templateInterpolationFound: [{ token: "{%x%}", count: 3 }],
      },
      filesByExtension: { ".html": 5 },
      templateDirectivesOverlap: true,
    });
    expect(codes).toContain("template_files_parsed_as_literal");
  });

  it("does NOT fire `template_files_parsed_as_literal` when interpolation tokens present but no finding overlaps", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        templateInterpolationFound: [{ token: "{%x%}", count: 3 }],
      },
      filesByExtension: { ".html": 5 },
      templateDirectivesOverlap: false,
    });
    expect(codes).not.toContain("template_files_parsed_as_literal");
  });

  it("does NOT fire `template_files_parsed_as_literal` when templateInterpolationFound is empty/absent", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { templateInterpolationFound: [] },
      filesByExtension: { ".html": 5 },
    });
    expect(codes).not.toContain("template_files_parsed_as_literal");
  });

  // frontmatter is a
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
        templateInterpolationFound: [{ token: "{%x%}", count: 3 }],
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

  it("fires `text_source_skipped` when the coverage block reports a non-empty skippedByExtension map", () => {
    const codes = computeScanWarnings({
      filesScanned: 125,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".astro": 104, ".scss": 122 },
      },
      filesByExtension: { ".tsx": 120, ".css": 5 },
    });
    expect(codes).toContain("text_source_skipped");
  });

  it("does NOT fire `text_source_skipped` when the map is empty or absent", () => {
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
    expect(empty).not.toContain("text_source_skipped");
    expect(absent).not.toContain("text_source_skipped");
  });

  it("does NOT fire `text_source_skipped` when the skipped map is binary assets only — fires `binary_assets_skipped` instead", () => {
    // A scan whose only "skipped" extensions are images / fonts / media
    // is not a text-source-parser-coverage gap an agent could re-route
    // via additionalPaths — but the corpus shape signal still matters,
    // so the binary subset surfaces under its own warning rather than
    // being silently filtered out (Routing skips that drop content are
    // the symmetric twin of suppression — surface honestly via a
    // labeled channel).
    const codes = computeScanWarnings({
      filesScanned: 50,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: {
          ".png": 10,
          ".jpg": 5,
          ".woff2": 3,
          ".mp4": 1,
          ".eot": 2,
        },
      },
      filesByExtension: { ".tsx": 50 },
    });
    expect(codes).not.toContain("text_source_skipped");
    expect(codes).toContain("binary_assets_skipped");
  });

  it("fires both `text_source_skipped` and `binary_assets_skipped` when the map mixes text and binary extensions (independent predicates)", () => {
    // Heterogeneous corpus: text-source skips coexist with binary
    // assets. Both warnings fire so the agent sees the actionable
    // text subset AND the residual asset bucket without one burying
    // the other (the pre-split shape lumped both under one warning,
    // letting `.jpg: 1835` hide `.php: 30`).
    const codes = computeScanWarnings({
      filesScanned: 50,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: {
          ".vue": 12,
          ".png": 200, // dominant by count but routed to its own channel
          ".woff2": 30,
        },
      },
      filesByExtension: { ".tsx": 50 },
    });
    expect(codes).toContain("text_source_skipped");
    expect(codes).toContain("binary_assets_skipped");
  });

  it("fires `sourcemap_files_excluded` when discovery records `.map` paths in the coverage block", () => {
    // The discovery walker routes `.map` files into a dedicated bucket
    // (`analysisCoverage.sourcemapFiles`) so the sourcemap-exclusion
    // signal is declared explicitly rather than buried under
    // `text_source_skipped` / `binary_assets_skipped`. Predicate fires
    // off list-presence — a non-empty list is sufficient evidence.
    const codes = computeScanWarnings({
      filesScanned: 50,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        sourcemapFiles: ["/proj/assets/app.css.map", "/proj/assets/vendor.js.map"],
      },
      filesByExtension: { ".tsx": 50 },
    });
    expect(codes).toContain("sourcemap_files_excluded");
  });

  it("does NOT fire `sourcemap_files_excluded` when the sourcemapFiles list is empty or absent", () => {
    const empty = computeScanWarnings({
      filesScanned: 50,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { sourcemapFiles: [] },
      filesByExtension: { ".tsx": 50 },
    });
    const absent = computeScanWarnings({
      filesScanned: 50,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {},
      filesByExtension: { ".tsx": 50 },
    });
    expect(empty).not.toContain("sourcemap_files_excluded");
    expect(absent).not.toContain("sourcemap_files_excluded");
  });

  it("does NOT fire `binary_assets_skipped` when the map is text-source only", () => {
    // Symmetric to the binary-only case: a pure text-source skip map
    // (Vue / Astro / SCSS components) trips `text_source_skipped`
    // alone — the binary channel stays absent because no asset
    // extension is in the map.
    const codes = computeScanWarnings({
      filesScanned: 125,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".astro": 104, ".scss": 122 },
      },
      filesByExtension: { ".tsx": 120, ".css": 5 },
    });
    expect(codes).toContain("text_source_skipped");
    expect(codes).not.toContain("binary_assets_skipped");
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

  it("fires `partial_parse_files_present` when partialParseFileCount > 0 (binary presence bit)", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { partialParseFileCount: 3 },
      filesByExtension: { ".mdx": 1, ".tsx": 9 },
    });
    expect(codes).toContain("partial_parse_files_present");
    // Pairs with the broader `parse_errors_present` (union code) —
    // both fire so the agent gets both the broad presence and the
    // partial-parse subset signal.
    expect(codes).toContain("parse_errors_present");
  });

  it("does NOT fire `partial_parse_files_present` when only parseErrorFileCount fires (total-failure bucket without partial parses)", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { parseErrorFileCount: 5 },
      filesByExtension: { ".tsx": 10 },
    });
    expect(codes).not.toContain("partial_parse_files_present");
    expect(codes).toContain("parse_errors_present");
  });

  it("fires `parser_bailed_zero_findings` when parseErrorFileCount > 0 AND totalFindings === 0", () => {
    const codes = computeScanWarnings({
      filesScanned: 538,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { parseErrorFileCount: 538 },
      filesByExtension: { ".js": 538 },
      totalFindings: 0,
    });
    expect(codes).toContain("parser_bailed_zero_findings");
  });

  it("does NOT fire `parser_bailed_zero_findings` when totalFindings > 0 (parse errors present, but findings still surfaced)", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { parseErrorFileCount: 1 },
      filesByExtension: { ".tsx": 42 },
      totalFindings: 14,
    });
    expect(codes).not.toContain("parser_bailed_zero_findings");
  });

  it("does NOT fire `parser_bailed_zero_findings` when totalFindings is undefined (drops conservatively without evidence)", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { parseErrorFileCount: 5 },
      filesByExtension: { ".tsx": 42 },
      // no totalFindings — derivative tools that don't compute the
      // total should never speculatively fire the bailed-zero code.
    });
    expect(codes).not.toContain("parser_bailed_zero_findings");
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
    // — the HTML parser routes `.erb` via the
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
    // regression guard: `.erb` is now parseable, so an
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

  // `additionalPaths` contributed
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

  // `restrictToPaths` intersected
  // the discovered file set down to zero entries — distinct from
  // `scanned_zero_files` (discovery itself produced nothing) because
  // the response carries a populated `meta.restrictToPathsApplied`
  // showing the pre-restrict count was non-zero. Without the dedicated
  // code, a scoped scan that matched no files reads as a clean
  // codebase.
  it("fires `restrict_to_paths_no_matches` when the flag is true", () => {
    const codes = computeScanWarnings({
      filesScanned: 0,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      restrictToPathsEmpty: true,
    });
    expect(codes).toContain("restrict_to_paths_no_matches");
  });

  it("does not fire `restrict_to_paths_no_matches` when the flag is absent or false", () => {
    const codesAbsent = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(codesAbsent).not.toContain("restrict_to_paths_no_matches");

    const codesFalse = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      restrictToPathsEmpty: false,
    });
    expect(codesFalse).not.toContain("restrict_to_paths_no_matches");
  });

  // the broader
  // `scanned_build_artifacts_present` already labels artifact
  // presence; this finer code names the minified subset
  // specifically, so an agent can triage findings on minified
  // bytes (nearly always unreliable) without rereading every
  // flagged file. The predicate is "the caller-supplied list is
  // non-empty"; the cross-reference between
  // `buildArtifacts.entries[].classification` and the two
  // minified-shaped variants (`definite-min-infix` and
  // `likely-minified-by-line-stats` — the confidence-graded split
  // introduced by)
  // lives at the call site so this module stays decoupled from
  // the build-artifact classifier internals.
  it("fires `scanned_minified_file` when the caller-supplied list is non-empty", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 2 },
      scannedMinifiedFiles: ["dist/bootstrap.min.css"],
    });
    expect(codes).toContain("scanned_minified_file");
  });

  it("does NOT fire `scanned_minified_file` when the list is empty (no minified entries in scan)", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 2 },
      scannedMinifiedFiles: [],
    });
    expect(codes).not.toContain("scanned_minified_file");
  });

  it("does NOT fire `scanned_minified_file` when the list is omitted (tool didn't run the detector)", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 2 },
    });
    expect(codes).not.toContain("scanned_minified_file");
  });

  // doctrine analogue of
  // `scanned_zero_files`. When 100% of the parsed files are
  // classified as build artifacts (the canonical misrooted-into-`dist/`
  // shape), `scanned_build_artifacts_present` only signals "at least
  // one artifact" — neither it nor `scanned_zero_files` (which needs
  // filesScanned: 0) names the dominance regime. The new code surfaces
  // the gap so the agent re-scopes to authored source.
  it("fires `dist_only_scan_detected` when every parsed file is a build artifact", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 5 },
      scannedBuildArtifactsPresent: true,
      scannedBuildArtifactsAllFiles: true,
    });
    expect(codes).toContain("dist_only_scan_detected");
  });

  it("does NOT fire `dist_only_scan_detected` when at least one parsed file is authored source", () => {
    const codes = computeScanWarnings({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 10 },
      scannedBuildArtifactsPresent: true,
      scannedBuildArtifactsAllFiles: false,
    });
    expect(codes).not.toContain("dist_only_scan_detected");
  });

  it("does NOT fire `dist_only_scan_detected` when filesScanned is zero (the bare scanned_zero_files stays the honest signal)", () => {
    const codes = computeScanWarnings({
      filesScanned: 0,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      // Even if a caller speculatively passes the flag, the helper
      // requires filesScanned > 0 so a 0-files scan can never trip
      // this code on top of `scanned_zero_files`.
      scannedBuildArtifactsAllFiles: true,
    });
    expect(codes).not.toContain("dist_only_scan_detected");
    expect(codes).toContain("scanned_zero_files");
  });

  it("does NOT fire `dist_only_scan_detected` when the flag is omitted (tool didn't run the detector)", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 5 },
    });
    expect(codes).not.toContain("dist_only_scan_detected");
  });

  // when filesScanned: 0 AND
  // the config-loader walk-up landed on a real project marker at a
  // strict ancestor, the bare `scanned_zero_files` is honest but
  // incomplete — the parent dir likely would have produced findings.
  // The companion code answers "did you mean a parent dir?" with a
  // concrete path the agent can re-scope to in one read.
  it("fires `cwd_appears_misrooted` when filesScanned is zero AND nearestConfigAncestor is supplied", () => {
    const codes = computeScanWarnings({
      filesScanned: 0,
      rootSource: "explicit",
      configSource: "/parent/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      nearestConfigAncestor: "/parent",
    });
    expect(codes).toContain("cwd_appears_misrooted");
    // Pairs with — does not replace — `scanned_zero_files`.
    expect(codes).toContain("scanned_zero_files");
  });

  it("does NOT fire `cwd_appears_misrooted` on a genuinely empty dir with no ancestor config (the bare scanned_zero_files stays honest)", () => {
    const codes = computeScanWarnings({
      filesScanned: 0,
      rootSource: "explicit",
      configSource: null,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      // No ancestor probe result — predicate drops conservatively.
    });
    expect(codes).not.toContain("cwd_appears_misrooted");
  });

  it("does NOT fire `cwd_appears_misrooted` when filesScanned is non-zero (the scan reached authored source)", () => {
    const codes = computeScanWarnings({
      filesScanned: 12,
      rootSource: "explicit",
      configSource: "/parent/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".tsx": 12 },
      nearestConfigAncestor: "/parent",
    });
    expect(codes).not.toContain("cwd_appears_misrooted");
  });
});

describe("computeScanWarningDetails (ADR 0023 parallel warningsDetails channel)", () => {
  it("emits an `text_source_skipped` payload when the code fired and skippedByExtension is populated", () => {
    const codes = ["text_source_skipped"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 125,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".astro": 104, ".scss": 114, ".mdx": 110 },
      },
      filesByExtension: { ".tsx": 125 },
    });
    expect(details.text_source_skipped).toBeDefined();
    // Sorted by descending count, ties broken alphabetically.
    expect(details.text_source_skipped?.extensions).toEqual([".scss", ".mdx", ".astro"]);
    expect(details.text_source_skipped?.topExtension).toBe(".scss");
    expect(details.text_source_skipped?.topCount).toBe(114);
    expect(details.text_source_skipped?.totalSkipped).toBe(328);
  });

  it("breaks count ties alphabetically (determinism the sort depends on)", () => {
    const codes = ["text_source_skipped"] as const;
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
    expect(details.text_source_skipped?.extensions).toEqual([".astro", ".svelte", ".vue"]);
    expect(details.text_source_skipped?.topExtension).toBe(".astro");
  });

  it("enumerates EVERY skipped extension in the `extensions` array (no top-N truncation)", () => {
    // Per AI-first doctrine "Routing skips that drop content are the
    // symmetric twin of suppression": the dense summary mirrors the
    // full predicate-fired distribution, not a top-5 head-slice. The
    // legacy cap silently hid the long tail — an agent on a bulk
    // corpus skipping 8+ distinct extension classes would only see 5.
    const codes = ["text_source_skipped"] as const;
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
    // All 7 entries surface — sorted by descending count.
    expect(details.text_source_skipped?.extensions).toHaveLength(7);
    expect(details.text_source_skipped?.extensions).toEqual([
      ".a",
      ".b",
      ".c",
      ".d",
      ".e",
      ".f",
      ".g",
    ]);
    expect(details.text_source_skipped?.totalSkipped).toBe(100 + 90 + 80 + 70 + 60 + 50 + 40);
  });

  it("returns an empty object when the `text_source_skipped` code did NOT fire (no entry for a missing code)", () => {
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
    expect(details.text_source_skipped).toBeUndefined();
    expect(Object.keys(details)).toHaveLength(0);
  });

  it("falls back to the truncation sentinel when a payload-bearing code fired but the summarizer's input is degenerate (warnings-details schema discipline — upstream-drift guard)", () => {
    // Prior contract: the dispatch fall-through stamped the
    // binary-presence `{}` marker for ANY code without a rich
    // summary, conflating "no payload by design" (binary code) with
    // "the payload was supposed to be here but the summarizer's
    // input was missing" (payload-bearing code with degenerate
    // input). Closes the payload-bearing codes whose summarizer
    // returns `undefined` get the
    // `{ truncated: true, reason: "summarizer_inputs_unavailable" }`
    // sentinel so the agent can tell the two cases apart on the wire.
    // The membership invariant still holds — every fired code in
    // `codes` carries a key — but the fall-through entry is now
    // honestly typed.
    const codes = ["text_source_skipped"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 125,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { skippedByExtension: {} },
      filesByExtension: { ".tsx": 125 },
    });
    // Read through `Record<string, unknown>` so the assertion
    // accepts either the rich payload OR the truncation sentinel.
    const detailsMap = details as Record<string, unknown>;
    expect(detailsMap.text_source_skipped).toEqual({
      truncated: true,
      reason: "summarizer_inputs_unavailable",
    });
  });

  it("drops entries whose count is zero or non-numeric (hostile-input defense)", () => {
    const codes = ["text_source_skipped"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 1,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".astro": 10, ".scss": 0, ".vue": "lots" as unknown as number },
      },
      filesByExtension: { ".tsx": 1 },
    });
    expect(details.text_source_skipped?.extensions).toEqual([".astro"]);
    expect(details.text_source_skipped?.totalSkipped).toBe(10);
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
        // see — `.haml` stands in as the skipped Ruby
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

  it("emits a `parse_errors_present` payload with `parseErrorsByParser` map", () => {
    const codes = ["parse_errors_present"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 552,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        parseErrorFileCount: 552,
        parseErrorsByParser: { tsx: 538, css: 12, html: 2 },
      },
      filesByExtension: { ".js": 538, ".css": 12, ".html": 2 },
    });
    expect(details.parse_errors_present?.parseErrorFileCount).toBe(552);
    expect(details.parse_errors_present?.parseErrorsByParser).toEqual({
      tsx: 538,
      css: 12,
      html: 2,
    });
  });

  it("emits the partialParseByParser payload mirror for the partial-parse bucket", () => {
    const codes = ["parse_errors_present"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 50,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        partialParseFileCount: 5,
        partialParseByParser: { html: 5 },
      },
      filesByExtension: { ".html": 50 },
    });
    expect(details.parse_errors_present?.partialParseByParser).toEqual({ html: 5 });
  });

  it("omits `parseErrorsByParser` when the coverage block doesn't carry the map (derivative tools that ship only the count scalar)", () => {
    const codes = ["parse_errors_present"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 50,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { parseErrorFileCount: 5 },
      filesByExtension: { ".tsx": 50 },
    });
    expect(details.parse_errors_present?.parseErrorFileCount).toBe(5);
    expect(details.parse_errors_present?.parseErrorsByParser).toBeUndefined();
  });

  it("filters binary-asset extensions out of the `text_source_skipped` payload", () => {
    const codes = ["text_source_skipped"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 50,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: {
          ".vue": 12,
          ".png": 200, // largest count but binary — must be filtered
          ".woff2": 30, // also binary
          ".scss": 8,
        },
      },
      filesByExtension: { ".tsx": 50 },
    });
    // `.png` would be the dominant entry but must be filtered out;
    // text-format `.vue` becomes the new top.
    expect(details.text_source_skipped?.topExtension).toBe(".vue");
    expect(details.text_source_skipped?.extensions).toEqual([".vue", ".scss"]);
    // `totalSkipped` only counts the surviving text-format entries —
    // mixing in binary counts would inflate the agent's triage signal
    // and re-introduce the noise the filter exists to remove.
    expect(details.text_source_skipped?.totalSkipped).toBe(20);
  });

  it("emits a `binary_assets_skipped` payload describing the binary subset (mirror shape of text_source_skipped)", () => {
    const codes = ["binary_assets_skipped"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 50,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: {
          ".vue": 12, // text — must NOT appear under binary
          ".png": 200,
          ".woff2": 30,
          ".scss": 8, // text — must NOT appear under binary
        },
      },
      filesByExtension: { ".tsx": 50 },
    });
    // Binary subset only — the text-source filter inverts.
    expect(details.binary_assets_skipped?.topExtension).toBe(".png");
    expect(details.binary_assets_skipped?.extensions).toEqual([".png", ".woff2"]);
    expect(details.binary_assets_skipped?.totalSkipped).toBe(230);
  });

  it("emits a `sourcemap_files_excluded` payload with count + head-sliced topPaths", () => {
    const codes = ["sourcemap_files_excluded"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 12,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        sourcemapFiles: [
          "/proj/assets/a.css.map",
          "/proj/assets/b.css.map",
          "/proj/assets/c.css.map",
        ],
      },
      filesByExtension: { ".tsx": 12 },
    });
    expect(details.sourcemap_files_excluded?.count).toBe(3);
    expect(details.sourcemap_files_excluded?.topPaths).toEqual([
      "/proj/assets/a.css.map",
      "/proj/assets/b.css.map",
      "/proj/assets/c.css.map",
    ]);
  });

  it("caps `sourcemap_files_excluded.topPaths` at 10 entries on a bulk corpus, preserves count", () => {
    // Mirrors the canonical 48-sourcemap CSS-framework corpus shape:
    // the count carries the full signal so the agent can spot bulk-
    // sourcemap directories without reading every path; topPaths is
    // a head slice large enough to recognize the directory pattern.
    const fullList = Array.from(
      { length: 48 },
      (_, i) => `/proj/dist/asset${String(i).padStart(2, "0")}.css.map`,
    );
    const details = computeScanWarningDetails(["sourcemap_files_excluded"], {
      filesScanned: 12,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { sourcemapFiles: fullList },
      filesByExtension: { ".tsx": 12 },
    });
    expect(details.sourcemap_files_excluded?.count).toBe(48);
    expect(details.sourcemap_files_excluded?.topPaths.length).toBe(10);
    // First 10 entries — list is sorted ascending at the discovery
    // seam, so the head slice is deterministic across runs.
    expect(details.sourcemap_files_excluded?.topPaths).toEqual(fullList.slice(0, 10));
  });

  it("emits both payloads with disjoint extension sets when both codes fire on a heterogeneous corpus", () => {
    const codes = ["text_source_skipped", "binary_assets_skipped"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 50,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: {
          ".php": 30,
          ".jpg": 1835, // canonical bulk-catalog vendor-asset volume
          ".coffee": 5,
          ".eot": 12,
        },
      },
      filesByExtension: { ".html": 50 },
    });
    // Text payload sees the actionable subset only.
    expect(details.text_source_skipped?.extensions).toEqual([".php", ".coffee"]);
    expect(details.text_source_skipped?.totalSkipped).toBe(35);
    // Binary payload sees the asset subset only.
    expect(details.binary_assets_skipped?.extensions).toEqual([".jpg", ".eot"]);
    expect(details.binary_assets_skipped?.totalSkipped).toBe(1847);
    // Disjoint by construction — no extension can appear in both.
    const textExts = new Set(details.text_source_skipped?.extensions ?? []);
    const binaryExts = new Set(details.binary_assets_skipped?.extensions ?? []);
    for (const ext of textExts) expect(binaryExts.has(ext)).toBe(false);
  });

  it("splits well-known textual no-extension filenames into a `noExtensionFiles` slot — `extensions` stays dotted-only", () => {
    // Per AI-first doctrine "Ambiguous field shapes are dishonest":
    // mixing dotted extensions with the parenthesized `(no-ext)`
    // sentinel and canonical filenames in one array forced the agent
    // to disambiguate three categorically different things from one
    // sorted list. The split keeps `extensions[]` type-honest (dotted
    // tokens only) and surfaces well-known textual filenames inline
    // under their canonical-cased name in `noExtensionFiles[]`.
    const codes = ["text_source_skipped"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 1,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: {
          ".php": 12,
          ".coffee": 4,
          LICENSE: 3,
          Makefile: 2,
          Dockerfile: 1,
        },
      },
      filesByExtension: { ".html": 1 },
    });
    // Dotted extensions only in `extensions[]` — no LICENSE / Makefile mixed in.
    expect(details.text_source_skipped?.extensions).toEqual([".php", ".coffee"]);
    // Well-known textual filenames inline under their canonical-cased names.
    expect(details.text_source_skipped?.noExtensionFiles).toEqual([
      "LICENSE",
      "Makefile",
      "Dockerfile",
    ]);
    // Total covers both slices (predicate-fired union).
    expect(details.text_source_skipped?.totalSkipped).toBe(12 + 4 + 3 + 2 + 1);
  });

  it("omits `noExtensionFiles` when no well-known textual filename contributed (present-when-meaningful)", () => {
    const codes = ["text_source_skipped"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 1,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".php": 12, ".coffee": 4 },
      },
      filesByExtension: { ".html": 1 },
    });
    expect(details.text_source_skipped?.extensions).toEqual([".php", ".coffee"]);
    // Field is omitted entirely (not `noExtensionFiles: []`) per the
    // present-when-meaningful contract — an agent can branch on
    // presence without having to re-disambiguate empty-vs-absent.
    expect(
      Object.hasOwn(details.text_source_skipped as Record<string, unknown>, "noExtensionFiles"),
    ).toBe(false);
  });

  it("excludes the residual `(no-ext)` token from both payloads (binary-shaped despite passing the binary-extension filter)", () => {
    // `(no-ext)` is the discovery walker's residual bucket for
    // binary-without-extension files (hash-named blobs, Git LFS
    // pointers). It satisfies !isBinaryAssetExtension but is not
    // text-source-shaped — keeping it in either payload would lie
    // about the predicate. The full `(no-ext)` count still lives in
    // `meta.analysisCoverage.skippedByExtension` for callers that
    // want the entire tail.
    const codes = ["text_source_skipped"] as const;
    const details = computeScanWarningDetails(codes, {
      filesScanned: 1,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        skippedByExtension: { ".php": 5, "(no-ext)": 99 },
      },
      filesByExtension: { ".html": 1 },
    });
    expect(details.text_source_skipped?.extensions).toEqual([".php"]);
    // `(no-ext)` does not appear under either slot.
    expect(details.text_source_skipped?.noExtensionFiles).toBeUndefined();
    // `totalSkipped` excludes the residual bucket.
    expect(details.text_source_skipped?.totalSkipped).toBe(5);
  });

  it("does NOT fire `text_source_skipped` when the skipped map carries only the residual `(no-ext)` token (predicate aligned with summarizer)", () => {
    const codes = computeScanWarnings({
      filesScanned: 50,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: { skippedByExtension: { "(no-ext)": 7 } },
      filesByExtension: { ".html": 50 },
    });
    // No text-source extension and no well-known textual filename →
    // predicate must NOT fire (otherwise the warning would fall
    // through to the truncation sentinel).
    expect(codes).not.toContain("text_source_skipped");
    expect(codes).not.toContain("binary_assets_skipped");
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
    expect(out.warnings).toEqual(["text_source_skipped"]);
    expect(out.warningsDetails?.text_source_skipped?.topExtension).toBe(".astro");
    expect(out.warningsDetails?.text_source_skipped?.totalSkipped).toBe(104);
  });

  it("emits `warningsDetails` with the truncation sentinel when a payload-bearing code fires without its summarizer inputs (warnings-details schema discipline)", () => {
    const out = warningsField({
      filesScanned: 10,
      rootSource: "explicit",
      configSource: null,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: true,
    });
    // `no_config_found` fires; the payload-bearing slot drops the
    // `searchedFrom` field because the caller did not thread
    // `configSearchedFromForWarning`. Closes the the payload-
    // bearing fall-through now stamps the
    // `{ truncated: true, reason: "summarizer_inputs_unavailable" }`
    // sentinel rather than the binary `{}` marker, so the agent can
    // tell "the payload-bearing slot exists but the input wasn't
    // threaded" apart from a code that is binary by design.
    expect(out.warnings).toEqual(["no_config_found"]);
    expect(out.warningsDetails).toBeDefined();
    // Read through `Record<string, unknown>` so the assertion accepts
    // either the rich shape (typed) OR the truncation sentinel
    // (runtime fall-through). The typed slot only describes the rich
    // shape because that's the call-site claim every caller can
    // satisfy; sentinels surface at the wire-reading boundary.
    const detailsMap = out.warningsDetails as Record<string, unknown>;
    expect(detailsMap.no_config_found).toEqual({
      truncated: true,
      reason: "summarizer_inputs_unavailable",
    });
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
    expect(out.warnings).toContain("text_source_skipped");
    expect(out.warningsDetails?.text_source_skipped?.topExtension).toBe(".scss");
    expect(out.warningsDetails?.text_source_skipped?.extensions).toEqual([".scss", ".astro"]);
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
    //
    // `sortOrder` is mandatory whenever the density cap fires — without
    // it the agent paginating via `nextOffset` (or re-scoping after a
    // truncation) cannot choose a page-walk strategy honestly. The
    // surviving `files[]` are alphabetical-by-path because
    // `discoverFiles` + `groupViolationsByFile` both sort by
    // `localeCompare` and the density cap drops trailing entries.
    expect(out.warningsDetails.response_token_budget_truncated).toEqual({
      requestedLimit: 50,
      effectiveLimit: 10,
      reason: "token_density",
      sortOrder: "alphabetical-by-path",
    });
    // Shape: `warningsDetails` is the only top-level key — the
    // fragment is designed to spread directly into a response body
    // alongside `warnings: [...]` without fighting object-spread
    // semantics.
    expect(Object.keys(out)).toEqual(["warningsDetails"]);
  });

  it("`response_token_budget_truncated` payload always carries `sortOrder: 'alphabetical-by-path'` so a paginating agent's page-walk strategy is informed", () => {
    // Mandatory-field invariant: agents paginating after a density-cap
    // truncation depend on the sort order of the surviving `files[]`
    // entries to decide their page-walk strategy (alphabetical
    // resumption via `nextOffset` vs. re-scoping by directory vs.
    // re-scanning under a tighter `cwd`). Without `sortOrder`, the
    // agent cannot tell whether the dropped tail follows alphabetical /
    // finding-density / severity order. The field is present on every
    // density-cap emission and must NOT be conditional-spread away.
    //
    // Repeats the assertion across the contributor-triple-present
    // branch + the contributor-absent branch so the field rides on
    // BOTH conditional shapes (the present-when-meaningful contributor
    // fields don't gate the always-on sortOrder).
    const withoutContributor = tokenBudgetTruncatedDetailsField({
      requestedLimit: 18,
      effectiveLimit: 1,
    }).warningsDetails.response_token_budget_truncated;
    expect(withoutContributor?.sortOrder).toBe("alphabetical-by-path");
    const withContributor = tokenBudgetTruncatedDetailsField({
      requestedLimit: 50,
      effectiveLimit: 12,
      topContributor: {
        topContributorRule: "color/contrast-minimum",
        topContributorByteCount: 4321,
        dominantContributor: "fix_description",
      },
    }).warningsDetails.response_token_budget_truncated;
    expect(withContributor?.sortOrder).toBe("alphabetical-by-path");
  });

  it("warnings-details schema discipline — every fired code has a corresponding key in `warningsDetails` (rich payload OR empty `{}` for binary codes OR truncation sentinel for payload-bearing codes without inputs)", () => {
    const out = warningsField({
      filesScanned: 42, // above the no_config_found threshold
      rootSource: "spawn-cwd", // fires root_source_defaulted (binary)
      configSource: null, // fires no_config_found (payload-bearing, no input here)
      configSearchSawProjectMarker: true,
      analysisCoverage: {
        skippedByExtension: { ".scss": 5 }, // fires text_source_skipped (rich)
      },
      filesByExtension: undefined,
    });
    // Rich payload retained for the payload-bearing code that DID
    // get its summarizer input.
    expect(out.warnings).toContain("text_source_skipped");
    const extensionsEntry = out.warningsDetails?.text_source_skipped as
      | { readonly topExtension: string }
      | undefined;
    expect(extensionsEntry?.topExtension).toBe(".scss");
    // `no_config_found` is payload-bearing on the type but the caller
    // didn't supply `configSearchedFromForWarning` — Closes the the
    // dispatch fall-through stamps the truncation sentinel rather
    // than the bare `{}` marker. Read through `Record<string, unknown>`
    // because the sentinel shape doesn't match the typed rich slot.
    const detailsMap = out.warningsDetails as Record<string, unknown>;
    expect(detailsMap.no_config_found).toEqual({
      truncated: true,
      reason: "summarizer_inputs_unavailable",
    });
    // `root_source_defaulted` is `BinaryPresenceMarker`-typed by
    // design, so the fall-through correctly stamps `{}`.
    expect(out.warningsDetails?.root_source_defaulted).toEqual({});
    const codes = out.warnings ?? [];
    const detailKeys = Object.keys(out.warningsDetails ?? {}).sort();
    expect(detailKeys).toEqual([...codes].sort());
  });

  it("Jekyll scan emits content_files_skipped + text_source_skipped together with matching payloads", () => {
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
    expect(out.warnings).toContain("text_source_skipped");
    expect(out.warningsDetails?.content_files_skipped?.count).toBe(307);
    expect(out.warningsDetails?.text_source_skipped?.topExtension).toBe(".md");
  });
});

// vendor-CSS dominance signal.
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

  it("falls back to the truncation sentinel when the code fired but topVendorFile is absent (warnings-details schema discipline)", () => {
    // Closes the payload-bearing codes whose summarizer returns
    // `undefined` because the rich-payload-required input was missing
    // get the `{ truncated: true, reason: "summarizer_inputs_unavailable" }`
    // sentinel, NOT the bare binary `{}` marker. The agent reading
    // the wire can then tell "this entry's payload was supposed to
    // be here" from "this code is binary by design."
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
    const detailsMap = details as Record<string, unknown>;
    expect(detailsMap.vendor_css_dominates_findings).toEqual({
      truncated: true,
      reason: "summarizer_inputs_unavailable",
    });
  });

  it("falls back to the truncation sentinel when vendorCssNoise is absent entirely (warnings-details schema discipline)", () => {
    const details = computeScanWarningDetails(["vendor_css_dominates_findings"] as const, {
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
    });
    const detailsMap = details as Record<string, unknown>;
    expect(detailsMap.vendor_css_dominates_findings).toEqual({
      truncated: true,
      reason: "summarizer_inputs_unavailable",
    });
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
  it("fires when metaArrayTruncatedFields names at least one elided field", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      metaArrayTruncatedFields: ["analysisCoverage.fragmentFiles"],
    });
    expect(codes).toContain("response_meta_truncated");
  });

  it("does NOT fire when metaArrayTruncatedFields is empty (every capped array fit)", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      metaArrayTruncatedFields: [],
    });
    expect(codes).not.toContain("response_meta_truncated");
  });

  it("does NOT fire when metaArrayTruncatedFields is omitted (caller didn't opt in)", () => {
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

  it("warningsDetails.response_meta_truncated payload names every elided field path", () => {
    // Slice 1 (Q-SHARED-RESPONSE-META-TRUNCATED-FIELDS): the
    // payload now carries the dotted field paths so the agent can
    // re-fetch under `verboseMeta: true` rather than probing each
    // possible array blind. Order is the table-declared order so the
    // wire shape stays deterministic.
    const out = warningsField({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      metaArrayTruncatedFields: [
        "analysisCoverage.fragmentFiles",
        "scannedBuildArtifacts.ungrouped",
      ],
    });
    expect(out.warnings).toContain("response_meta_truncated");
    expect(out.warningsDetails?.response_meta_truncated).toEqual({
      fields: ["analysisCoverage.fragmentFiles", "scannedBuildArtifacts.ungrouped"],
    });
  });
});

// the payload-vs-binary
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
// `text_source_skipped`, `parse_errors_present`,
// `source_language_unsupported`, `template_files_parsed_as_literal`)
// — half the report's claim was that only one of seven carried a
// payload; the contract now is "three carry quantitative payloads
// from the start (tokens / extensions / source-language), two more
// were enriched here (build-artifacts / parse-errors), and two are
// honestly binary (no-config / template-literal)." Together they
// pin the cross-surface invariant so the regression cannot reopen
// silently.
describe("warningsDetails cross-surface regression — payload-vs-binary contract", () => {
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

  it("`scanned_build_artifacts_present` fires with the truncation sentinel when only the binary flag is supplied (caller can't compute the count)", () => {
    // Derivative tools that know "at least one artifact was scanned"
    // but didn't materialize the entries list still emit the bare
    // code — surface-don't-suppress doctrine. Closes the the
    // sub-entry on `warningsDetails` is the truncation sentinel
    // rather than the binary `{}` marker, so the agent can tell
    // "the count was supposed to be here and isn't" from "this code
    // is binary by design." `scanned_build_artifacts_present` is
    // typed as payload-bearing in `ScanWarningDetails`; the sentinel
    // matches that schema honestly.
    const out = warningsField({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
      scannedBuildArtifactsPresent: true,
    });
    expect(out.warnings).toContain("scanned_build_artifacts_present");
    const detailsMap = out.warningsDetails as Record<string, unknown> | undefined;
    expect(detailsMap?.scanned_build_artifacts_present).toEqual({
      truncated: true,
      reason: "summarizer_inputs_unavailable",
    });
  });

  it("warnings-details schema discipline — `no_config_found` carries `searchedFrom` when supplied; falls back to the truncation sentinel otherwise", () => {
    // `no_config_found` is payload-bearing in the schema — the
    // `searchedFrom: <cwd>` field gives the agent one canonical
    // answer to "where did the loader walk from." When the caller
    // threads `configSearchedFromForWarning`, the payload populates;
    // when it doesn't, the dispatch falls through to the truncation
    // sentinel (sentinel disambiguation) so the agent can distinguish "the
    // payload was supposed to be here" from "binary by design."
    const withPayload = warningsField({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: null,
      configSearchedFromForWarning: "/proj/root",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: true,
    });
    expect(withPayload.warnings).toContain("no_config_found");
    expect(withPayload.warningsDetails?.no_config_found).toEqual({ searchedFrom: "/proj/root" });

    const withoutPayload = warningsField({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: null,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: true,
    });
    expect(withoutPayload.warnings).toContain("no_config_found");
    // Read through `Record<string, unknown>` because the sentinel
    // shape doesn't match the typed rich slot.
    const detailsMap = withoutPayload.warningsDetails as Record<string, unknown>;
    expect(detailsMap.no_config_found).toEqual({
      truncated: true,
      reason: "summarizer_inputs_unavailable",
    });
  });

  it("warnings-details schema discipline — binary-presence code `template_files_parsed_as_literal` ships the empty-object marker", () => {
    // `template_files_parsed_as_literal` is binary too: the
    // interpolation token list lives in
    // `meta.analysisCoverage.templateInterpolationFound` and the
    // code's prose names the dispatch (overlap or frontmatter fence).
    // A count of tokens or fence presence bit doesn't change the
    // agent's next action — read the file, confirm the parse-as-
    // literal regime, decide whether to add a pragma — the bare
    // code IS the entire top-level signal. The marker on
    // `warningsDetails` keeps the membership invariant honest across
    // the response.
    const out = warningsField({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {
        templateInterpolationFound: [{ token: "{%x%}", count: 3 }],
      },
      filesByExtension: { ".html": 5 },
      templateDirectivesOverlap: true,
    });
    expect(out.warnings).toContain("template_files_parsed_as_literal");
    expect(
      (out.warningsDetails as Record<string, unknown> | undefined)?.[
        "template_files_parsed_as_literal"
      ],
    ).toEqual({});
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
        templateInterpolationFound: [{ token: "{%x%}", count: 3 }],
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
    expect(codes).toContain("text_source_skipped");
    expect(codes).toContain("parse_errors_present");
    expect(codes).toContain("source_language_unsupported");
    expect(codes).toContain("scanned_build_artifacts_present");
    expect(codes).toContain("template_files_parsed_as_literal");
    // Payload-bearing slots populated for every fired code that has
    // a rich slot.
    expect(out.warningsDetails?.text_source_skipped).toBeDefined();
    expect(out.warningsDetails?.parse_errors_present).toBeDefined();
    expect(out.warningsDetails?.source_language_unsupported).toBeDefined();
    expect(out.warningsDetails?.scanned_build_artifacts_present).toBeDefined();
    // warnings-details schema discipline: every fired code is keyed.
    // Disambiguation:
    //   - `template_files_parsed_as_literal` is binary by design
    //     (typed as `BinaryPresenceMarker`) so the fall-through
    //     stamps `{}` honestly.
    //   - `no_config_found` is payload-bearing in the schema; the
    //     caller didn't thread `configSearchedFromForWarning`, so
    //     the fall-through stamps the truncation sentinel rather
    //     than the bare `{}` marker — disambiguates "the payload
    //     was supposed to be here" from "binary by design."
    // Sentinel reads go through `Record<string, unknown>` because the
    // typed slot describes only the rich shape.
    const detailsMap = out.warningsDetails as Record<string, unknown>;
    expect(detailsMap.no_config_found).toEqual({
      truncated: true,
      reason: "summarizer_inputs_unavailable",
    });
    expect(detailsMap.template_files_parsed_as_literal).toEqual({});
    // Membership invariant: keys on `warningsDetails` exactly match
    // the codes in `warnings[]` (no extras, no omissions).
    const detailsKeys = Object.keys(out.warningsDetails ?? {}).sort();
    expect(detailsKeys).toEqual([...codes].sort());
  });

  it("the membership-vs-payload invariant: every key on `warningsDetails` corresponds to a fired code in `warnings[]` (and no extras leak when codes is empty)", () => {
    // Drives `computeScanWarningDetails` directly with codes that
    // were NOT emitted (empty `codes` arg) — the helper must NOT
    // leak any payload (rich OR `{}` marker), even when the inputs
    // would otherwise let a `summarize*` helper succeed. Prevents a
    // refactor from detaching the gate that keeps the two channels
    // in lock-step.
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

  it("warnings-details schema discipline — canonical 8-codes-vs-1-detail regression: every code in warnings[] gets a key (rich OR marker)", () => {
    // The canonical repro: 8 codes fired, only
    // `response_token_budget_truncated` carried a payload, the
    // other 7 codes had no key on `warningsDetails`. Asymmetric
    // discipline made the wire shape dishonest — an agent reading
    // a code without a key couldn't tell "no payload by design"
    // from "payload exists but this surface didn't compute it."
    //
    // Schema-discipline contract: every fired code has a key. Rich
    // payloads for the codes whose summarizers carry quantitative
    // signal, empty `{}` markers for the rest. The membership
    // invariant is load-bearing — the agent reads
    // `warningsDetails[code]` and gets a definite answer,
    // regardless of which code it is.
    const out = warningsField({
      filesScanned: 250,
      rootSource: "spawn-cwd", // root_source_defaulted (presence)
      configSource: null, // no_config_found (presence)
      configSearchSawProjectMarker: true,
      analysisCoverage: {
        parseErrorFileCount: 4,
        partialParseFileCount: 0,
        // template directives + finding overlap fire
        // template_files_parsed_as_literal (presence)
        templateInterpolationFound: [{ token: "{%x%}", count: 1 }],
        // skippedByExtension fires text_source_skipped (rich)
        skippedByExtension: { ".astro": 80, ".rb": 120 },
      },
      filesByExtension: { ".tsx": 250 },
      // build artifacts present (rich payload — `{ count, topPath }`)
      scannedBuildArtifactsPresent: true,
      scannedBuildArtifactsSummary: { count: 17, topPath: "vendor/x.css" },
      // template-overlap gate — the warning fires only when at
      // least one finding's line sits inside a directive range.
      templateDirectivesOverlap: true,
    });
    const codes = out.warnings ?? [];
    // Sample the canonical 5 codes the regression item names — the
    // exact code set varies per fixture so the load-bearing
    // assertion is the membership invariant on the next line.
    expect(codes).toContain("no_config_found");
    expect(codes).toContain("template_files_parsed_as_literal");
    expect(codes).toContain("scanned_build_artifacts_present");
    expect(codes).toContain("text_source_skipped");
    expect(codes).toContain("parse_errors_present");
    // Membership invariant — keys on `warningsDetails` exactly
    // match the codes in `warnings[]`. The integration test in
    // `tests/integration/mcp-consistency/warnings-details-cross-surface.test.ts`
    // pins this across the live MCP wire; this unit test pins it
    // at the helper layer.
    const detailKeys = Object.keys(out.warningsDetails ?? {}).sort();
    expect(detailKeys).toEqual([...codes].sort());
    // Spot-check rich + marker entries to lock both shapes.
    // Rich payload populated when the summarizer's input was wired.
    expect(out.warningsDetails?.scanned_build_artifacts_present).toEqual({
      count: 17,
      topPath: "vendor/x.css",
    });
    // Disambiguation: payload-bearing code without its
    // summarizer input → truncation sentinel, NOT bare `{}`.
    // Read through `Record<string, unknown>` because the sentinel
    // shape doesn't match the typed rich slot.
    const detailsMap = out.warningsDetails as Record<string, unknown>;
    expect(detailsMap.no_config_found).toEqual({
      truncated: true,
      reason: "summarizer_inputs_unavailable",
    });
    // Binary-presence code (typed as `BinaryPresenceMarker`) →
    // bare `{}` marker, honestly.
    expect(detailsMap.template_files_parsed_as_literal).toEqual({});
  });
});

//
//
// Doctrine: zero-output success is ambiguous failure. Token-only
// `.scss` partials (`_variables.scss`, Font Awesome theme files,
// Bootstrap-style design-system roots) parse to zero CSS rules — and
// `contrast/minimum`'s per-rule coverage row would silently surface as
// `findings: 0, coverageConfidence: "high"` without the warning + the
// per-row downgrade. The detector lives in `src/mcp/scan-assembly.ts`;
// these tests rehearse the wire shape after the call site has handed
// the file list to the warnings module.
describe("computeScanWarnings — scss_unresolved_variables", () => {
  it("fires when scssUnresolvedVariableFiles is non-empty", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".scss": 3, ".tsx": 2 },
      scssUnresolvedVariableFiles: ["theme/_variables.scss"],
    });
    expect(codes).toContain("scss_unresolved_variables");
  });

  it("does NOT fire when scssUnresolvedVariableFiles is empty", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".scss": 3 },
      scssUnresolvedVariableFiles: [],
    });
    expect(codes).not.toContain("scss_unresolved_variables");
  });

  it("does NOT fire when the field is omitted entirely", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".scss": 3 },
    });
    expect(codes).not.toContain("scss_unresolved_variables");
  });

  it("emits the file list verbatim under warningsDetails.scss_unresolved_variables", () => {
    const fields = warningsField({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".scss": 3 },
      scssUnresolvedVariableFiles: ["a/_variables.scss", "b/_tokens.scss"],
    });
    expect(fields.warnings).toContain("scss_unresolved_variables");
    expect(fields.warningsDetails?.scss_unresolved_variables).toEqual({
      files: ["a/_variables.scss", "b/_tokens.scss"],
    });
  });

  it("omits warningsDetails.scss_unresolved_variables when the code did not fire (payload-vs-binary contract)", () => {
    const fields = warningsField({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".scss": 3 },
      // No scssUnresolvedVariableFiles supplied — no code, no payload.
    });
    expect(fields.warnings ?? []).not.toContain("scss_unresolved_variables");
    expect(fields.warningsDetails?.scss_unresolved_variables).toBeUndefined();
  });
});

// parallel coverage for the
// `scanned_minified_file` code's `warningsDetails` payload + the
// payload-vs-binary contract. Mirrors the `scss_unresolved_variables`
// pattern because both codes carry the same shape (`{ files: string[] }`)
// and the same emission predicate ("non-empty caller-supplied list").
describe("computeScanWarnings — scanned_minified_file payload + warningsField wiring", () => {
  it("emits the file list under warningsDetails.scanned_minified_file (sorted alphabetically for deterministic wire output)", () => {
    const fields = warningsField({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 3 },
      // Intentionally unsorted on input so the test locks the
      // call-site sort that keeps the wire shape stable across
      // discovery-order changes.
      scannedMinifiedFiles: ["dist/jquery.min.js", "dist/bootstrap.min.css"],
    });
    expect(fields.warnings).toContain("scanned_minified_file");
    expect(fields.warningsDetails?.scanned_minified_file).toEqual({
      files: ["dist/bootstrap.min.css", "dist/jquery.min.js"],
    });
  });

  it("omits warningsDetails.scanned_minified_file when the code did not fire (payload-vs-binary contract)", () => {
    const fields = warningsField({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 3 },
      // No scannedMinifiedFiles supplied — no code, no payload.
    });
    expect(fields.warnings ?? []).not.toContain("scanned_minified_file");
    expect(fields.warningsDetails?.scanned_minified_file).toBeUndefined();
  });

  it("falls back to the truncation sentinel when scannedMinifiedFiles is supplied but empty (warnings-details schema discipline)", () => {
    // Closes the payload-bearing codes whose summarizer falls
    // through on degenerate input get the truncation sentinel
    // rather than the binary `{}` marker. `scanned_minified_file`
    // is typed as payload-bearing; an empty `scannedMinifiedFiles`
    // array is still a degenerate input from the summarizer's
    // perspective (it returns `undefined`) — the sentinel stamp is
    // the honest disambiguation.
    const details = computeScanWarningDetails(["scanned_minified_file"], {
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      scannedMinifiedFiles: [],
    });
    // Read through `Record<string, unknown>` so the assertion
    // Read through `Record<string, unknown>` so the assertion
    // accepts the truncation-sentinel shape that the dispatch's
    // fall-through path stamps for payload-bearing codes whose
    // summarizer returned `undefined`.
    const detailsMap = details as Record<string, unknown>;
    expect(detailsMap.scanned_minified_file).toEqual({
      truncated: true,
      reason: "summarizer_inputs_unavailable",
    });
  });
});

describe("computeScanWarnings: bulk-catalog scan performance", () => {
  // The detector at `src/mcp/bulk-catalog.ts` resolves to either an
  // additive payload (slow + vendor-heavy OR bulk + vendor-heavy) or
  // `undefined`. The warnings module is pure over the resolved value
  // — when the detection field is populated, the code fires and its
  // payload echoes the raw inputs verbatim (no thresholds in the
  // payload, no derived "severity" tokens). When the field is
  // omitted, the code drops conservatively.
  it("fires `bulk_catalog_detected` when the detection field is populated", () => {
    const codes = computeScanWarnings({
      filesScanned: 4043,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      bulkCatalogDetection: {
        trigger: "slow_and_vendor_heavy",
        durationMs: 12188,
        filesScanned: 4043,
        buildArtifactsCount: 516,
        suggestedExcludes: ["**/bootstrap.css", "**/animate.css"],
        topVendorFile: "templates/site-0/bootstrap.css",
      },
    });
    expect(codes).toContain("bulk_catalog_detected");
  });

  it("does NOT fire when the detection field is undefined (the common case)", () => {
    const codes = computeScanWarnings({
      filesScanned: 200,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(codes).not.toContain("bulk_catalog_detected");
  });

  it("emits the structured payload via the dispatch table when the code fires", () => {
    const inputs = {
      filesScanned: 4043,
      rootSource: "explicit" as const,
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      bulkCatalogDetection: {
        trigger: "slow_and_vendor_heavy" as const,
        durationMs: 12188,
        filesScanned: 4043,
        buildArtifactsCount: 516,
        suggestedExcludes: ["**/bootstrap.css", "**/animate.css", "**/font-awesome.min.css"],
        topVendorFile: "templates/site-0/bootstrap.css",
      },
    };
    const codes = computeScanWarnings(inputs);
    const details = computeScanWarningDetails(codes, inputs);
    expect(details.bulk_catalog_detected).toBeDefined();
    expect(details.bulk_catalog_detected?.trigger).toBe("slow_and_vendor_heavy");
    expect(details.bulk_catalog_detected?.durationMs).toBe(12188);
    expect(details.bulk_catalog_detected?.filesScanned).toBe(4043);
    expect(details.bulk_catalog_detected?.buildArtifactsCount).toBe(516);
    expect(details.bulk_catalog_detected?.suggestedExcludes).toEqual([
      "**/bootstrap.css",
      "**/animate.css",
      "**/font-awesome.min.css",
    ]);
    expect(details.bulk_catalog_detected?.topVendorFile).toBe("templates/site-0/bootstrap.css");
  });

  it("the `topVendorFile` field is omitted from the payload when the detection has no top vendor file (present-when-meaningful)", () => {
    // Defensive — a detection without `topVendorFile` should still
    // produce a payload (the rest of the signal is load-bearing) but
    // the optional field stays absent rather than emitting `null` or
    // `""` per CLAUDE.md §1 "Ambiguous field shapes are dishonest."
    const inputs = {
      filesScanned: 4043,
      rootSource: "explicit" as const,
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      bulkCatalogDetection: {
        trigger: "bulk_and_vendor_heavy" as const,
        durationMs: 5000,
        filesScanned: 4043,
        buildArtifactsCount: 60,
        suggestedExcludes: ["**/some-vendor.css"],
      },
    };
    const codes = computeScanWarnings(inputs);
    const details = computeScanWarningDetails(codes, inputs);
    expect(details.bulk_catalog_detected).toBeDefined();
    expect("topVendorFile" in (details.bulk_catalog_detected ?? {})).toBe(false);
  });
});

// a banner-detected vendor library
// emitting a single rule's findings ≥ ANIMATION_LIB_GUARD_FINDING_FLOOR
// times on one file earns the additive guard warning. The remediation
// pivot ("wrap the import in @media (prefers-reduced-motion)") shifts
// the agent's triage from O(N) per-finding pragma writes to O(1) one
// wrap. Surface-don't-suppress: every individual finding stays in
// `files[]`; the warning is additive routing telemetry only.
describe("computeScanWarnings — animation_library_without_reduced_motion_guard", () => {
  it("fires when at least one (ruleId, file) pair on a vendor library cleared the floor", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
      animationLibraryGuardCandidates: [
        {
          ruleId: "motion/pause-stop-hide",
          file: "vendor/animate.css",
          findingCount: 27,
          library: "animate.css",
          suggestion: "wrap @import in @media (prefers-reduced-motion: no-preference)",
        },
      ],
    });
    expect(codes).toContain("animation_library_without_reduced_motion_guard");
  });

  it("does NOT fire on the same finding count when the candidate list is omitted (caller didn't compute it)", () => {
    // The cross-reference predicate is computed at the call site; this
    // module stays pure over its inputs. A caller that doesn't
    // participate (e.g. a derivative tool that lacks vendor-library
    // detection) silently drops the code rather than emitting it on
    // weaker evidence.
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
    });
    expect(codes).not.toContain("animation_library_without_reduced_motion_guard");
  });

  it("does NOT fire on an empty candidate array (caller computed but no pair cleared the floor)", () => {
    const codes = computeScanWarnings({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
      animationLibraryGuardCandidates: [],
    });
    expect(codes).not.toContain("animation_library_without_reduced_motion_guard");
  });

  it("warningsField pairs the code with its structured payload — densest tuple on the headline", () => {
    const out = warningsField({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
      animationLibraryGuardCandidates: [
        {
          ruleId: "motion/pause-stop-hide",
          file: "vendor/animate.css",
          findingCount: 27,
          library: "animate.css",
          suggestion:
            "Wrap the `animate.css` import in `@media (prefers-reduced-motion: no-preference) { ... }`.",
        },
      ],
    });
    expect(out.warnings).toContain("animation_library_without_reduced_motion_guard");
    const payload = out.warningsDetails?.animation_library_without_reduced_motion_guard;
    expect(payload?.ruleId).toBe("motion/pause-stop-hide");
    expect(payload?.file).toBe("vendor/animate.css");
    expect(payload?.findingCount).toBe(27);
    expect(payload?.library).toBe("animate.css");
    expect(payload?.suggestion).toContain("prefers-reduced-motion");
    expect(payload?.additionalMatches).toBeUndefined();
  });

  it("packs lower-density candidates under additionalMatches[] when multiple libraries hit the regime", () => {
    const out = warningsField({
      filesScanned: 42,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".css": 4 },
      animationLibraryGuardCandidates: [
        {
          ruleId: "motion/pause-stop-hide",
          file: "vendor/animate.css",
          findingCount: 27,
          library: "animate.css",
          suggestion: "wrap animate.css",
        },
        {
          ruleId: "motion/pause-stop-hide",
          file: "vendor/extra.css",
          findingCount: 50,
          library: "other-lib",
          suggestion: "wrap other-lib",
        },
      ],
    });
    const payload = out.warningsDetails?.animation_library_without_reduced_motion_guard;
    // Highest findingCount rides on the headline (50 > 27).
    expect(payload?.findingCount).toBe(50);
    expect(payload?.library).toBe("other-lib");
    // The lower-density candidate lands under additionalMatches.
    expect(payload?.additionalMatches?.length).toBe(1);
    expect(payload?.additionalMatches?.[0]).toMatchObject({
      ruleId: "motion/pause-stop-hide",
      file: "vendor/animate.css",
      findingCount: 27,
      library: "animate.css",
    });
    // additionalMatches entries deliberately omit `suggestion` — the
    // headline tuple's text already names the remediation pattern.
    expect(payload?.additionalMatches?.[0]).not.toHaveProperty("suggestion");
  });

  // payload-bearing surface:
  // the ancestor path is the load-bearing pivot the agent re-scopes
  // to, so it must ride on the structured `warningsDetails` channel
  // alongside the bare code (membership-vs-payload invariant).
  it("warningsField pairs `cwd_appears_misrooted` with its `nearestConfigAncestor` payload", () => {
    const out = warningsField({
      filesScanned: 0,
      rootSource: "explicit",
      configSource: "/parent/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: undefined,
      nearestConfigAncestor: "/parent",
    });
    expect(out.warnings).toContain("cwd_appears_misrooted");
    expect(out.warningsDetails?.cwd_appears_misrooted).toBeDefined();
    expect(out.warningsDetails?.cwd_appears_misrooted?.nearestConfigAncestor).toBe("/parent");
  });

  it("does NOT emit a `cwd_appears_misrooted` payload when the code didn't fire", () => {
    const out = warningsField({
      filesScanned: 12,
      rootSource: "explicit",
      configSource: "/parent/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".tsx": 12 },
      nearestConfigAncestor: "/parent",
    });
    expect(out.warnings ?? []).not.toContain("cwd_appears_misrooted");
    expect(out.warningsDetails?.cwd_appears_misrooted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// js_innerhtml_template_literal_unparsed — emission predicate + payload
// ---------------------------------------------------------------------------
// The warning code names a routing-skip failure mode the doctrine flags:
// inline-HTML islands inside JS/TS source whose payload the static path
// either declined (dynamic `${…}` literals) OR couldn't see through the
// router's coverage (file produced zero findings). Both axes drive the
// same code; the payload carries whichever evidence the caller threaded.

describe("computeScanWarnings — js_innerhtml_template_literal_unparsed", () => {
  it("fires when a dynamic template literal was declined (declinedCount > 0)", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {},
      filesByExtension: { ".js": 5 },
      jsInnerHtmlDeclinedCount: 1,
    });
    expect(codes).toContain("js_innerhtml_template_literal_unparsed");
  });

  it("fires when fileSamples is non-empty even with declinedCount = 0", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {},
      filesByExtension: { ".js": 5 },
      jsInnerHtmlFileSamples: [{ path: "src/widget.js", line: 12, pattern: "innerHTML" }],
    });
    expect(codes).toContain("js_innerhtml_template_literal_unparsed");
  });

  it("does NOT fire when both axes are empty / undefined", () => {
    const codes = computeScanWarnings({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: {},
      filesByExtension: { ".js": 5 },
    });
    expect(codes ?? []).not.toContain("js_innerhtml_template_literal_unparsed");
  });

  it("payload carries declinedCount + fileSamples on the warningsDetails channel", () => {
    const out = warningsField({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".js": 5 },
      jsInnerHtmlDeclinedCount: 2,
      jsInnerHtmlFileSamples: [
        { path: "src/widget.js", line: 12, pattern: "innerHTML" },
        { path: "src/modal.js", line: 7, pattern: "insertAdjacentHTML" },
      ],
    });
    expect(out.warnings).toContain("js_innerhtml_template_literal_unparsed");
    const detail = out.warningsDetails?.js_innerhtml_template_literal_unparsed;
    expect(detail).toBeDefined();
    expect(detail?.declinedCount).toBe(2);
    expect(detail?.fileSamples?.length).toBe(2);
  });

  it("payload omits declinedCount sub-field when declined was zero (present-when-meaningful)", () => {
    const out = warningsField({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".js": 5 },
      jsInnerHtmlFileSamples: [{ path: "src/x.js", line: 1, pattern: "jquery.html" }],
    });
    const detail = out.warningsDetails?.js_innerhtml_template_literal_unparsed;
    expect(detail).toBeDefined();
    expect(detail?.declinedCount).toBeUndefined();
    expect(detail?.fileSamples?.length).toBe(1);
  });

  it("payload omits fileSamples sub-field when no samples were threaded (present-when-meaningful)", () => {
    const out = warningsField({
      filesScanned: 5,
      rootSource: "explicit",
      configSource: "/proj/ra11y.config.ts",
      analysisCoverage: undefined,
      filesByExtension: { ".js": 5 },
      jsInnerHtmlDeclinedCount: 3,
    });
    const detail = out.warningsDetails?.js_innerhtml_template_literal_unparsed;
    expect(detail).toBeDefined();
    expect(detail?.declinedCount).toBe(3);
    expect(detail?.fileSamples).toBeUndefined();
  });
});
