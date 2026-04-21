/**
 * Rule: semantics/duplicate-landmark-unlabeled
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, wcag22:2.4.1, wcag21:2.4.1
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
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
 * `<main>` / `<aside>` / `<form>` landmarks in one rendered page.
 *
 * Two detection paths:
 *
 * 1. **Same-file duplicates.** Two or more landmarks of the same type
 *    in one file, one or more of them without `aria-label` /
 *    `aria-labelledby`. Every unlabeled landmark in the duplicate set
 *    is flagged — the fix is to label at least the duplicates.
 *
 * 2. **Fragment-file single landmark.** A fragment / partial file
 *    (no `<html>` root, no `<body>`) that contains a single unlabeled
 *    `<nav>` / `<aside>` / `<form>` at the file root. These files are
 *    include-targets (Jekyll `_includes/header.html`, Handlebars
 *    partials, Astro slots) that get composed with siblings at render
 *    time — the fragment's landmark is almost certainly going to land
 *    next to another landmark of the same type once the layout is
 *    assembled. Flag it now so the author labels before the duplicate
 *    materializes.
 *
 * `<main>` is excluded from the single-fragment path — there should
 * only ever be one main on a page by spec, and `semantics/landmark-main`
 * already polices that. A fragment with a single unlabeled `<main>`
 * is fine (it IS the main); the duplicate rule would produce false
 * positives here.
 */

import { defineRule } from "../../api/plugin.ts";
import { findHtmlElementsByTag, getHtmlAttribute } from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";
import type { FileContext } from "../../types/rule.ts";

/**
 * Landmark tag names this rule polices. `main` is intentionally
 * absent — its uniqueness is `semantics/landmark-main`'s job, and a
 * single unlabeled main in a fragment is the normal Jekyll/Astro
 * shape (partials ARE the main content).
 */
const LANDMARK_TAGS: readonly ("nav" | "aside" | "form")[] = ["nav", "aside", "form"];

/**
 * Tags whose duplicates are checked when a `<body>` is present
 * (full-page path). `main` is still checked for duplication here
 * because landmark-main only fires when the page already "looks like
 * a page" — it's safe to double-cover the multi-main case without
 * double-emission since landmark-main lives on `scope: "document"`
 * with its own message.
 */
const DUPLICATE_TAGS: readonly ("nav" | "aside" | "form" | "main")[] = [
  "nav",
  "aside",
  "form",
  "main",
];

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
      "When a document ships two or more landmarks of the same type (nav, aside, form, main), each one needs a distinguishing aria-label or aria-labelledby so screen-reader users can tell them apart. A fragment/partial file with a single unlabeled nav/aside/form is flagged too — it will compose with siblings at render.",
    rationale:
      "Screen readers expose landmarks via a dedicated shortcut (D in NVDA, VO+U in VoiceOver, R in JAWS). Two `<nav>` elements with no labels both announce as 'navigation landmark', so a blind user cursoring the landmark list sees 'navigation, navigation' and has to enter each one to discover which is the primary nav. In Jekyll, Astro, Handlebars etc., header partials that ship mobile + desktop copies of the same landmark are the canonical shape of this failure — the duplicate only materializes after the layout composes, so the in-file partial check is load-bearing.",
    goodExample:
      '<header><nav aria-label="Primary">…</nav><nav aria-label="Mobile">…</nav></header>',
    badExample: "<header><nav>…desktop…</nav><nav>…mobile…</nav></header>",
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/TR/WCAG22/#bypass-blocks",
      "https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/examples/navigation.html",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;

    if (isFragment(doc)) {
      checkFragmentSingleLandmark(ctx, doc);
      return;
    }

    checkDuplicateLandmarks(ctx, doc);
  },
});

/**
 * True when the parsed document does not look like a full HTML page.
 *
 * A full page has `<html>` as a root element, a `<body>` somewhere
 * inside, or both. A partial / fragment — Jekyll `_includes/header.html`,
 * Astro slot, Handlebars partial — has neither; it's a chunk of
 * markup meant to be composed into a parent layout at render time.
 *
 * Heuristic intentionally simple (no path-based guessing): if there's
 * no `<html>` root and no `<body>` descendant, the document is a
 * fragment. Matches the approach already documented in
 * `src/rules/semantics/landmark-main.ts`'s `looksLikeFullPage` while
 * inverting the sense (that helper gates on "has landmarks already",
 * this one gates on "has page-wrapper tags").
 */
function isFragment(doc: HtmlDocument): boolean {
  const htmlRoots = findHtmlElementsByTag(doc, "html");
  if (htmlRoots.length > 0) return false;
  const bodies = findHtmlElementsByTag(doc, "body");
  if (bodies.length > 0) return false;
  return true;
}

