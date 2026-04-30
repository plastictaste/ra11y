/**
 * Rule: parsing/malformed-tag
 * Satisfies: wcag21:4.1.1
 * Spec: https://www.w3.org/TR/WCAG21/#parsing
 *
 * > In content implemented using markup languages, elements have complete
 * > start and end tags, elements are nested according to their
 * > specifications, elements do not contain duplicate attributes, and any
 * > IDs are unique, except where the specifications allow these features.
 *
 * Source: https://www.w3.org/TR/WCAG21/#parsing
 *
 * WCAG 2.2 removed SC 4.1.1 Parsing because modern HTML parsers recover
 * from malformed markup. We cite wcag21:4.1.1 only (WCAG 2.1, Section 508,
 * and EN 301 549 still reference it). Sister rules in this domain
 * (`parsing/duplicate-id`, `parsing/invalid-id-shape`) follow the same
 * citation strategy.
 *
 * Catches heading-tag typos — element tag names of the shape `h\d+`
 * where the digit is NOT in [1..6]. The HTML5 inventory defines
 * exactly six heading levels (`h1` through `h6`); anything outside
 * that — `<h0>`, `<h7>`, `<h33>`, `<h44>` — is a typo. Browsers
 * silently fall back to handling the unknown name as a generic inline
 * element, which strips heading semantics from the assistive-tech
 * tree: the screen reader's heading list never lists the element, and
 * skip-by-heading shortcuts fly past it.
 *
 * Two emission paths:
 *
 *   1. Opening (or paired) malformed tag — `<h33>...</h33>`,
 *      `<h0>...`. The parser preserves these in the AST as elements
 *      with the impossible `tagName`. We walk every HTML element and
 *      classify the tag.
 *
 *   2. Orphan closing tag — `<h3>...</h33>`. The parser sees `<h3>`
 *      as a valid opener and emits a generic "Stray closing tag at
 *      top level" recoverable error for `</h33>`; the closer's name
 *      is collapsed into the message. We re-scan source for closing
 *      tags of the impossible shape (`</h\d+>`) and dedupe against
 *      paired malformed openings already covered by path (1).
 *
 * Why heading-tag typos specifically (and not arbitrary unknown tag
 * names)? The HTML5 inventory is open — `<my-widget>` is a valid
 * custom element (custom elements MUST contain a hyphen per the
 * spec), `<foo>` is a perfectly legal unknown element that browsers
 * treat as inline, and many frameworks coin element names that do
 * not appear on the static-analysis radar. Heading typos are the
 * tightest detectable shape with a near-zero false-positive rate:
 * the regex `/^h\d+$/` captures intent unambiguously, and the only
 * legal members of that shape are `h1`-`h6`. Wider malformed-tag
 * detection (custom elements without hyphens, namespace typos)
 * belongs in a separate rule with a different evidence model.
 */

import { defineRule } from "../../api/plugin.ts";
import { walkHtmlElements } from "../../engine/ast-helpers.ts";
import type { HtmlDocument } from "../../types/ast.ts";

/** Matches a heading-shaped tag name: `h` followed by one or more digits. */
const HEADING_TAG_SHAPE = /^h(\d+)$/i;

/**
 * Matches a closing tag with a heading-shaped name — captures group 1
 * is the digit run. Used to find orphan closing tags that the parser
 * folded into a generic "stray closing tag" recoverable error.
 */
const HEADING_CLOSING_TAG = /<\/h(\d+)\s*>/gi;

