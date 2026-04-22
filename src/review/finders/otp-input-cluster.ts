/**
 * Candidate finder: review/otp-input-cluster
 * Criteria: wcag22:1.3.1, wcag21:1.3.1
 *           wcag22:1.3.5, wcag21:1.3.5
 *           wcag22:3.3.2, wcag21:3.3.2
 *
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *       https://www.w3.org/TR/WCAG22/#identify-input-purpose
 *       https://www.w3.org/TR/WCAG22/#labels-or-instructions
 *
 * Surfaces clusters of single-character inputs that share the shape of a
 * one-time-code (OTP) entry — N sibling `<input>` elements limited to one
 * character each (typically `type="number"` or `type="text"` with
 * `maxlength="1"` / `pattern` matching a single digit), grouped under a
 * common parent. Per-input rules (`forms/labels-required`,
 * `forms/non-empty-label`) fire individually on each box, but the cluster
 * itself is the user-facing control: a screen reader hears "edit text, edit
 * text, edit text..." instead of "one-time code, edit text". The fix is
 * almost never per-input — it is a single group label plus
 * `autocomplete="one-time-code"` on at least one box so the OS / browser
 * autofill recognises the field.
 *
 * Detection (intentionally loose — finder, not rule):
 *
 *   1. Walk every parent element with multiple direct child elements.
 *   2. Collect direct-child `<input>` siblings that "look single-character":
 *        - `type="number"` OR `type="text"` (case-insensitive, default
 *          `<input>` type is `text` so omitted-`type` is also accepted)
 *        - AND the input narrows entry to exactly one character via
 *          `maxlength="1"` OR `pattern` containing a single-digit shape
 *          (`\d`, `[0-9]`, `[0-9a-zA-Z]`, etc.).
 *   3. When that count is ≥ 4 within one parent, emit ONE candidate per
 *      cluster, anchored at the FIRST single-char input in the group.
 *
 * Why a cluster, not per-input
 *
 *   `forms/labels-required` + `forms/non-empty-label` already fire per
 *   input — that is fine but mis-shaped: the agent ends up looking at six
 *   findings on the same logical control with the same fix. The cluster
 *   candidate names the pattern once, gives the right fix shape (group
 *   label + autocomplete), and lets the per-input findings stay live as
 *   secondary evidence the agent can read in the same pass.
 *
 * False-positive surface (intentional, agent-resolvable in one read)
 *
 *   - 3-input MM/DD/YY date pickers: don't hit the ≥ 4 threshold by
 *     design.
 *   - 4+ separate single-character inputs that legitimately are not an
 *     OTP (rare; usually puzzle/quiz UIs): the agent reads the parent's
 *     surrounding context and dismisses. The reason text frames the
 *     question — "looks like an OTP cluster, verify whether the
 *     surrounding context confirms" — so dismissal is one read away.
 *
 * Confidence: "medium". The shape predicate is deterministic (siblings,
 * single-character cap), but whether the cluster is an OTP vs. some other
 * single-character grid (puzzle, quiz, captcha-shaped legacy widget) is
 * context the scanner cannot see; the agent reading the parent decides.
 *
 * Per CLAUDE.md §1 / docs/kb/architecture/ai-first-consumer.md: the
 * scanner's job is to point — file, line, pattern — and the agent's job
 * is to investigate. We do not silence per-input findings; we add a
 * cluster-level frame so the right fix shape is visible.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, JsxNode, TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = [
  "wcag22:1.3.1",
  "wcag21:1.3.1",
  "wcag22:1.3.5",
  "wcag21:1.3.5",
  "wcag22:3.3.2",
  "wcag21:3.3.2",
] as const;

/** Minimum number of single-character sibling inputs to flag a cluster. */
const CLUSTER_THRESHOLD = 4;

/**
 * `<input>` types that plausibly hold a single OTP character. `text` is
 * the default when `type` is omitted, so the omitted-attribute branch
 * also matches. Other types (`email`, `url`, `tel`, `password`, etc.) are
 * excluded — they would not narrow to one character even with
 * `maxlength="1"` and would not match the OTP pattern in practice.
 */
const SINGLE_CHAR_INPUT_TYPES: ReadonlySet<string> = new Set(["text", "number"]);

/**
 * Patterns whose match-set is a single character. Authors use varied
 * regex shapes (`\d`, `[0-9]`, `[A-Za-z0-9]`, optional anchors); the
 * predicate accepts any of these as long as the body collapses to one
 * character. Anchors and the pattern delimiters are stripped before the
 * shape check; case-insensitive on alpha character classes.
 */
const SINGLE_CHAR_PATTERN_RES: readonly RegExp[] = [
  /^\\d$/,
  /^\[0-9\]$/,
  /^\[a-z0-9\]$/i,
  /^\[a-zA-Z0-9\]$/,
  /^\[0-9a-zA-Z\]$/,
  /^\.$/,
] as const;

