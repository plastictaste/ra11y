/**
 * Candidate finder: review/headings-and-labels
 * Criteria: wcag22:2.4.6, wcag21:2.4.6, section508:2.4.6, en301549:9.2.4.6
 * Spec: https://www.w3.org/TR/WCAG22/#headings-and-labels
 *
 * Flags headings (h1-h6) and form labels whose visible text is one of a
 * short list of generic phrases ("Overview", "Section", "Click here",
 * "Label", etc.) that do not describe the topic or purpose of the
 * content they head or label. A human reviewer must confirm whether
 * the text is load-bearing in context.
 *
 * Review finder — biased toward false positives. The output is a
 * checklist of places to verify, not a list of failures.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  htmlTextContent,
  jsxTextContent,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import { htmlElementOnlyChildIsTemplateDirective } from "../../input/parsers/html-template-directives.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = [
  "wcag22:2.4.6",
  "wcag21:2.4.6",
  "section508:2.4.6",
  "en301549:9.2.4.6",
] as const;

const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Phrases that rarely describe the topic or purpose of the heading's
 * content. Matched case-insensitively against the trimmed text. The
 * `page 2` / `page N` variant catches pagination-style headings that
 * name the ordinal but not the content.
 */
const GENERIC_HEADING =
  /^(?:overview|section|details|summary|description|introduction|intro|untitled|welcome|home|info|information|content|contents|about|more|other|new|title|click here|more info|read more|learn more|page(?:\s*\d+)?)$/i;

/**
 * Generic label phrases. Includes the heading list plus label-specific
 * words ("label", "field", "text", "value", "input") and common
 * placeholder-style phrases ("enter text", "type here").
 */
const GENERIC_LABEL =
  /^(?:label|field|text|value|input|enter text|type here|overview|section|details|summary|description|introduction|intro|untitled|welcome|home|info|information|content|contents|about|more|other|new|title|click here|more info|read more|learn more)$/i;

export const finder = defineCandidateFinder({
  id: "review/headings-and-labels",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds headings (h1-h6) and labels whose text is a generic phrase (Overview, Section, Click here, Label, Field...) that probably does not describe the topic or purpose of the content.",
    reviewPrompt:
      "Verify that this heading or label describes the topic or purpose of the content it heads. If the text is generic (Overview, Click here, Field...) and a screen-reader user hitting it cold would not know what follows, rewrite it so the meaning is clear without surrounding context.",
    references: [
      "https://www.w3.org/TR/WCAG22/#headings-and-labels",
      "https://www.access-board.gov/ict/",
    ],
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
    const tag = el.tagName.toLowerCase();
    if (HEADING_TAGS.has(tag)) {
      handleHtmlHeading(filePath, el, tag, candidates);
      continue;
    }
    if (tag === "label") {
      const text = htmlTextContent(el);
      if (text && GENERIC_LABEL.test(text)) emitLabel(filePath, el, text, candidates);
    }
  }
}

/**
 * Routes one HTML heading (`<h1>`–`<h6>`) to its finder branch:
 *
 *   1. Generic-phrase text content (`<h2>Overview</h2>`) → emit at
 *      confidence "low" via the existing generic-heading regex.
 *   2. Sole child is a stripped template directive
 *      (`<h2>{{ page.title }}</h2>`) → predicate-axis pair to
 *      `semantics/empty-heading`. The rule suppresses emission for
 *      this shape because static evidence can't see whether the
 *      binding resolves to non-empty text; this finder takes over
 *      with reason text framing the binding-resolves question.
 *   3. Anything else → no candidate (descriptive text or covered by
 *      another rule/finder).
 *
 * Extracted from `findHtmlCandidates` to keep per-function complexity
 * under the lint budget once the template-directive branch landed.
 */
function handleHtmlHeading(
  filePath: string,
  el: HtmlElement,
  tag: string,
  candidates: ReviewCandidate[],
): void {
  const text = htmlTextContent(el);
  if (text && GENERIC_HEADING.test(text)) {
    emitHeading(filePath, el, tag, text, candidates);
    return;
  }
  if (htmlElementOnlyChildIsTemplateDirective(el)) {
    emitHeadingTemplateInterpolated(filePath, el, tag, candidates);
  }
}

function findJsxCandidates(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  for (const el of walkJsxElements(root)) {
    const tag = el.tagName;
    if (HEADING_TAGS.has(tag)) {
      const text = jsxTextContent(el);
      if (text && GENERIC_HEADING.test(text)) emitHeading(filePath, el, tag, text, candidates);
      continue;
    }
    if (tag === "label") {
      const text = jsxTextContent(el);
      if (text && GENERIC_LABEL.test(text)) emitLabel(filePath, el, text, candidates);
    }
  }
}

function emitHeading(
  filePath: string,
  el: HtmlElement | JsxElement,
  tag: string,
  text: string,
  candidates: ReviewCandidate[],
): void {
  const reason = `<${tag}> text "${text}" is a generic phrase -- verify the heading describes the topic or purpose of the content it heads`;
  for (const criterionId of CRITERION_IDS) {
    // Confidence "low": generic-phrase regex on heading text content.
    // "Overview" / "Introduction" / "Page 2" often really are fine in
    // context; the finder is a prompt to verify, not evidence of a
    // failure. Biased toward false positives per the docstring.
    candidates.push({
      criterionId,
      location: { filePath, line: el.loc.start.line, column: el.loc.start.column },
      reason,
      confidence: "low",
    });
  }
}

function emitHeadingTemplateInterpolated(
  filePath: string,
  el: HtmlElement,
  tag: string,
  candidates: ReviewCandidate[],
): void {
  const reason =
    `<${tag}> sole child is a template expression (Liquid/Jinja/ERB) stripped by the parser` +
    " -- verify the binding resolves to non-empty descriptive text at render time;" +
    " if the interpolation is trusted to always render, suppress at source with" +
    " `<!-- ra11y-disable wcag22:2.4.6 -->`";
  for (const criterionId of CRITERION_IDS) {
    // Confidence "low": the static scanner saw `{{ … }}` / `<%= … %>`
    // and stripped it; whether the rendered text is non-empty and
    // descriptive is a runtime question. The candidate still surfaces
    // so the agent verifies, per the AI-first consumer doctrine
    // §"Surface, don't suppress."
    candidates.push({
      criterionId,
      location: { filePath, line: el.loc.start.line, column: el.loc.start.column },
      reason,
      confidence: "low",
    });
  }
}

function emitLabel(
  filePath: string,
  el: HtmlElement | JsxElement,
  text: string,
  candidates: ReviewCandidate[],
): void {
  const reason = `<label> text "${text}" is a generic phrase -- verify the label describes the purpose of the form control`;
  for (const criterionId of CRITERION_IDS) {
    // Confidence "low": same regex-on-text heuristic — a "Label" or
    // "Field" form label might be a stub the team left, or might be
    // the correct UI. Reviewer decides.
    candidates.push({
      criterionId,
      location: { filePath, line: el.loc.start.line, column: el.loc.start.column },
      reason,
      confidence: "low",
    });
  }
}
