/**
 * Unit tests for buildFileLimitation / buildFileLimitations — the
 * helper that derives per-file scan-degradation telemetry for
 * scan_file and scan_project per-file entries (Q4-SCAN-FILE-PARSE-
 * ERROR-LIMITATIONS-FIELD).
 *
 * Clean-parse paths return null / empty so the outer response can
 * conditional-spread without a sentinel — a file that parsed clean
 * must not carry a `limitations` field.
 */

import { describe, expect, it } from "bun:test";
import type { ParsedFile } from "../../../src/engine/scanner.ts";
import { buildFileLimitation, buildFileLimitations } from "../../../src/mcp/file-limitations.ts";

function htmlFile(path: string, errorMessages: readonly string[]): ParsedFile {
  return {
    filePath: path,
    source: "<div></div>",
    ast: {
      language: "html",
      root: {
        kind: "HtmlDocument",
        range: { start: 0, end: 0 },
        loc: {
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 1, offset: 0 },
        },
        children: [],
      },
      errors: errorMessages.map((message) => ({
        message,
        position: { line: 1, column: 1, offset: 0 },
        recoverable: true,
      })),
    },
  };
}

describe("buildFileLimitation", () => {
  it("returns null when the parser emitted no errors", () => {
    const file = htmlFile("/tmp/clean.html", []);
    expect(buildFileLimitation(file, false)).toBeNull();
  });

  it("stamps reason='parse_error' when the file produced no findings", () => {
    const file = htmlFile("/tmp/broken.html", ["Unexpected end of input"]);
    const result = buildFileLimitation(file, false);
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("parse_error");
    expect(result?.file).toBe("/tmp/broken.html");
    expect(result?.parser).toBe("html");
    expect(result?.detail).toBe("Unexpected end of input");
  });

  it("stamps reason='partial_parse' when the file still produced findings", () => {
    const file = htmlFile("/tmp/recovered.html", ["Unexpected token <"]);
    const result = buildFileLimitation(file, true);
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("partial_parse");
    expect(result?.detail).toBe("Unexpected token <");
  });

  it("omits detail when the first error message is empty", () => {
    const file = htmlFile("/tmp/empty-msg.html", [""]);
    const result = buildFileLimitation(file, false);
    expect(result).not.toBeNull();
    // Conditional-spread — an empty string would be a dishonest shape
    // per CLAUDE.md §1 "Ambiguous field shapes are dishonest".
    expect(Object.hasOwn(result ?? {}, "detail")).toBe(false);
  });

  it("truncates detail to the 200-char cap with an ellipsis", () => {
    const longMessage = "x".repeat(500);
    const file = htmlFile("/tmp/long.html", [longMessage]);
    const result = buildFileLimitation(file, false);
    // 199 chars + ellipsis = 200 visible glyphs (ellipsis is one codepoint).
    expect(result?.detail?.endsWith("…")).toBe(true);
    expect(result?.detail?.length).toBe(200);
  });
});

describe("buildFileLimitations", () => {
  it("filters out cleanly-parsed files and sorts the rest by path", () => {
    const files: readonly ParsedFile[] = [
      htmlFile("/z/last.html", ["err z"]),
      htmlFile("/a/clean.html", []),
      htmlFile("/m/middle.html", ["err m"]),
    ];
    const findingFilePaths = new Set<string>();
    const result = buildFileLimitations(files, findingFilePaths);
    expect(result).toHaveLength(2);
    expect(result[0]?.file).toBe("/m/middle.html");
    expect(result[1]?.file).toBe("/z/last.html");
  });

  it("routes finding-bearing paths into partial_parse and the rest into parse_error", () => {
    const files: readonly ParsedFile[] = [
      htmlFile("/a/partial.html", ["err a"]),
      htmlFile("/b/invisible.html", ["err b"]),
    ];
    const findingFilePaths = new Set(["/a/partial.html"]);
    const result = buildFileLimitations(files, findingFilePaths);
    expect(result).toHaveLength(2);
    const byPath = new Map(result.map((r) => [r.file, r.reason]));
    expect(byPath.get("/a/partial.html")).toBe("partial_parse");
    expect(byPath.get("/b/invisible.html")).toBe("parse_error");
  });

  it("returns an empty array when every file parsed cleanly", () => {
    const files: readonly ParsedFile[] = [
      htmlFile("/a/clean1.html", []),
      htmlFile("/b/clean2.html", []),
    ];
    const result = buildFileLimitations(files, new Set());
    expect(result).toEqual([]);
  });
});