/**
 * Fragment-file landmark path.
 *
 * A fragment is a Jekyll/Astro/Handlebars include target — a markup
 * chunk that gets composed into a parent layout at render time.
 * Two sub-cases:
 *
 * 1. Multiple same-type landmarks in the fragment → same shape as
 *    the full-page duplicate path (one finding per unlabeled
 *    landmark, duplicate-suggestion message).
 *
 * 2. Single unlabeled `<nav>` / `<aside>` / `<form>` in the fragment
 *    → emit the fragment-single-landmark finding. At the time the
 *    partial is authored there's no sibling landmark to check
 *    against, but once the layout composes (header + content +
 *    footer partials) a second `<nav>` almost always appears. Label
 *    now so the duplicate doesn't ship unlabeled.
 *
 * `<main>` is excluded from sub-case 2 — `semantics/landmark-main`
 * already polices main uniqueness, and a fragment whose sole
 * content is the main landmark is the normal Jekyll/Astro layout
 * shape. `<main>` duplicates inside a fragment still fall through
 * to sub-case 1.
 */
function checkFragmentSingleLandmark(ctx: FileContext, doc: HtmlDocument): void {
  // First pass: multi-instance same-type landmarks (nav/aside/form/main).
  // Fires the duplicate path; identical to the full-page case.
  const handled = new Set<string>();
  for (const tag of DUPLICATE_TAGS) {
    const all = findHtmlElementsByTag(doc, tag);
    if (all.length <= 1) continue;
    emitDuplicatesForTag(ctx, tag, all);
    handled.add(tag);
  }

  // Second pass: single unlabeled nav/aside/form anywhere in the
  // fragment. Skip any tag the duplicate pass already handled (no
  // double-emission on the same element).
  for (const tag of LANDMARK_TAGS) {
    if (handled.has(tag)) continue;
    const all = findHtmlElementsByTag(doc, tag);
    if (all.length !== 1) continue;
    const el = all[0];
    if (!el) continue;
    if (hasAccessibleName(el)) continue;
    ctx.emit({
      severity: "warning",
      location: {
        filePath: "",
        line: el.loc.start.line,
        column: el.loc.start.column,
      },
      message: `Fragment contains a single unlabeled <${tag}> landmark. When composed into a layout, it will likely sit alongside another <${tag}> and screen readers will announce both with the same generic role name.`,
      suggestion: fragmentSuggestion(tag),
    });
  }
}

/**
 * Full-page path: two or more landmarks of the same type anywhere in
 * the document. Emits one finding per unlabeled landmark in the set —
 * the fix is specific to each occurrence (which label to add), so the
 * emission is per-instance rather than per-set.
 */
function checkDuplicateLandmarks(ctx: FileContext, doc: HtmlDocument): void {
  for (const tag of DUPLICATE_TAGS) {
    const all = findHtmlElementsByTag(doc, tag);
    if (all.length <= 1) continue;
    emitDuplicatesForTag(ctx, tag, all);
  }
}

function emitDuplicatesForTag(ctx: FileContext, tag: string, all: readonly HtmlElement[]): void {
  const labeledCount = all.filter(hasAccessibleName).length;
  const unlabeled = all.filter((el) => !hasAccessibleName(el));
  if (unlabeled.length === 0) return;
  const otherLines = all.map((el) => el.loc.start.line);
  for (const el of unlabeled) {
    const siblings = otherLines.filter((line) => line !== el.loc.start.line);
    ctx.emit({
      severity: "warning",
      location: {
        filePath: "",
        line: el.loc.start.line,
        column: el.loc.start.column,
      },
      message: `Document has ${all.length} <${tag}> landmarks; this one has no aria-label or aria-labelledby, so screen readers cannot tell it apart from the ${siblings.length === 1 ? "other" : "others"}.`,
      suggestion: duplicateSuggestion(tag, all.length, labeledCount, siblings),
    });
  }
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

function fragmentSuggestion(tag: string): string {
  const hint = fragmentRoleHint(tag);
  return `Add aria-label="<purpose>" (or aria-labelledby referencing a heading id) to this <${tag}>. ${hint} If this fragment is guaranteed to be the only <${tag}> on every rendered page, the label is still useful — screen-reader landmark lists read the label before the role.`;
}

function fragmentRoleHint(tag: string): string {
  if (tag === "nav") {
    return 'Typical values: "Primary", "Breadcrumb", "Footer", "Mobile", "Table of contents".';
  }
  if (tag === "aside") {
    return 'Typical values: "Related articles", "Sidebar", "Table of contents", "Advertisements".';
  }
  return 'Typical values: "Search", "Subscribe", "Contact".';
}

function duplicateSuggestion(
  tag: string,
  total: number,
  labeledCount: number,
  siblings: readonly number[],
): string {
  const siblingList = siblings.join(", ");
  const siblingLabel = siblings.length === 1 ? `line ${siblingList}` : `lines ${siblingList}`;
  const rolePurposeHint = fragmentRoleHint(tag);
  if (labeledCount === 0) {
    return `${total} <${tag}> landmarks in this document (other ${siblings.length === 1 ? "is" : "are"} at ${siblingLabel}); none have aria-label / aria-labelledby. Add a distinct aria-label to each — ${rolePurposeHint}`;
  }
  return `${total} <${tag}> landmarks in this document (other ${siblings.length === 1 ? "is" : "are"} at ${siblingLabel}); this one has no aria-label / aria-labelledby while ${labeledCount} ${labeledCount === 1 ? "does" : "do"}. Add aria-label to this <${tag}> so it reads distinctly in the screen-reader landmark list. ${rolePurposeHint}`;
}
