/**
 * buildAgentFinding — Violation → AgentFinding builder.
 *
 * Single implementation consumed by both the CLI agent formatter
 * (`src/output/formatters/agent.ts`) and the MCP tools layer.
 *
 * Hollow-fix rule: `AgentFix.oldText` / `newText` are emitted only when the
 * violation carries a mechanical edit via `fixPaths?.primary.edit`. For
 * guidance-only findings (prose `suggestion` but no edit), `fix` carries only
 * `description` — no empty-string sentinels. Per CLAUDE.md §1 "Ambiguous
 * field shapes are dishonest."
 *
 * Cross-tool contract — `oldText` widening (-
 * ADJACENT). When the caller provides the file's `source`, `oldText` /
 * `newText` are widened to a unique anchor window via `widenToUniqueAnchor`
 * — the same helper `suggest_fix` runs on its `primary.edit`. This unifies
 * the edit shape across `scan_project` (per-finding `fix.oldText`) and
 * `suggest_fix` (`primary.edit.oldText`): both surfaces ship multi-line
 * unique context so an agent applying the edit through `apply_fix` can't
 * silently clobber the wrong occurrence. Without source, the bare
 * rule-emitted edit ships unwidened (current behavior preserved for
 * surfaces that have no source in scope, e.g. CLI formatters consuming
 * `ScanResult` only).
 *
 * `safety` used to ride on every emitted fix as a constant `"safe"`, regardless
 * of `fixClass` — a field that never varies conveys no signal, and claiming
 * "safe" on a runtime-only or guidance fix is arguably wrong (static analysis
 * cannot prove safety without runtime context). Dropped per
 * `fixClass` already distinguishes the
 * remediation lane; a sibling constant is noise.
 */

import type { FixClass } from "../../types/rule.ts";
import type { Violation } from "../../types/violation.ts";
import { buildSnippetForReason, type SnippetLanguage } from "../../utils/source-snippet.ts";
import { isSuppressionFlavoredSuggestion } from "../../utils/suppression-flavored-suggestion.ts";
import { widenToUniqueAnchor } from "../../utils/unique-anchor.ts";
import type { AgentFinding, AgentFix, Category, Confidence } from "./types.ts";

/** @internal */
export function severityToConfidence(severity: string): Confidence {
  if (severity === "error") return "high";
  if (severity === "warning") return "medium";
  return "low";
}

/**
 * Resolves the agent-facing confidence for a Violation. Honours an
 * explicit `v.confidence` when present (canonically `"inherited"` on
 * synthesized wrapper-call-site findings), otherwise
 * falls back to the severity-derived mapping.
 */
function resolveConfidence(v: Violation): Confidence {
  if (v.confidence !== undefined) return v.confidence;
  return severityToConfidence(v.severity);
}

function buildFix(v: Violation, source: string | undefined): AgentFix | undefined {
  const hasMechanicalEdit = v.fixPaths?.primary.edit !== undefined;
  const hasGuidance = typeof v.suggestion === "string" && v.suggestion.length > 0;

  if (hasMechanicalEdit && v.fixPaths !== undefined) {
    // Deterministic rewrite — emit both text fields so an agent can apply verbatim.
    const edit = v.fixPaths.primary.edit;
    if (edit !== undefined) {
      // widen the bare
      // rule-emitted edit to a unique-in-file anchor window when the
      // caller threaded the file's source through. The same
      // `widenToUniqueAnchor` helper `suggest_fix` runs on its
      // `primary.edit` — sharing it here unifies the cross-tool edit
      // shape so an agent pasting `fix.oldText` straight into
      // `apply_fix` can't silently clobber the first of N matching
      // occurrences in the file (the canonical case: 5 sibling
      // `forms/label-adjacent-unassociated` findings whose
      // rule-emitted oldText is the bare 4-char literal `<label>`).
      // Without source, the edit ships unwidened (current behavior
      // preserved for surfaces that have no source in scope, e.g.
      // CLI formatters that consume `ScanResult` only).
      const widened =
        source === undefined
          ? { oldText: edit.oldText, newText: edit.newText }
          : widenToUniqueAnchor({
              source,
              oldText: edit.oldText,
              newText: edit.newText,
              line: v.location.line,
            });
      return {
        oldText: widened.oldText,
        newText: widened.newText,
        description: v.suggestion ?? v.fixPaths.primary.label,
      };
    }
  }

  if (hasGuidance && typeof v.suggestion === "string") {
    // Prose guidance only — no hollow oldText/newText sentinels.
    return {
      description: v.suggestion,
    };
  }

  return undefined;
}

