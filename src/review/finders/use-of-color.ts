/**
 * Candidate finder: review/use-of-color
 * Criteria: wcag22:1.4.1, wcag21:1.4.1, section508:1194.22.c, en301549:9.1.4.1
 * Spec: https://www.w3.org/TR/WCAG22/#use-of-color
 *
 * Flags JSX/HTML elements whose className signals status purely through
 * color (red/green/amber/success/danger/warning) and that have no
 * sibling icon, no text child with a status word, and no aria-label.
 * A human reviewer must confirm a non-color signal is present.
 *
 * Review finder — biased toward false positives. The output is a
 * checklist of places to verify, not a list of failures.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlAttribute,
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxAttribute,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = [
  "wcag22:1.4.1",
  "wcag21:1.4.1",
  "section508:1194.22.c",
  "en301549:9.1.4.1",
] as const;

/**
 * Tailwind-ish color utility names commonly used to convey status.
 * Matches `{prefix}-{hue}-{shade}` and a few semantic keywords.
 * Case-insensitive; tested against the className string.
 */
const STATUS_COLOR_CLASS =
  /\b(?:bg|text|border|ring|fill|stroke)-(?:red|rose|green|emerald|lime|yellow|amber|orange|success|danger|warning|error|destructive)(?:-\d{2,3})?\b/i;

/**
 * Status words that, if present in visible text or aria-label, signal a
 * non-color-only treatment. If any of these appear in the element's
 * text content or label, the color likely isn't the sole indicator.
 */
const STATUS_WORD_TEXT =
  /\b(error|errors|warning|warnings|success|successful|failed|failure|passed|invalid|valid|required|danger|alert|critical|complete|incomplete|pending|approved|rejected)\b/i;

/** JSX components conventionally rendering an icon or glyph. */
const ICON_COMPONENT_TAG = /^(?:[A-Z]\w*)?(?:Icon|Glyph|Symbol|Svg|Image)$/;

/**
 * Conventional shape-signal glyphs that convey meaning by shape alone —
 * a G182 "additional visual cue" for sighted users without color
 * perception. Geometric-only shapes (●, ■, ▲ etc.) are deliberately
 * excluded: a colorblind user sees a gray dot and learns nothing from
 * the shape, so those still need review. Keep this list conservative —
 * over-including weakens F81 recall.
 */
const SHAPE_SIGNAL_GLYPH = /^(?:\*|\?|✓|✔|✗|✘|✖|×|⚠|→|←|↑|↓)$/;

/**
 * Tags whose contents are not visible to the user. When walking an
 * element body to compute "visible text," skip into these subtrees so
 * `<p class="text-danger"><script>alert(1)</script></p>` is treated as
 * empty (script body is not a status indicator the user can perceive).
 */
const NON_VISIBLE_TAGS = new Set(["script", "style", "noscript", "template"]);

/**
 * Approximate cap on text echoed into the `reason` string. The full
 * snippet lives at the file:line citation; the reason just needs enough
 * to orient the agent. Matches `truncateForEcho`'s default budget.
 */
const REASON_TEXT_BUDGET = 60;

export const finder = defineCandidateFinder({
  id: "review/use-of-color",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds elements whose className uses a status color (red/green/warning/danger) without an adjacent icon or status word, which may convey meaning by color alone.",
    reviewPrompt:
      "Verify that the color on this element is not the only cue. A sighted user without color perception must still be able to tell the state — look for an icon, a text label, or aria-label that duplicates the signal.",
    references: ["https://www.w3.org/TR/WCAG22/#use-of-color", "https://www.access-board.gov/ict/"],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    if (ctx.language === "html")
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, candidates);
    else if (ctx.language === "tsx" || ctx.language === "jsx")
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, candidates);
    return candidates;
  },
});

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  for (const el of walkHtmlElements(root)) {
    const className = getHtmlClass(el);
    const matched = className ? STATUS_COLOR_CLASS.exec(className)?.[0] : undefined;
    if (!matched) continue;
    if (htmlElementHasNonColorSignal(el)) continue;
    const visibleText = visibleHtmlText(el);
    // Empty body, no presentational child, no other non-color signal —
    // color cannot be the sole indicator of *nothing*. Drop the
    // candidate per.4.1-COLOR-EMPTY-BODY-FALSE-POSITIVE
    // (validation-message placeholder pattern: <p class="help-block
    // text-danger"></p>). The earlier non-color-signal check has
    // already cleared elements with <svg>/<img>/<i> children, so an
    // element reaching here with no visible text is genuinely empty.
    if (visibleText.length === 0) continue;
    emit(filePath, el.loc.start, matched, visibleText, candidates);
  }
}

