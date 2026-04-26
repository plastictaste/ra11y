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
import { assembleScanFamilyResponse } from "../../src/mcp/response-assembler.ts";
import { buildRuleCoverageDerivative } from "../../src/mcp/rule-coverage-derivative.ts";
import { buildScanMeta } from "../../src/mcp/scan-assembly.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { wcag22 } from "../../src/standards/wcag22/standard.ts";
import type { Ast } from "../../src/types/ast.ts";
import type { PerRuleCoverage } from "../../src/types/violation.ts";

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

  it("css file with no var(--…) references stays at 'high' on contrast/minimum (no cross-file candidate observed)", () => {
    // Predicate-strength gate: a `crossFileCapable: false` rule
    // downgrades to `"medium"` only when it observed at least one
    // candidate token whose resolution may extend beyond the file. A
    // stylesheet with no `var(--name)` references carries no
    // cross-file question — the row stays at `"high"` rather than
    // defaulting to a pessimistic `"medium"` that would lie about what
    // evidence the rule actually had. See
    // docs/kb/architecture/ai-first-consumer.md "Reason text and
    // severity must agree."
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
    expect(contrastMinRow!.reason).toBeUndefined();
    expect(contrastMinRow!.findingsEmitted).toBe(
      result.violations.filter((v) => v.ruleId === "contrast/minimum").length,
    );
    for (const row of perRuleCoverage) {
      expect(typeof row.findingsEmitted).toBe("number");
    }
  });

  it("css file referencing var(--…) downgrades contrast/minimum to 'medium' (candidate observed)", () => {
    // Counterpart: when the same rule observes a candidate token
    // (`var(--fg)` reference whose declaration may live in a sibling
    // tokens stylesheet), the cross-file-bounded downgrade fires
    // honestly. The fixture inlines `:root` so the rule's pair logic
    // resolves locally and emits no findings; the downgrade reflects
    // the substrate-level limit, not whether a finding was emitted.
    const files = [
      tsxFile("src/App.tsx", `export function App() { return <main><h1>Hi</h1></main>; }`),
      cssFile(
        "src/styles.css",
        `:root { --fg: #111; --bg: #fff; }\nbody { color: var(--fg); background: var(--bg); }`,
      ),
    ];
    const { perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    const contrastMinRow = perRuleCoverage.find((r) => r.ruleId === "contrast/minimum");
    expect(contrastMinRow).toBeDefined();
    expect(contrastMinRow!.filesEligible).toBeGreaterThan(0);
    expect(contrastMinRow!.coverageConfidence).toBe("medium");
    expect(contrastMinRow!.reason).toBe(
      "cross_file_custom_property_resolution_limited_on_this_input",
    );
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

  // Q7-AAA-RULE-LOADER-SILENT-NORUN. An AAA-only rule (e.g.
  // `navigation/link-target-blank-announcement` satisfying
  // `wcag22:3.2.5` AAA, `contrast/enhanced` satisfying `wcag22:1.4.6`
  // AAA, `motion/animation-from-interactions` satisfying `wcag22:2.3.3`
  // AAA) under a default `level: "AA"` scan used to disappear from
  // `perRuleCoverage` — the agent reading "the rule isn't here"
  // could not distinguish "rule isn't loaded" from "rule loaded but
  // level-gated." End-to-end, the scanner now emits a
  // `skipReason: "gated_by_level"` row with `requiredLevel: "AAA"`
  // and `requestedLevel: "AA"` so the agent has the exact
  // remediation. The same rule must actually fire when the scan
  // requests `level: "AAA"` (the half-(a) of the dispatch).
  it("AAA-only rules surface as gated-by-level rows under AA and run under AAA", () => {
    // `<a target="_blank">` with no announcement text triggers
    // `navigation/link-target-blank-announcement` (AAA-only). The same
    // file is used for both directions of the test so the only
    // independent variable is the active level.
    const source = `<!doctype html><html lang="en"><head><title>t</title></head><body><a href="https://example.com" target="_blank">Docs</a></body></html>`;
    const files = [htmlFile("site/index.html", source)];

    // Half (b): under AA (the default project-config level), the
    // AAA-only rule does NOT fire, but the row IS present with
    // structured `skipReason`.
    const aa = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      level: "AA",
      files,
    });
    const aaaFired = aa.result.violations.filter(
      (v) => v.ruleId === "navigation/link-target-blank-announcement",
    );
    expect(aaaFired.length).toBe(0);
    const gatedRow = aa.perRuleCoverage.find(
      (r) => r.ruleId === "navigation/link-target-blank-announcement",
    );
    expect(gatedRow).toBeDefined();
    expect(gatedRow!.skipReason).toBe("gated_by_level");
    expect(gatedRow!.requiredLevel).toBe("AAA");
    expect(gatedRow!.requestedLevel).toBe("AA");
    expect(gatedRow!.coverageConfidence).toBe("low");
    expect(gatedRow!.findingsEmitted).toBe(0);
    expect(gatedRow!.filesEvaluated).toBe(0);
    expect(gatedRow!.filesEligible).toBe(0);

    // Invariant: every AAA-only built-in rule under enabled standards
    // surfaces a gated row under AA so the agent never has to wonder
    // which AAA rules exist. Non-gated rows must NOT carry skipReason.
    for (const row of aa.perRuleCoverage) {
      if (row.skipReason === "gated_by_level") {
        expect(row.requiredLevel).toBe("AAA");
        expect(row.requestedLevel).toBe("AA");
      } else {
        expect(row.skipReason).toBeUndefined();
        expect(row.requiredLevel).toBeUndefined();
        expect(row.requestedLevel).toBeUndefined();
      }
    }

    // Half (a): under AAA, the rule actually fires.
    const aaa = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      level: "AAA",
      files,
    });
    const aaaFiredUnderAaa = aaa.result.violations.filter(
      (v) => v.ruleId === "navigation/link-target-blank-announcement",
    );
    expect(aaaFiredUnderAaa.length).toBeGreaterThan(0);
    const aaaRow = aaa.perRuleCoverage.find(
      (r) => r.ruleId === "navigation/link-target-blank-announcement",
    );
    expect(aaaRow).toBeDefined();
    expect(aaaRow!.skipReason).toBeUndefined();
    expect(aaaRow!.coverageConfidence).toBe("high");
    expect(aaaRow!.findingsEmitted).toBeGreaterThan(0);
  });

  // Cross-surface invariant carried by the doctrine: at every level
  // the caller can request, every BUILTIN_RULE that has at least one
  // cited criterion under enabled standards must appear in
  // `perRuleCoverage` — gated rules surface as a structured row
  // rather than vanishing. Without this, the agent reads two
  // different totals for "rules in this scan" depending on which
  // surface it consults (Q7-AAA-RULE-LOADER-SILENT-NORUN).
  //
  // Rules whose `satisfies` resolves to no enabled-standard criterion
  // (e.g. `parsing/invalid-id-shape` cites only `wcag21:4.1.1` while
  // this scan enables only `wcag22`) are honestly absent — surfacing
  // them as "loaded" would lie about reachability under the current
  // standards configuration.
  it("perRuleCoverage surfaces every reachable rule at every level (gated rules included)", () => {
    const files = [
      tsxFile("src/App.tsx", `export function App() { return <main><h1>Hi</h1></main>; }`),
    ];
    // Compute the reachable set once at level "AAA" (no rule is
    // level-gated there) so the expected list is the ceiling.
    const ceiling = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      level: "AAA",
      files,
    });
    const reachableIds = new Set(ceiling.perRuleCoverage.map((r) => r.ruleId));
    expect(reachableIds.size).toBeGreaterThan(0);

    for (const level of ["A", "AA", "AAA"] as const) {
      const { perRuleCoverage } = runScan({
        standards: [wcag22],
        rules: BUILTIN_RULES,
        enabled: ["wcag22"],
        level,
        files,
      });
      const presentIds = new Set(perRuleCoverage.map((r) => r.ruleId));
      const missing = [...reachableIds].filter((id) => !presentIds.has(id));
      expect({ level, missing }).toEqual({ level, missing: [] });
    }
  });

  // Q7-PERRULECOVERAGE-EMPTY-ELIGIBLE-COLLAPSE: an HTML-only project
  // scanned with the full WCAG22 rule set used to ship ~30 boilerplate
  // perRuleCoverage entries for CSS/TSX-eligible rules, each carrying
  // identical "no files matching .css were scanned" remediation prose
  // (~200 chars per row, dominating a single-subdir 347KB response).
  // The collapse rolls those rows up into one
  // `meta.rulesNotEvaluatedDueToInputType: { count, byExtension }`
  // counter so the agent reads `byExtension` once and decides whether
  // to widen scope. Level-gated rows (gated_by_level discriminator)
  // and rows with eligible inputs survive the partition unchanged.
  it("HTML-only scan collapses zero-eligibility CSS/TSX rows into rulesNotEvaluatedDueToInputType", () => {
    const files = [
      htmlFile(
        "site/index.html",
        `<!doctype html><html lang="en"><head><title>x</title></head><body><h1>Hi</h1></body></html>`,
      ),
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
      // verboseMeta: true — this assertion inspects the per-row
      // perRuleCoverage[] array (skipReason / coverageConfidence / etc).
      // Default verbosity surfaces only the compact summary
      // (V1-TOOL-VERBOSE-META-INVERTED-DEFAULT).
      verboseMeta: true,
      preset: undefined,
      suppressions: [],
      perRuleCoverage,
    });

    const collapsed = meta["rulesNotEvaluatedDueToInputType"] as {
      readonly count: number;
      readonly byExtension: Readonly<Record<string, number>>;
    };
    // Counter is always present so the agent has a deterministic field
    // to read — even on a clean HTML-only scan the field rides.
    expect(collapsed).toBeDefined();
    expect(collapsed.count).toBeGreaterThan(0);
    // CSS rules (contrast/*) must collapse under `.css` since the
    // HTML-only scan has zero eligible CSS files.
    expect(collapsed.byExtension[".css"]).toBeGreaterThan(0);

    const surfaced = meta["perRuleCoverage"] as readonly PerRuleCoverage[];
    expect(surfaced).toBeDefined();
    // Every surfaced row either has eligible inputs OR carries the
    // level-gated discriminator from Q7-AAA-RULE-LOADER-SILENT-NORUN.
    for (const row of surfaced) {
      const isEligible = row.filesEvaluated > 0 || row.filesEligible > 0;
      const isLevelGated = row.skipReason === "gated_by_level";
      // Project-scoped rules without an extension gate also stay — but
      // on a non-empty scan those report `filesScanned > 0` so they
      // satisfy the `isEligible` branch.
      expect(isEligible || isLevelGated).toBe(true);
    }
    // Sanity: the engine's own perRuleCoverage stays full (other
    // consumers — buildRuleCoverageDerivative, buildRulesEvaluated,
    // testable-criteria — must still see every row).
    expect(perRuleCoverage.length).toBeGreaterThan(surfaced.length);
    // Reduction is meaningful — the collapse must have folded enough
    // rows that the surfaced array is materially smaller.
    expect(collapsed.count + surfaced.length).toBe(perRuleCoverage.length);
  });

  // V1-MOTION-PAUSE-STOP-FILES-EVALUATED-OFF-BY-ONE: rules sharing the
  // same `appliesTo.fileExtensions` set must report the same
  // `filesEvaluated` count on a given scan. The eligibility pass is
  // purely a function of `(rule.appliesTo, file.extension)` — it's the
  // same `applies()` predicate over the same file pool — so any drift
  // between two such rules signals an off-by-one in the tracker
  // (double-bump on one rule, missed bump on another, or duplicate rule
  // registration). Surfaced through the field-report shape "rule X
  // reports 105 evaluated where every other rule with the same gate
  // reports 104"; root cause was confirmed to be filesEvaluated honestly
  // counting all files matching the rule's gate (the user under-counted
  // CSS files when comparing against HTML+JS+MD-targeted siblings — see
  // backlog note). Test pins the engine invariant so a real off-by-one
  // can't slip in silently.
  //
  // Pool is intentionally heterogeneous (HTML + JS + MD + CSS + SCSS)
  // so multiple `appliesTo` shapes share the same evaluated-count
  // bucket — the parity check is meaningful only when ≥2 rules share an
  // appliesTo set, and a mixed pool maximizes coincident gates.
  it("rules with identical appliesTo.fileExtensions report identical filesEvaluated", () => {
    const files = buildHeterogeneousPool();
    const { perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      level: "AAA",
      files,
    });

    const groupsWithSiblings = assertAppliesToSiblingsAgree(perRuleCoverage);
    // Sanity: at least one multi-member group must exist for the
    // assertion above to have run — otherwise the test is vacuous.
    expect(groupsWithSiblings).toBeGreaterThan(0);
  });

  // Per-finding confidence parity invariant — doctrine source:
  // docs/kb/architecture/ai-first-consumer.md "Per-finding confidence
  // must reflect per-rule coverage limitations." When a rule's
  // adjusted `coverageConfidence !== "high"`, every per-finding emission
  // of that rule in the same response must either downgrade
  // `confidence` to match OR include the per-rule reason in
  // `couldBeWrongBecause`. Closure path (b) is the smaller blast
  // radius — propagate the reason code into `couldBeWrongBecause`.
  // The fixture exercises a substrate-axis downgrade
  // (`coverageConfidenceReason: "file-parse-error"`) and a rule-family
  // axis downgrade (`reason: "cross_file_listener_resolution_limited_on_this_input"`)
  // simultaneously: a `keyboard/handler-missing` finding on an HTML
  // file with a sibling `.html` parse error, sharing the same gate.
  it("per-finding couldBeWrongBecause carries the per-rule degradation reason for every degraded rule", () => {
    // Two HTML files: one parses cleanly and emits a keyboard/handler-
    // missing finding (`<div onclick=…>` with no keyboard sibling); the
    // second deliberately fails to parse (truncated tag) so the file
    // lands in `partialParseFiles` and every rule whose gate matched it
    // drops to `coverageConfidence: "low"` with
    // `coverageConfidenceReason: "partial-parse"`. Without the parity
    // fix, the per-rule rows would carry the substrate-level signal
    // but per-finding entries would still ship at `confidence: "high"`
    // with no `couldBeWrongBecause` — the contradictory shape the
    // doctrine names.
    const response = assembleParityFixture();
    const adjustedRows = (response.meta["perRuleCoverage"] as readonly PerRuleCoverage[]) ?? [];
    const degradedRuleIds = collectDegradedRuleIds(adjustedRows);
    expect(degradedRuleIds.size).toBeGreaterThan(0);

    // Every per-finding emission of a degraded rule must carry SOME
    // `couldBeWrongBecause` codes — either the propagated substrate
    // code or a rule-emitted code that already covered the gap.
    expect(observeEnrichedFinding(response, degradedRuleIds)).toBe(true);

    // Stronger invariant: the substrate-level reason code surfaces on
    // at least one per-finding entry whose rule's adjusted row carries
    // `coverageConfidenceReason: "partial-parse"`. The propagated code
    // is snake_case (`partial_parse`) so the `couldBeWrongBecause`
    // axis stays uniform across substrate and rule-family codes.
    const partialParseRules = collectRulesWithReason(adjustedRows, "partial-parse");
    expect(partialParseRules.size).toBeGreaterThan(0);
    expect(observeSubstrateCode(response, partialParseRules, "partial_parse")).toBe(true);
  });
});

