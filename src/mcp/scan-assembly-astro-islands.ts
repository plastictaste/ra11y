/**
 * Per-rule-coverage astro-islands-unrendered adjuster — companion of
 * {@link import("./scan-assembly.ts").applyFragmentInputAdjustment} on
 * a different substrate axis. An `.astro` file is two regions: an
 * optional component-script frontmatter fence (`---\n…\n---\n`) and
 * an HTML template that may interleave capitalized component tags
 * (`<Layout>`, `<Header>`, `<Icon>`) and JSX-style `{expr}` braces.
 * The {@link parseAstro} adapter blanks the frontmatter (so line
 * numbers stay aligned) and hands the residual template to
 * {@link parseHtml}; the HTML parser tolerates capitalized tags as
 * arbitrary elements but cannot resolve imported components or
 * evaluate expressions. Any aria/role/label attribute a component
 * would have rendered, or any visible text an expression would have
 * produced, is invisible to the static scan.
 *
 * Doctrine source: docs/kb/architecture/ai-first-consumer.md
 *   - "Parser-failure invalidates per-file confidence" — extended to
 *     template-island parse-as-literal classifications. The unrendered
 *     `<Layout>` / `<Header>` is not a parser error per se; it's a
 *     routing-decision property of the substrate that bounds the
 *     rule's evidence model.
 *   - "Per-finding confidence must reflect per-rule coverage
 *     limitations" — the per-rule downgrade
 *     (`coverageConfidenceReason: "astro-islands-unrendered-static-only"`)
 *     and the per-finding propagation
 *     (`astro_islands_unrendered_static_only` on
 *     `couldBeWrongBecause`) ride on the same file set so per-rule
 *     and per-finding signals never disagree.
 *
 * Backlog closure: `Q19-ASTRO-ISLANDS-NO-PERRULE-CONFIDENCE-DOWNGRADE`.
 *
 * Two exports drive the adjustment + the file-list collection:
 *
 *   - {@link detectAstroIslandsUnrenderedFiles} — walks the parsed
 *     file set and returns the subset of `.astro` files carrying
 *     unrendered-island evidence per the same three-component OR
 *     predicate the warning-channel detector uses.
 *   - {@link applyAstroIslandUnrenderedAdjustment} — walks per-rule
 *     coverage rows and downgrades `coverageConfidence` to `"medium"`
 *     with `coverageConfidenceReason:
 *     "astro-islands-unrendered-static-only"` when at least one of
 *     the rule's eligible files is in the astro-island set AND the
 *     rule is in {@link ASTRO_ISLAND_DOWNGRADE_RULE_IDS}.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage } from "../types/violation.ts";
import { countMatchingFiles } from "./scan-assembly.ts";

/**
 * Document-shaped + event-handler rules whose evidence model is
 * structurally bounded on `.astro` files where the static scan sees
 * only the frontmatter `<script>` island and the residual HTML
 * template with imported components left as opaque elements and
 * `{expr}` braces passed through as literal text. The rendered output
 * an Astro server-render would produce — `<main>` injected by a
 * `<Layout>` import, page `<title>` set by an SEO component, `lang=`
 * on the framework root, `aria-*` attributes the component spreads,
 * listener wiring the island runtime attaches — is invisible to the
 * scanner. Per the AI-first doctrine, any classification that gates
 * the rule's evidence model must propagate to that rule's confidence
 * label in the same response.
 *
 * Why a separate set rather than reusing
 * `FRAGMENT_DOWNGRADE_RULE_IDS`: the fragment classification names
 * "no `<html>`/`<body>` root" — a structural property of the parsed
 * AST. The astro-islands signal names "the component-script and
 * imported components are unrendered" — a routing-decision property
 * of the substrate that holds even when the file's parsed AST DOES
 * carry an `<html>` root. The two classifications are orthogonal; an
 * `.astro` file may be a fragment, an envelope-carrier, or both, and
 * its rules must downgrade in either case. The reason codes also
 * differ (`fragment-input-no-document-envelope` vs
 * `astro-islands-unrendered-static-only`), so the per-rule layer
 * surfaces which substrate signal drove the downgrade.
 *
 * The list is small and stable — these are the rules whose evidence
 * model is structurally bounded by the unrendered island substrate.
 * Adding here is a one-line edit; the test suite asserts the set
 * covers the document-shaped + event-handler rules it lists.
 */