/**
 * Resolves the per-finding `snippet` field with this precedence:
 *
 * 1. The rule emitted a non-empty `Violation.snippet` — surface it
 *    verbatim. The rule has the most context (e.g. `<a href="javascript:…">`
 *    capturing the offending opener), so its choice wins.
 * 2. The caller threaded `source` + `language` AND the rule did not
 *    emit one — auto-build a ±3-line window via
 *    {@link buildSnippetForReason} (wide-fallback when the message
 *    cites cross-line evidence). This is the same recipe checklist
 *    candidates use, so an agent reading the same conceptual location
 *    across `scan_project` / `scan_file` / `checklist` sees the same
 *    snippet.
 * 3. Otherwise, omit the field per CLAUDE.md §1 "Ambiguous field shapes
 *    are dishonest." Empty-string sentinels are silent-miss hazards.
 *
 * Findings without a usable file:line (synthetic rule-crash records,
 * project-rooted aggregate findings) reach this helper with `line < 1`
 * — the snippet builder returns `undefined` on those inputs, the call
 * site conditional-spreads it away.
 */
function resolveSnippet(v: Violation, opts?: BuildAgentFindingOptions): string | undefined {
  if (typeof v.snippet === "string" && v.snippet.length > 0) return v.snippet;
  if (opts?.source === undefined || opts?.language === undefined) return undefined;
  return buildSnippetForReason({
    source: opts.source,
    line: v.location.line,
    reason: v.message,
    language: opts.language,
  });
}

function buildSuppressPragma(filePath: string, ruleId: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less")) {
    return `/* ra11y-disable-next-line ${ruleId} */`;
  }
  if (
    lower.endsWith(".html") ||
    lower.endsWith(".htm") ||
    lower.endsWith(".xhtml") ||
    lower.endsWith(".astro") ||
    lower.endsWith(".svg") ||
    lower.endsWith(".erb") ||
    lower.endsWith(".php") ||
    lower.endsWith(".phtml") ||
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".mkdn")
  ) {
    // Astro templates are HTML, so the HTML-comment disable form is
    // the one that parses inside an Astro template body (a
    // `{/* … */}` would be interpreted as a JSX expression by Astro
    // only inside the component-script frontmatter, not in template
    // position where the agent will land the pragma). Standalone SVG
    // is XML, which also accepts `<!-- … -->` comments. ERB
    // templates are HTML skeletons with embedded Ruby; `<!-- … -->`
    // survives the ERB pre-processor verbatim and is the right form
    // for the rendered HTML reviewer too. Markdown (.md / .markdown)
    // routes through `parseHtml` after the markdown stripper (ADR
    // 0025), so findings sit inside embedded-HTML residue where raw
    // HTML comments pass through CommonMark verbatim and the pragma
    // reader already accepts them. The shape echoed here matches the
    // `suppress` tool's writer half so an agent calling
    // `suppress({ file: "docs.md", … })` lands the same text the
    // scan response promised.
    return `<!-- ra11y-disable-next-line ${ruleId} -->`;
  }
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx") || lower.endsWith(".mdx")) {
    return `{/* ra11y-disable-next-line ${ruleId} */}`;
  }
  return `// ra11y-disable-next-line ${ruleId}`;
}

/**
 * Per-file-type placement guidance so the agent lands the pragma in a
 * syntactically valid spot on the first edit.
 */
