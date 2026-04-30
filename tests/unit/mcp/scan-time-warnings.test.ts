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
import type { Violation } from "../../../src/types/violation.ts";

/**
 * Synthesizes a minimal {@link Violation}-shaped object for the
 * scan-time-warnings predicates that only consult
 * `location.filePath` + `ruleId`. The `as unknown as Violation` cast
 * mirrors the pattern in `response-assembler.test.ts` — building a
 * full violation requires fields that aren't relevant to these
 * predicates and would obscure what the test actually pins.
 */
const fakeFinding = (filePath: string, line = 1): Violation =>
  ({
    ruleId: "synthetic/test-rule",
    severity: "warning",
    message: "synthetic rule fired",
    location: { filePath, line, column: 1 },
  }) as unknown as Violation;

describe("buildScanTimeWarnings — parser-route telemetry", () => {
  it("does NOT fire `parser_bailed_on_non_jsx_in_tsx_route` when a `.js` file parsed cleanly with findings — the warning gates on actual bail evidence (parse errors + zero findings on the file), not the routing decision alone", () => {
    // The earlier predicate fired on every clean `.js` parse. That
    // surfaced the warning as a false-positive on responses where 86
    // rules fired and `perRuleCoverage` was uniformly `high`. Per the
    // doctrine bullet "Empty `warningsDetails.<code>: {}` is dishonest"
    // + "Routing skips that drop content" together, the warning must
    // gate on observed content drop, not the routing decision.
    const source = "const x = 1;\nconst btn = '<button>';\n";
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
      // A finding fired against `lib.js` — a clean parse where rules
      // ran is exactly the case the false-positive surfaced under, and
      // exactly the case the new predicate must drop.
      violations: [fakeFinding("lib.js", 2)],
      root: "/proj",
      configSource: "/proj/ra11y.config.ts",
      configSearchSawProjectMarker: true,
      rootSource: "explicit",
      analysisCoverage: undefined,
      filesByExtension: { ".js": 1 },
    });
    expect(result.warnings ?? []).not.toContain("parser_bailed_on_non_jsx_in_tsx_route");
  });

  it("does NOT fire `parser_bailed_on_non_jsx_in_tsx_route` on a clean `.js` parse with zero findings either — the routing decision alone is not bail evidence", () => {
    // The doctrine framing: a clean parse where rules genuinely had
    // nothing to flag is not the routing-skip failure mode. The
    // existing `parser_bailed_zero_findings` family covers the
    // ambiguous "zero findings + parse errors" shape; this code stays
    // narrow to actual bail evidence (parse errors recorded AND no
    // rules fired against the file).
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
    expect(result.warnings ?? []).not.toContain("parser_bailed_on_non_jsx_in_tsx_route");
  });

  it("fires `parser_bailed_on_non_jsx_in_tsx_route` when a `.js` file recorded parse errors AND zero rules fired — the actual bail-evidence conjunction", () => {
    // Construct a parsed-file entry that simulates the bail conjunction
    // the new predicate gates on: TSX parser recorded errors against a
    // `.js` source AND no findings fired on that file. This is the
    // honest fire — the routing decision actually dropped content.
    const result = buildScanTimeWarnings({
      parsedFiles: [
        {
          filePath: "broken.js",
          source: "if (r.length<b.length) {}\n",
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
    expect(result.warnings).toContain("parser_bailed_on_non_jsx_in_tsx_route");
    // Payload graduated from `BinaryPresenceMarker` to a payload-bearing
    // shape — `files: [...]` names the agent's triage targets so an
    // agent reading the code can scope around them.
    expect(result.warningsDetails?.parser_bailed_on_non_jsx_in_tsx_route).toEqual({
      files: ["broken.js"],
    });
  });

  it("does NOT fire `parser_bailed_on_non_jsx_in_tsx_route` when a `.js` file recorded parse errors but ALSO produced findings — partial-parse case, not bail", () => {
    // Errors present + at least one rule fired = `partialParseFiles`
    // territory; the existing `partial_parse_files_present` code names
    // that case. The routing-telemetry code stays narrow to "the
    // routing decision dropped content" (zero findings on the file).
    const result = buildScanTimeWarnings({
      parsedFiles: [
        {
          filePath: "partial.js",
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
      violations: [fakeFinding("partial.js")],
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
