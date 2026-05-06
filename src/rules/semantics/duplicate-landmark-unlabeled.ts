/**
 * Rule: semantics/duplicate-landmark-unlabeled
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, wcag22:2.4.1, wcag21:2.4.1
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *       https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are
 * > available in text.
 *
 * When a page has multiple landmarks of the same type — the classic
 * example is a mobile `<nav>` alongside a desktop `<nav>` — screen
 * readers announce each one with the same generic "navigation" role
 * name. Without distinguishing accessible names, a user cursoring
 * through the landmark list can't tell them apart and the primary
 * navigation target is no longer findable. Same story for two
 * `<main>` / `<aside>` / `<form>` landmarks in one rendered page,
 * and for body-level `<header>` / `<footer>` (which map to the
 * `banner` / `contentinfo` landmarks per ARIA-in-HTML).
 *
 * Detection gate: emit only when ≥2 same-type landmarks are
 * observable in the same file, with at least one unlabeled. Every
 * unlabeled landmark in the duplicate set is flagged — the fix is to
 * label at least the duplicates.
 *
 * `<header>` and `<footer>` are landmark-mapped (`banner` /
 * `contentinfo`) only when their nearest sectioning-content ancestor
 * is the document body. A `<header>` nested inside `<article>`,
 * `<section>`, `<main>`, `<aside>`, or `<nav>` is a generic group
 * with no landmark role — those instances do NOT count toward the
 * duplicate predicate. Per ARIA-in-HTML §4.1.2 and the WAI-ARIA
 * Landmarks pattern.
 *
 * The single-unlabeled-in-fragment case (Jekyll/Astro/Handlebars
 * partial with one bare `<nav>` / `<aside>` / `<form>`) is
 * deliberately NOT emitted by this rule. The predicate "the partial
 * will likely compose alongside another same-type landmark" is a
 * guess about composition that is unobservable from the file the
 * scanner has — encoding it as a deterministic finding leaks the
 * heuristic's uncertainty into a slot the agent reads as "this is
 * real." That belongs on the review-candidate surface (where the
 * `reason` text frames the question "is another `<nav>` present at
 * runtime?"), not on the rule surface. See the AI-first consumer
 * doctrine entry on heuristic emission, the symmetric twin of
 * heuristic suppression.
 *
 * The two-or-more-in-fragment case IS observable from the file
 * alone, so the emit stays — but the framing "Document has N
 * <nav> landmarks" is dishonest when the file is a partial. On
 * `html_partial` classification (the same predicate that produces
 * `analysisCoverage.fragmentFiles[].kind: "html_partial"` on the
 * meta surface), severity downgrades to `info` and the message
 * reframes to "this partial supplies N <nav> landmarks (composed
 * into a parent page at render time)" with a
 * `partial_input_duplicate_landmark_in_fragment`
 * `couldBeWrongBecause` code. Per the AI-first doctrine "Reason
 * text and severity must agree" — when the predicate's framing
 * concedes the file is composed elsewhere, the attention-budget
 * signal must agree.
 */

import { defineRule } from "../../api/plugin.ts";
import { findHtmlElementsByTag, getHtmlAttribute } from "../../engine/ast-helpers.ts";
import { classifyHtmlFile } from "../../engine/layout-partial.ts";
import type { HtmlDocument, HtmlElement, HtmlNode } from "../../types/ast.ts";
import type { FileContext } from "../../types/rule.ts";

/**
 * Structured `couldBeWrongBecause` code surfaced when the duplicate-
 * landmark emit lands on a file the unified classifier
 * ({@link classifyHtmlFile}) labels as a leaf fragment — the same
 * `analysisCoverage.fragmentFiles[].kind: "html_partial"` shape on the
 * meta surface. The framing "Document has N <nav> landmarks" reads as
 * a confident document-level assertion, but the file is a partial that
 * supplies its landmarks to a composing parent at render time. Pairs
 * with the `info` severity downgrade on the same branch so the
 * attention-budgeting signal matches the conceded reason per
 * `docs/kb/architecture/ai-first-consumer.md` "Reason text and severity
 * must agree" + "Heuristic emission is the symmetric twin of heuristic
 * suppression." Mirrors the
 * {@link import("./landmark-main.ts").MARKDOWN_RESIDUE_NO_MAIN_VISIBLE}
 * shape on `semantics/landmark-main`'s markdown-residue branch (Q15
 * landmark-main precedent).
 */
const PARTIAL_INPUT_DUPLICATE_LANDMARK_CODE = "partial_input_duplicate_landmark_in_fragment";

