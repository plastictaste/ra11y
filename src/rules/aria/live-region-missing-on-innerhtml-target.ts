/**
 * Rule: aria/live-region-missing-on-innerhtml-target
 * Satisfies: wcag22:4.1.3, wcag21:4.1.3
 * Spec: https://www.w3.org/TR/WCAG22/#status-messages
 *
 * > In content implemented using markup languages, status messages can
 * > be programmatically determined through role or properties such that
 * > they can be presented to the user by assistive technologies without
 * > receiving focus.
 *
 * Source: https://www.w3.org/TR/WCAG22/#status-messages
 *
 * Cross-file rule. The failing pattern looks like this:
 *
 *   <!-- index.html -->
 *   <div id="clock"></div>
 *   <script src="./app.js"></script>
 *
 *   // app.js
 *   setInterval(() => {
 *     document.getElementById('clock').innerHTML = new Date().toLocaleTimeString();
 *   }, 1000);
 *
 * The `<div id="clock">` is mutated every second by `app.js`, but it has
 * no `aria-live`, no `role="status"`/`role="alert"`/`role="log"`, and
 * isn't an `<output>`. Sighted users see the clock update; screen-reader
 * users hear nothing — the SC 4.1.3 failure this rule targets.
 *
 * Detection strategy:
 *
 *   1. Walk every scanned `.js` / `.ts` / `.jsx` / `.tsx` source string
 *      for the JS-side trigger pattern: a `document.getElementById('X')`
 *      reference whose `.innerHTML = …` / `.textContent = …` /
 *      `.innerText = …` assignment sits inside a recurring scheduler
 *      (`setInterval(...)`) or any event-handler / timer callback. The
 *      detector lives in `live-region-missing-on-innerhtml-target-js-targets.ts`
 *      so the host rule stays under the file-budget cap; see that
 *      module for the trace strategy.
 *
 *   2. For each captured target ID, walk every scanned `.html` / `.htm`
 *      file for `<el id="X">`. If the host element lacks the live-region
 *      declarations (`aria-live`, `role="status"`, `role="alert"`,
 *      `role="log"`, `role="marquee"`, `role="timer"`, or the host tag
 *      is `<output>`) AND no ancestor in the same document carries one,
 *      emit a finding at the HTML element's location.
 *
 * The emission lives at the HTML element because that's the file the
 * agent edits to fix it (add `aria-live="polite"` to the `<div>`). The
 * suggestion text names the JS site so the agent can verify the JS is
 * actually mutating the right thing — surface, point at both files, let
 * the agent investigate.
 *
 * crossFileCapable: false — though this rule's `afterProject` lifecycle
 * walks both halves when both are present in `ctx.files`, the rule's
 * evidence model is structurally cross-file (HTML host element +
 * sibling JS mutation site). Single-file substrates — `scan_file` on the
 * HTML alone, or on the JS alone — render the rule unable to fire even
 * when both halves exist on disk. Per
 * docs/kb/architecture/ai-first-consumer.md "Reason-token suffixes must
 * name the actual predicate": the rule's design does not attempt
 * cross-file innerHTML target resolution outside the scoped file set
 * the scanner happens to surface, so the limitation is named
 * `_not_attempted_by_rule` (not `_limited_on_this_input`, which would
 * imply a different input would resolve the limitation when in fact
 * the rule structurally never resolves the JS half from an HTML-only
 * scan, or the HTML half from a JS-only scan).
 *
 * Per-finding confidence: `"medium"` with `couldBeWrongBecause:
 * ["cross_file_innerhtml_target_resolution_not_attempted_by_rule"]`.
 * Even with both halves of the pair in scope, the static-analysis
 * trace can be misled by reassignment of the captured variable,
 * conditional execution paths, or framework lifecycle (the timer
 * might be cleared before the user sees an update). The `medium`
 * label matches the predicate strength the rule can honestly express,
 * and the `_not_attempted_by_rule` reason mirrors the per-rule
 * `coverageConfidence: "medium"` the engine records via
 * `CROSS_FILE_BOUND_REASONS` for this rule.
 *
 * Severity: `warning`. The conceded uncertainty in the suggestion text
 * ("verify the JS at <site> actually mutates this element at runtime")
 * is incompatible with `error` per docs/kb/architecture/ai-first-consumer.md
 * "Reason text and severity must agree."
 *
 * Out of scope (deliberate):
 *   - React/Vue/Angular component-state updates that re-render content.
 *     React's reconciler is not `innerHTML =`; the equivalent SC 4.1.3
 *     concerns there belong to a different finder/rule (live regions on
 *     state-driven status text). This rule targets the vanilla-JS DOM-
 *     mutation idiom that frameworks abstract away.
 *   - Selectors other than `getElementById`. `querySelector('#X')` and
 *     `getElementsByClassName(...)` resolve at runtime against arbitrary
 *     CSS selectors; static analysis cannot reliably tie the call back
 *     to a single HTML element. ID-keyed resolution is the deterministic
 *     subset.
 *   - Append-only mutations via `appendChild` /
 *     `insertAdjacentHTML('beforeend', …)` — content-injection idioms
 *     that may or may not be status messages depending on what's
 *     injected.
 */