/**
 * Builds the per-finding-parity fixture and assembles the scan-family
 * response. Extracted so the test body stays inside Biome's cognitive-
 * complexity ceiling.
 */
function assembleParityFixture() {
  const cleanHtml = `<!doctype html><html lang="en"><head><title>t</title></head><body><div onclick="doit()">Click</div></body></html>`;
  // Truncated open-tag in the middle — the HTML parser records an error
  // and produces a partial AST that still fires rules, so the file
  // lands in `partialParseFiles`.
  const brokenHtml = `<!doctype html><html lang="en"><head><title>t</title></head><body><div onclick="doit()">unterminated`;
  const files = [
    htmlFile("site/clean.html", cleanHtml),
    htmlFile("site/broken.html", brokenHtml),
  ];
  const { result, perRuleCoverage } = runScan({
    standards: [wcag22],
    rules: BUILTIN_RULES,
    enabled: ["wcag22"],
    files,
  });
  return assembleScanFamilyResponse({
    violations: result.violations,
    rawViolations: result.violations,
    parsedFiles: files,
    activeRules: BUILTIN_RULES,
    durationMs: result.durationMs,
    enabledStandards: result.enabledStandards,
    perRuleCoverage,
    reviewCandidates: [],
    wrappers: {
      wrappers: [],
      sessionOnly: [],
      bySource: {
        fromConfig: [],
        fromSession: [],
        fromAutoDetect: { confirmed: [], assumed: [] },
      },
      elements: {},
    },
    unusedWrappers: [],
    suppressions: [],
    verboseMeta: true,
    preset: undefined,
    actionableManual: 0,
    untargetedCriteria: 0,
    configSource: null,
    rootSource: "explicit",
  });
}