/**
 * Tags whose same-file duplicates trigger the rule unconditionally
 * (no sectioning-ancestor scoping). `main` is included because two
 * `<main>` elements in one document is a deterministic violation;
 * `semantics/landmark-main` lives on `scope: "document"` with its
 * own distinct message, so the double-cover is intentional and not a
 * double-emission.
 */
const UNSCOPED_DUPLICATE_TAGS: readonly ("nav" | "aside" | "form" | "main")[] = [
  "nav",
  "aside",
  "form",
  "main",
];

/**
 * Tags whose landmark mapping is conditional on sectioning ancestry.
 * `<header>` is `banner` and `<footer>` is `contentinfo` only when
 * the nearest sectioning ancestor is the document body. Inside
 * `<article>`, `<section>`, `<main>`, `<aside>`, or `<nav>` they
 * become generic groups without a landmark role and do NOT count
 * toward the duplicate predicate.
 */
const SECTIONED_DUPLICATE_TAGS: readonly ("header" | "footer")[] = ["header", "footer"];

/**
 * Sectioning-content tags whose presence in the ancestor chain
 * demotes a `<header>` or `<footer>` from a landmark to a generic
 * group. Per HTML5 / ARIA-in-HTML.
 */
const SECTIONING_ANCESTORS: ReadonlySet<string> = new Set([
  "article",
  "aside",
  "main",
  "nav",
  "section",
]);

export const rule = defineRule({
  id: "semantics/duplicate-landmark-unlabeled",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:2.4.1", "wcag21:2.4.1"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      "When a file ships two or more landmarks of the same type (nav, aside, form, main, body-level header, body-level footer) and at least one lacks aria-label or aria-labelledby, screen-reader users cannot tell them apart in the landmark list. Each unlabeled landmark in the duplicate set is flagged. `<header>` / `<footer>` only count when their nearest sectioning ancestor is the body — instances nested in `<article>`, `<section>`, `<main>`, `<aside>`, or `<nav>` are generic groups, not landmarks. The single-unlabeled-in-fragment case is not emitted — composition with a sibling partial is unobservable from this file alone. On `html_partial`-classified inputs (Jekyll `_includes/`, similar SSG partials with no `<html>` envelope and no layout directive), the duplicate-in-partial emit downgrades to `info` and reframes the message as 'this partial supplies N landmarks' so the attention-budget signal matches the conceded composition.",
    rationale:
      "Screen readers expose landmarks via a dedicated shortcut (D in NVDA, VO+U in VoiceOver, R in JAWS). Two `<nav>` elements with no labels both announce as 'navigation landmark', so a blind user cursoring the landmark list sees 'navigation, navigation' and has to enter each one to discover which is the primary nav. Same shape for two body-level `<header>` elements (both 'banner') or two body-level `<footer>` elements (both 'contentinfo'). The rule emits only when the duplicate is observable in the file — two `<nav>`s in one document, two body-level `<header>`s in one partial. `<header>` / `<footer>` nested inside sectioning content are not landmarks per ARIA-in-HTML and are excluded from the count. Predicting that a single unlabeled landmark in a partial will compose alongside another at render time is a guess about an unseen layout; that case belongs on the review-candidate surface, where the `reason` text frames the question instead of asserting it.",
    goodExample:
      '<header aria-label="Site"><nav aria-label="Primary">…</nav></header><header aria-label="Article header">…</header>',
    badExample: "<body><header>Site</header><header>Article header</header></body>",
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/TR/WCAG22/#bypass-blocks",
      "https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/examples/navigation.html",
      "https://www.w3.org/TR/html-aria/#el-header",
      "https://www.w3.org/TR/html-aria/#el-footer",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;

    // The duplicate-landmark predicate is the same shape in full
    // pages and fragments: ≥2 same-type landmarks observable in the
    // file with at least one unlabeled. The single-unlabeled-in-
    // fragment branch was removed — predicting composition with an
    // unseen sibling partial is a heuristic, and heuristic emission
    // is the symmetric twin of heuristic suppression.
    //
    // On `isFragment: true` files (the same predicate that produces
    // `analysisCoverage.fragmentFiles[].kind: "html_partial"` on the
    // meta surface), the duplicate IS still observable from in-file
    // evidence so the emission stays — but the framing "Document has
    // N <nav> landmarks" is dishonest because the file is a partial,
    // not a document. The emission downgrades to `info` severity and
    // the message reframes to "partial" wording with a
    // {@link PARTIAL_INPUT_DUPLICATE_LANDMARK_CODE} concession code.
    // Per `docs/kb/architecture/ai-first-consumer.md` "Reason text
    // and severity must agree" + the just-shipped Q15 landmark-main
    // markdown-residue precedent. Layout files (`_layouts/`) are NOT
    // fragments under the unified classifier — they ARE the page
    // envelope — and continue to fire at full `warning` severity
    // with document-level framing.
    const { isFragment } = classifyHtmlFile(doc, ctx.source, ctx.filePath);
    checkDuplicateLandmarks(ctx, doc, isFragment);
  },
});

