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
 * Scope: HTML documents with a `<body>` (fragments without a body
 * are typically components, not pages, and we don't assume they
 * need a landmark). JSX files are out of scope because a JSX
 * fragment rarely represents a full page — apps use router layouts
 * to add the main landmark at the shell level, and we'd produce
 * false positives flagging every route component.
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
    // and test fixtures for other rules) that have no landmark
    // structure at all. The heuristic: a page has at least one
    // other landmark-ish element (header/nav/footer) or several
    // top-level block children.
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

// A page "looks like a page" when the author has already reached
// for structural landmarks — header, nav, footer, or aside. If the
// document is just content (headings + paragraphs + images), we
// don't have enough signal to demand `<main>` and would produce
// noise on email templates, minimal test fixtures, and snippets.
const LANDMARK_TAGS: ReadonlySet<string> = new Set(["header", "nav", "footer", "aside"]);

function looksLikeFullPage(_body: HtmlElement, doc: HtmlDocument): boolean {
  for (const el of walkHtmlElements(doc)) {
    if (LANDMARK_TAGS.has(el.tagName.toLowerCase())) return true;
  }
  return false;
}