const ASTRO_ISLAND_DOWNGRADE_RULE_IDS: ReadonlySet<string> = new Set([
  "semantics/landmark-main",
  "semantics/heading-hierarchy",
  "semantics/empty-heading",
  "document/page-titled",
  "document/lang-attribute",
  "parsing/html-has-lang",
  // Event-handler rule: fires on bare `<button onClick>` /
  // `<div onClick>` JSX-style emits but cannot see listener wiring
  // the Astro island runtime attaches client-side. Per the AI-first
  // doctrine "Per-finding confidence must reflect per-rule coverage
  // limitations" the unrendered-island substrate bounds this rule's
  // evidence model on `.astro` files just as the cross-file-listener
  // limitation bounds it on plain `.html` corpora.
  "keyboard/handler-missing",
]);

/**
 * Returns the subset of scanned `.astro` files classified as carrying
 * unrendered-island evidence per the predicate in
 * {@link import("./analysis-coverage-astro.ts").recordAstroIslandStripped}.
 * Mirrors the predicate {@link buildAnalysisCoverage} uses to populate
 * `meta.analysisCoverage.astroIslandsUnrenderedFiles[]` so the file
 * list driving the
 * `coverageConfidenceReason: "astro-islands-unrendered-static-only"`
 * per-rule downgrade and the file list the agent sees on the meta
 * surface stay identical — same evidence, same shared classifier, no
 * cross-surface drift between rule-side suppression and meta-side
 * telemetry.
 *
 * Returns paths in sorted order so wire output is deterministic across
 * runs. Empty array when no astro-island files are present — callers
 * conditional-spread on `length > 0`.
 */
export function detectAstroIslandsUnrenderedFiles(
  files: readonly ParsedFile[],
): readonly string[] {
  const out: string[] = [];
  for (const file of files) {
    if (!file.filePath.toLowerCase().endsWith(".astro")) continue;
    if (!hasAstroIslandEvidence(file.source)) continue;
    out.push(file.filePath);
  }
  out.sort();
  return out;
}

/**
 * Three-component OR predicate mirroring
 * {@link import("./analysis-coverage-astro.ts").recordAstroIslandStripped}'s
 * `hasAstroEvidence` helper. Kept inlined here (rather than imported)
 * because the analysis-coverage sub-module's helper writes onto a
 * structural accumulator and the per-rule-coverage seam wants a pure
 * `(source) => boolean` predicate. The two predicates are textually
 * the same regex set; integration tests pin the file-list parity
 * between meta surface and per-rule downgrade so any future predicate
 * drift would surface there.
 */
