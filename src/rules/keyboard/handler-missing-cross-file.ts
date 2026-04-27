/**
 * Cross-file handler enrichment helpers for `keyboard/handler-missing`.
 *
 * SC 2.1.1 evidence is bounded to one file at scan time — a click attach
 * or a missing handler may be answered by JS in a sibling script. The
 * rule still surfaces the finding (per "surface-don't-suppress"), but
 * when a same-document `<script src="…">` (HTML) or a sibling-module
 * import (JSX/JS/TS) is present, we enrich the suggestion with that
 * follow-up signal and degrade per-finding `confidence` to `"medium"`
 * with a structured `couldBeWrongBecause` so the per-finding label
 * mirrors the per-rule `coverageConfidence` (ADR 0026,
 * docs/kb/architecture/ai-first-consumer.md "Per-finding confidence
 * must reflect per-rule coverage limitations").
 *
 * Extracted into its own file so the host rule stays under the
 * scripts/check-limits.ts file budget. The detectors are content-free
 * over the rule itself and could later serve other rules whose
 * evidence horizon is similarly bounded.
 */

import { findHtmlElementsByTag, getHtmlAttribute } from "../../engine/ast-helpers.ts";
import type { HtmlDocument } from "../../types/ast.ts";

/** Structured `couldBeWrongBecause` code for the cross-file ambiguity. */
export const CROSS_FILE_LISTENER_RESOLUTION_LIMITED = "cross_file_listener_resolution_limited";

/**
 * Returns the first `src` attribute value among the document's
 * `<script src="…">` elements, or `null` if no external script is
 * referenced. The first src is named verbatim in the suggestion so the
 * agent has a concrete grep target. Inline `<script>` tags (no src) are
 * excluded — their bodies are already in the same document and the rule
 * can already see them on the JSX/TS branch.
 */
export function detectExternalScriptSrc(doc: HtmlDocument): string | null {
  for (const el of findHtmlElementsByTag(doc, "script")) {
    const src = getHtmlAttribute(el, "src");
    if (src !== null && src !== "") return src;
  }
  return null;
}

/**
 * Matches `import` statements pulling from a relative path that ends
 * in `.js` / `.jsx` / `.ts` / `.tsx` / `.mjs` / `.cjs`, OR an extension-
 * less relative path (`./foo`, `../bar/baz`) — which Node/bundlers
 * resolve to a sibling module. Bare-package imports (`import x from
 * "react"`) are excluded: their handler bindings are library code, not
 * user-authored sibling files the agent can grep.
 *
 * The match captures the import specifier (group 1) so the suggestion
 * can name the file the agent should investigate.
 */
const SIBLING_MODULE_IMPORT = /\bimport\s+(?:[^"'`;]+?\s+from\s+)?["'`](\.\.?\/[^"'`]+)["'`]/g;

/**
 * Returns the first sibling-module import specifier in the source, or
 * `null` if no relative-path import is present. Side-effect imports
 * (`import "./styles.css"`) and named-binding imports both match — the
 * shape is "any import whose specifier starts with `./` or `../`."
 */
export function detectSiblingModuleImport(source: string): string | null {
  SIBLING_MODULE_IMPORT.lastIndex = 0;
  const m = SIBLING_MODULE_IMPORT.exec(source);
  if (m === null) return null;
  return m[1] ?? null;
}

/** Shape of the violation payloads `keyboard/handler-missing` emits. */
export interface CrossFileEnrichable {
  readonly severity: "error" | "warning" | "info";
  readonly location: { filePath: string; line: number; column: number };
  readonly message: string;
  readonly suggestion: string;
  readonly confidence?: "high" | "medium" | "low";
  readonly couldBeWrongBecause?: readonly string[];
}

/**
 * When a cross-file source is present, append a sentence to the
 * existing suggestion naming the cross-file possibility and stamp
 * `confidence: "medium"` with a structured `couldBeWrongBecause` code.
 * When no cross-file source is detected, the violation passes through
 * unchanged. Doctrine: surface-don't-suppress with reason-text
 * enrichment so the agent can verify the binding rather than guess.
 */
export function enrichForCrossFileScript<V extends CrossFileEnrichable>(
  v: V,
  externalSource: string | null,
): V {
  if (externalSource === null) return v;
  const enrichmentSuffix = ` Cross-file follow-up: this file has no inline keyboard handler, but the binding may live in an external script (\`${externalSource}\`) — verify the keyboard wiring there before treating this finding as live.`;
  return {
    ...v,
    suggestion: `${v.suggestion}${enrichmentSuffix}`,
    confidence: "medium",
    couldBeWrongBecause: [CROSS_FILE_LISTENER_RESOLUTION_LIMITED],
  };
}

/**
 * Stamps `confidence: "medium"` + `couldBeWrongBecause:
 * ["cross_file_listener_resolution_limited"]` on an external-JS
 * finding unconditionally — and, when a sibling-module import was
 * detected, additionally appends the cross-file follow-up sentence to
 * the suggestion. The unconditional downgrade reflects a structural
 * fact: external-JS click attaches resolve their target against the
 * DOM (an HTML file separate from the `.js` source the rule scanned),
 * so the per-finding confidence cannot honestly be `"high"` from a
 * `.js`-only read — the receiver might be a native `<button>` /
 * `<a href>` or it might be a bare `<div>`, and only the HTML knows.
 *
 * Mirrors the per-rule `coverageConfidence: "medium"` with reason
 * `cross_file_listener_resolution_limited_on_this_input` that
 * `CROSS_FILE_BOUND_REASONS_PER_INPUT` (in `src/engine/per-rule-coverage.ts`) already records, per the
 * doctrine at docs/kb/architecture/ai-first-consumer.md "Per-finding
 * confidence must reflect per-rule coverage limitations" —
 * propagating the limitation to per-finding `confidence` keeps the
 * per-rule and per-finding layers from shipping contradictory
 * attention-budget signals on the same rule in the same response.
 *
 * Distinct from {@link enrichForCrossFileScript} which gates on the
 * presence of an external script / sibling-module import: the JSX/HTML
 * paths can have an in-file keyboard handler that the rule already
 * verified absent, so when no cross-file source is present the binding
 * is in-file and `"high"` confidence is honest. The external-JS path
 * can never verify the receiver in-file — its target is always cross-
 * file.
 */
export function enrichExternalJsFinding<V extends CrossFileEnrichable>(
  v: V,
  siblingImport: string | null,
): V {
  if (siblingImport === null) {
    return {
      ...v,
      confidence: "medium",
      couldBeWrongBecause: [CROSS_FILE_LISTENER_RESOLUTION_LIMITED],
    };
  }
  const enrichmentSuffix = ` Cross-file follow-up: this file has no inline keyboard handler, but the binding may live in an external script (\`${siblingImport}\`) — verify the keyboard wiring there before treating this finding as live.`;
  return {
    ...v,
    suggestion: `${v.suggestion}${enrichmentSuffix}`,
    confidence: "medium",
    couldBeWrongBecause: [CROSS_FILE_LISTENER_RESOLUTION_LIMITED],
  };
}
