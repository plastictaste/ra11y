/**
 * Rule: forms/multiple-label-for-same-id
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available
 * > in text.
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * Flags two-or-more `<label for="X">` elements that reference the
 * same `id="X"` in the same document.
 *
 * Why this is a labeling problem (not just a style choice):
 *
 *   - The HTML spec ties one input to ONE labeled-by relationship via
 *     `for`. When N labels point at the same id, the `labels` IDL
 *     attribute on the form control returns all of them, but the
 *     accessible-name computation (HTML-AAM §5.4) walks the references
 *     and concatenates — and screen readers vary in how they surface
 *     the concatenation. NVDA/JAWS often announce only the first;
 *     VoiceOver may concatenate without a separator; Narrator may pick
 *     the lexically-first. The result is per-AT inconsistent labeling
 *     against an authored intent the parser can't see.
 *
 *   - When one of the duplicates is a visually-hidden duplicate of a
 *     visible label (a common copy-paste in forms that supply both
 *     screen-reader and visible captions), the user hears the same
 *     phrase twice or sees the screen-reader text leak into the
 *     accessible name unintentionally.
 *
 *   - Click-to-focus still works (clicking ANY of the labels focuses
 *     the input) — so the failure mode is silent for sighted users
 *     and only manifests in AT output.
 *
 * Implementation notes:
 *
 *   1. Document-scoped (`afterFile`). We need every `<label for>` in
 *      the file to compute the multi-reference grouping; per-node
 *      can't see the duplicates.
 *
 *   2. We require the target id to actually resolve in the document.
 *      If the `for` is dangling, that's `forms/label-for-id-mismatch`'s
 *      job — emitting both rules on the same label would be noise. A
 *      group of N labels all pointing at a non-existent id surfaces
 *      via the dangling-id rule N times; this rule stays quiet.
 *
 *   3. Group fires once per (file, target-id) — emit on the second-
 *      and-later label nodes, not on the first. The first label is
 *      the one most ATs honor; the remaining are the duplicates the
 *      author should reconcile. Each emission carries the line of the
 *      first label so the agent has the full pair in one finding.
 *
 *   4. JSX uses `htmlFor` (React's rename of `for`). Both spellings
 *      are accepted, mirroring `forms/label-for-id-mismatch`.
 *
 *   5. Severity is `warning`: the input still has *some* label, so
 *      the criterion isn't fully unsatisfied — but the labeling is
 *      inconsistent across ATs and the agent should investigate the
 *      duplication intent (kill one? merge them? promote one to
 *      `aria-describedby`?).
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
  truncateForEcho,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

export const rule = defineRule({
  id: "forms/multiple-label-for-same-id",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:4.1.2", "wcag21:4.1.2"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Two or more <label for='X'> elements pointing at the same id produce inconsistent labeling — assistive tech may concatenate, announce only the first, or vary by engine.",
    rationale:
      "When multiple `<label for='X'>` elements reference the same input id, the form control's `labels` IDL collection returns all of them and the HTML-AAM accessible-name computation walks the references in source order. Screen readers handle the concatenation differently — NVDA/JAWS often announce only the first label, VoiceOver may concatenate without a separator, Narrator may pick the lexically-first — so the user-perceived label varies by AT against an authored intent the parser can't infer. The common shape is a copy-paste of a visible label and a visually-hidden screen-reader-only label both pointing at the same id; reconciling to one explicit association (or routing the secondary text through `aria-describedby`) is the durable fix.",
    goodExample: `<label for="email">Email address</label>\n<input id="email" type="email">`,
    badExample: `<label for="email">Email</label>\n<label for="email" class="sr-only">Email address</label>\n<input id="email" type="email">`,
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/TR/html-aam-1.0/#input-text-and-other-input-types-text-search-tel-url-email-and-password-accessible-name-computation",
      "https://html.spec.whatwg.org/multipage/forms.html#the-label-element",
    ],
  },
  afterFile(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
      return;
    }
    if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkJsx(ctx.ast as TsxModule, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

// ---------------------------------------------------------------------------
// Generic grouping + emission (shared by HTML and JSX branches)
// ---------------------------------------------------------------------------

/**
 * `<label>` accessor pack the generic core uses. Each branch supplies
 * one — the core stays language-agnostic and never touches an HTML- or
 * JSX-specific node API directly.
 */
interface LabelAccessor<E extends { readonly loc: HtmlElement["loc"] }> {
  readonly forValue: (label: E) => string | null;
  readonly directText: (label: E) => string;
}

function groupLabelsByTarget<E extends { readonly loc: HtmlElement["loc"] }>(
  labels: readonly E[],
  ids: ReadonlySet<string>,
  accessor: LabelAccessor<E>,
): Map<string, E[]> {
  const byTarget = new Map<string, E[]>();
  for (const label of labels) {
    const target = accessor.forValue(label);
    // Skip blanks and dangling references — that's
    // `forms/label-for-id-mismatch`'s surface. Reporting both on the
    // same label is double-counting.
    if (target === null || target.length === 0) continue;
    if (!ids.has(target)) continue;
    const list = byTarget.get(target);
    if (list === undefined) byTarget.set(target, [label]);
    else list.push(label);
  }
  return byTarget;
}

