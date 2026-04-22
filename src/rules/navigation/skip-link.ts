/**
 * Rule: navigation/skip-link
 * Satisfies: wcag22:2.4.1, wcag21:2.4.1
 * Spec: https://www.w3.org/TR/WCAG22/#bypass-blocks
 *
 * > A mechanism is available to bypass blocks of content that are
 * > repeated on multiple Web pages.
 *
 * The conventional skip-link pattern: the first focusable element
 * in a document is an anchor with an in-page href like `#main`
 * that jumps past the nav to the primary content. Keyboard users
 * press Tab once to focus the link, then Enter to jump — bypassing
 * the N items in the primary nav without having to Tab through
 * each one on every page.
 *
 * Two detection paths:
 *
 * 1. Primary-nav gating. On documents with a `<nav>` landmark
 *    containing multiple links, the first `<a href>` before that
 *    nav must (a) have an in-page href (`#something`) and (b)
 *    reference a valid id. Missing/non-matching → warning.
 *
 * 2. Any skip-link-shaped anchor. An `<a href="#foo">` whose class
 *    or visible text identifies it as a skip link ("Skip to main
 *    content", "Skip navigation", class="skip-link" etc.) must
 *    resolve to an `id="foo"` element in the same parsed file,
 *    regardless of whether the primary-nav gating fired. Path 2
 *    catches the Bootstrap `accessibility.mdx` failure mode where
 *    the page documents `href="#content"` as canonical while the
 *    layout renders `<main>` without that id — path 1's nav-gating
 *    would miss that case on any route that doesn't happen to have
 *    a `<nav>` with ≥2 links in the same parsed file.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  getHtmlAttribute,
  htmlTextContent,
  truncateForEcho,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import { stripTemplateDirectives } from "../../input/parsers/html-template-directives.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";
import type { FileContext } from "../../types/rule.ts";

const NAV_LINK_MIN = 2;

export const rule = defineRule({
  id: "navigation/skip-link",
  satisfies: ["wcag22:2.4.1", "wcag21:2.4.1"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      "Pages with a primary navigation should offer a skip link as the first focusable element so keyboard users can bypass the nav on every page, and any skip-link-shaped anchor must resolve to an existing id in the same document.",
    rationale:
      "Keyboard-only users (including people using screen readers and people with motor impairments) Tab through every focusable element in source order. On a page with a 12-item primary nav, that's 12 Tab presses on every navigation between pages — which compounds fast. The skip-link pattern is the standard answer: a link at the very top of the page that jumps to `#main`, hidden off-screen until focused.",
    goodExample:
      '<a class="skip-link" href="#main">Skip to main content</a>…<nav>…</nav>…<main id="main">…</main>',
    badExample: "<nav>…12 links…</nav><main>…</main>  <!-- no skip link -->",
    normativeQuote:
      "A mechanism is available to bypass blocks of content that are repeated on multiple Web pages.",
    references: [
      "https://www.w3.org/TR/WCAG22/#bypass-blocks",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G1",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;
    const ids = collectIds(doc);
    const reportedAnchors = new Set<HtmlElement>();

    checkPrimaryNavPath(ctx, doc, ids, reportedAnchors);

    // Second path: any skip-link-shaped anchor with an in-page href whose
    // target id does not exist in this parsed file. Runs even when the
    // primary-nav gating above didn't fire (no <nav>, or only one link),
    // because a skip link that points at nothing is a 2.4.1 failure
    // regardless of whether the page also has a multi-link nav.
    for (const el of walkHtmlElements(doc)) {
      if (el.tagName.toLowerCase() !== "a") continue;
      if (reportedAnchors.has(el)) continue;
      const href = getHtmlAttribute(el, "href");
      if (href === null) continue;
      if (!href.startsWith("#") || href === "#") continue;
      if (!looksLikeSkipLink(el)) continue;
      // Skip template-valued hrefs (`#{{ section.slug }}`): the target
      // id renders at runtime, so we cannot determine statically
      // whether the landing element exists. Defer to the agent; echoing
      // the raw directive as the "missing target" would be dishonest.
      if (stripTemplateDirectives(href).stripped) continue;

      const targetId = href.slice(1);
      if (ids.has(targetId)) continue;

      const echoTargetId = truncateForEcho(targetId);
      ctx.emit({
        severity: "warning",
        location: {
          filePath: "",
          line: el.loc.start.line,
          column: el.loc.start.column,
        },
        message: `Skip link targets '#${echoTargetId}' but no element in the document has that id.`,
        suggestion: `Add id="${echoTargetId}" to the landing element (usually your <main> landmark) so focus lands there on activation. If the target lives in a different file (e.g. a shared layout), move the skip link into the same document as its target — in-page anchors don't resolve across files.`,
      });
      reportedAnchors.add(el);
    }
  },
});

function checkPrimaryNavPath(
  ctx: FileContext,
  doc: HtmlDocument,
  ids: Set<string>,
  reportedAnchors: Set<HtmlElement>,
): void {
  const navs = findHtmlElementsByTag(doc, "nav");
  if (navs.length === 0) return;
  const firstNav = navs[0];
  if (!firstNav) return;
  if (linksInside(firstNav).length < NAV_LINK_MIN) return;

  const firstLink = firstFocusableAnchor(doc);
  if (!(firstLink && precedesElement(firstLink, firstNav))) {
    ctx.emit({
      severity: "warning",
      location: {
        filePath: "",
        line: firstNav.loc.start.line,
        column: firstNav.loc.start.column,
      },
      message:
        "No skip link precedes the primary <nav>. Keyboard users will Tab through every link in the nav on every page.",
      suggestion:
        'Add <a href="#main">Skip to main content</a> (or similar) as the first focusable element, with `#main` pointing to your <main> landmark. Visually hide it with CSS and reveal on :focus. See https://www.w3.org/WAI/WCAG22/Techniques/general/G1.',
    });
    return;
  }

  const href = getHtmlAttribute(firstLink, "href") ?? "";
  if (!href.startsWith("#") || href === "#") {
    ctx.emit({
      severity: "warning",
      location: {
        filePath: "",
        line: firstLink.loc.start.line,
        column: firstLink.loc.start.column,
      },
      message:
        "First link on the page is not a skip link. Expected href='#<target-id>' bypassing the primary nav.",
      suggestion:
        'Point the first link at an in-page anchor, e.g. href="#main", matching your <main id="main"> landmark.',
    });
    reportedAnchors.add(firstLink);
    return;
  }

  const targetId = href.slice(1);
  // Template-valued target ids (`#{{ section.slug }}`) render at
  // runtime — we can't know whether the landing element exists.
  // Silencing here is consistent with path 2 and avoids echoing a
  // raw Liquid directive as the "missing target."
  if (stripTemplateDirectives(targetId).stripped) return;
  if (!ids.has(targetId)) {
    // `targetId` is a user-authored fragment — ids are conventionally
    // short but pathological inputs can blow the echo. Cap before
    // interpolation.
    const echoTargetId = truncateForEcho(targetId);
    ctx.emit({
      severity: "warning",
      location: {
        filePath: "",
        line: firstLink.loc.start.line,
        column: firstLink.loc.start.column,
      },
      message: `Skip link targets '#${echoTargetId}' but no element in the document has that id.`,
      suggestion: `Add id="${echoTargetId}" to your <main> (or the element the skip link should jump to) so browser focus lands there on activation.`,
    });
    reportedAnchors.add(firstLink);
  }
}

/**
 * Heuristic: does this anchor look like a skip link? Matches when its
 * class list contains a skip-nav idiom or its visible text starts with
 * the canonical "Skip to …" / "Jump to …" phrasing. We only use this
 * for the second-path id-existence check — path 1 still gates on
 * source-order-first-link, so false negatives here are fine (path 1
 * picks them up), and false positives are cheap to dismiss (the agent
 * reads the anchor and confirms).
 */
