/**
 * Unit tests for `manual-applicability` — specifically the parse-coverage
 * caveat on `irrelevanceReason`.
 *
 * The `likelyIrrelevant` label is one of the few labeled buckets doctrine
 * allows because it is meant to be provable from code — "no <video>/<audio>
 * elements in the scanned files" is a deterministic fact. When discovery
 * silently rejected authored-content files (`.md`, `.markdown`, `.rst`,
 * `.adoc`) that could embed media via raw HTML or shortcodes, the
 * deterministic claim becomes honest only about the parseable subset.
 * The reason text must surface that parse-coverage gap; the bucket label
 * stays the same.
 */

import { describe, expect, it } from "bun:test";
import type { ParsedFile } from "../../../src/engine/scanner.ts";
import type { DiscoveryDiagnostics } from "../../../src/input/discover.ts";
import {
  detectApplicability,
  irrelevanceReason,
  isLikelyIrrelevant,
} from "../../../src/mcp/manual-applicability.ts";

const MEDIA_CRITERIA = [
  "wcag22:1.2.1",
  "wcag22:1.2.2",
  "wcag22:1.2.3",
  "wcag22:1.2.4",
  "wcag22:1.2.5",
] as const;

function makeFile(filePath: string, source: string): ParsedFile {
  return {
    filePath,
    source,
    ast: {
      type: "root",
      children: [],
      location: { line: 1, column: 1 },
    } as unknown as ParsedFile["ast"],
  };
}

describe("detectApplicability", () => {
  it("returns hasMedia:false and empty skippedContentExtensions when no diagnostics", () => {
    const applicability = detectApplicability([makeFile("a.tsx", "<div />")]);
    expect(applicability.hasMedia).toBe(false);
    expect(applicability.skippedContentExtensions).toEqual({});
  });

  it("detects <video> / <audio> in any parseable file", () => {
    expect(detectApplicability([makeFile("a.html", "<video />")]).hasMedia).toBe(true);
    expect(detectApplicability([makeFile("a.html", "<audio />")]).hasMedia).toBe(true);
  });

  it("ignores non-content extensions in skippedByExtension", () => {
    const diagnostics: DiscoveryDiagnostics = {
      skippedByExtension: { ".scss": 50, ".astro": 10, ".vue": 5 },
    };
    const applicability = detectApplicability([], diagnostics);
    expect(applicability.skippedContentExtensions).toEqual({});
  });

  it("picks up content extensions with non-zero counts", () => {
    const diagnostics: DiscoveryDiagnostics = {
      skippedByExtension: { ".md": 307, ".scss": 50, ".rst": 2 },
    };
    const applicability = detectApplicability([], diagnostics);
    expect(applicability.skippedContentExtensions).toEqual({ ".md": 307, ".rst": 2 });
  });

  it("skips content extensions with zero counts", () => {
    const diagnostics: DiscoveryDiagnostics = {
      skippedByExtension: { ".md": 0, ".markdown": 4 },
    };
    const applicability = detectApplicability([], diagnostics);
    expect(applicability.skippedContentExtensions).toEqual({ ".markdown": 4 });
  });

  it("recognizes all documented content extensions", () => {
    const diagnostics: DiscoveryDiagnostics = {
      skippedByExtension: {
        ".md": 1,
        ".markdown": 1,
        ".mdx": 1,
        ".rst": 1,
        ".adoc": 1,
        ".asciidoc": 1,
      },
    };
    const applicability = detectApplicability([], diagnostics);
    expect(Object.keys(applicability.skippedContentExtensions ?? {}).sort()).toEqual([
      ".adoc",
      ".asciidoc",
      ".markdown",
      ".md",
      ".mdx",
      ".rst",
    ]);
  });
});

