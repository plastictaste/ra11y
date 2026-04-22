/**
 * Rule: semantics/landmark-main
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are
 * > available in text.
 *
 * HTML5 / WAI-ARIA landmark roles expose page structure to
 * assistive tech so users can jump between major regions. The
 * single most important landmark is `main` — there should be
 * exactly one per document, and it should wrap the primary content.
 *
 * Flags documents that either:
 *   - have zero `<main>` / `role="main"` elements
 *   - have more than one (ARIA requires exactly one main landmark)
 *
 * Scope: HTML documents with a `<body>` AND enough page-shape
 * evidence to warrant a landmark — see `looksLikeFullPage()` for
 * the layered branches (explicit landmarks, h1 + body content, or
 * heading + list + interactive). Fragments without a body are
 * typically components, not pages, and we don't assume they need
 * a landmark. JSX files are out of scope because a JSX fragment
 * rarely represents a full page — apps use router layouts to add
 * the main landmark at the shell level, and we'd produce false
 * positives flagging every route component.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  getHtmlAttribute,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";

export const rule = defineRule({
  id: "semantics/landmark-main",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      "Every page should have exactly one <main> landmark. Screen-reader users jump between landmarks to skip repetitive navigation; a missing main leaves them with no primary-content anchor.",
    rationale:
      "The main landmark is the single most useful navigation target for assistive-tech users. NVDA, JAWS, and VoiceOver all bind a shortcut to 'jump to main'. When it's missing, users have to linearly skim past the header and navigation on every page. When there's more than one, the shortcut becomes ambiguous and users lose the anchor point entirely.",
    goodExample: "<body><header>…</header><main>…</main><footer>…</footer></body>",
    badExample: '<body><header>…</header><div class="content">…</div><footer>…</footer></body>',
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/examples/main.html",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;
    // Only evaluate full documents — a fragment without <body> is
    // probably a component template, not a page.
    const bodies = findHtmlElementsByTag(doc, "body");
    if (bodies.length === 0) return;
    // Only flag on documents that look like real pages — skip
    // minimal documents (e.g. email templates, OG meta shells,
    // and test fixtures for other rules) without enough page-shape
    // evidence. See `looksLikeFullPage()` below for the layered
    // branches.
    if (!looksLikeFullPage(bodies[0] as HtmlElement, doc)) return;

    const mains: HtmlElement[] = [];
    for (const el of walkHtmlElements(doc)) {
      if (isMainLandmark(el)) mains.push(el);
    }

    if (mains.length === 0) {
      const body = bodies[0];
      ctx.emit({
        severity: "warning",
        location: {
          filePath: "",
          line: body?.loc.start.line ?? 1,
          column: body?.loc.start.column ?? 1,
        },
        message:
          "Document has no <main> landmark. Screen-reader users expect exactly one main landmark per page.",
        suggestion:
          'Document has no <main>. Wrap the primary content region — typically the main article/content below the header/nav — in <main> or add role="main" to an existing container. Do not wrap the <header>, <nav>, or <footer> regions in the main landmark.',
      });
      return;
    }

    if (mains.length > 1) {
      const suggestion = buildMultipleMainSuggestion(mains);
      // Report on every extra main so the fix is unambiguous.
      for (let i = 1; i < mains.length; i += 1) {
        const extra = mains[i];
        if (!extra) continue;
        ctx.emit({
          severity: "warning",
          location: {
            filePath: "",
            line: extra.loc.start.line,
            column: extra.loc.start.column,
          },
          message: `Document has ${mains.length} <main> landmarks — ARIA requires exactly one per page.`,
          suggestion,
        });
      }
    }
  },
});

/**
 * Build a disambiguating suggestion for multiple main landmarks.
 *
 * Four branches, ordered by the amount of context we can inline:
 *   1. Every landmark is a role="main" on a non-main element → tell the
 *      caller to remove the attribute from all but one; inline each line.
 *   2. At least one landmark carries an `id` or `class` → inline each
 *      landmark's tag line + id/class so the caller can identify which
 *      one to demote.
 *   3. Plain `<main>` elements with no identifying attributes → fall back
 *      to line-only disambiguation.
 */
function buildMultipleMainSuggestion(mains: readonly HtmlElement[]): string {
  const allRoleOnly = mains.every((el) => el.tagName.toLowerCase() !== "main");
  if (allRoleOnly) {
    const lines = mains.map((el) => el.loc.start.line).join(", ");
    return `Multiple role="main" declarations at lines ${lines}. Remove the attribute from all but one — ARIA requires exactly one main landmark per document.`;
  }

  const descriptors = mains.map((el) => describeMain(el));
  const haveIdentity = descriptors.some((d) => d.identity !== "");
  if (haveIdentity) {
    const joined = descriptors.map((d) => `${d.descriptor} (line ${d.line})`).join(" and ");
    return `Document has ${joined}. Keep exactly one main landmark — demote one of them to <section> or <div> (preserve its id/class).`;
  }

  const lines = mains.map((el) => el.loc.start.line).join(" and ");
  return `Multiple <main> elements at lines ${lines}. Keep one; demote the others to <section> or <div>.`;
}

interface MainDescriptor {
  readonly descriptor: string;
  readonly identity: string;
  readonly line: number;
}

/**
 * Compose a tag-plus-identifying-attributes descriptor for a main
 * landmark. We inline id first, then class (class often carries the
 * disambiguating token when id is absent), then role — the role is
 * included when the element is a non-main carrying role="main", so
 * the descriptor reads as-authored.
 */