function looksLikeSkipLink(el: HtmlElement): boolean {
  const cls = (getHtmlAttribute(el, "class") ?? "").toLowerCase();
  if (
    cls.includes("skip-link") ||
    cls.includes("skip-nav") ||
    cls.includes("skiplink") ||
    cls.includes("visually-hidden-focusable")
  ) {
    return true;
  }
  const text = htmlTextContent(el).toLowerCase();
  if (text.length === 0) return false;
  return (
    text.startsWith("skip to") ||
    text.startsWith("skip navigation") ||
    text.startsWith("skip past") ||
    text.startsWith("skip main") ||
    text.startsWith("jump to main") ||
    text.startsWith("jump to content")
  );
}

function linksInside(nav: HtmlElement): HtmlElement[] {
  const links: HtmlElement[] = [];
  collectAnchors(nav, links);
  return links;
}

function collectAnchors(el: HtmlElement, out: HtmlElement[]): void {
  if (el.tagName.toLowerCase() === "a") out.push(el);
  for (const child of el.children) {
    if (child.kind === "HtmlElement") collectAnchors(child, out);
  }
}

function firstFocusableAnchor(doc: HtmlDocument): HtmlElement | null {
  for (const el of walkHtmlElements(doc)) {
    if (el.tagName.toLowerCase() === "a" && getHtmlAttribute(el, "href") !== null) {
      return el;
    }
  }
  return null;
}

function precedesElement(a: HtmlElement, b: HtmlElement): boolean {
  if (a.loc.start.line !== b.loc.start.line) return a.loc.start.line < b.loc.start.line;
  return a.loc.start.column < b.loc.start.column;
}

function collectIds(doc: HtmlDocument): Set<string> {
  const ids = new Set<string>();
  for (const el of walkHtmlElements(doc)) {
    const id = getHtmlAttribute(el, "id");
    if (id !== null && id.length > 0) ids.add(id);
  }
  return ids;
}