function buildSuppressPlacement(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx") || lower.endsWith(".mdx")) {
    return "Place on the line immediately above the opening JSX tag of the flagged element — not inside attributes, and not between adjacent JSX siblings without a wrapping expression. The `{/* … */}` wrapper is valid as a JSX expression or at module scope.";
  }
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less")) {
    return "Place on the line immediately above the CSS rule whose declarations are flagged.";
  }
  if (
    lower.endsWith(".html") ||
    lower.endsWith(".htm") ||
    lower.endsWith(".xhtml") ||
    lower.endsWith(".astro") ||
    lower.endsWith(".svg") ||
    lower.endsWith(".erb") ||
    lower.endsWith(".php") ||
    lower.endsWith(".phtml")
  ) {
    return "Place on the line immediately above the opening tag of the flagged element.";
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mkdn")) {
    return "Place on the line immediately above the embedded-HTML element the finding refers to (the markdown parser only flags findings on raw HTML residue — `<table>`, `<iframe>`, `<img>` synthesized from `![alt](url)`, etc.). The `<!-- … -->` shape passes through the markdown renderer verbatim.";
  }
  return "Place on the line immediately above the flagged statement.";
}

/**
 * Options for {@link buildAgentFinding}.
 */
export interface BuildAgentFindingOptions {
  /**
   * Whether to include per-finding `suppressPlacement` guidance.
   *
   * `"inline"` (default) — emit the file-type-specific placement string on
   * every finding. CLI agent-format consumers read it per-finding.
   *
   * `"omit"` — drop the field. MCP responses hoist the same guidance once
   * into `referenceGuide.suppressPlacement` keyed by file extension, so
   * repeating identical text on every finding would just inflate the payload.
   */
  readonly suppressPlacement?: "inline" | "omit";
  /**
   * the file's source text. When
   * provided AND the violation carries a mechanical edit
   * (`fixPaths.primary.edit`), `oldText` / `newText` are widened to a
   * unique-in-file anchor window via `widenToUniqueAnchor` — the same
   * helper `suggest_fix` runs on its `primary.edit`. Threading source
   * through here unifies the cross-tool edit shape so an agent pasting
   * `fix.oldText` from a `scan_project` finding straight into
   * `apply_fix` can't silently clobber the first of N matching
   * occurrences in the file.
   *
   * Same source is also consumed to populate the per-finding `snippet`
   * field when the rule did not emit one inline — see
   * V1-FINDINGS-SNIPPET-FIELD-OMITTED-ON-SCAN-SURFACES. When `source`
   * is provided alongside {@link language}, the builder reads ±3 lines
   * around `v.location.line` (or wider if the message cites cross-line
   * evidence — see {@link buildSnippetForReason}) so the agent can
   * triage in-place without an extra Read round-trip per finding. The
   * recipe is the same one `checklist` runs on its review candidates,
   * keeping `snippet` shape parity across scan/checklist/coverage
   * surfaces (per docs/kb/architecture/ai-first-consumer.md "Per-tool
   * review-candidate shape must agree across surfaces"). Omitted when
   * no honest snippet can be built (line out of bounds, empty source).
   *
   * Omit when the caller does not have the source on hand (e.g. the CLI
   * agent formatter consumes `ScanResult` only, which carries violations
   * but not parsed-file sources). In that case the bare rule-emitted
   * edit ships unwidened, and `snippet` is omitted unless the rule
   * itself stamped one — same as before this option existed.
   */
  readonly source?: string;
  /**
   * Language tag of the file's source — sibling to {@link source}. Required
   * for the snippet auto-population path so {@link buildSnippetForReason}
   * can pick the correct enclosing-block walker (TSX/JSX/TS/JS use a
   * brace-balanced wide-fallback; HTML/CSS use the fixed-line window).
   * Omit at call sites that do not have parsed-file ASTs in scope; the
   * snippet falls back to whatever the rule emitted on `Violation.snippet`,
   * preserving prior behavior on the CLI formatter and other ScanResult-only
   * surfaces.
   */
  readonly language?: SnippetLanguage;
}

