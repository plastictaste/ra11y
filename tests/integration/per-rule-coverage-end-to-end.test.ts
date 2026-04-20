/**
 * End-to-end scanner coverage-confidence test.
 *
 * Runs the full scanner over a JSX-only file set and confirms that the
 * `PerRuleCoverage` rows + `ruleCoverage` derivative the MCP response
 * will surface correctly classify CSS-targeted rules as
 * `lowConfidenceClean` — the canonical Tailwind-pre-build shape.
 *
 * Counterpart high-confidence direction: a scan with CSS files present
 * pushes those same rules into `confidentlyClean` on a clean result,
 * confirming that the transition `low → high` tracks what actually
 * ran.
 */

import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../src/engine/scanner.ts";
import { parseCss, parseHtml, parseTsx } from "../../src/input/parsers/index.ts";
import { buildRuleCoverageDerivative } from "../../src/mcp/rule-coverage-derivative.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { wcag22 } from "../../src/standards/wcag22/standard.ts";
import type { Ast } from "../../src/types/ast.ts";

function tsxFile(path: string, source: string): ParsedFile {
  const parsed = parseTsx(source);
  const ast: Ast = { language: "tsx", root: parsed.root, errors: parsed.errors };
  return { filePath: path, source, ast };
}

function cssFile(path: string, source: string): ParsedFile {
  const parsed = parseCss(source);
  const ast: Ast = { language: "css", root: parsed.root, errors: parsed.errors };
  return { filePath: path, source, ast };
}

function htmlFile(path: string, source: string): ParsedFile {
  const parsed = parseHtml(source);
  const ast: Ast = { language: "html", root: parsed.root, errors: parsed.errors };
  return { filePath: path, source, ast };
}

describe("per-rule coverage end-to-end", () => {
  it("JSX-only scan surfaces CSS-targeted rules in lowConfidenceClean", () => {
    const files = [
      tsxFile(
        "src/App.tsx",
        `export function App() { return <main><h1>Hello</h1><p>world</p></main>; }`,
      ),
      tsxFile(
        "src/Button.tsx",
        `export function Button({ label }: { label: string }) { return <button>{label}</button>; }`,
      ),
    ];
    const { result, perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    const cssRuleRows = perRuleCoverage.filter((r) => r.ruleId.startsWith("contrast/"));
    // Every contrast rule targets `.css`; with no CSS files scanned
    // they must all show 0 eligible + low confidence.
    expect(cssRuleRows.length).toBeGreaterThan(0);
    for (const row of cssRuleRows) {
      expect(row.filesEligible).toBe(0);
      expect(row.coverageConfidence).toBe("low");
      expect(row.reason).toBeDefined();
      expect(row.remediation).toBeDefined();
      // V1-SHAPE-RULECOV-COUNT: zero is meaningful — the rule didn't
      // run because nothing eligible existed, and 0 findings is the
      // honest read of that state. Pairs with coverageConfidence: "low"
      // for the agent to disambiguate "didn't run" from "ran clean."
      expect(row.findingsEmitted).toBe(0);
    }

    // V1-SHAPE-RULECOV-COUNT invariant: findingsEmitted on each entry
    // must equal the number of violations the scan produced for that
    // rule. The whole point is letting consumers skip the
    // re-derivation walk over `files[].findings[]`.
    for (const row of perRuleCoverage) {
      const fromStream = result.violations.filter((v) => v.ruleId === row.ruleId).length;
      expect(row.findingsEmitted).toBe(fromStream);
      expect(typeof row.findingsEmitted).toBe("number");
    }

    const derivative = buildRuleCoverageDerivative(perRuleCoverage, result.violations);
    expect(derivative).not.toBeNull();
    // contrast/minimum is the canonical acute case — verify it's in the
    // low-confidence bucket and not in confidentlyClean.
    expect(derivative!.lowConfidenceClean).toContain("contrast/minimum");
    expect(derivative!.lowConfidenceClean).toContain("contrast/enhanced");
    expect(derivative!.confidentlyClean).not.toContain("contrast/minimum");
  });

  it("scan that includes CSS files promotes those rules to confidentlyClean", () => {
    const files = [
      tsxFile("src/App.tsx", `export function App() { return <main><h1>Hi</h1></main>; }`),
      cssFile("src/styles.css", `body { color: #000; background: #fff; }`),
    ];
    const { result, perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    const contrastMinRow = perRuleCoverage.find((r) => r.ruleId === "contrast/minimum");
    expect(contrastMinRow).toBeDefined();
    expect(contrastMinRow!.filesEligible).toBeGreaterThan(0);
    expect(contrastMinRow!.coverageConfidence).toBe("high");
    // V1-SHAPE-RULECOV-COUNT: the field is present even when the rule
    // ran cleanly — zero here is "ran on N files, found nothing,"
    // which paired with high confidence is the "trust the clean tally"
    // signal.
    expect(contrastMinRow!.findingsEmitted).toBe(
      result.violations.filter((v) => v.ruleId === "contrast/minimum").length,
    );
    for (const row of perRuleCoverage) {
      expect(typeof row.findingsEmitted).toBe("number");
    }
  });

  // V1-NOISE-RULE-PER-FILE-ROLLUP: the per-rule concentration hint
  // surfaces end-to-end through the scanner's `perRuleCoverage` array
  // when one file's findings clear both thresholds. Canonical fixture:
  // `media/alt-text-missing` firing 12× on one page and 1× on another —
  // total 13 (> 10) and share 12/13 ≈ 0.92 (> 0.5).
  it("stamps concentration on a per-rule row when one file dominates past both thresholds", () => {
    const densePage = `<!doctype html><html lang="en"><head><title>gallery</title></head><body>${Array.from(
      { length: 12 },
      (_, i) => `<img src="img-${i}.png">`,
    ).join("\n")}</body></html>`;
    const otherPage = `<!doctype html><html lang="en"><head><title>other</title></head><body><img src="lone.png"></body></html>`;
    const files = [
      htmlFile("site/gallery.html", densePage),
      htmlFile("site/other.html", otherPage),
    ];
    const { result, perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    const row = perRuleCoverage.find((r) => r.ruleId === "media/alt-text-missing");
    expect(row).toBeDefined();
    // Sanity check: the fixture produced the expected total.
    const emitted = result.violations.filter((v) => v.ruleId === "media/alt-text-missing").length;
    expect(emitted).toBeGreaterThan(10);
    expect(row!.findingsEmitted).toBe(emitted);
    expect(row!.concentration).toBeDefined();
    expect(row!.concentration!.file).toBe("site/gallery.html");
    // Densest file holds a strict majority — the exact number depends
    // on rule internals (alt-text-missing may also flag adjacent img
    // patterns), but the winner's count must be > half the total.
    expect(row!.concentration!.count).toBeGreaterThan(emitted / 2);
  });
});
