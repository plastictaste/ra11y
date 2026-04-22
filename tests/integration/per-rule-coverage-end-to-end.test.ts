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
import { buildScanMeta } from "../../src/mcp/scan-assembly.ts";
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

  // V1-META-RULES-EVALUATED-COVERAGE-DRIFT: every rule the scan
  // evaluates must get exactly one `perRuleCoverage` entry — no silent
  // absences for project-scoped rules (`focus/outline-visible`,
  // `wrapper/drift`), which previously went missing because the
  // builder only looked at the per-file tracker. The invariant holds
  // for every scan shape (pure TSX, TSX + CSS, zero files) so an agent
  // reading `rulesEvaluated` against `perRuleCoverage.length` can
  // trust the two to agree.
  it("emits a perRuleCoverage entry for every active rule, including project-scoped ones", () => {
    const files = [
      tsxFile("src/App.tsx", `export function App() { return <main><h1>Hi</h1></main>; }`),
    ];
    const { perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    // Project-scoped rules (`afterProject` only, no `appliesTo`
    // extensions) must have a row — previously they were silently
    // absent because the builder iterated the per-file tracker.
    const projectScopedIds = BUILTIN_RULES.filter(
      (r) => r.appliesTo?.fileExtensions === undefined || r.appliesTo.fileExtensions.length === 0,
    ).map((r) => r.id);
    expect(projectScopedIds.length).toBeGreaterThan(0);
    for (const id of projectScopedIds) {
      const row = perRuleCoverage.find((r) => r.ruleId === id);
      expect(row).toBeDefined();
      // 1 TSX file scanned, project rule saw all of them.
      expect(row!.filesEvaluated).toBe(1);
      expect(row!.filesEligible).toBe(1);
      expect(row!.coverageConfidence).toBe("high");
    }
  });

  // Class-pattern rollup end-to-end: the canonical acute case is a
  // Bootstrap-admin template repeating `<i class="fa fa-*">` inside
  // sibling buttons. The rollup names that (file, pattern) cluster
  // so one read triages many candidates.
  it("stamps classPatternConcentration on aria/icon-font-hidden when a Font Awesome idiom dominates one file", () => {
    const densePage = `<!doctype html><html lang="en"><head><title>admin</title></head><body>${Array.from(
      { length: 12 },
      (_, i) => `<button aria-label="Button ${i}"><i class="fa fa-glyph-${i % 4}"></i></button>`,
    ).join("\n")}</body></html>`;
    const files = [htmlFile("site/admin.html", densePage)];
    const { result, perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    const emitted = result.violations.filter((v) => v.ruleId === "aria/icon-font-hidden").length;
    expect(emitted).toBeGreaterThanOrEqual(10);
    const row = perRuleCoverage.find((r) => r.ruleId === "aria/icon-font-hidden");
    expect(row).toBeDefined();
    expect(row!.classPatternConcentration).toBeDefined();
    expect(row!.classPatternConcentration!.length).toBeGreaterThan(0);
    const [cluster] = row!.classPatternConcentration!;
    expect(cluster!.file).toBe("site/admin.html");
    expect(cluster!.classPattern).toBe("fa fa-*");
    expect(cluster!.count).toBeGreaterThanOrEqual(10);
    // Samples surface real class-attribute values (capped at 3,
    // sorted) — the agent can sanity-check the pattern without
    // re-reading N findings.
    expect(cluster!.samples.length).toBeLessThanOrEqual(3);
    expect(cluster!.samples.length).toBeGreaterThan(0);
    for (const sample of cluster!.samples) {
      expect(sample).toMatch(/^fa fa-glyph-\d+$/u);
    }
  });

  it("pure-TSX scan still lists CSS-only rules with filesEvaluated:0 (no silent absence)", () => {
    const files = [
      tsxFile("src/App.tsx", `export function App() { return <main><h1>Hi</h1></main>; }`),
    ];
    const { perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    // Canonical Tailwind-pre-build shape: contrast/minimum targets
    // `.css`, scan has zero eligible CSS files. The entry must exist
    // and carry the honest zero-eligible marker — agent can tell
    // "ran-with-zero-eligible-files" from "never-ran" without
    // guessing.
    const contrastMin = perRuleCoverage.find((r) => r.ruleId === "contrast/minimum");
    expect(contrastMin).toBeDefined();
    expect(contrastMin!.filesEvaluated).toBe(0);
    expect(contrastMin!.filesEligible).toBe(0);
    expect(contrastMin!.coverageConfidence).toBe("low");
    expect(contrastMin!.reason).toBeDefined();
  });

  it("zero-file scan still emits a row per evaluated rule (honest 'nothing to evaluate')", () => {
    const { perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [],
    });

    // Every WCAG22-active rule must have a row — even with zero
    // files, the invariant holds so downstream consumers (including
    // the MCP `rulesEvaluated` counter) don't diverge from
    // `perRuleCoverage.length`.
    expect(perRuleCoverage.length).toBeGreaterThan(0);
    for (const row of perRuleCoverage) {
      expect(row.filesEvaluated).toBe(0);
      expect(row.filesEligible).toBe(0);
      expect(row.findingsEmitted).toBe(0);
      expect(row.coverageConfidence).toBe("low");
      expect(row.reason).toBeDefined();
    }
  });

  // Q4-RULES-EVALUATED-COMPOSITE: the MCP meta block now emits
  // `rulesEvaluated` as a three-field object ({ loaded,
  // withEligibleInputs, fired }) derived from `activeRules` +
  // `perRuleCoverage`. Previously it was a single number equal to
  // `perRuleCoverage.length`, which inflated the agent's sense of "work
  // in this scan" because it counted every rule that got a coverage
  // row regardless of whether that rule had eligible inputs or fired.
  // The split is monotone (`fired <= withEligibleInputs <= loaded`) so
  // an agent reading the summary can budget honestly.
  it("buildScanMeta's rulesEvaluated splits into loaded / withEligibleInputs / fired", () => {
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

    const meta = buildScanMeta({
      filesScanned: result.filesScanned,
      files,
      activeRules: BUILTIN_RULES,
      durationMs: result.durationMs,
      enabledStandards: result.enabledStandards,
      wrappers: [],
      sessionOnly: [],
      unusedWrappers: [],
      wrapperProvenance: {
        fromConfig: [],
        fromAutoDetect: { confirmed: [], assumed: [] },
        fromSession: [],
      },
      wrapperElements: {},
      verboseMeta: false,
      preset: undefined,
      suppressions: [],
      perRuleCoverage,
    });

    const rulesEvaluated = meta["rulesEvaluated"] as {
      readonly loaded: number;
      readonly withEligibleInputs: number;
      readonly fired: number;
    };
    expect(rulesEvaluated.loaded).toBe(BUILTIN_RULES.length);
    // Monotone invariant: fired <= withEligibleInputs <= loaded.
    expect(rulesEvaluated.fired).toBeLessThanOrEqual(rulesEvaluated.withEligibleInputs);
    expect(rulesEvaluated.withEligibleInputs).toBeLessThanOrEqual(rulesEvaluated.loaded);
    // Cross-check with the underlying per-rule coverage rows — the
    // sub-counters are derived from them, so agents that want to drill
    // down can reconstruct the numbers from `meta.perRuleCoverage`.
    const eligibleFromRows = perRuleCoverage.filter((r) => r.filesEligible > 0).length;
    const firedFromRows = perRuleCoverage.filter((r) => r.findingsEmitted > 0).length;
    expect(rulesEvaluated.withEligibleInputs).toBe(eligibleFromRows);
    expect(rulesEvaluated.fired).toBe(firedFromRows);
  });
});