/**
 * Resolves the agent-facing {@link Category} for a Violation.
 *
 * `"auto-fix"` is reserved for findings that ship a mechanical edit
 * (`fixPaths?.primary.edit`). Everything else — guidance-only prose
 * suggestions, runtime-only checks, verify-in-source rules without a
 * mechanical edit — routes to `"review"` because no static edit is
 * available for the agent to apply verbatim.
 *
 * Doctrine: per `docs/kb/architecture/ai-first-consumer.md` "Reason /
 * priority / fix-description must agree across all three channels," a
 * finding with `fixClass: "runtime-only"` (the rule's own declaration
 * that no static edit exists) cannot honestly carry `category:
 * "auto-fix"`. Before this fix, any prose `suggestion` string upgraded
 * the category — including on `runtime-only` rules — and shipped a
 * silent contradiction with the sibling `fixClass` on the same finding
 * (canonical case: `motion/pause-stop-hide` shipped `fixClass:
 * "runtime-only"` AND `category: "auto-fix"` simultaneously, because
 * every emission carries a prose `suggestion`). Anchoring `auto-fix`
 * to the presence of a mechanical edit removes the contradiction
 * without dropping signal — the prose suggestion is still surfaced
 * via `fix.description`.
 */
function categorize(v: Violation): Category {
  if (v.fixPaths?.primary.edit !== undefined) return "auto-fix";
  return "review";
}

/**
 * Resolves the per-finding remediation lane. The rule's declared
 * {@link FixClass} is the common case; suppression-flavored emissions
 * (suggestion prose that names the source-level disable pragma —
 * `ra11y-disable` / `suppress with` — see
 * {@link isSuppressionFlavoredSuggestion}) reroute to the per-emission
 * `"suppress-recommended"` lane.
 *
 * Doctrine: docs/kb/architecture/ai-first-consumer.md "Per-call shape
 * must agree with per-class plan tally" — `suggest_fix.kind:
 * "suppress-recommended"` is the per-call discriminator on these
 * findings; the per-finding `fixClass` mirrors the same partition so
 * an agent budgeting from `plan.fixesByClass` lands in the same lane
 * `suggest_fix` would route to. The plan-tally side already partitions
 * via {@link import("./build-plan.ts")#countFixesByClass}; this
 * helper keeps the per-finding stamp aligned with that partition.
 *
 * Mechanical edits never reroute: a violation with a populated
 * `fixPaths.primary.edit` ships an actual edit, and an actual edit is
 * never a "verify and add a pragma" outcome. The suppression-flavored
 * predicate fires on suggestion prose, not on edit shape, but the
 * doctrine carve-out is explicit — keep mechanical-fix findings in
 * their declared lane.
 */
function resolveFixClass(v: Violation): FixClass | "suppress-recommended" {
  if (v.fixPaths?.primary.edit !== undefined) return v.fixClass;
  if (isSuppressionFlavoredSuggestion(v.suggestion)) return "suppress-recommended";
  return v.fixClass;
}

/**
 * Convert a single {@link Violation} into an {@link AgentFinding}.
 *
 * The `category` field uses `"auto-fix"` only when the violation ships a
 * mechanical edit (`fixPaths?.primary.edit`); every other finding —
 * guidance-only prose, runtime-only checks, verify-in-source without an
 * edit, info-severity additive context — routes to `"review"`. See
 * {@link categorize} for the doctrine.
 */