import { defineRule } from "../../api/plugin.ts";
import { getHtmlAttribute, hasHtmlAttribute } from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";
import type { Language, ProjectRuleFile } from "../../types/rule.ts";
import { findInnerHtmlAssignmentSites } from "./live-region-missing-on-innerhtml-target-js-targets.ts";

/**
 * Structured `couldBeWrongBecause` code. Suffix `_not_attempted_by_rule`
 * is correct here per docs/kb/architecture/ai-first-consumer.md
 * "Reason-token suffixes must name the actual predicate": the rule's
 * design does not attempt cross-file innerHTML target resolution beyond
 * the scoped file set the scanner surfaces. On `scan_file` (HTML or JS
 * alone), the rule cannot resolve the other half of the pair, and the
 * earlier `_limited_on_this_input` framing read as "we tried this input
 * and were limited" — agents could mis-interpret as "maybe a different
 * input would resolve it" and waste a re-scan. The `_not_attempted_by_rule`
 * suffix names the permanent rule-design limitation honestly.
 *
 * The code value here intentionally matches the per-rule reason in
 * `src/engine/per-rule-coverage.ts` `CROSS_FILE_BOUND_REASONS` for
 * `aria/live-region-missing-on-innerhtml-target`. The MCP per-finding
 * propagation helper (`src/mcp/per-finding-confidence-parity.ts`) uses
 * the per-rule reason for findings on degraded rules; matching the
 * value here means the propagation helper's dedup gate
 * (`existing?.includes(code)`) collapses the two paths to a single
 * code rather than shipping two contradictory variants on the same
 * finding.
 */
const CROSS_FILE_INNERHTML_TARGET_RESOLUTION_NOT_ATTEMPTED =
  "cross_file_innerhtml_target_resolution_not_attempted_by_rule";

/**
 * Roles that declare a live region per WAI-ARIA 1.2 §5.3.5. Either the
 * role attribute carrying one of these values, or an explicit
 * `aria-live` of any non-empty value, satisfies the SC 4.1.3 declaration
 * for a status-message host.
 */
const LIVE_REGION_ROLES: ReadonlySet<string> = new Set([
  "alert",
  "status",
  "log",
  "marquee",
  "timer",
]);

/** Tags whose definition is implicitly a live region per HTML semantics. */
const IMPLICIT_LIVE_REGION_TAGS: ReadonlySet<string> = new Set(["output"]);

/** Languages whose source we scan for the JS-side trigger pattern. */
const JS_LIKE_LANGUAGES: ReadonlySet<Language> = new Set<Language>(["js", "ts", "jsx", "tsx"]);

