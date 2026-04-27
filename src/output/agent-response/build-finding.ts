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

import type { Violation } from "../../types/violation.ts";
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
    lower.endsWith(".erb")
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
   * Omit when the caller does not have the source on hand (e.g. the CLI
   * agent formatter consumes `ScanResult` only, which carries violations
   * but not parsed-file sources). In that case the bare rule-emitted
   * edit ships unwidened — the same as before this option existed.
   */
  readonly source?: string;
}

function categorize(v: Violation): Category {
  if (v.fixPaths?.primary.edit !== undefined) return "auto-fix";
  if (v.severity === "info") return "review";
  if (typeof v.suggestion === "string" && v.suggestion.length > 0) return "auto-fix";
  return "review";
}

/**
 * Convert a single {@link Violation} into an {@link AgentFinding}.
 *
 * The `category` field uses `"auto-fix"` when there is a mechanical edit,
 * `"review"` for guidance-only or no-suggestion findings at non-info severity,
 * and `"review"` for info-severity findings.
 */
export function buildAgentFinding(v: Violation, opts?: BuildAgentFindingOptions): AgentFinding {
  const category = categorize(v);
  const fix = buildFix(v, opts?.source);
  const placement =
    (opts?.suppressPlacement ?? "inline") === "inline"
      ? buildSuppressPlacement(v.location.filePath)
      : undefined;

  return {
    findingId: v.findingId,
    groupKey: v.groupKey,
    ruleId: v.ruleId,
    fixClass: v.fixClass,
    criteria: [...v.criteria],
    ...(v.criteriaTitles !== undefined && { criteriaTitles: [...v.criteriaTitles] }),
    ...(v.couldBeWrongBecause && v.couldBeWrongBecause.length > 0
      ? { couldBeWrongBecause: [...v.couldBeWrongBecause] }
      : {}),
    severity: v.severity,
    confidence: resolveConfidence(v),
    ...mapPositionToAgent(v),
    message: v.message,
    ...(typeof v.snippet === "string" && v.snippet.length > 0 ? { snippet: v.snippet } : {}),
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