/**
 * Same-file duplicate path: two or more landmarks of the same type
 * anywhere in the file. Emits one finding per unlabeled landmark in
 * the set — the fix is specific to each occurrence (which label to
 * add), so the emission is per-instance rather than per-set. Applies
 * uniformly to full pages and fragments.
 *
 * The unscoped tag set (`nav`, `aside`, `form`, `main`) counts every
 * occurrence regardless of nesting — these elements are landmarks
 * wherever they appear in the tree. The scoped tag set (`header`,
 * `footer`) only counts instances whose nearest sectioning-content
 * ancestor is the document body — `<header>` inside `<article>` is a
 * generic group, not a `banner` landmark, and so does not contribute
 * to the duplicate predicate.
 */
function checkDuplicateLandmarks(ctx: FileContext, doc: HtmlDocument, isFragment: boolean): void {
  for (const tag of UNSCOPED_DUPLICATE_TAGS) {
    const all = findHtmlElementsByTag(doc, tag);
    if (all.length <= 1) continue;
    emitDuplicatesForTag(ctx, tag, all, isFragment);
  }
  for (const tag of SECTIONED_DUPLICATE_TAGS) {
    const landmarks = findBodyLevelHeaderFooter(doc, tag);
    if (landmarks.length <= 1) continue;
    emitDuplicatesForTag(ctx, tag, landmarks, isFragment);
  }
}

/**
 * Walks the document and returns every `<header>` / `<footer>`
 * element whose nearest sectioning-content ancestor is the document
 * body (or the fragment root). Elements nested inside `<article>`,
 * `<section>`, `<main>`, `<aside>`, or `<nav>` are excluded — those
 * instances are generic groups, not `banner` / `contentinfo`
 * landmarks, per ARIA-in-HTML §4.1.2.
 */
function findBodyLevelHeaderFooter(
  doc: HtmlDocument,
  targetTag: "header" | "footer",
): readonly HtmlElement[] {
  const out: HtmlElement[] = [];
  const visit = (children: readonly HtmlNode[], inSectioning: boolean): void => {
    for (const node of children) {
      if (node.kind !== "HtmlElement") continue;
      const tag = node.tagName.toLowerCase();
      if (tag === targetTag && !inSectioning) {
        out.push(node);
      }
      const nextInSectioning = inSectioning || SECTIONING_ANCESTORS.has(tag);
      visit(node.children, nextInSectioning);
    }
  };
  visit(doc.children, false);
  return out;
}

function emitDuplicatesForTag(
  ctx: FileContext,
  tag: string,
  all: readonly HtmlElement[],
  isFragment: boolean,
): void {
  const labeledCount = all.filter(hasAccessibleName).length;
  const unlabeled = all.filter((el) => !hasAccessibleName(el));
  if (unlabeled.length === 0) return;
  const otherLines = all.map((el) => el.loc.start.line);
  for (const el of unlabeled) {
    const siblings = otherLines.filter((line) => line !== el.loc.start.line);
    ctx.emit({
      severity: isFragment ? "info" : "warning",
      location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
      message: buildDuplicateMessage(tag, all.length, siblings.length, isFragment),
      suggestion: duplicateSuggestion(tag, all.length, labeledCount, siblings, isFragment),
      ...(isFragment ? { couldBeWrongBecause: [PARTIAL_INPUT_DUPLICATE_LANDMARK_CODE] } : {}),
    });
  }
}

/**
 * Builds the per-emit message text. Two branches keyed off
 * {@link classifyHtmlFile}'s `isFragment` label:
 *
 *   - Fragment branch: "This partial supplies N <tag> landmarks
 *     (composed into a parent page at render time); …" — concedes
 *     the partial-shape composition. Pairs with the `info` severity
 *     downgrade and the {@link PARTIAL_INPUT_DUPLICATE_LANDMARK_CODE}
 *     concession code so the agent reads attention-budget and reason
 *     in agreement.
 *   - Non-fragment branch: "Document has N <tag> landmarks; …" —
 *     the canonical full-page framing.
 *
 * Extracted from {@link emitDuplicatesForTag} to keep that function
 * under the cyclomatic-complexity limit while still preserving the
 * per-instance fanout the rule emits.
 */