/** Set of rule IDs whose adjusted coverage row is degraded below `"high"`. */
function collectDegradedRuleIds(rows: readonly PerRuleCoverage[]): ReadonlySet<string> {
  return new Set(rows.filter((r) => r.coverageConfidence !== "high").map((r) => r.ruleId));
}

/** Set of rule IDs whose adjusted row carries the named substrate-level reason. */
function collectRulesWithReason(
  rows: readonly PerRuleCoverage[],
  reason: PerRuleCoverage["coverageConfidenceReason"],
): ReadonlySet<string> {
  return new Set(rows.filter((r) => r.coverageConfidenceReason === reason).map((r) => r.ruleId));
}

/**
 * Walks per-file findings and asserts each finding from a degraded rule
 * carries a non-empty `couldBeWrongBecause`. Returns whether at least
 * one such finding was observed (the parity invariant is vacuous if no
 * degraded rule actually emitted on the fixture).
 */
function observeEnrichedFinding(
  response: ReturnType<typeof assembleScanFamilyResponse>,
  degradedRuleIds: ReadonlySet<string>,
): boolean {
  let any = false;
  for (const file of response.files) {
    for (const finding of file.findings) {
      if (!degradedRuleIds.has(finding.ruleId)) continue;
      expect(finding.couldBeWrongBecause).toBeDefined();
      expect(finding.couldBeWrongBecause!.length).toBeGreaterThan(0);
      any = true;
    }
  }
  return any;
}