export const rule = defineRule({
  id: "aria/live-region-missing-on-innerhtml-target",
  satisfies: ["wcag22:4.1.3", "wcag21:4.1.3"],
  severity: "warning",
  scope: "project",
  fixClass: "verify-in-source",
  // crossFileCapable: false. Although `afterProject` walks both halves
  // when both are present in `ctx.files`, single-file substrates
  // (`scan_file` on the HTML alone, or the JS alone) leave the rule
  // structurally unable to fire — silent-miss when the rule reports
  // `coverageConfidence: "high"` on a half-input scan. Per ADR 0026
  // and docs/kb/architecture/ai-first-consumer.md "Per-finding
  // confidence must reflect per-rule coverage limitations", declaring
  // `crossFileCapable: false` routes the per-rule coverage row to
  // `coverageConfidence: "medium"` with reason
  // `cross_file_innerhtml_target_resolution_not_attempted_by_rule`,
  // honestly naming the bound the rule's design carries. Per-finding
  // `confidence: "medium"` mirrors the per-rule degradation on every
  // emission, with the same structured reason in
  // `couldBeWrongBecause`.
  crossFileCapable: false,
  appliesTo: {
    // The rule walks both halves; the engine's eligibility gate is
    // satisfied when either extension is present. We list every JS-like
    // and HTML extension so per-rule coverage telemetry credits both
    // file kinds correctly.
    fileExtensions: [".html", ".htm", ".tsx", ".jsx", ".ts", ".js"],
  },
  docs: {
    description:
      "Elements whose innerHTML/textContent is rewritten by recurring schedulers or event handlers must declare a live region (aria-live, role=status, role=alert, role=log, or <output>) so screen-reader users hear the update.",
    rationale:
      "When a vanilla-JS app calls `document.getElementById('X').innerHTML = …` inside a `setInterval` or event handler, the element's content changes at runtime and sighted users see the update. Without `aria-live` or a live-region role on the host, screen-reader users are never told the content changed — the SC 4.1.3 failure this rule targets. Emitting at the HTML element (rather than the JS site) points the agent at the file they edit to fix it; the suggestion names the JS site so the agent can verify the trace before adding the attribute.",
    goodExample: `<!-- index.html -->\n<div id="clock" aria-live="polite"></div>\n<script src="./app.js"></script>\n\n// app.js\nsetInterval(() => {\n  document.getElementById('clock').innerHTML = new Date().toLocaleTimeString();\n}, 1000);`,
    badExample: `<!-- index.html -->\n<div id="clock"></div>\n<script src="./app.js"></script>\n\n// app.js\nsetInterval(() => {\n  document.getElementById('clock').innerHTML = new Date().toLocaleTimeString();\n}, 1000);`,
    normativeQuote:
      "In content implemented using markup languages, status messages can be programmatically determined through role or properties such that they can be presented to the user by assistive technologies without receiving focus.",
    references: [
      "https://www.w3.org/TR/WCAG22/#status-messages",
      "https://www.w3.org/TR/wai-aria-1.2/#aria-live",
      "https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA22",
      "https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA19",
    ],
    knownLimitations: [
      "Only `getElementById('X')` selectors are resolved. Other DOM-query patterns (`querySelector`, `getElementsByClassName`, `getElementsByTagName`) resolve at runtime against arbitrary CSS selectors and are out of scope.",
      "React/Vue/Angular component-state updates that re-render content are out of scope — those frameworks abstract `innerHTML` away. This rule targets the vanilla-JS DOM-mutation idiom.",
      'When the JS half of the pair references an ID for which no scanned HTML carries `<el id="X">`, no finding is emitted — the rule has nowhere to point. Confidence on the matched cases is the only confidence the rule can express.',
    ],
  },
  afterProject(ctx) {
    const targets = collectMutatedTargetIds(ctx.files);
    // Cross-file-candidate signal: any JS innerHTML/textContent/innerText
    // mutation site is a token whose host element may live in a sibling
    // HTML file — `scan_file` on the JS alone cannot verify the host. Any
    // id-bearing HTML element is the symmetric token: its mutating JS may
    // live in a sibling file. Either presence flips the per-rule
    // coverage downgrade gate (the engine collapses the count to ≥1 vs 0
    // at consumption time, so a single bump per kind is sufficient). When
    // neither half is observed, the rule had nothing cross-file to miss
    // and `coverageConfidence: "high"` is honest. See the per-rule
    // coverage logic in `src/engine/per-rule-coverage.ts`
    // `buildExtensionGatedEntry`.
    if (targets.size > 0) ctx.markCrossFileCandidate?.();
    if (targets.size === 0) {
      if (anyHtmlIdBearingElement(ctx.files)) ctx.markCrossFileCandidate?.();
      return;
    }
    for (const file of ctx.files) {
      if (file.language !== "html") continue;
      checkHtmlForUnannouncedTargets(file, targets, (v) => ctx.emit(v));
    }
  },
});