function hasAstroIslandEvidence(source: string): boolean {
  if (/^---(?:\r?\n)/.test(source)) return true;
  if (/<[A-Z][A-Za-z0-9]*(?:[\s/>]|$)/.test(source)) return true;
  if (/\{[^{}]/.test(source)) return true;
  return false;
}

/**
 * Companion of
 * {@link import("./scan-assembly.ts").applyFragmentInputAdjustment} on
 * the astro-islands axis. Downgrades a rule's `coverageConfidence` to
 * `"medium"` with
 * `coverageConfidenceReason: "astro-islands-unrendered-static-only"`
 * when at least one of its eligible files is in
 * `analysisCoverage.astroIslandsUnrenderedFiles[]` (the static scan
 * sees only the frontmatter `<script>` island; the rendered output
 * — `<Layout>` / `<Header>` injection, expression-rendered text /
 * aria, client-side listener wiring — is invisible).
 *
 * Why `"medium"` and not `"low"`: the rule did run, eligibility was
 * met, the file parsed cleanly. The honest signal is "evidence
 * horizon was bounded by the substrate's unrendered-island routing"
 * — a peer to the `fragment-input-no-document-envelope` and
 * `cross_file_*_resolution_not_attempted_by_rule` downgrade shape,
 * not the parse-error invisibility shape. A `"low"` downgrade would
 * conflate this case with the parse-error case (file invisible /
 * partially-parsed), which is a stronger statement than the substrate
 * warrants.
 *
 * Precedence: when an upstream adjuster
 * (`applyParseErrorAdjustment`, `applyScssUnresolvedVariablesAdjustment`,
 * or `applyFragmentInputAdjustment`) already stamped a non-astro
 * `coverageConfidenceReason`, this adjuster passes the row through
 * unchanged — those reasons name a stronger or earlier substrate-
 * level signal and the two reasons never share a row. The astro
 * adjuster runs after the fragment-input pass so a layout-style
 * `.astro` file lacking an `<html>` root (which both predicates fire
 * on) keeps the stronger fragment-input reason; envelope-carrying
 * `.astro` files get the astro reason.
 *
 * No-op fast path: when {@link astroIslandFilePaths} is empty, returns
 * the input array unchanged. Exported so the wiring layer
 * (response-assembler, tools-helpers, per-rule-coverage-shared) can
 * run all adjusters in series and feed the per-rule meta + the
 * top-level `ruleCoverage` derivative the same adjusted view.
 */
export function applyAstroIslandUnrenderedAdjustment(
  rows: readonly PerRuleCoverage[],
  files: readonly ParsedFile[],
  activeRules: readonly Rule[],
  astroIslandFilePaths: ReadonlySet<string>,
): readonly PerRuleCoverage[] {
  if (astroIslandFilePaths.size === 0) return rows;
  const ruleById = new Map<string, Rule>();
  for (const r of activeRules) ruleById.set(r.id, r);
  const islandSet = new Set(astroIslandFilePaths);
  const islandFiles = files.filter((f) => islandSet.has(f.filePath));
  return rows.map((row) =>
    adjustRowForAstroIslandUnrendered(row, ruleById.get(row.ruleId), islandFiles),
  );
}

/**
 * Per-row adjustment helper for {@link applyAstroIslandUnrenderedAdjustment}.
 * Returns the input row unchanged when the rule isn't in
 * {@link ASTRO_ISLAND_DOWNGRADE_RULE_IDS} (only document-shaped rules
 * + event-handler rules downgrade — every other rule's evidence
 * model is honest on an unrendered-island file), when no astro-island
 * files match the rule's gate, when the row is already at `"low"`
 * (parse-error precedence), or when the row's existing
 * `coverageConfidenceReason` is set to a non-astro reason (substrate-
 * level signals from earlier adjusters win over astro classification).
 */
function adjustRowForAstroIslandUnrendered(
  row: PerRuleCoverage,
  rule: Rule | undefined,
  islandFiles: readonly ParsedFile[],
): PerRuleCoverage {
  if (!ASTRO_ISLAND_DOWNGRADE_RULE_IDS.has(row.ruleId)) return row;
  if (row.coverageConfidence === "low") return row;
  if (
    row.coverageConfidenceReason !== undefined &&
    row.coverageConfidenceReason !== "astro-islands-unrendered-static-only"
  ) {
    return row;
  }
  const matches = countMatchingFiles(rule, islandFiles);
  if (matches === 0) return row;
  return {
    ...row,
    coverageConfidence: "medium",
    coverageConfidenceReason: "astro-islands-unrendered-static-only",
    reason:
      row.reason ??
      "at least one matching .astro file's component-script and imported components are unrendered (Astro adapter blanked the frontmatter; the HTML parser left components/expressions as literal); evidence the rendered output would have produced is invisible to the static scan",
  };
}