function emitDuplicateGroups<E extends { readonly loc: HtmlElement["loc"] }>(
  byTarget: ReadonlyMap<string, readonly E[]>,
  accessor: LabelAccessor<E>,
  emit: Emit,
): void {
  for (const [target, group] of byTarget) {
    if (group.length < 2) continue;
    const first = group[0];
    if (first === undefined) continue;
    for (let i = 1; i < group.length; i += 1) {
      const dup = group[i];
      if (dup !== undefined) emitOneDuplicate(target, first, dup, accessor, emit);
    }
  }
}

function emitOneDuplicate<E extends { readonly loc: HtmlElement["loc"] }>(
  target: string,
  first: E,
  dup: E,
  accessor: LabelAccessor<E>,
  emit: Emit,
): void {
  emit({
    severity: "warning",
    location: {
      filePath: "",
      line: dup.loc.start.line,
      column: dup.loc.start.column,
    },
    message: buildMessage(target, first.loc.start.line, dup.loc.start.line),
    suggestion: buildSuggestion(
      target,
      first.loc.start.line,
      accessor.directText(first),
      accessor.directText(dup),
    ),
  });
}

// ---------------------------------------------------------------------------
// HTML branch
// ---------------------------------------------------------------------------

const htmlAccessor: LabelAccessor<HtmlElement> = {
  forValue: (label) => getHtmlAttribute(label, "for"),
  directText: htmlLabelText,
};

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const ids = collectHtmlIds(doc);
  const byTarget = groupLabelsByTarget(findHtmlElementsByTag(doc, "label"), ids, htmlAccessor);
  emitDuplicateGroups(byTarget, htmlAccessor, emit);
}

function collectHtmlIds(doc: HtmlDocument): Set<string> {
  const ids = new Set<string>();
  for (const el of walkHtmlElements(doc)) {
    const id = getHtmlAttribute(el, "id");
    if (id !== null && id.length > 0) ids.add(id);
  }
  return ids;
}

function htmlLabelText(label: HtmlElement): string {
  // Concatenate direct text-node children only — descendant text is
  // usually icons or hidden copy and would muddy the echo. We just need
  // a hint the agent can recognize when reading the file.
  const parts: string[] = [];
  for (const child of label.children) {
    if (child.kind === "HtmlText") parts.push(child.value);
  }
  return parts.join("").trim().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// JSX branch
// ---------------------------------------------------------------------------

const jsxAccessor: LabelAccessor<JsxElement> = {
  forValue: getJsxLabelFor,
  directText: jsxLabelText,
};

function checkJsx(module: TsxModule, emit: Emit): void {
  const ids = collectJsxIds(module);
  const byTarget = groupLabelsByTarget(findJsxElementsByTag(module, "label"), ids, jsxAccessor);
  emitDuplicateGroups(byTarget, jsxAccessor, emit);
}

/** React uses `htmlFor`; authors sometimes still write `for`. Accept both. */
function getJsxLabelFor(label: JsxElement): string | null {
  return getJsxAttributeString(label, "htmlFor") ?? getJsxAttributeString(label, "for");
}

function collectJsxIds(module: TsxModule): Set<string> {
  const ids = new Set<string>();
  for (const el of walkJsxElements(module)) {
    const id = getJsxAttributeString(el, "id");
    if (id !== null && id.length > 0) ids.add(id);
  }
  return ids;
}

function jsxLabelText(label: JsxElement): string {
  const parts: string[] = [];
  for (const child of label.children) {
    if (child.kind === "JsxText") parts.push(child.value);
  }
  return parts.join("").trim().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function buildMessage(target: string, firstLine: number, dupLine: number): string {
  const echoTarget = truncateForEcho(target);
  return `<label for="${echoTarget}"> at line ${dupLine} duplicates the for-target of an earlier <label for="${echoTarget}"> at line ${firstLine} — assistive tech may concatenate, announce only the first, or vary by engine.`;
}

function buildSuggestion(
  target: string,
  firstLine: number,
  firstText: string,
  dupText: string,
): string {
  const echoTarget = truncateForEcho(target);
  const firstHint = firstText.length > 0 ? truncateForEcho(firstText, 80) : "<no direct text>";
  const dupHint = dupText.length > 0 ? truncateForEcho(dupText, 80) : "<no direct text>";
  return (
    `Two <label for="${echoTarget}"> elements target the same input — the first at line ${firstLine}` +
    ` ("${firstHint}") and this one ("${dupHint}"). Resolve to ONE explicit association so the` +
    ` accessible name is deterministic across ATs:` +
    ` (a) merge the copy into one <label> and delete this duplicate,` +
    ` (b) keep one as the <label> and move the other text to aria-describedby="${echoTarget}-hint"` +
    ` on the input (with a sibling element carrying that id), or` +
    ` (c) if the second label intentionally annotates a *different* control, change its for=` +
    ` to point at that control's id (and give the control that id if it doesn't have one).`
  );
}