function describeMain(el: HtmlElement): MainDescriptor {
  const tag = el.tagName.toLowerCase();
  const id = getHtmlAttribute(el, "id");
  const cls = getHtmlAttribute(el, "class");
  const role = getHtmlAttribute(el, "role");
  const parts: string[] = [];
  if (id) parts.push(`id="${id}"`);
  if (cls) parts.push(`class="${cls}"`);
  if (role && tag !== "main") parts.push(`role="${role}"`);
  const identity = parts.join(" ");
  const descriptor = identity ? `<${tag} ${identity}>` : `<${tag}>`;
  return { descriptor, identity, line: el.loc.start.line };
}

function isMainLandmark(el: HtmlElement): boolean {
  if (el.tagName.toLowerCase() === "main") return true;
  const role = getHtmlAttribute(el, "role");
  return role !== null && role.toLowerCase() === "main";
}

// A page "looks like a page" when one of the following signals is
// present in the body. The branches are layered cheapest-first and
// reflect successively weaker structural evidence:
//
//   A. Explicit landmark structure — header, nav, footer, or aside.
//      The author has already reached for landmarks; expecting `main`
//      is the natural completion.
//
//   B. An `<h1>` plus body content (≥ 5 element descendants of body).
//      A top-level page heading paired with non-trivial body content
//      is the canonical "I'm a page" shape — counter / FAQ / multi-step
//      widget pages all hit this branch. The descendant threshold keeps
//      one-h1-plus-one-img demonstration fixtures (alt-text snippets,
//      parsing-id-shape snippets) below the bar.
//
//   C. Any heading + a list (ul/ol/dl) + at least one interactive
//      element. A heading naming a list of items below an interactive
//      control is "real content area" shape — the hidden-search /
//      product-list pattern. This branch is intentionally narrow: it
//      requires three concurrent signals so isolated demo fixtures
//      (radio group with a heading, link cluster with a heading) stay
//      below the bar.
//
// Below the bar: minimal documents (alt-text snippets, attribute-rule
// fixtures, email templates) that have neither landmarks nor an h1 +
// body content nor a heading + list + interactive trio. Treating those
// as fragments avoids noisy "missing <main>" warnings on documents
// that genuinely have nothing to wrap.
//
// Doctrine note (`docs/kb/architecture/ai-first-consumer.md`): the
// thresholds here gate *whether the rule evaluates*, not whether a
// finding is reported. A document above the bar always emits its
// finding to the agent; a document below the bar is treated as a
// fragment, the same way a body-less document is. This is rule-level
// scope selection, not finding-level suppression.
const LANDMARK_TAGS: ReadonlySet<string> = new Set(["header", "nav", "footer", "aside"]);
const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const LIST_TAGS: ReadonlySet<string> = new Set(["ul", "ol", "dl"]);
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "details",
  "summary",
]);

interface BodyShape {
  readonly hasExplicitLandmark: boolean;
  readonly hasH1: boolean;
  readonly hasHeading: boolean;
  readonly hasList: boolean;
  readonly hasInteractive: boolean;
  readonly descendantCount: number;
}

/**
 * True when `el` is a descendant of `body` — implemented via source-range
 * containment because HtmlElement nodes don't carry parent pointers and
 * the document walk surfaces `<head>` children, the `<html>` root, and
 * any post-`</body>` content alongside body descendants. Range comparison
 * is the cheapest filter that distinguishes them in a single O(n) pass.
 */
function isInsideBody(el: HtmlElement, body: HtmlElement): boolean {
  return el !== body && el.range.start >= body.range.start && el.range.end <= body.range.end;
}

interface ContentSignals {
  hasH1: boolean;
  hasHeading: boolean;
  hasList: boolean;
  hasInteractive: boolean;
}

function tallySignals(tag: string, signals: ContentSignals): void {
  if (tag === "h1") signals.hasH1 = true;
  if (HEADING_TAGS.has(tag)) signals.hasHeading = true;
  if (LIST_TAGS.has(tag)) signals.hasList = true;
  if (INTERACTIVE_TAGS.has(tag)) signals.hasInteractive = true;
}

function inspectBody(body: HtmlElement, doc: HtmlDocument): BodyShape {
  let hasExplicitLandmark = false;
  let descendantCount = 0;
  const signals: ContentSignals = {
    hasH1: false,
    hasHeading: false,
    hasList: false,
    hasInteractive: false,
  };
  // Single document walk: landmark check sees the whole tree (so a
  // `<header>` placed outside `<body>` in parser-tolerant input still
  // counts), content-signal tally is restricted to body descendants
  // via `isInsideBody`.
  for (const el of walkHtmlElements(doc)) {
    const tag = el.tagName.toLowerCase();
    if (LANDMARK_TAGS.has(tag)) hasExplicitLandmark = true;
    if (!isInsideBody(el, body)) continue;
    descendantCount += 1;
    tallySignals(tag, signals);
  }
  return { hasExplicitLandmark, ...signals, descendantCount };
}

function looksLikeFullPage(body: HtmlElement, doc: HtmlDocument): boolean {
  const shape = inspectBody(body, doc);
  // Branch A: explicit landmark structure (existing behavior).
  if (shape.hasExplicitLandmark) return true;
  // Branch B: top-level heading + non-trivial body content.
  if (shape.hasH1 && shape.descendantCount >= 5) return true;
  // Branch C: heading + list + interactive (content-area shape).
  if (shape.hasHeading && shape.hasList && shape.hasInteractive) return true;
  return false;
}