/**
 * Returns `true` when at least one scanned HTML file contains an element
 * with an `id` attribute. Used by the `afterProject` hook as the
 * candidate-token gate when no JS-side mutation sites were observed —
 * an HTML-only `scan_file` over a page declaring `<div id="status">`
 * still has a cross-file question (a sibling JS may mutate `#status`),
 * and reporting `coverageConfidence: "high"` on that substrate would
 * silently mis-state the evidence the rule had access to.
 */
function anyHtmlIdBearingElement(files: ReadonlyArray<ProjectRuleFile>): boolean {
  for (const file of files) {
    if (file.language !== "html") continue;
    if (htmlHasIdBearingElement(file.ast as HtmlDocument)) return true;
  }
  return false;
}

function htmlHasIdBearingElement(doc: HtmlDocument): boolean {
  let found = false;
  visitHtmlNodes(doc.children, false, (el) => {
    if (found) return;
    if (getHtmlAttribute(el, "id") !== null) found = true;
  });
  return found;
}

interface MutationSite {
  /** Source-file path of the JS site driving this mutation. */
  readonly filePath: string;
  /** Line of the `.innerHTML = …` assignment. */
  readonly line: number;
  /** Column of the `.innerHTML = …` assignment. */
  readonly column: number;
  /** Which property was assigned to. */
  readonly property: "innerHTML" | "textContent" | "innerText";
}

/**
 * Scans every JS-like file in the project for the trigger pattern and
 * returns the map `id → readonly MutationSite[]`. Multiple sites per ID
 * are kept (the suggestion lists them) so the agent sees every place
 * the host is being rewritten.
 */