function findJsxCandidates(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  for (const el of walkJsxElements(root)) {
    const className = getJsxAttributeString(el, "className");
    const matched = className ? STATUS_COLOR_CLASS.exec(className)?.[0] : undefined;
    if (!matched) continue;
    if (jsxElementHasNonColorSignal(el)) continue;
    const visibleText = visibleJsxText(el);
    if (visibleText.length === 0) continue;
    emit(filePath, el.loc.start, matched, visibleText, candidates);
  }
}

function getHtmlClass(el: HtmlElement): string | null {
  for (const attr of el.attributes) {
    if (attr.name.toLowerCase() === "class") return attr.value ?? "";
  }
  return null;
}

/**
 * Deterministic non-color-signal evidence: the agent does not need to
 * re-read the file to know an `aria-label`, `title`, recognized shape
 * glyph, or icon-sibling is present. These suppressions are anchored on
 * provable evidence the static parser already has, so the AI-first rule
 * "labeled buckets must be provable from the code" is satisfied.
 *
 * Status-word text containment is deliberately NOT in this set: it is
 * weaker evidence (the prose word may appear coincidentally — "the
 * success of the mission depended on…" inside a `text-success` element
 * — and the static parser cannot tell coincidence from intent). On the
 * rule surface (`color/meaning-by-color-only`) the rule suppresses
 * emission on this branch because a rule emits at `error` severity and
 * the AI-first doctrine "reason text and severity must agree" forbids
 * a contradicting reason; the finder surface is review candidates
 * whose framing is "please verify," so the doctrine direction is
 * inverted: surface the candidate and enrich the reason with the
 * textContent-containment evidence so the agent dismisses with one
 * read, instead of dropping the candidate and risking a silent miss.
 */
function htmlElementHasNonColorSignal(el: HtmlElement): boolean {
  if (hasHtmlAttribute(el, "aria-label")) return true;
  if (hasHtmlAttribute(el, "title")) return true;
  const text = visibleHtmlText(el);
  if (text && SHAPE_SIGNAL_GLYPH.test(text.trim())) return true;
  for (const child of el.children) {
    if (child.kind === "HtmlElement") {
      const tag = child.tagName.toLowerCase();
      if (tag === "svg" || tag === "img" || tag === "i") return true;
    }
  }
  return false;
}

function jsxElementHasNonColorSignal(el: JsxElement): boolean {
  if (hasJsxAttribute(el, "aria-label")) return true;
  if (hasJsxAttribute(el, "title")) return true;
  const text = visibleJsxText(el);
  if (text && SHAPE_SIGNAL_GLYPH.test(text.trim())) return true;
  for (const child of el.children) {
    if (child.kind === "JsxElement" && ICON_COMPONENT_TAG.test(child.tagName)) return true;
  }
  return false;
}

/**
 * Concatenated visible text in an HTML element body, recursing into
 * descendants. Skips entire subtrees that are not user-perceivable:
 * <script>, <style>, <noscript>, <template>, and any element with
 * `aria-hidden="true"`. Returns the trimmed concatenation.
 *
 * This is the body-content gate driving.4.1-COLOR-EMPTY-
 * BODY-FALSE-POSITIVE (zero-length body must not fire) and the body-
 * read input to the reason text per.4.1-COLOR-READ-
 * ELEMENT-BODY (reason mentions the actual visible text).
 */
function visibleHtmlText(element: HtmlElement): string {
  const chunks: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind === "HtmlText") {
      chunks.push(node.value);
      return;
    }
    if (node.kind !== "HtmlElement") return;
    if (NON_VISIBLE_TAGS.has(node.tagName.toLowerCase())) return;
    if (htmlAttributeEquals(node.attributes, "aria-hidden", "true")) return;
    for (const c of node.children) visit(c);
  };
  for (const child of element.children) visit(child);
  return chunks.join("").trim();
}