function buildDuplicateMessage(
  tag: string,
  total: number,
  siblingCount: number,
  isFragment: boolean,
): string {
  const otherWord = siblingCount === 1 ? "other" : "others";
  if (isFragment) {
    const landmarkSingularPlural = siblingCount === 1 ? "landmark" : "landmarks";
    return `This partial supplies ${total} <${tag}> landmarks (composed into a parent page at render time); this one has no aria-label or aria-labelledby, so once the partial composes, screen readers cannot tell it apart from the ${otherWord} same-type ${landmarkSingularPlural} in the file.`;
  }
  return `Document has ${total} <${tag}> landmarks; this one has no aria-label or aria-labelledby, so screen readers cannot tell it apart from the ${otherWord}.`;
}

/**
 * An accessible-name signal strong enough to disambiguate sibling
 * landmarks: `aria-label` with any non-whitespace value, or
 * `aria-labelledby` referencing any id token. We intentionally do
 * NOT resolve `aria-labelledby` targets — a dangling `labelledby`
 * is a separate rule's problem (`aria/labelledby-target-exists`),
 * and resolving here would double-report on that same failure.
 * `title` is not accepted: it's advisory, not a reliable landmark
 * name.
 */
function hasAccessibleName(el: HtmlElement): boolean {
  const label = getHtmlAttribute(el, "aria-label");
  if (label !== null && label.trim().length > 0) return true;
  const labelledby = getHtmlAttribute(el, "aria-labelledby");
  if (labelledby !== null && labelledby.trim().length > 0) return true;
  return false;
}

function roleLabelHint(tag: string): string {
  if (tag === "nav") {
    return 'Typical values: "Primary", "Breadcrumb", "Footer", "Mobile", "Table of contents".';
  }
  if (tag === "aside") {
    return 'Typical values: "Related articles", "Sidebar", "Table of contents", "Advertisements".';
  }
  if (tag === "main") {
    return 'Typical values: "Article", "Page content", "Search results".';
  }
  if (tag === "header") {
    return 'Typical values: "Site header", "Article header", "Section header".';
  }
  if (tag === "footer") {
    return 'Typical values: "Site footer", "Article footer", "Legal".';
  }
  return 'Typical values: "Search", "Subscribe", "Contact".';
}

function duplicateSuggestion(
  tag: string,
  total: number,
  labeledCount: number,
  siblings: readonly number[],
  isFragment: boolean,
): string {
  const siblingList = siblings.join(", ");
  const siblingLabel = siblings.length === 1 ? `line ${siblingList}` : `lines ${siblingList}`;
  const rolePurposeHint = roleLabelHint(tag);
  // The "context noun" varies by classification: "this document" reads
  // honestly when the file is a full page, but reads as a confident
  // assertion when the file is an `html_partial` whose composed parent
  // is unobservable. The fragment branch frames the count as "this
  // partial" and adds a verify-the-composing-parent suffix so the
  // agent reads the dismissal hatch in one pass — per the AI-first
  // doctrine "Reason / priority / fix-description must agree across
  // all three channels" extension.
  const contextNoun = isFragment ? "this partial" : "this document";
  const partialSuffix = isFragment
    ? ` This file looks like an HTML partial composed into a parent page at render time — verify whether the composing parent ALSO supplies a same-type landmark (which would give the rendered page even more duplicates) OR whether labelling the duplicates inside this partial is the right fix. Use a <!-- ra11y-disable semantics/duplicate-landmark-unlabeled --> pragma if the duplicate is intentional and the rendered page disambiguates them upstream.`
    : "";
  if (labeledCount === 0) {
    return `${total} <${tag}> landmarks in ${contextNoun} (other ${siblings.length === 1 ? "is" : "are"} at ${siblingLabel}); none have aria-label / aria-labelledby. Add a distinct aria-label to each — ${rolePurposeHint}${partialSuffix}`;
  }
  return `${total} <${tag}> landmarks in ${contextNoun} (other ${siblings.length === 1 ? "is" : "are"} at ${siblingLabel}); this one has no aria-label / aria-labelledby while ${labeledCount} ${labeledCount === 1 ? "does" : "do"}. Add aria-label to this <${tag}> so it reads distinctly in the screen-reader landmark list. ${rolePurposeHint}${partialSuffix}`;
}