export function buildAgentFinding(v: Violation, opts?: BuildAgentFindingOptions): AgentFinding {
  const category = categorize(v);
  const fix = buildFix(v, opts?.source);
  const placement =
    (opts?.suppressPlacement ?? "inline") === "inline"
      ? buildSuppressPlacement(v.location.filePath)
      : undefined;
  const snippet = resolveSnippet(v, opts);

  return {
    findingId: v.findingId,
    findingGroupId: v.findingGroupId,
    groupKey: v.groupKey,
    // CSS-declaration cross-file fingerprint — sibling of `groupKey`
    // for the contrast family and `motion/pause-stop-hide`'s CSS
    // branches. Surfaced on the agent finding so the collapsed-by-
    // group response mode (`src/mcp/scan-project-collapse-by-group.ts`)
    // can prefer it over `groupKey` when bucketing findings — the
    // 117-copy `.img-thumbnail` template-catalog case collapses to
    // one canonical entry by construction. Conditional spread keeps
    // `cssPatternId: undefined` off the wire per CLAUDE.md §1
    // "Ambiguous field shapes are dishonest."
    ...(v.cssPatternId !== undefined && { cssPatternId: v.cssPatternId }),
    ruleId: v.ruleId,
    fixClass: resolveFixClass(v),
    criteria: [...v.criteria],
    ...(v.criteriaTitles !== undefined && { criteriaTitles: [...v.criteriaTitles] }),
    ...(v.couldBeWrongBecause && v.couldBeWrongBecause.length > 0
      ? { couldBeWrongBecause: [...v.couldBeWrongBecause] }
      : {}),
    severity: v.severity,
    confidence: resolveConfidence(v),
    ...mapPositionToAgent(v),
    message: v.message,
    ...(snippet === undefined ? {} : { snippet }),
    ...(fix === undefined ? {} : { fix }),
    effort: "trivial",
    category,
    suppressWith: buildSuppressPragma(v.location.filePath, v.ruleId),
    ...(placement !== undefined && { suppressPlacement: placement }),
    ...(v.sourceOfFinding !== undefined && {
      sourceOfFinding: {
        filePath: v.sourceOfFinding.filePath,
        line: v.sourceOfFinding.line,
        ...(v.sourceOfFinding.column !== undefined && { column: v.sourceOfFinding.column }),
      },
    }),
    ...(v.vendorOccurrences !== undefined && v.vendorOccurrences.length > 0
      ? { vendorOccurrences: v.vendorOccurrences.map((o) => ({ path: o.path, line: o.line })) }
      : {}),
    // In-file rule-emitted sibling rollup (-
    // COLLAPSE). Conditional spread keeps `siblingInstances: []` /
    // `undefined` off the wire per CLAUDE.md §1 "Ambiguous field shapes
    // are dishonest."
    ...mapSiblingInstancesToAgent(v.siblingInstances),
    // Structured discriminating evidence forwarded from the upstream
    // Violation. High-density rules promote the discriminator from
    // prose to a typed sub-shape so the agent can branch-route triage.
    // Conditional spread per CLAUDE.md §1 "Ambiguous field shapes are
    // dishonest" — rules that don't populate the field see no field
    // on the agent finding either.
    ...(v.evidence !== undefined && { evidence: v.evidence }),
  };
}

function mapSiblingInstancesToAgent(
  siblings: readonly { readonly line: number; readonly id?: string }[] | undefined,
): { siblingInstances?: readonly { readonly line: number; readonly id?: string }[] } {
  if (siblings === undefined || siblings.length === 0) return {};
  return {
    siblingInstances: siblings.map((s) =>
      s.id === undefined ? { line: s.line } : { line: s.line, id: s.id },
    ),
  };
}

/**
 * Folds the position cluster (`line`, `column`, optional `endLine` /
 * `endColumn`, optional `decline`) into one shape so the assembly site
 * stays under the cognitive-complexity ceiling. `decline` is the
 * declaration-line sibling for selector-scoped CSS findings — present
 * only when the rule's selector start (`location.line`) differs from
 * the offending declaration line, per.
 * Conditional spread keeps `decline: undefined` off the wire per
 * CLAUDE.md §1 "Ambiguous field shapes are dishonest."
 */
function mapPositionToAgent(v: Violation): {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  decline?: number;
} {
  return {
    line: v.location.line,
    column: v.location.column,
    ...(v.location.endLine !== undefined && { endLine: v.location.endLine }),
    ...(v.location.endColumn !== undefined && { endColumn: v.location.endColumn }),
    ...(typeof v.decline === "number" && { decline: v.decline }),
  };
}