/**
 * Concatenated visible text in a JSX element body, recursing into
 * descendants. Skips elements with `aria-hidden="true"` (string-literal
 * form). Treats `JsxExpression` children as visible-content sentinels
 * — the runtime value of `{label}` is text we can't read statically,
 * so we substitute the raw expression so the reason text and the
 * non-empty-body gate both see *something*. Without this, the very
 * common `<small className="text-success">{version}</small>` pattern
 * would be silently dropped as if it were an empty placeholder.
 */
function visibleJsxText(element: JsxElement): string {
  const chunks: string[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind === "JsxText") {
      chunks.push(node.value);
      return;
    }
    if (node.kind === "JsxExpression") {
      // Use the raw expression as a content placeholder so the body
      // is treated as non-empty. Wrapping in braces preserves the
      // hint that this is an interpolation, not literal source text.
      chunks.push(`{${node.raw}}`);
      return;
    }
    if (node.kind !== "JsxElement") return;
    if (jsxAttributeEquals(node.attributes, "aria-hidden", "true")) return;
    for (const c of node.children) visit(c);
  };
  for (const child of element.children) visit(child);
  return chunks.join("").trim();
}

function htmlAttributeEquals(
  attrs: readonly HtmlAttribute[],
  name: string,
  value: string,
): boolean {
  const lname = name.toLowerCase();
  for (const attr of attrs) {
    if (attr.name.toLowerCase() === lname) return (attr.value ?? "") === value;
  }
  return false;
}

function jsxAttributeEquals(attrs: readonly JsxAttribute[], name: string, value: string): boolean {
  for (const attr of attrs) {
    if (attr.name !== name) continue;
    const v = attr.value;
    if (v && v.kind === "StringLiteral") return v.value === value;
    return false;
  }
  return false;
}

function emit(
  filePath: string,
  loc: { line: number; column: number },
  matched: string,
  visibleText: string,
  candidates: ReviewCandidate[],
): void {
  // The element has already been filtered for aria-label, title,
  // shape-signal glyph, icon-sibling, and zero-length body. So at emit
  // time we know there IS visible text in the body. Quote it back so
  // the agent can see what color may be styling without re-reading the
  // file just to triage the candidate.
  //
  // Per.4.1-COLOR-READ-ELEMENT-BODY: the reason text must
  // reflect the actual content, not claim "no visible text."
  const echoed = collapseWhitespace(visibleText);
  const trimmed =
    echoed.length > REASON_TEXT_BUDGET ? `${echoed.slice(0, REASON_TEXT_BUDGET)}…` : echoed;
  // Status-word containment is per-candidate enrichment, not
  // suppression. When the visible text already names a status word
  // (`Error`, `Warning`, `Success`, `Danger`, `Failed`, `Required`…),
  // the prose IS the second channel for users who can read the text —
  // BUT color may still be the sole signal for a screen-reader user
  // hearing the prose without status framing, or for a user under a
  // color-inverted theme. Surface the evidence so the agent dismisses
  // with one read on the common case, and still investigates when the
  // prose framing is too generic ("Failed" alone vs. "Upload failed:
  // network error"). Per AI-first doctrine: finders surface; agents
  // dismiss. The rule-side closure (-
  // CHECK) suppresses on this branch instead, because the rule emits
  // at `error` severity and the doctrine "reason text and severity
  // must agree" forbids a self-contradicting reason; the finder
  // surface is review candidates ("please verify"), so enrichment is
  // the consistent direction.
  const statusWordMatch = STATUS_WORD_TEXT.exec(echoed);
  const enrichment =
    statusWordMatch === null
      ? ""
      : ` -- visible text already carries status word "${statusWordMatch[0]}", so a sighted reader of the prose has the second channel; verify the status is also reachable for screen-reader users (consider role="alert"/role="status" or an sr-only label) and for users under color-inverted themes`;
  const reason = `className uses status color "${matched}" on an element with visible text "${trimmed}" -- color-only indicator check: verify the state is not conveyed by "${matched}" alone; ensure a non-color affordance (icon, label, underline) is present${enrichment}`;
  for (const criterionId of CRITERION_IDS) {
    // Confidence "low": className-regex on status-color utility
    // tokens (red/green/danger/success…) combined with an absence-
    // of-sibling-signal check. An element genuinely communicating
    // only by color matches; so does a styled chip whose context
    // (parent heading, sibling label) carries the real signal. The
    // reviewer decides. Biased toward false positives per docstring.
    candidates.push({
      criterionId,
      location: { filePath, line: loc.line, column: loc.column },
      reason,
      confidence: "low",
    });
  }
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
