/**
 * Rule: semantics/section-accessible-name-missing
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *       https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are
 * > available in text.
 *
 * > For all user interface components … name and role can be
 * > programmatically determined …
 *
 * HTML5 promotes `<section>` to a landmark role (`region`) ONLY when
 * the element has an accessible name. Without one, browsers
 * intentionally drop the implicit `role="region"` and the element
 * behaves like a generic `<div>` for assistive technology — the
 * author's structural intent is silently discarded.
 *
 * Scoping is deliberate and narrow. Many `<section>` usages inside
 * articles, cards, or prose are legitimately unnamed per spec, so
 * firing on every naked `<section>` would be noisy. This rule only
 * flags `<section>` usages that look like they were authored AS
 * landmarks:
 *
 * 1. A `<section>` that is a direct child of `<body>` — the author
 *    reached for a sectioning element at the page-level structure
 *    layer, alongside `<header>`, `<nav>`, `<main>`, `<aside>`,
 *    `<footer>`.
 * 2. A `<section>` that sits as a sibling to an explicit landmark
 *    (`<main>`, `<nav>`, `<aside>`, `<header>`, `<footer>`, `<form>`)
 *    under any parent — the author placed it in the top-level landmark
 *    row. These unnamed sections break the landmark list for AT users.
 *
 * Acceptable accessible-name sources (presence only — see below):
 *   - `aria-label` with any non-whitespace value
 *   - `aria-labelledby` referencing at least one token (dangling-id
 *     validation is `aria/labelledby-target-exists`'s job; this rule
 *     only checks whether the author pointed somewhere)
 *   - A direct-child `<h1>` … `<h6>` (spec-sanctioned: authors commonly
 *     pair a section with its leading heading, and `aria-labelledby`
 *     typically points at exactly that heading)
 *
 * `title` is not accepted: it's advisory, not a reliable landmark
 * name.
 *
 * Fragment files (Jekyll `_includes/…`, Handlebars partials, Astro
 * slots) are skipped entirely — we can't see their composed parent,
 * so any top-level `<section>` might or might not end up under
 * `<body>` at render time. The duplicate-landmark rule handles
 * fragment-single-nav; section doesn't get the same treatment because
 * `<section>` is a weaker landmark and the false-positive cost is
 * higher.
 */

import { defineRule } from "../../api/plugin.ts";
import { findHtmlElementsByTag, getHtmlAttribute } from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, HtmlNode } from "../../types/ast.ts";
import type { FileContext } from "../../types/rule.ts";

/**
 * Landmark tag names whose presence as a sibling promotes a `<section>`
 * into the top-level-landmark row. The author who put a `<section>`
 * next to one of these was clearly in landmark-authoring mode — the
 * unnamed section at their side breaks landmark navigation.
 *
 * `<form>` is included because a labeled `<form>` is a landmark under
 * ARIA; an unnamed section sitting next to a search form reads as a
 * peer region but announces as a generic div.
 */
const LANDMARK_SIBLING_TAGS: ReadonlySet<string> = new Set([
  "main",
  "nav",
  "aside",
  "header",
  "footer",
  "form",
]);

/**
 * Heading tags that — when used as a direct child of `<section>` —
 * provide an accessible name via the HTML5 sectioning algorithm. The
 * screen-reader compute-accessible-name walk falls back to the first
 * heading of a sectioning content root in the absence of aria-label.
 */
const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export const rule = defineRule({
  id: "semantics/section-accessible-name-missing",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:4.1.2", "wcag21:4.1.2"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      "A <section> used as a top-level content wrapper (direct child of <body> or sibling to other landmarks) needs an accessible name — aria-label, aria-labelledby, or a direct-child <h1>-<h6> heading — otherwise assistive tech treats it as a generic <div>.",
    rationale:
      "HTML5 only promotes <section> to the ARIA 'region' landmark role when the element has an accessible name. Without one, the browser accessibility tree strips the region role and the section becomes a generic grouping element for screen readers — the author's intent to carve out a top-level region is silently discarded. In NVDA/JAWS/VoiceOver landmark lists, an unnamed section simply does not appear, so a blind user cursoring by landmark skips over it entirely. Scoping the rule to body-level sections and landmark-siblings keeps the bar high: prose sections inside articles are fine unnamed, but a <section> sitting alongside <main> or <nav> was clearly intended as a landmark.",
    goodExample:
      '<body><main>…</main><section aria-labelledby="related-h"><h2 id="related-h">Related</h2>…</section></body>',
    badExample: "<body><main>…</main><section>Related articles…</section></body>",
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/TR/html-aria/#el-section",
      "https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/examples/region.html",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;

    // Fragment files: no <body>, no <html> wrapper. We can't decide
    // whether a top-level <section> composes into a landmark row, so
    // we don't fire. Over-triggering on fragments was the primary
    // concern on the backlog item.
    if (isFragment(doc)) return;

    checkSections(ctx, doc);
  },
});

/**
 * True when the parsed document does not look like a full HTML page.
 * Matches the shape used by duplicate-landmark-unlabeled: no `<html>`
 * root and no `<body>` descendant means the file is a partial that
 * will compose into a parent layout at render time.
 */
function isFragment(doc: HtmlDocument): boolean {
  const htmlRoots = findHtmlElementsByTag(doc, "html");
  if (htmlRoots.length > 0) return false;
  const bodies = findHtmlElementsByTag(doc, "body");
  if (bodies.length > 0) return false;
  return true;
}

