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
 * Three detection paths:
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
 *
 * 3. Opaque-navigation component. When path 1 finds no literal
 *    multi-link `<nav>` but the layout's first significant `<body>`
 *    child is a PascalCase component whose name reads like
 *    navigation chrome (`<Header />`, `<Topbar />`, `<Sidebar />`,
 *    `<AppBar />`, `<NavBar />`, …), the rendered page very likely
 *    contains primary navigation we cannot see from in-file evidence
 *    — and the layout it would compose into needs a skip link the
 *    same way. We can't *prove* that from this file (the component's
 *    body lives elsewhere), so this path emits at `info` severity
 *    with a `reason` framing the question for the agent to verify
 *    by reading the component source. Suppressed when any top-level
 *    `<body>` child is already a skip-link-shaped anchor — the
 *    agent has plausibly handled the case and we avoid a false
 *    positive on layouts that wired the skip link correctly.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  getHtmlAttribute,
  htmlTextContent,
  isHtmlFragment,
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
  // The skip-link target (`#main`, `#content`, …) may live in a
  // sibling layout partial / include / server-rendered wrapper the
  // scanner never parses in this call — the Bootstrap
  // `accessibility.mdx` failure mode noted in the rule docs is
  // exactly that shape. Declaring `crossFileCapable: false` routes a
  // clean tally on HTML substrates to `coverageConfidence: "medium"`
  // with the IDREF-resolution reason code per ADR 0026 — surfacing
  // the blindspot rather than hiding it behind a confident `"high"`.
  crossFileCapable: false,
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

    const primaryNavApplied = checkPrimaryNavPath(ctx, doc, ids, reportedAnchors);
    checkSkipLinkShapedAnchors(ctx, doc, ids, reportedAnchors);
    if (!primaryNavApplied) checkOpaqueNavComponent(ctx, doc);
  },
});

/**
 * Second path: any skip-link-shaped anchor with an in-page href whose
 * target id does not exist in this parsed file. Runs even when the
 * primary-nav gating above didn't fire (no `<nav>`, or only one link),
 * because a skip link that points at nothing is a 2.4.1 failure
 * regardless of whether the page also has a multi-link nav.
 */
function checkSkipLinkShapedAnchors(
  ctx: FileContext,
  doc: HtmlDocument,
  ids: Set<string>,
  reportedAnchors: Set<HtmlElement>,
): void {
  for (const el of walkHtmlElements(doc)) {
    const targetId = resolveSkipLinkTargetId(el, reportedAnchors);
    if (targetId === null) continue;
    if (ids.has(targetId)) continue;
    const echoTargetId = truncateForEcho(targetId);
    ctx.emit({
      severity: "warning",
      location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
      message: `Skip link targets '#${echoTargetId}' but no element in the document has that id.`,
      suggestion: `Add id="${echoTargetId}" to the landing element (usually your <main> landmark) so focus lands there on activation. If the target lives in a different file (e.g. a shared layout), move the skip link into the same document as its target — in-page anchors don't resolve across files.`,
    });
    reportedAnchors.add(el);
  }
}

/**
 * PascalCase component names that read like primary-navigation chrome.
 * Pulled out as a top-level constant so a sibling check (e.g. the
 * upcoming nested-nav-detector that also walks for opaque nav-shaped
 * components inside `<header>` or further down the body) can reuse the
 * same vocabulary without re-deriving it.
 */
const OPAQUE_NAV_NAME_RE = /header|nav|chrome|topbar|appbar|sidebar/i;

/**
 * `true` when the element's tag is a PascalCase component (first char
 * uppercase, distinguishing `<Header />` from native `<header>`) whose
 * name reads like primary-navigation chrome. Exposed at file scope so
 * the upcoming nested-nav detector can apply the same predicate to
 * non-first-child positions without duplicating the regex.
 */