function collectMutatedTargetIds(
  files: ReadonlyArray<ProjectRuleFile>,
): ReadonlyMap<string, readonly MutationSite[]> {
  const out = new Map<string, MutationSite[]>();
  for (const file of files) {
    if (!JS_LIKE_LANGUAGES.has(file.language)) continue;
    for (const site of findInnerHtmlAssignmentSites(file)) {
      const list = out.get(site.id) ?? [];
      list.push({
        filePath: file.filePath,
        line: site.line,
        column: site.column,
        property: site.property,
      });
      out.set(site.id, list);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML half — consume the JS-side targets and emit at the host element.
// ---------------------------------------------------------------------------

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  confidence?: "high" | "medium" | "low";
  couldBeWrongBecause?: readonly string[];
}) => void;

function checkHtmlForUnannouncedTargets(
  file: ProjectRuleFile,
  targets: ReadonlyMap<string, readonly MutationSite[]>,
  emit: Emit,
): void {
  const doc = file.ast as HtmlDocument;
  // A descendant of a live-region host inherits the announcement, so a
  // `<div role="status"><span id="time"></span></div>` should NOT flag
  // the inner `<span>` even when it's the JS target. Walking top-down
  // with a live-ancestor flag avoids needing parent pointers on the
  // HTML AST (which the parser does not expose).
  visitHtmlNodes(doc.children, false, (el, hasLiveAncestor) => {
    const id = getHtmlAttribute(el, "id");
    if (id === null) return;
    const sites = targets.get(id);
    if (sites === undefined) return;
    if (isLiveRegionElement(el)) return;
    if (hasLiveAncestor) return;
    emit(buildHtmlFinding(file.filePath, el, id, sites));
  });
}

/**
 * Pre-order DFS walk over HTML element children that propagates a
 * "live-region ancestor in scope" flag down the tree. The flag flips on
 * when descending through a live-region host so its descendants — which
 * inherit the announcement at the AT layer — are not flagged even when
 * they carry the JS target ID.
 */
function visitHtmlNodes(
  nodes: readonly { kind: string }[],
  hasLiveAncestor: boolean,
  visit: (el: HtmlElement, hasLiveAncestor: boolean) => void,
): void {
  for (const node of nodes) {
    if (node.kind !== "HtmlElement") continue;
    const el = node as HtmlElement;
    visit(el, hasLiveAncestor);
    const childAncestor = hasLiveAncestor || isLiveRegionElement(el);
    visitHtmlNodes(el.children, childAncestor, visit);
  }
}

function isLiveRegionElement(el: HtmlElement): boolean {
  if (IMPLICIT_LIVE_REGION_TAGS.has(el.tagName.toLowerCase())) return true;
  if (hasHtmlAttribute(el, "aria-live")) {
    const value = getHtmlAttribute(el, "aria-live");
    if (value !== null && value.trim() !== "") return true;
  }
  const role = getHtmlAttribute(el, "role");
  if (role === null) return false;
  for (const token of role.split(/\s+/u).filter(Boolean)) {
    if (LIVE_REGION_ROLES.has(token.toLowerCase())) return true;
  }
  return false;
}

function buildHtmlFinding(
  filePath: string,
  el: HtmlElement,
  id: string,
  sites: readonly MutationSite[],
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  confidence: "medium";
  couldBeWrongBecause: readonly string[];
} {
  const sample = sites[0];
  const sampleLabel =
    sample === undefined
      ? ""
      : ` (e.g. ${sample.filePath}:${sample.line} sets .${sample.property})`;
  const total = sites.length;
  const moreClause = total > 1 ? ` plus ${total - 1} other site${total === 2 ? "" : "s"}` : "";
  return {
    severity: "warning",
    location: { filePath, line: el.loc.start.line, column: el.loc.start.column },
    message: `<${el.tagName} id="${id}"> is rewritten by recurring JS (.innerHTML / .textContent assignment inside a callback)${sampleLabel}${moreClause}, but the host has no aria-live, no role="status"/"alert"/"log", and isn't an <output> — screen-reader users won't hear the update.`,
    suggestion: buildHtmlSuggestion(id, sites),
    confidence: "medium",
    couldBeWrongBecause: [CROSS_FILE_INNERHTML_TARGET_RESOLUTION_NOT_ATTEMPTED],
  };
}

function buildHtmlSuggestion(id: string, sites: readonly MutationSite[]): string {
  const siteList = sites
    .slice(0, 3)
    .map((s) => `${s.filePath}:${s.line} (.${s.property})`)
    .join(", ");
  const moreNote = sites.length > 3 ? `, plus ${sites.length - 3} more` : "";
  return (
    `Add aria-live to <#${id}>: \`aria-live="polite"\` for routine updates (clock ticks, "Saved." toasts), or \`aria-live="assertive"\` for time-critical alerts (errors, expiring sessions). ` +
    `Equivalent shapes: \`role="status"\` (implicitly polite), \`role="alert"\` (implicitly assertive), or replace the wrapper with \`<output>\` if the content is the result of a calculation. ` +
    `Verify the JS at ${siteList}${moreNote} before treating this as live — the rule resolves \`document.getElementById('${id}')\` to this element by ID match, but reassignment of the captured variable or conditional execution paths can mislead the trace.`
  );
}