/**
 * Walk every `<section>` in the document, classify whether it
 * qualifies for the rule (body-direct-child OR landmark-sibling), and
 * emit when it qualifies AND has no accessible name.
 *
 * Classification uses a single parent-walk over the document rather
 * than caching parents globally — cheap enough for the handful of
 * `<section>` elements a page typically carries, and keeps the rule
 * free of cross-rule state.
 */
function checkSections(ctx: FileContext, doc: HtmlDocument): void {
  const sections = findHtmlElementsByTag(doc, "section");
  if (sections.length === 0) return;

  const parentMap = buildParentMap(doc);

  for (const section of sections) {
    const trigger = classifySection(section, parentMap);
    if (trigger === "not-applicable") continue;
    if (hasAccessibleName(section)) continue;

    ctx.emit({
      severity: "warning",
      location: {
        filePath: "",
        line: section.loc.start.line,
        column: section.loc.start.column,
      },
      message: buildMessage(trigger),
      suggestion: buildSuggestion(section, trigger),
    });
  }
}

/** Builds a child→parent map from a single document-order walk. */
function buildParentMap(doc: HtmlDocument): Map<HtmlElement, HtmlElement | "document"> {
  const parents = new Map<HtmlElement, HtmlElement | "document">();
  const visitChildren = (children: readonly HtmlNode[], parent: HtmlElement | "document"): void => {
    for (const child of children) {
      if (child.kind !== "HtmlElement") continue;
      parents.set(child, parent);
      visitChildren(child.children, child);
    }
  };
  visitChildren(doc.children, "document");
  return parents;
}

type Trigger = "body-direct-child" | "landmark-sibling" | "not-applicable";

/**
 * Decide whether this `<section>` is one of the two in-scope shapes.
 *
 * 1. **body-direct-child** — the section's immediate parent is a
 *    `<body>`. The author wrote a top-level sectioning element.
 * 2. **landmark-sibling** — the section has at least one sibling with
 *    a tag in `LANDMARK_SIBLING_TAGS`. Fires even when the parent is
 *    not `<body>` (e.g. a wrapping `<div class="layout">` shell).
 */
function classifySection(
  section: HtmlElement,
  parentMap: Map<HtmlElement, HtmlElement | "document">,
): Trigger {
  const parent = parentMap.get(section);
  if (!parent || parent === "document") return "not-applicable";
  if (parent.tagName.toLowerCase() === "body") return "body-direct-child";
  for (const sibling of parent.children) {
    if (sibling.kind !== "HtmlElement") continue;
    if (sibling === section) continue;
    if (LANDMARK_SIBLING_TAGS.has(sibling.tagName.toLowerCase())) return "landmark-sibling";
  }
  return "not-applicable";
}

/**
 * Presence-only accessible-name signal. Matches duplicate-landmark's
 * approach — we intentionally do NOT resolve `aria-labelledby` targets
 * (a dangling labelledby is `aria/labelledby-target-exists`'s
 * problem), and we accept a direct-child heading because the HTML5
 * sectioning algorithm uses it.
 *
 * `title` is not accepted: the ARIA spec discourages it as a
 * name-of-last-resort and it produces inconsistent announcements
 * across screen readers.
 */
function hasAccessibleName(section: HtmlElement): boolean {
  const label = getHtmlAttribute(section, "aria-label");
  if (label !== null && label.trim().length > 0) return true;
  const labelledby = getHtmlAttribute(section, "aria-labelledby");
  if (labelledby !== null && labelledby.trim().length > 0) return true;
  for (const child of section.children) {
    if (child.kind !== "HtmlElement") continue;
    if (HEADING_TAGS.has(child.tagName.toLowerCase())) return true;
  }
  return false;
}

function buildMessage(trigger: Trigger): string {
  if (trigger === "body-direct-child") {
    return "<section> is a direct child of <body> but has no accessible name (aria-label / aria-labelledby / direct-child heading) — assistive tech drops the implicit region role and announces it as a generic div.";
  }
  return "<section> sits alongside other landmarks but has no accessible name (aria-label / aria-labelledby / direct-child heading) — it will not appear in the screen-reader landmark list.";
}

function buildSuggestion(section: HtmlElement, trigger: Trigger): string {
  const idHint = describeIdentity(section);
  const placement =
    trigger === "body-direct-child"
      ? "This <section> is a direct child of <body>"
      : "This <section> sits alongside explicit landmarks (<main>/<nav>/<aside>/<header>/<footer>/<form>)";
  return `${placement}${idHint}. Pick one of: (a) add aria-label="<purpose>" naming the region (e.g. "Related articles", "Featured", "Search results"); (b) add a direct-child <h2> (or any heading) whose text names the region — the HTML5 sectioning algorithm accepts it as the accessible name; (c) add aria-labelledby="<id-of-existing-heading>" pointing at a heading already on the page. If the region doesn't merit a landmark, change <section> to <div> — an unnamed <section> is semantically equivalent to <div> but misleads readers of the markup.`;
}

/**
 * Inline an id="…" or class="…" descriptor when present, so the agent
 * can disambiguate this section among siblings in a file carrying
 * several. Falls back to an empty string when neither attribute exists
 * — line numbers remain authoritative.
 */
function describeIdentity(section: HtmlElement): string {
  const id = getHtmlAttribute(section, "id");
  if (id !== null && id.length > 0) return ` with id="${id}"`;
  const cls = getHtmlAttribute(section, "class");
  if (cls !== null && cls.length > 0) return ` with class="${cls}"`;
  return "";
}