export const rule = defineRule({
  id: "parsing/malformed-tag",
  satisfies: ["wcag21:4.1.1"],
  severity: "warning",
  scope: "document",
  // The rule computes a `nearestValidHeadingLevel` (e.g. `<h33>`
  // → `<h3>`) but the choice of level is content-dependent (the
  // author may have intended `<h2>` instead). Mechanically
  // rewriting also requires updating the paired closer if the
  // typo is on the opener (or vice versa) — risky to automate.
  // Per AI-first doctrine "Per-call shape must agree with
  // per-class plan tally," `verify-in-source` keeps the plan tally
  // honest.
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      "Element tag names of the form `h<digits>` outside h1-h6 (e.g. `<h0>`, `<h7>`, `<h33>`) are typos. Browsers fall back to handling the unknown name as a generic inline element, stripping heading semantics from the assistive-tech tree.",
    rationale:
      "HTML5 defines exactly six heading levels: h1, h2, h3, h4, h5, h6. A tag like `<h33>` (digit-double typo on `<h3>`) or `<h0>` is not a valid heading; browsers parse it as an unknown element with no implicit role, so the element is absent from the screen-reader heading list and skip-by-heading navigation passes over it. The HTML5 parser recovers silently from malformed names — meaning the visual rendering may look acceptable while the AT tree is wrong. The canonical field shape is a closing-tag typo (`<h3>Hello</h33>`) that the parser logs as a recoverable error without surfacing the offending name to a rule; this rule re-scans source so the bad token reaches the agent at file:line.",
    goodExample: `<h2>Section title</h2>\n<h3>Sub-section</h3>\n<my-widget>custom element with hyphen — legal</my-widget>`,
    badExample: `<h33>Section title</h33>\n<h3>Sub-section</h7>\n<h0>not a heading</h0>`,
    normativeQuote:
      "In content implemented using markup languages, elements have complete start and end tags, elements are nested according to their specifications, elements do not contain duplicate attributes, and any IDs are unique, except where the specifications allow these features.",
    references: [
      "https://www.w3.org/TR/WCAG21/#parsing",
      "https://html.spec.whatwg.org/multipage/sections.html#the-h1,-h2,-h3,-h4,-h5,-and-h6-elements",
      "https://html.spec.whatwg.org/multipage/indices.html#elements-3",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;

    // Track positions already reported via the AST walk so the source-scan
    // pass for orphan closing tags doesn't double-emit on paired malformed
    // tags whose closer is also re-discoverable in source.
    const reportedNames = new Set<string>();

    // Path 1: walk every HTML element looking for impossible heading shapes.
    for (const element of walkHtmlElements(doc)) {
      const match = HEADING_TAG_SHAPE.exec(element.tagName);
      if (!match) continue;
      const digits = match[1] ?? "";
      if (isValidHeadingDigit(digits)) continue;
      const lowerName = element.tagName.toLowerCase();
      reportedNames.add(lowerName);
      const proposedLevel = nearestValidHeadingLevel(digits);
      ctx.emit({
        severity: "warning",
        location: {
          filePath: "",
          line: element.loc.start.line,
          column: element.loc.start.column,
        },
        message: `<${element.tagName}> is not a valid HTML element — heading levels are h1-h6 only. Likely typo on <h${proposedLevel}>.`,
        suggestion: buildOpeningSuggestion(element.tagName, proposedLevel),
      });
    }

    // Path 2: source-scan for orphan closing heading tags. The parser
    // collapses the closer's name into a generic "stray closing tag"
    // error message, so the AST alone can't surface the bad token —
    // we re-scan source for `</h\d+>` shapes and skip names already
    // covered by path 1 (paired malformed `<h33>...</h33>` whose
    // opener was already reported).
    for (const orphan of findOrphanClosingTags(ctx.source, reportedNames)) {
      ctx.emit({
        severity: "warning",
        location: {
          filePath: "",
          line: orphan.line,
          column: orphan.column,
        },
        message: `</${orphan.name}> is not a valid HTML element — heading levels are h1-h6 only. Likely typo on </h${orphan.proposedLevel}>.`,
        suggestion: buildClosingSuggestion(orphan.name, orphan.proposedLevel),
      });
    }
  },
});

/**
 * Returns true when the digit run names a valid HTML heading level (1-6).
 * Anything else — `0`, `7`, `33`, `123` — is an impossible heading.
 */
