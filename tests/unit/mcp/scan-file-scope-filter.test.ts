/**
 * Unit tests for `scan_file`'s defensive per-file scope filter on
 * `meta.analysisCoverage` + `meta.scannedBuildArtifacts`.
 *
 * The filter is the response-assembly-site guard against cross-file
 * state leaking into a single-file response. Per the AI-first
 * doctrine "Per-tool lane and warning-set classification must agree"
 * extended downward: a per-file response must contain only per-file
 * evidence; an entry mentioning a sibling file forces the agent to
 * re-read and disambiguate whether that file was actually involved
 * in evaluating the scanned one.
 *
 * Most of the time the filter is a no-op (the analysis-coverage
 * accumulator walks `[parsed]` only on the scan_file path), but the
 * defensive guard catches regressions where a project-shaped state
 * leaks downstream — these tests pin the filter against synthetic
 * leak shapes the regression would have produced.
 */

import { describe, expect, it } from "bun:test";
import { applySingleFileScopeFilterToMeta } from "../../../src/mcp/tool-scan-file.ts";

const SCANNED = "docs/_includes/top.html";
const SIBLING = "docs/error.html";

describe("scan_file: applySingleFileScopeFilterToMeta", () => {
  it("drops sibling-file entries from meta.analysisCoverage.partialParseFiles", () => {
    const meta = {
      filesScanned: 1,
      analysisCoverage: {
        partialParseFileCount: 2,
        partialParseFiles: [
          { path: SCANNED, parserAttempted: "html", reason: "Mismatched </body>" },
          { path: SIBLING, parserAttempted: "html", reason: "Mismatched </div>" },
        ],
      },
    } as const;
    const out = applySingleFileScopeFilterToMeta(meta, SCANNED);
    const coverage = out["analysisCoverage"] as Record<string, unknown>;
    const list = coverage["partialParseFiles"] as readonly { readonly path: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.path).toBe(SCANNED);
    expect(coverage["partialParseFileCount"]).toBe(1);
  });

  it("drops sibling-file entries from meta.analysisCoverage.parseErrorFiles", () => {
    const meta = {
      analysisCoverage: {
        parseErrorFileCount: 2,
        parseErrorFiles: [
          { path: SCANNED, parserAttempted: "html", reason: "Unclosed <html>" },
          { path: SIBLING, parserAttempted: "html", reason: "Unclosed <body>" },
        ],
      },
    } as const;
    const out = applySingleFileScopeFilterToMeta(meta, SCANNED);
    const coverage = out["analysisCoverage"] as Record<string, unknown>;
    const list = coverage["parseErrorFiles"] as readonly { readonly path: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.path).toBe(SCANNED);
    expect(coverage["parseErrorFileCount"]).toBe(1);
  });

  it("drops sibling-file entries from meta.analysisCoverage.fragmentFiles", () => {
    const meta = {
      analysisCoverage: {
        fragmentFileCount: 2,
        fragmentFiles: [
          {
            path: SCANNED,
            kind: "layout_include_partial",
            fragmentClassificationSignals: {
              hasHtmlOpener: false,
              hasLayoutDirective: false,
              inLayoutsDir: false,
            },
          },
          {
            path: SIBLING,
            kind: "html_partial",
            fragmentClassificationSignals: {
              hasHtmlOpener: false,
              hasLayoutDirective: false,
              inLayoutsDir: false,
            },
          },
        ],
      },
    } as const;
    const out = applySingleFileScopeFilterToMeta(meta, SCANNED);
    const coverage = out["analysisCoverage"] as Record<string, unknown>;
    const list = coverage["fragmentFiles"] as readonly { readonly path: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.path).toBe(SCANNED);
    expect(coverage["fragmentFileCount"]).toBe(1);
  });

  it("drops sibling-file entries from string-list fields (frontmatterFenceFiles, etc.)", () => {
    const meta = {
      analysisCoverage: {
        hasFrontmatterFence: true,
        frontmatterFenceFiles: [SCANNED, SIBLING].sort(),
        phpIslandsStripped: true,
        phpIslandsStrippedFiles: [SCANNED, SIBLING].sort(),
        erbIslandsUnrenderedFiles: [SIBLING],
        astroIslandsUnrenderedFiles: [SIBLING],
        sourcemapFiles: [SIBLING],
      },
    } as const;
    const out = applySingleFileScopeFilterToMeta(meta, SCANNED);
    const coverage = out["analysisCoverage"] as Record<string, unknown>;
    expect(coverage["frontmatterFenceFiles"]).toEqual([SCANNED]);
    expect(coverage["phpIslandsStrippedFiles"]).toEqual([SCANNED]);
    // Sibling-only fields drop entirely (present-when-meaningful).
    expect(coverage).not.toHaveProperty("erbIslandsUnrenderedFiles");
    expect(coverage).not.toHaveProperty("astroIslandsUnrenderedFiles");
    expect(coverage).not.toHaveProperty("sourcemapFiles");
  });

  it("drops the parseErrorFiles bucket entirely when only sibling entries existed", () => {
    const meta = {
      analysisCoverage: {
        parseErrorFileCount: 1,
        parseErrorFiles: [{ path: SIBLING, parserAttempted: "html", reason: "Unclosed <a>" }],
        // unrelated field that should pass through untouched
        rulesEligibleByExtension: { ".html": ["page-titled"] },
      },
    } as const;
    const out = applySingleFileScopeFilterToMeta(meta, SCANNED);
    const coverage = out["analysisCoverage"] as Record<string, unknown>;
    expect(coverage).not.toHaveProperty("parseErrorFiles");
    expect(coverage).not.toHaveProperty("parseErrorFileCount");
    expect(coverage["rulesEligibleByExtension"]).toEqual({ ".html": ["page-titled"] });
  });

  it("drops sibling-file entries from meta.scannedBuildArtifacts.classified[]", () => {
    const meta = {
      scannedBuildArtifacts: {
        grouped: [],
        classified: [
          {
            path: SCANNED,
            classifications: [{ kind: "min-infix", classification: "definite-min-infix" }],
          },
          {
            path: SIBLING,
            classifications: [{ kind: "min-infix", classification: "definite-min-infix" }],
          },
        ],
      },
    } as const;
    const out = applySingleFileScopeFilterToMeta(meta, SCANNED);
    const ba = out["scannedBuildArtifacts"] as Record<string, unknown>;
    const classified = ba["classified"] as readonly { readonly path: string }[];
    expect(classified).toHaveLength(1);
    expect(classified[0]?.path).toBe(SCANNED);
  });

  it("drops the whole scannedBuildArtifacts field when only sibling entries existed", () => {
    const meta = {
      scannedBuildArtifacts: {
        grouped: [],
        classified: [
          {
            path: SIBLING,
            classifications: [{ kind: "min-infix", classification: "definite-min-infix" }],
          },
        ],
      },
    } as const;
    const out = applySingleFileScopeFilterToMeta(meta, SCANNED);
    expect(out).not.toHaveProperty("scannedBuildArtifacts");
  });

  it("drops grouped[] rows on a single-file scope (any group is cross-file leakage)", () => {
    // Grouped rows aggregate >=3 same-basename paths — on a per-file
    // scan no honest grouped row can survive. Any surviving group is
    // by construction cross-file leakage.
    const meta = {
      scannedBuildArtifacts: {
        grouped: [
          {
            basename: "bootstrap.min.css",
            count: 3,
            classifications: [],
            suggestedGlob: "**/bootstrap.min.css",
          },
        ],
        classified: [
          {
            path: SCANNED,
            classifications: [{ kind: "min-infix", classification: "definite-min-infix" }],
          },
        ],
      },
    } as const;
    const out = applySingleFileScopeFilterToMeta(meta, SCANNED);
    const ba = out["scannedBuildArtifacts"] as Record<string, unknown>;
    expect(ba["grouped"]).toEqual([]);
  });

  it("drops the classifiedTruncated sentinel — bulk truncation cannot fire on a per-file scope", () => {
    const meta = {
      scannedBuildArtifacts: {
        grouped: [],
        classified: [
          {
            path: SCANNED,
            classifications: [{ kind: "min-infix", classification: "definite-min-infix" }],
          },
        ],
        classifiedTruncated: { shown: 1, total: 200 },
      },
    } as const;
    const out = applySingleFileScopeFilterToMeta(meta, SCANNED);
    const ba = out["scannedBuildArtifacts"] as Record<string, unknown>;
    expect(ba).not.toHaveProperty("classifiedTruncated");
  });

  it("is a no-op on meta with no path-keyed sub-arrays", () => {
    const meta = {
      filesScanned: 1,
      configSource: null,
      analysisCoverage: {
        rulesEligibleByExtension: { ".html": ["page-titled"] },
      },
    } as const;
    const out = applySingleFileScopeFilterToMeta(meta, SCANNED);
    const coverage = out["analysisCoverage"] as Record<string, unknown>;
    expect(coverage).toEqual({ rulesEligibleByExtension: { ".html": ["page-titled"] } });
    expect(out["filesScanned"]).toBe(1);
    expect(out["configSource"]).toBeNull();
  });

  it("accepts the relativized path form when configSearchBase is supplied", () => {
    // `meta.scannedBuildArtifacts.classified[]` carries paths
    // relativized against the scan root — the filter must accept
    // both the absolute form (matching `parsed.filePath`) and the
    // relativized form so a vendor `.min.css` scanned via absolute
    // path still survives the filter.
    const root = "/tmp/proj";
    const absScanned = "/tmp/proj/bootstrap.min.css";
    const meta = {
      scannedBuildArtifacts: {
        grouped: [],
        classified: [
          {
            path: "bootstrap.min.css", // relativized form
            classifications: [{ kind: "min-infix", classification: "definite-min-infix" }],
          },
          {
            path: "vendor/jquery.min.js", // sibling — must be filtered
            classifications: [{ kind: "min-infix", classification: "definite-min-infix" }],
          },
        ],
      },
    } as const;
    const out = applySingleFileScopeFilterToMeta(meta, absScanned, root);
    const ba = out["scannedBuildArtifacts"] as Record<string, unknown>;
    const classified = ba["classified"] as readonly { readonly path: string }[];
    expect(classified).toHaveLength(1);
    expect(classified[0]?.path).toBe("bootstrap.min.css");
  });

  it("does not mutate the input meta object", () => {
    const meta = {
      analysisCoverage: {
        partialParseFileCount: 1,
        partialParseFiles: [
          { path: SIBLING, parserAttempted: "html", reason: "Unclosed <body>" },
        ],
      },
    } as const;
    const before = JSON.stringify(meta);
    applySingleFileScopeFilterToMeta(meta as unknown as Record<string, unknown>, SCANNED);
    expect(JSON.stringify(meta)).toBe(before);
  });
});