export const finder = defineCandidateFinder({
  id: "review/otp-input-cluster",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      'Finds clusters of ≥4 sibling single-character <input> elements (type="number" / type="text" with maxlength="1" or single-character pattern) under a common parent — the shape of a one-time-code (OTP) entry. Per-input label rules fire on each box; the cluster itself is the missing semantic group.',
    reviewPrompt:
      'At each candidate, confirm the cluster is an OTP / verification-code entry (vs. a puzzle, quiz, or other multi-character grid). If yes, fix the group instead of the per-input findings: add `autocomplete="one-time-code"` to at least one input so OS/browser autofill recognises the field, and provide a single accessible name covering the cluster (`<fieldset><legend>` or a wrapping element with `role="group"` + `aria-labelledby`). The per-input label findings can be resolved by the group label.',
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/TR/WCAG22/#identify-input-purpose",
      "https://www.w3.org/TR/WCAG22/#labels-or-instructions",
      "https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill",
    ],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      scanHtml(ctx.ast as HtmlDocument, ctx.filePath, candidates);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      scanJsx(ctx.ast as TsxModule, ctx.filePath, candidates);
    }
    return candidates;
  },
});

// ---------------------------------------------------------------------------
// HTML branch
// ---------------------------------------------------------------------------

function scanHtml(root: HtmlDocument, filePath: string, candidates: ReviewCandidate[]): void {
  // Top-level children of the document act as a sibling group too — an
  // OTP cluster authored at the document root (uncommon but valid in
  // fragment HTML) should still register.
  inspectHtmlSiblings(root.children, filePath, candidates);
}

function inspectHtmlSiblings(
  children: readonly HtmlDocument["children"][number][],
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  // Per-parent: collect single-char inputs among DIRECT element children,
  // count, emit if threshold met. Then recurse into every element child
  // so deeper parents are inspected too.
  const singleCharInputs: HtmlElement[] = [];
  for (const child of children) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() === "input" && htmlInputLooksSingleChar(child)) {
      singleCharInputs.push(child);
    }
  }
  if (singleCharInputs.length >= CLUSTER_THRESHOLD) {
    const first = singleCharInputs[0];
    if (first) {
      pushCandidate(
        candidates,
        filePath,
        first.loc.start.line,
        first.loc.start.column,
        buildReason(singleCharInputs.length, htmlClusterShapeSummary(singleCharInputs)),
      );
    }
  }
  // Recurse — every nested element is itself a parent group.
  for (const child of children) {
    if (child.kind !== "HtmlElement") continue;
    inspectHtmlSiblings(child.children, filePath, candidates);
  }
}

function htmlInputLooksSingleChar(input: HtmlElement): boolean {
  const type = (getHtmlAttribute(input, "type") ?? "text").trim().toLowerCase();
  if (!SINGLE_CHAR_INPUT_TYPES.has(type)) return false;
  return narrowsToSingleChar(
    getHtmlAttribute(input, "maxlength"),
    getHtmlAttribute(input, "pattern"),
  );
}

function htmlClusterShapeSummary(inputs: readonly HtmlElement[]): string {
  // Cite the first input's resolved (type, maxlength) pair as the
  // representative shape. The agent can read the file and confirm the
  // remaining members match — this mirrors the "point, don't enumerate"
  // doctrine.
  const first = inputs[0];
  if (!first) return "";
  const type = (getHtmlAttribute(first, "type") ?? "text").trim().toLowerCase();
  const maxlength = getHtmlAttribute(first, "maxlength");
  const pattern = getHtmlAttribute(first, "pattern");
  return formatShape(type, maxlength, pattern);
}

// ---------------------------------------------------------------------------
// JSX branch
// ---------------------------------------------------------------------------

function scanJsx(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  for (const topLevel of root.jsxElements) {
    inspectJsxParent(topLevel, filePath, candidates);
  }
}

function inspectJsxParent(
  parent: JsxElement,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  const singleCharInputs: JsxElement[] = [];
  for (const child of parent.children) {
    if (child.kind !== "JsxElement") continue;
    // JSX intrinsic check: lowercase `input` only. PascalCase wrappers
    // (`<OtpDigit />`, `<Input />`) hide their resolved attributes — the
    // companion auto rules and a project-level config-driven wrapper map
    // are the right shapes for those. False negatives here are
    // recoverable; false positives on wrapper components would be
    // confidently wrong.
    if (child.tagName === "input" && jsxInputLooksSingleChar(child)) {
      singleCharInputs.push(child);
    }
  }
  if (singleCharInputs.length >= CLUSTER_THRESHOLD) {
    const first = singleCharInputs[0];
    if (first) {
      pushCandidate(
        candidates,
        filePath,
        first.loc.start.line,
        first.loc.start.column,
        buildReason(singleCharInputs.length, jsxClusterShapeSummary(singleCharInputs)),
      );
    }
  }
  for (const child of parent.children) {
    if (child.kind === "JsxElement") inspectJsxParent(child, filePath, candidates);
    else if (child.kind === "JsxExpression")
      inspectJsxExpressionChildren(child, filePath, candidates);
  }
}