function isOpaqueNavComponent(el: HtmlElement): boolean {
  const name = el.tagName;
  if (name.length === 0) return false;
  const first = name.charCodeAt(0);
  // PascalCase: ASCII A–Z. Native HTML elements are always lowercase
  // after parsing — the parser preserves source casing on custom tags
  // but never up-cases native ones, so this is a clean discriminator.
  if (first < 65 || first > 90) return false;
  return OPAQUE_NAV_NAME_RE.test(name);
}

/**
 * First non-whitespace, non-comment `HtmlElement` child of `<body>`.
 * Returns `null` when the document has no `<body>`, when `<body>` has
 * no element children, or when only text/comment nodes precede a body
 * with no real elements. Comments and pure-whitespace text are skipped
 * because they are visually empty — the "first thing the user sees"
 * notion the WCAG bypass-blocks pattern targets is the first rendered
 * element, not the first source-order node.
 */
function firstSignificantBodyChild(doc: HtmlDocument): HtmlElement | null {
  const bodies = findHtmlElementsByTag(doc, "body");
  const body = bodies[0];
  if (!body) return null;
  for (const child of body.children) {
    if (child.kind === "HtmlComment" || child.kind === "HtmlDoctype") continue;
    if (child.kind === "HtmlText") {
      if (child.value.trim().length === 0) continue;
      // Non-whitespace text directly inside <body> is unusual but real
      // (e.g. error-page HTML); treat it as a real element preceding
      // any opaque component, which means the opaque-nav check stays
      // silent — the agent can verify by reading.
      return null;
    }
    if (child.kind === "HtmlElement") return child;
  }
  return null;
}

/**
 * `true` when any direct child of `<body>` is a skip-link-shaped
 * anchor — i.e. an `<a href="#…">` whose class or visible text
 * matches `looksLikeSkipLink`. Used to suppress the opaque-nav-
 * component path 3 emission: if the layout already has a top-level
 * skip link, the agent has plausibly handled the case and we avoid a
 * false positive. Direct-child scope (not deep walk) because a skip
 * link buried inside the opaque component itself is the very thing
 * the agent needs to verify — we can't see it from this file.
 */
function bodyHasTopLevelSkipLinkAnchor(doc: HtmlDocument): boolean {
  const bodies = findHtmlElementsByTag(doc, "body");
  const body = bodies[0];
  if (!body) return false;
  for (const child of body.children) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() !== "a") continue;
    const href = getHtmlAttribute(child, "href");
    if (href === null || !href.startsWith("#") || href === "#") continue;
    if (looksLikeSkipLink(child)) return true;
  }
  return false;
}

/**
 * Path 3: opaque-navigation component. When path 1 found no literal
 * multi-link `<nav>` to check against, but the layout's first
 * significant `<body>` child is a PascalCase component whose name
 * reads like navigation chrome (`<Header />`, `<Topbar />`,
 * `<Sidebar />`, `<AppBar />`, `<NavBar />`), the rendered page very
 * likely contains primary navigation that needs a skip link. We emit
 * at `info` severity with a `reason` framing the question for the
 * agent — this is a candidate to verify, not a deterministic finding,
 * because the component's body lives in a different file and we
 * cannot prove navigation is present from here. Per the AI-first
 * doctrine, the right response is to surface and annotate, not
 * suppress: silently passing because the literal `<nav>` is hidden
 * inside an opaque wrapper is a real silent-miss failure mode.
 *
 * Suppressed when any top-level `<body>` child is already a
 * skip-link-shaped anchor — the layout has plausibly handled the
 * case (the skip link will land on whatever id the agent wired up,
 * and path 2 separately checks id-existence for skip-link-shaped
 * anchors). Also suppressed on fragments: a fragment has no `<body>`,
 * `firstSignificantBodyChild` returns `null`, the path stays silent.
 */
