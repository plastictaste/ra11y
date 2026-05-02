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
import {
  buildScanTimeWarnings,
  combineTemplateLiteralFiles,
} from "../../../src/mcp/scan-time-warnings.ts";
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

describe("combineTemplateLiteralFiles — fragment-vs-template mutual exclusion", () => {
  // Cross-surface invariant per the AI-first consumer model "Sibling
  // fields naming the same concept must use one shape" + "Heuristic-
  // mislabeled meta sub-fields are dishonest": a file appearing as both
  // `analysisCoverage.fragmentFiles[]` and
  // `warningsDetails.template_files_parsed_as_literal.files` ships two
  // competing narratives about why the file produced no findings. The
  // fragment classifier (more nuanced kind enumeration) is the
  // canonical source-of-truth; the warning-channel payload deduplicates
  // against it at this assembly seam.
  it("excludes a path that already appears in fragmentFiles[] from the frontmatter-fence subset", () => {
    // Canonical case: a Jekyll-style include `_partials/header.html`
    // opens with `---\n…\n---\n` (frontmatter fence) AND has no
    // `<html>` opener (fragment). The fragment classifier wins; the
    // template-literal payload must omit the path.
    const out = combineTemplateLiteralFiles(
      {
        frontmatterFenceFiles: ["_partials/header.html", "page.html"],
        fragmentFiles: [
          {
            path: "_partials/header.html",
            kind: "html_partial",
            fragmentClassificationSignals: {
              hasHtmlOpener: false,
              hasLayoutDirective: false,
              inLayoutsDir: false,
            },
          },
        ],
      },
      new Set<string>(),
    );
    expect(out).toEqual(["page.html"]);
  });

  it("excludes a path that already appears in fragmentFiles[] from the overlap-confirmed directive subset", () => {
    // Mirror case: a `partial.html` whose findings overlap with
    // `{{ x }}` directive lines AND is classified as a fragment (no
    // `<html>` opener). The overlap path would normally feed the
    // payload; mutual exclusion drops it.
    const out = combineTemplateLiteralFiles(
      {
        fragmentFiles: [
          {
            path: "partial.html",
            kind: "html_partial",
            fragmentClassificationSignals: {
              hasHtmlOpener: false,
              hasLayoutDirective: false,
              inLayoutsDir: false,
            },
          },
        ],
      },
      new Set<string>(["partial.html", "base.jinja.html"]),
    );
    expect(out).toEqual(["base.jinja.html"]);
  });

  it("returns the union when no fragmentFiles[] entry overlaps either subset (regression guard)", () => {
    // The dedup must be a no-op when no path is in both sets — the
    // historical behavior (sorted union of frontmatter + overlap) is
    // preserved on inputs the new branch doesn't fire on.
    const out = combineTemplateLiteralFiles(
      {
        frontmatterFenceFiles: ["a.md", "b.md"],
        fragmentFiles: [
          {
            path: "_includes/footer.html",
            kind: "layout_include_partial",
            fragmentClassificationSignals: {
              hasHtmlOpener: false,
              hasLayoutDirective: false,
              inLayoutsDir: false,
            },
          },
        ],
      },
      new Set<string>(["c.html"]),
    );
    expect(out).toEqual(["a.md", "b.md", "c.html"]);
  });

  it("returns an empty array when every contributing path is also a fragment file", () => {
    // Edge case: all evidence collapses to fragment classification.
    // The combined list goes empty so the caller's conditional spread
    // omits the field — the `template_files_parsed_as_literal` warning
    // code's `BinaryPresenceMarker` fallback then carries the bare
    // signal, but no per-file payload (which would have lied).
    const out = combineTemplateLiteralFiles(
      {
        frontmatterFenceFiles: ["fragment.html"],
        fragmentFiles: [
          {
            path: "fragment.html",
            kind: "html_partial",
            fragmentClassificationSignals: {
              hasHtmlOpener: false,
              hasLayoutDirective: false,
              inLayoutsDir: false,
            },
          },
        ],
      },
      new Set<string>(["fragment.html"]),
    );
    expect(out).toEqual([]);
  });

  it("treats absent / malformed fragmentFiles[] as no-classification (no exception, no dedup)", () => {
    // Defensive shape — the helper accepts a `Record<string, unknown>`
    // whose `fragmentFiles` slot may be undefined, an empty array, or
    // a malformed entry shape. Each path falls through to the historical
    // behavior so the dedup degrades to a no-op rather than throwing.
    const noFragmentFiles = combineTemplateLiteralFiles(
      { frontmatterFenceFiles: ["a.html"] },
      new Set<string>(["b.html"]),
    );
    expect(noFragmentFiles).toEqual(["a.html", "b.html"]);

    const emptyFragmentFiles = combineTemplateLiteralFiles(
      { frontmatterFenceFiles: ["a.html"], fragmentFiles: [] },
      new Set<string>(["b.html"]),
    );
    expect(emptyFragmentFiles).toEqual(["a.html", "b.html"]);

    const malformedEntries = combineTemplateLiteralFiles(
      {
        frontmatterFenceFiles: ["a.html"],
        fragmentFiles: [null, { path: 42 }, { kind: "html_partial" }],
      },
      new Set<string>(["b.html"]),
    );
    expect(malformedEntries).toEqual(["a.html", "b.html"]);
  });
});