/** Returns true when at least one finding from `targetRules` lists `code` in `couldBeWrongBecause`. */
function observeSubstrateCode(
  response: ReturnType<typeof assembleScanFamilyResponse>,
  targetRules: ReadonlySet<string>,
  code: string,
): boolean {
  for (const file of response.files) {
    for (const finding of file.findings) {
      if (!targetRules.has(finding.ruleId)) continue;
      if (finding.couldBeWrongBecause?.includes(code)) return true;
    }
  }
  return false;
}

/**
 * Builds the heterogeneous file pool used by the appliesTo-parity
 * invariant test. Mixes HTML, JSX, and CSS so multiple rule gates fire
 * over the same scan — the parity check is meaningful only when ≥2
 * rules share an `appliesTo` set.
 */
function buildHeterogeneousPool(): ParsedFile[] {
  const files: ParsedFile[] = [];
  for (let i = 0; i < 4; i++) {
    files.push(
      htmlFile(
        `site/page-${i}.html`,
        `<!doctype html><html lang="en"><body><h1>p${i}</h1></body></html>`,
      ),
    );
    files.push(tsxFile(`src/comp-${i}.jsx`, `export const C${i} = () => <div>${i}</div>;`));
    files.push(cssFile(`src/style-${i}.css`, `.c${i} { color: #000; }`));
  }
  return files;
}