function checkOpaqueNavComponent(ctx: FileContext, doc: HtmlDocument): void {
  if (isHtmlFragment(doc)) return;
  if (bodyHasTopLevelSkipLinkAnchor(doc)) return;
  const first = firstSignificantBodyChild(doc);
  if (!(first && isOpaqueNavComponent(first))) return;
  const echoName = truncateForEcho(first.tagName);
  ctx.emit({
    severity: "info",
    location: {
      filePath: "",
      line: first.loc.start.line,
      column: first.loc.start.column,
    },
    message: `First <body> child is opaque component <${echoName} />; if it renders primary navigation, the page needs a skip link.`,
    suggestion: `Verify a skip link is the first focusable descendant of <${echoName} />, or add a top-level <a href="#main">Skip to main content</a> before <${echoName} /> in this layout (with <main id="main"> as the landing target). If <${echoName} /> doesn't render navigation, no action is needed — this is a candidate, not a confirmed failure.`,
  });
}

/**
 * Narrows a walked element to a skip-link-shaped anchor whose href is
 * a static in-page fragment. Returns the trimmed target id when the
 * caller should evaluate id-existence, or `null` to skip. Template-
 * valued hrefs (`#{{ section.slug }}`) render at runtime and are
 * deferred to the agent; echoing the raw directive as the "missing
 * target" would be dishonest.
 */
function resolveSkipLinkTargetId(
  el: HtmlElement,
  reportedAnchors: Set<HtmlElement>,
): string | null {
  if (el.tagName.toLowerCase() !== "a") return null;
  if (reportedAnchors.has(el)) return null;
  const href = getHtmlAttribute(el, "href");
  if (href === null || !href.startsWith("#") || href === "#") return null;
  if (!looksLikeSkipLink(el)) return null;
  if (stripTemplateDirectives(href).stripped) return null;
  return href.slice(1);
}

/**
 * Returns `true` when a literal multi-link `<nav>` was present in this
 * file (whether or not the path emitted) — that signal lets the caller
 * suppress path 3 (opaque-nav-component), which is only meant to fire
 * when the file has *no* in-file nav evidence path 1 could have used.
 * Returns `false` on fragments, on documents with no `<nav>`, or on
 * docs where the first `<nav>` has too few links to be primary nav.
 */
function checkPrimaryNavPath(
  ctx: FileContext,
  doc: HtmlDocument,
  ids: Set<string>,
  reportedAnchors: Set<HtmlElement>,
): boolean {
  // Fragment files — Jekyll `_includes/header.html`, Hugo partials,
  // Astro slots, Handlebars include targets — have no `<html>` root
  // and no `<body>`. The primary-nav skip-link check assumes the
  // document IS the page: "first focusable element in the document
  // precedes the primary nav." A fragment has no document-level first-
  // focusable notion — the composed layout it gets included into does,
  // but that's a cross-file concern we can't evaluate in isolation.
  // Firing the primary-nav path on a fragment is a false positive
  // indistinguishable from a real page missing its skip link.
  //
  // The second path (skip-link-shaped anchor with missing in-page
  // target) stays live on fragments: a broken `#target` anchor is
  // honestly wrong regardless of whether the file is a fragment or a
  // full page, and the target it claims is supposed to exist in the
  // same document.
  //
  // Doctrine (docs/kb/architecture/ai-first-consumer.md): rule-level
  // scope selection, not finding-level suppression — this is the same
  // shape as landmark-main gating on `<body>` presence. The MCP
  // `analysisCoverage.fragmentFiles` signal surfaces the list of files
  // treated as fragments so an agent can verify the composed layout
  // elsewhere.
  if (isHtmlFragment(doc)) return false;
  const navs = findHtmlElementsByTag(doc, "nav");
  if (navs.length === 0) return false;
  const firstNav = navs[0];
  if (!firstNav) return false;
  if (linksInside(firstNav).length < NAV_LINK_MIN) return false;

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
    return true;
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
    return true;
  }

  const targetId = href.slice(1);
  // Template-valued target ids (`#{{ section.slug }}`) render at
  // runtime — we can't know whether the landing element exists.
  // Silencing here is consistent with path 2 and avoids echoing a
  // raw Liquid directive as the "missing target."
  if (stripTemplateDirectives(targetId).stripped) return true;
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
  return true;
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