/**
 * The TSX parser exposes `{items.map(...)}` and similar children as a
 * single `JsxExpression` node — its `raw` string contains nested JSX but
 * no parsed structure for us to inspect. We deliberately do not try to
 * decode that here; agents own cross-file / runtime-shaped inspection
 * better than a regex would. This stub exists so the recursion contract
 * is explicit and the omission is visible.
 */
function inspectJsxExpressionChildren(
  _expr: JsxNode,
  _filePath: string,
  _candidates: ReviewCandidate[],
): void {
  // Intentional no-op — see comment above.
}

function jsxInputLooksSingleChar(input: JsxElement): boolean {
  const type = (getJsxAttributeString(input, "type") ?? "text").trim().toLowerCase();
  if (!SINGLE_CHAR_INPUT_TYPES.has(type)) return false;
  return narrowsToSingleChar(jsxMaxLength(input), getJsxAttributeString(input, "pattern"));
}

function jsxClusterShapeSummary(inputs: readonly JsxElement[]): string {
  const first = inputs[0];
  if (!first) return "";
  const type = (getJsxAttributeString(first, "type") ?? "text").trim().toLowerCase();
  return formatShape(type, jsxMaxLength(first), getJsxAttributeString(first, "pattern"));
}

/**
 * Resolves the JSX `maxLength` (or HTML-cased `maxlength`) attribute to
 * a string. Accepts both `maxLength="1"` (string literal) and
 * `maxLength={1}` (numeric-literal expression — the React idiom). Other
 * expression shapes (`maxLength={count}`, `maxLength={ONE}`) stay
 * unresolved so the static reader doesn't speculate; an OTP cluster
 * authored that way produces a false negative on this finder, but the
 * per-input label rules still fire and the agent can dismiss / promote.
 */
function jsxMaxLength(input: JsxElement): string | null {
  const literal =
    getJsxAttributeString(input, "maxLength") ?? getJsxAttributeString(input, "maxlength");
  if (literal !== null) return literal;
  const attr = getJsxAttribute(input, "maxLength") ?? getJsxAttribute(input, "maxlength");
  if (attr?.value?.kind !== "Expression") return null;
  const trimmed = attr.value.raw.trim();
  // Strip exactly one pair of outer braces from the expression text;
  // `maxLength={1}` arrives as the raw string `{1}` here.
  let inner = trimmed;
  if (inner.startsWith("{") && inner.endsWith("}")) {
    inner = inner.slice(1, -1).trim();
  }
  // Only numeric-literal bodies resolve. `{1}` → "1"; `{count}` and
  // `{1 + 1}` stay null.
  if (/^-?\d+$/.test(inner)) return inner;
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function narrowsToSingleChar(maxlength: string | null, pattern: string | null): boolean {
  if (maxlength !== null && maxlength.trim() === "1") return true;
  if (pattern !== null && isSingleCharPattern(pattern)) return true;
  return false;
}

function isSingleCharPattern(raw: string): boolean {
  // Strip leading/trailing whitespace and the common `^...$` anchors so
  // both `\d` and `^\d$` (and `^[0-9]$`) are recognised as single-char.
  let body = raw.trim();
  if (body.startsWith("^")) body = body.slice(1);
  if (body.endsWith("$")) body = body.slice(0, -1);
  for (const re of SINGLE_CHAR_PATTERN_RES) {
    if (re.test(body)) return true;
  }
  return false;
}

function formatShape(type: string, maxlength: string | null, pattern: string | null): string {
  // Build a short evidence summary: type plus whichever of maxlength /
  // pattern actually narrowed the input. Both can be present; we cite
  // both when so to make the dismissal evidence explicit.
  const parts: string[] = [`type="${type}"`];
  if (maxlength !== null && maxlength.trim() === "1") parts.push('maxlength="1"');
  if (pattern !== null && isSingleCharPattern(pattern)) parts.push(`pattern="${pattern.trim()}"`);
  return parts.join(" ");
}

function buildReason(count: number, shape: string): string {
  // Reason text owns the dismissal frame — the agent reading once should
  // know (a) what we matched, (b) why screen-reader behaviour is at
  // stake, (c) the canonical fix shape, (d) that per-input findings on
  // the same boxes are expected and addressed by the same fix.
  const shapePhrase = shape.length > 0 ? ` (${shape})` : "";
  return [
    `${count} sibling <input> elements${shapePhrase} share the shape of a one-time-code (OTP) cluster.`,
    "Screen readers will announce N individual edit fields instead of a single one-time-code field.",
    'Add `autocomplete="one-time-code"` to at least one input, and provide a single group-level',
    "accessible name covering the cluster (`<fieldset><legend>...</legend>` or a wrapping element",
    'with `role="group"` and `aria-labelledby`).',
    "Per-input label findings on the same boxes (e.g. forms/labels-required) are addressed by the",
    "same group fix.",
  ].join(" ");
}

function pushCandidate(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  reason: string,
): void {
  for (const criterionId of CRITERION_IDS) {
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason,
      // Confidence "medium": deterministic shape predicate (≥ 4 sibling
      // single-character inputs under one parent) but the OTP-vs-other
      // semantic is context the scanner cannot see — agent reads the
      // parent and confirms.
      confidence: "medium",
    });
  }
}
