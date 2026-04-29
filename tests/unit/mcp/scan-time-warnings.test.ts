/**
 * Unit tests for `src/mcp/scan-time-warnings.ts` — focused on the
 * derivations that walk `parsedFiles` to produce `WarningInputs`. Most
 * scan-time warning predicates are exercised in
 * `tests/unit/mcp/warnings.test.ts` (predicate-level) and
 * `tests/integration/mcp-consistency/scan-time-warnings-cross-surface.test.ts`
 * (cross-surface parity). This file pins the synthetic inputs that
 * fixture-driven tests can't easily express — chiefly the parser-route
 * derivations that are extension- + AST-error driven.
 */

import { describe, expect, it } from "bun:test";
import { parseTsx } from "../../../src/input/parsers/tsx.ts";
import { buildScanTimeWarnings } from "../../../src/mcp/scan-time-warnings.ts";

describe("buildScanTimeWarnings — parser-route telemetry", () => {
  it("fires `parser_bailed_on_non_jsx_in_tsx_route` when a `.js` file successfully parsed via the tsx route", () => {
    // A trivial `.js` source that parses cleanly through `parseTsx`
    // (no JSX-import signal, no relational-expression false positives).
    const source = "const x = 1;\n";
    const parsed = parseTsx(source, { filePath: "lib.js" });
    expect(parsed.errors).toEqual([]);

    const result = buildScanTimeWarnings({
      parsedFiles: [
        {
          filePath: "lib.js",
          source,
          ast: { language: "tsx", root: parsed.root, errors: parsed.errors },
        },
      ],
      violations: [],
      root: "/proj",
      configSource: "/proj/ra11y.config.ts",
      configSearchSawProjectMarker: true,
      rootSource: "explicit",
      analysisCoverage: undefined,
      filesByExtension: { ".js": 1 },
    });
    expect(result.warnings).toContain("parser_bailed_on_non_jsx_in_tsx_route");
  });

  it("does NOT fire `parser_bailed_on_non_jsx_in_tsx_route` when the `.js` file recorded a parse error", () => {
    // Construct a parsed-file entry that simulates a parse-error
    // outcome — the doctrine names the routing-decision telemetry only
    // for clean parses (parse-error files are already covered by
    // `parse_errors_present` and `parser_bailed_zero_findings`).
    const result = buildScanTimeWarnings({
      parsedFiles: [
        {
          filePath: "broken.js",
          source: "const x = 1;\n",
          ast: {
            language: "tsx",
            root: {
              kind: "TsxModule",
              range: { start: 0, end: 0 },
              loc: {
                start: { line: 1, column: 1, offset: 0 },
                end: { line: 1, column: 1, offset: 0 },
              },
              jsxElements: [],
            },
            errors: [
              {
                code: "tsx_parser_on_non_jsx_input",
                message: "synthetic parse error",
                position: { line: 1, column: 1, offset: 0 },
                recoverable: true,
              },
            ],
          },
        },
      ],
      violations: [],
      root: "/proj",
      configSource: "/proj/ra11y.config.ts",
      configSearchSawProjectMarker: true,
      rootSource: "explicit",
      analysisCoverage: undefined,
      filesByExtension: { ".js": 1 },
    });
    expect(result.warnings ?? []).not.toContain("parser_bailed_on_non_jsx_in_tsx_route");
  });

  it("does NOT fire `parser_bailed_on_non_jsx_in_tsx_route` when no `.js` file was scanned", () => {
    const source = "export const x = 1;\n";
    const parsed = parseTsx(source, { filePath: "lib.tsx" });
    const result = buildScanTimeWarnings({
      parsedFiles: [
        {
          filePath: "lib.tsx",
          source,
          ast: { language: "tsx", root: parsed.root, errors: parsed.errors },
        },
      ],
      violations: [],
      root: "/proj",
      configSource: "/proj/ra11y.config.ts",
      configSearchSawProjectMarker: true,
      rootSource: "explicit",
      analysisCoverage: undefined,
      filesByExtension: { ".tsx": 1 },
    });
    expect(result.warnings ?? []).not.toContain("parser_bailed_on_non_jsx_in_tsx_route");
  });
});