function isValidHeadingDigit(digits: string): boolean {
  if (digits.length !== 1) return false;
  const n = Number.parseInt(digits, 10);
  return n >= 1 && n <= 6;
}

/**
 * Proposes the nearest valid heading level (1-6) for an impossible
 * digit run. The most common typo shapes in field data are
 * digit-doubles (`33` → 3, `44` → 4) and off-by-one (`0` → 1, `7` →
 * 6). For longer runs we take the first digit (`33` → `3`, `123` →
 * `1`) and clamp into [1..6]. The suggestion is advisory; the agent
 * reads surrounding headings to decide the actual level.
 */
function nearestValidHeadingLevel(digits: string): number {
  if (digits.length === 0) return 1;
  const head = Number.parseInt(digits[0] ?? "1", 10);
  if (head >= 1 && head <= 6) return head;
  if (head === 0) return 1;
  // head is 7, 8, or 9 — clamp down to the nearest valid level.
  return 6;
}

/**
 * Builds a context-aware suggestion for an opening malformed heading.
 * Names the offending tag, the proposed corrected level, and warns
 * about the AT impact so the agent doesn't dismiss it as "renders
 * fine in the browser."
 */
function buildOpeningSuggestion(badName: string, proposedLevel: number): string {
  const correct = `h${proposedLevel}`;
  return `Rename <${badName}> to <${correct}> (HTML headings are h1-h6 only). Browsers parse <${badName}> as an unknown inline element with no implicit role, so the element is absent from the screen-reader heading list and skip-by-heading navigation passes over it. If both the opener and closer use <${badName}>, fix both — paired malformed tags still strip heading semantics. Verify the level matches the surrounding outline (h2 inside an article, h3 inside a section, etc.) before pasting <${correct}>.`;
}

/**
 * Builds a context-aware suggestion for an orphan closing malformed
 * heading. The opening tag is presumably a valid heading (`<h3>`)
 * and the typo is on the closer; rename the closer to match.
 */
function buildClosingSuggestion(badName: string, proposedLevel: number): string {
  const correct = `h${proposedLevel}`;
  return `Rename </${badName}> to </${correct}> (HTML headings are h1-h6 only). The opening tag is presumably a valid <${correct}> — the typo is on the closer. The HTML5 parser logs the orphan close as a recoverable error and silently leaves the heading element unclosed, so the heading absorbs sibling content into its accessible name. Find the matching opener and ensure its name agrees with the closer.`;
}

interface OrphanClosingTag {
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly proposedLevel: number;
}

/**
 * Scans `source` for closing tags shaped like `</h\d+>` whose digit
 * run is not 1-6. Emits each such tag once. Skips names already
 * reported via the AST walk (paired malformed openers whose closer
 * names match — those are already covered).
 */
function findOrphanClosingTags(
  source: string,
  reportedNames: ReadonlySet<string>,
): readonly OrphanClosingTag[] {
  const out: OrphanClosingTag[] = [];
  const seen = new Set<string>();
  // Reset the regex's lastIndex defensively — global regexes are
  // module-level and reused across calls.
  HEADING_CLOSING_TAG.lastIndex = 0;
  for (const match of source.matchAll(HEADING_CLOSING_TAG)) {
    const digits = match[1] ?? "";
    if (isValidHeadingDigit(digits)) continue;
    const name = `h${digits}`;
    if (reportedNames.has(name.toLowerCase())) continue;
    const offset = match.index ?? 0;
    // Dedupe by offset so the same source position is never emitted
    // twice within one file.
    const key = `${offset}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { line, column } = offsetToLineColumn(source, offset);
    out.push({
      name,
      line,
      column,
      proposedLevel: nearestValidHeadingLevel(digits),
    });
  }
  return out;
}

/**
 * Converts a 0-based source offset to 1-based (line, column). Mirrors
 * the convention used by `loc` in the HTML AST so emitted findings
 * align with element-walk emissions on the same line.
 */
function offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}