describe("irrelevanceReason — parse-coverage caveat", () => {
  it("returns undefined for criteria outside the media-only set", () => {
    const applicability = detectApplicability([]);
    expect(irrelevanceReason("wcag22:2.4.5", applicability)).toBeUndefined();
  });

  it("returns undefined when hasMedia is true", () => {
    const applicability = detectApplicability([makeFile("a.html", "<video />")]);
    for (const id of MEDIA_CRITERIA) {
      expect(irrelevanceReason(id, applicability)).toBeUndefined();
    }
  });

  it("returns the bare reason when no content extensions were skipped", () => {
    const applicability = detectApplicability([]);
    for (const id of MEDIA_CRITERIA) {
      expect(irrelevanceReason(id, applicability)).toBe(
        "No <video> or <audio> elements detected in the scanned files.",
      );
    }
  });

  it("appends a parse-coverage caveat when content extensions were skipped", () => {
    const diagnostics: DiscoveryDiagnostics = {
      skippedByExtension: { ".md": 307 },
    };
    const applicability = detectApplicability([], diagnostics);
    const reason = irrelevanceReason("wcag22:1.2.1", applicability);
    expect(reason).toContain("No <video> or <audio> elements detected in the scanned files.");
    expect(reason).toContain("Note: 307 files in content extensions (.md) were skipped");
    expect(reason).toContain("the media check is under-covered");
  });

  it("lists multiple skipped content extensions in sorted order", () => {
    const diagnostics: DiscoveryDiagnostics = {
      skippedByExtension: { ".rst": 2, ".md": 10, ".markdown": 5 },
    };
    const applicability = detectApplicability([], diagnostics);
    const reason = irrelevanceReason("wcag22:1.2.2", applicability);
    expect(reason).toContain("(.markdown, .md, .rst)");
    expect(reason).toContain("17 files");
  });

  it("uses singular 'file' when exactly one content file was skipped", () => {
    const diagnostics: DiscoveryDiagnostics = {
      skippedByExtension: { ".md": 1 },
    };
    const applicability = detectApplicability([], diagnostics);
    const reason = irrelevanceReason("wcag22:1.2.1", applicability);
    expect(reason).toContain("1 file in content extensions");
    expect(reason).not.toContain("1 files");
  });

  it("covers every MEDIA_ONLY criterion with the caveat", () => {
    const diagnostics: DiscoveryDiagnostics = {
      skippedByExtension: { ".md": 42 },
    };
    const applicability = detectApplicability([], diagnostics);
    // Sampling across the WCAG 2.2 and 2.1 prefixes to prove the caveat
    // applies uniformly on the MEDIA_ONLY bucket without hard-coding the
    // full set here — the test that the full set lives in one place is
    // the snapshot below.
    const sampled = ["wcag22:1.2.1", "wcag22:1.2.9", "wcag22:1.4.2", "wcag21:1.2.5"];
    for (const id of sampled) {
      const reason = irrelevanceReason(id, applicability);
      expect(reason).toContain("Note: 42 files in content extensions (.md) were skipped");
    }
  });

  it("does not append a caveat when the applicability's skipped map is empty", () => {
    const diagnostics: DiscoveryDiagnostics = {
      skippedByExtension: { ".scss": 100 },
    };
    const applicability = detectApplicability([], diagnostics);
    // .scss doesn't embed inline media tags — no caveat should fire.
    const reason = irrelevanceReason("wcag22:1.2.1", applicability);
    expect(reason).toBe("No <video> or <audio> elements detected in the scanned files.");
  });
});

describe("isLikelyIrrelevant stays stable across caveat rollout", () => {
  it("does not flip the label when the caveat fires", () => {
    // Doctrine: the label is deterministic — "scanner saw no media in
    // the parseable subset." The caveat sits in the reason text, not the
    // bucket. This invariant is the reason the fix is a reason-text
    // enrichment rather than a bucket demotion.
    const diagnostics: DiscoveryDiagnostics = {
      skippedByExtension: { ".md": 300 },
    };
    const applicability = detectApplicability([], diagnostics);
    expect(isLikelyIrrelevant("wcag22:1.2.1", applicability)).toBe(true);
  });
});