/**
 * Groups active rules by their normalized `appliesTo.fileExtensions`
 * key and asserts that every multi-member group reports the same
 * `filesEvaluated`. Returns the count of multi-member groups so the
 * caller can sanity-check that the assertion actually ran. Throws on
 * disagreement with a diagnostic that names the offending rule IDs.
 */
function assertAppliesToSiblingsAgree(
  perRuleCoverage: ReturnType<typeof runScan>["perRuleCoverage"],
): number {
  const byRuleId = new Map(perRuleCoverage.map((r) => [r.ruleId, r]));
  const groups = new Map<string, string[]>();
  for (const rule of BUILTIN_RULES) {
    const exts = rule.appliesTo?.fileExtensions;
    if (!exts || exts.length === 0) continue;
    // Only rules that ended up with a coverage row are in scope —
    // rules filtered by `isRuleActive` (e.g. AAA-only rules at AA)
    // don't appear and would skew the parity check.
    if (!byRuleId.has(rule.id)) continue;
    const key = [...exts].sort().join(",");
    const list = groups.get(key) ?? [];
    list.push(rule.id);
    groups.set(key, list);
  }
  let groupsWithSiblings = 0;
  for (const [key, ruleIds] of groups.entries()) {
    if (ruleIds.length < 2) continue;
    groupsWithSiblings += 1;
    const counts = ruleIds.map((id) => ({ id, n: byRuleId.get(id)!.filesEvaluated }));
    const distinct = new Set(counts.map((c) => c.n));
    if (distinct.size !== 1) {
      const detail = counts.map((c) => `${c.id}=${c.n}`).join(", ");
      throw new Error(
        `appliesTo=[${key}] siblings disagree on filesEvaluated: ${detail}. ` +
          `Eligibility is a pure function of (appliesTo, file.extension); ` +
          `disagreement implies a tracker bug (double-bump, missed bump, or duplicate rule registration).`,
      );
    }
  }
  return groupsWithSiblings;
}
