/**
 * Rule: document/page-titled
 * Satisfies: wcag22:2.4.2, wcag21:2.4.2
 * Spec: https://www.w3.org/TR/WCAG22/#page-titled
 *
 * > Web pages have titles that describe topic or purpose.
 *
 * Source: https://www.w3.org/TR/WCAG22/#page-titled
 *
 * Flags HTML documents whose <head> contains no <title> element or
 * whose <title> is empty. Screen readers announce the title first
 * when a page loads — a missing or empty title leaves users unsure
 * what they landed on.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  getHtmlAttribute,
  htmlTextContent,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import { htmlSubtreeHasStrippedDirective } from "../../input/parsers/html-template-directives.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";

export const rule = defineRule({
  id: "document/page-titled",
  satisfies: ["wcag22:2.4.2", "wcag21:2.4.2"],
  severity: "error",
  scope: "document",
  // The page title must describe topic or purpose — that prose is
  // never a deterministic source transform from the static evidence
  // alone. Tagged `verify-in-source` so `plan.fixesByClass` reflects
  // honest "agent reads adjacent code to author title" expectation
  // rather than the previous `mechanical` lane that always fell
  // through to `kind: "guidance"` in `suggest_fix`. Agents wanting
  // the apply-now subset sum `fixesByClass.mechanical +
  // fixesByClass.verifyInSource` off the structured tally. See ADR
  // 0007 + docs/kb/architecture/ai-first-consumer.md "Per-call shape
  // must agree with per-class plan tally."
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      "HTML documents must have a non-empty <title> element describing topic or purpose.",
    rationale:
      "Screen readers announce the page title when a document loads. A missing or empty title leaves non-sighted users unsure what they've landed on; it also breaks browser tabs, bookmarks, and search engine results.",
    goodExample: `<title>Settings — Acme Dashboard</title>`,
    badExample: `<title></title>`,
    normativeQuote: "Web pages have titles that describe topic or purpose.",
    references: [
      "https://www.w3.org/TR/WCAG22/#page-titled",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G88",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;
    // Only check complete documents — if there's no <html> root, we're
    // looking at a fragment and it's not meaningful to require a title.
    const htmlElements = findHtmlElementsByTag(doc, "html");
    if (htmlElements.length === 0) return;

    const titles = findHtmlElementsByTag(doc, "title");
    // Ignore <title> elements under <svg> or similar namespaces — those
    // are graphical titles, not document titles. For the HTML parser
    // we don't track namespace, so walk up the ancestor chain via tag
    // name heuristic: a document <title> is inside <head>.
    const docTitles = titles.filter((t) => isInsideHead(doc, t));

    // Fragment-shape detection. SSG head-
    // partials (Jekyll `_includes/head.html`, Hugo `partials/head.html`,
    // Eleventy / Astro equivalents) open `<html>` + `<head>` but leave
    // `<body>` to the parent layout, and often inject `<title>` via a
    // template directive (`{% seo %}`, `{% include title.html %}`) that
    // static analysis cannot observe. Per docs/kb/architecture/
    // ai-first-consumer.md "Surface, don't suppress" and "No heuristic
    // suppression," we do NOT skip the finding — the fragment might
    // legitimately be missing a title generator — but we enrich the
    // emit with a structured `couldBeWrongBecause` code and a message
    // suffix so an agent reading the finding routes to the parent
    // layout (or applies the source-level disable pragma) in one read.
    // See docs/adr/0009-violation-could-be-wrong-because.md.
    const fragmentShape = findHtmlElementsByTag(doc, "body").length === 0;

    //. Layouts in component
    // frameworks (Next.js `<Head>`, react-helmet `<Helmet>`, Gatsby
    // `<DocumentHead>`, custom `<Title>`/`<Meta>` wrappers) inject the
    // document <title> at render time. The literal JSX tag is in the
    // file we're scanning — its presence is provable from the code in
    // this file alone, the same evidence model as detecting `<form>`.
    // When such a delegation component is present and there is no
    // literal <title>, asserting "title is missing" would be false:
    // the rendered output WILL have a title supplied by the named
    // component. Suppression here is deterministic, not heuristic —
    // per docs/kb/architecture/ai-first-consumer.md §"No heuristic
    // suppression": the carve-out is a code-provable fact, not a
    // guess about composition. The emit-path message on the
    // remaining (no-delegation) branch reminds the agent that this
    // case was already accounted for.
    const delegation = findHeadDelegationComponent(doc);

    if (docTitles.length === 0) {
      if (delegation !== null) return;
      const htmlEl = htmlElements[0];
      ctx.emit(
        buildEmit(
          doc,
          fragmentShape,
          htmlEl?.loc.start.line ?? 1,
          htmlEl?.loc.start.column ?? 1,
          MESSAGE_MISSING,
        ),
      );
      return;
    }

    for (const title of docTitles) {
      const text = htmlTextContent(title);
      if (text.length > 0) {
        // Scaffold-placeholder title: the <title> has literal content,
        // but it matches a known boilerplate token (`index`, `Untitled`,
        // `Page Title`, `New Page`, etc.) emitted by editor scaffolds
        // and CMS templates and never edited by the author. The literal
        // is provable from the code in this file alone — no guess about
        // composition or rendering — so emission is deterministic, not
        // speculative. Severity is `warning` rather than `error` because
        // a real page might legitimately title itself "Welcome" (e.g. a
        // greeting page); the agent reading the file is the correct
        // arbiter. Per docs/kb/architecture/ai-first-consumer.md
        // §"Surface, don't suppress" we emit; the source-level disable
        // pragma is the durable dismissal path.
        if (isScaffoldPlaceholderTitle(text)) {
          ctx.emit(buildPlaceholderEmit(doc, title, text));
        }
        continue;
      }
      // Template-interpolated title:
      // `<title>{{ page.title }}</title>` — the parser stripped the
      // directive span so `htmlTextContent` returns "", but the static
      // scanner has no way to know whether the rendered value will be
      // a non-empty string. Emit a weaker-confidence finding (warning,
      // distinct message, structured couldBeWrongBecause) rather than
      // a confident "empty title" error. Per docs/kb/architecture/
      // ai-first-consumer.md §"Surface, don't suppress": the candidate
      // still surfaces so the agent sees it; the severity + message
      // reflect the weaker evidence honestly.
      if (htmlSubtreeHasStrippedDirective(title)) {
        ctx.emit(buildTemplateInterpolatedEmit(doc, title));
        continue;
      }
      ctx.emit(
        buildEmit(doc, fragmentShape, title.loc.start.line, title.loc.start.column, MESSAGE_EMPTY),
      );
    }
  },
});

const MESSAGE_MISSING =
  "HTML document is missing a <title> element — browsers and screen readers have nothing to announce.";
const MESSAGE_EMPTY =
  "<title> is empty — screen readers will announce nothing when the page loads.";
const FRAGMENT_SUFFIX =
  " This file has no <body> so it may be a template partial whose <title> is template-injected" +
  " (e.g. Jekyll {% seo %} / Hugo partials / Eleventy includes) — verify against the parent layout before acting.";

/**
 * Builds the emit object shared between the missing-title and
 * empty-title branches. Splits the fragment-shape enrichment out of
 * the main `afterFile` body so the hot path stays under the cognitive-
 * complexity budget — both branches route through the same `ctx.emit`
 * shape, so duplicating the spread at each call site was both verbose
 * and lint-hostile.
 */
function buildEmit(
  doc: HtmlDocument,
  fragmentShape: boolean,
  line: number,
  column: number,
  baseMessage: string,
): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  couldBeWrongBecause?: readonly string[];
} {
  return {
    severity: "error",
    location: { filePath: "", line, column },
    message: fragmentShape ? `${baseMessage}${FRAGMENT_SUFFIX}` : baseMessage,
    suggestion: buildSuggestion(doc),
    ...(fragmentShape ? { couldBeWrongBecause: [TITLE_MAY_BE_TEMPLATE_INJECTED] } : {}),
  };
}

/**
 * Structured `couldBeWrongBecause` code emitted on fragment-shape
 * files (no `<body>`) where the `<title>` could be rendered by a
 * template directive the static scanner cannot observe. Per
 * docs/kb/architecture/ai-first-consumer.md §"No heuristic suppression,"
 * the scanner surfaces the finding with this signal rather than
 * silently skipping — the agent reading the file has categorically
 * stronger evidence than our tag-level heuristic.
 */
const TITLE_MAY_BE_TEMPLATE_INJECTED = "title_may_be_template_injected";

/**
 * Structured `couldBeWrongBecause` code emitted when the `<title>`
 * element's own body is a template directive (`<title>{{ page.title }}</title>`)
 * — the parser stripped the directive span so the in-memory text is
 * empty, but the rendered output at runtime is whatever the template
 * expression evaluates to. Distinct from `title_may_be_template_injected`
 * (which signals "<title> lives in a parent layout"): here the <title>
 * IS present and its content IS a template expression; the rendered
 * value just can't be known statically.
 */
const TITLE_IS_TEMPLATE_INTERPOLATED = "title_is_template_interpolated";

const MESSAGE_TEMPLATE_INTERPOLATED =
  "<title> is template-interpolated — verify the rendered output carries a non-empty title.";

/**
 * Emit for the template-interpolated-title branch.
 * Downgraded to `warning`
 * because the static scanner can't see whether the rendered value will
 * be empty — the existing empty-title error would be a confident false
 * positive on `<title>{{ page.title }}</title>`. Per docs/kb/
 * architecture/ai-first-consumer.md §"Surface, don't suppress" the
 * finding still surfaces so the agent reading the file can verify.
 */
function buildTemplateInterpolatedEmit(
  doc: HtmlDocument,
  title: HtmlElement,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  couldBeWrongBecause: readonly string[];
} {
  return {
    severity: "warning",
    location: { filePath: "", line: title.loc.start.line, column: title.loc.start.column },
    message: MESSAGE_TEMPLATE_INTERPOLATED,
    suggestion: buildSuggestion(doc),
    couldBeWrongBecause: [TITLE_IS_TEMPLATE_INTERPOLATED],
  };
}

/**
 * Lowercased scaffold-placeholder titles emitted by editor templates,
 * CMS new-page wizards, and HTML boilerplates and never customized by
 * the author. Each entry is the fully-trimmed, lowercased form so the
 * predicate is case-insensitive and whitespace-tolerant. Detection is
 * by literal-string match — no fuzzy comparison, no substring — so
 * `<title>Index of /docs</title>` (a real listing page) does not fire.
 *
 * Membership criterion: only tokens whose appearance as a `<title>` is
 * overwhelmingly the result of an unedited scaffold (NOT plausible
 * page-topic phrases). "Welcome" and "Home Page" are borderline — a
 * real greeting page might title itself "Welcome" — which is why the
 * emit severity is `warning` rather than `error` and the agent reading
 * the file is the correct arbiter.
 */
const SCAFFOLD_PLACEHOLDER_TITLES: ReadonlySet<string> = new Set([
  "index",
  "page1",
  "page 1",
  "untitled",
  "untitled document",
  "untitled page",
  "document",
  "page title",
  "new page",
  "welcome",
  "home page",
  "html",
  "html document",
]);

const MESSAGE_PLACEHOLDER =
  "<title> reads like an unedited scaffold default — verify it actually describes this page's topic or purpose.";

const TITLE_LOOKS_LIKE_SCAFFOLD_DEFAULT = "title_looks_like_scaffold_default";

/**
 * Returns true when the trimmed, lowercased title text is in the
 * scaffold-placeholder dictionary. Pure literal-string membership
 * check — no substring matching, so document-topic phrases that
 * legitimately *contain* a placeholder word ("Index of /docs",
 * "Welcome Letter Templates") do not fire.
 */
function isScaffoldPlaceholderTitle(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return SCAFFOLD_PLACEHOLDER_TITLES.has(normalized);
}

/**
 * Emit shape for the scaffold-placeholder branch. Severity is
 * `warning` because the scanner cannot tell whether the placeholder
 * was deliberate ("Welcome" might be a real greeting page) — the agent
 * reading the file is the correct arbiter, and the structured
 * `title_looks_like_scaffold_default` code on `couldBeWrongBecause`
 * carries the dismissal signal so an agent can route to a one-line
 * pragma when the title was intentional.
 */
function buildPlaceholderEmit(
  doc: HtmlDocument,
  title: HtmlElement,
  text: string,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  couldBeWrongBecause: readonly string[];
} {
  return {
    severity: "warning",
    location: { filePath: "", line: title.loc.start.line, column: title.loc.start.column },
    message: `${MESSAGE_PLACEHOLDER} Found <title>${text}</title>.`,
    suggestion: buildSuggestion(doc),
    couldBeWrongBecause: [TITLE_LOOKS_LIKE_SCAFFOLD_DEFAULT],
  };
}

/**
 * PascalCase component names that read like document-head delegation
 * wrappers — Next.js `<Head>`, react-helmet `<Helmet>`/`<HelmetProvider>`,
 * Gatsby `<DocumentHead>`, generic `<NextHead>`/`<Meta>`/`<Title>`.
 * When any such element appears anywhere in the parsed tree, the file
 * is programmatically — not speculatively — handing title rendering
 * to the named component. Detection is by tag-name match on a closed
 * vocabulary so the false-positive surface is bounded: a custom
 * `<Helmet>` named for the Greek goddess of war is vanishingly rare
 * compared to react-helmet usage, and would still resolve correctly
 * via the source-level disable pragma if it ever fires.
 */
const HEAD_DELEGATION_COMPONENT_NAMES: ReadonlySet<string> = new Set([
  "Head",
  "Helmet",
  "HelmetProvider",
  "DocumentHead",
  "NextHead",
  "Title",
  "Meta",
  "Metadata",
  "PageHead",
  "SEO",
  "Seo",
]);

/**
 * Returns the first PascalCase opaque-component element whose tag is
 * a recognized document-head delegation wrapper, or `null` when no
 * such element is present in the parsed tree. Detection is shape-only:
 * we walk every `HtmlElement` and match against the closed vocabulary.
 * Walking the whole tree (rather than scoping to `<head>` / `<body>`)
 * mirrors how component frameworks place these wrappers — Next.js's
 * `<Head>` lives inside the page body in `pages/_document.tsx`-style
 * layouts; Gatsby's `<DocumentHead>` is component-scoped; react-helmet
 * places `<Helmet>` anywhere in the render tree.
 */
function findHeadDelegationComponent(doc: HtmlDocument): HtmlElement | null {
  for (const el of walkHtmlElements(doc)) {
    if (HEAD_DELEGATION_COMPONENT_NAMES.has(el.tagName)) return el;
  }
  return null;
}

function isInsideHead(doc: HtmlDocument, target: { range: { start: number } }): boolean {
  // Heuristic: does any <head> element's range encompass the target's
  // start offset? In-house HTML parser doesn't track parent pointers,
  // so we use offset containment.
  const heads = findHtmlElementsByTag(doc, "head");
  if (heads.length === 0) return true; // No <head> — treat <title> as document title anyway.
  for (const head of heads) {
    if (head.range.start <= target.range.start && target.range.start <= head.range.end) {
      return true;
    }
  }
  return false;
}

/**
 * Context-aware fix text. Walks the current document for in-file signals
 * the author has already written — the page's own `<h1>` text and its
 * `<meta name="description">` — and folds them into the suggestion so the
 * agent sees a concrete title candidate rather than a generic "write
 * something specific" instruction. Cross-file inspection (sibling pages,
 * site-name detection) would violate the "rules are pure" invariant
 * (CLAUDE.md §3.6), so the ladder uses only signals reachable from
 * `ctx.ast`.
 *
 * Ladder (first match wins):
 *   1. `<h1>` text present — inline it as the candidate title (shortest,
 *      most specific signal the author has already written). When a
 *      meta description also exists, mention it as the longer fallback.
 *   2. `<meta name="description">` present but no `<h1>` — derive a
 *      title candidate from the description (truncated to ~60 chars at
 *      a word boundary, trailing punctuation trimmed).
 *   3. Neither — fallback guidance naming the ≤60 char length budget and
 *      the "differ from sibling pages" constraint.
 */
function buildSuggestion(doc: HtmlDocument): string {
  const h1Text = findFirstH1Text(doc);
  const metaDescription = findMetaDescription(doc);

  if (h1Text !== null) {
    const descNote =
      metaDescription === null
        ? ""
        : ` A longer candidate from <meta name="description"> (line ${metaDescription.line}) is also available as a fallback.`;
    return `Set <title>${h1Text.text}</title>. Candidate derived from the page's existing <h1> (line ${h1Text.line}). Append a site name if you have one, e.g. <title>${h1Text.text} — Acme</title>.${descNote}`;
  }

  if (metaDescription !== null) {
    const candidate = truncateForTitle(metaDescription.content);
    return `Set <title>${candidate}</title>. Candidate derived from <meta name="description" content="${metaDescription.content}"> (line ${metaDescription.line}); truncated to ~60 characters. Edit to a concise page-topic phrase and append a site name if you have one.`;
  }

  return "Set <title> to a concise (≤60 char) description of this page's primary purpose. A good title differs from sibling pages and does not duplicate the site name alone — e.g. <title>Contact — Acme</title>, not <title>Acme</title>.";
}

interface H1Text {
  readonly text: string;
  readonly line: number;
}

/** Returns the trimmed text + source line of the first non-empty `<h1>`. */
function findFirstH1Text(doc: HtmlDocument): H1Text | null {
  for (const h1 of findHtmlElementsByTag(doc, "h1")) {
    const text = htmlTextContent(h1);
    if (text.length === 0) continue;
    return { text, line: h1.loc.start.line };
  }
  return null;
}

interface MetaDescription {
  readonly content: string;
  readonly line: number;
}

/** Returns the trimmed `content` + source line of the first `<meta name="description">`. */
function findMetaDescription(doc: HtmlDocument): MetaDescription | null {
  for (const meta of findHtmlElementsByTag(doc, "meta")) {
    const name = getHtmlAttribute(meta, "name");
    if (name === null || name.toLowerCase() !== "description") continue;
    const content = getHtmlAttribute(meta, "content");
    if (content === null) continue;
    const trimmed = content.trim();
    if (trimmed.length === 0) continue;
    return { content: trimmed, line: meta.loc.start.line };
  }
  return null;
}

/**
 * Truncates a meta-description candidate to roughly 60 characters at
 * the nearest word boundary, then strips trailing punctuation (`.`,
 * `,`, `;`, `:`, `—`, `-`) so the candidate reads as a title rather
 * than a sentence fragment. Short descriptions pass through unchanged.
 */
function truncateForTitle(description: string): string {
  const MAX_LEN = 60;
  if (description.length <= MAX_LEN) return stripTrailingPunctuation(description);
  const window = description.slice(0, MAX_LEN);
  const lastSpace = window.lastIndexOf(" ");
  const truncated = lastSpace > 20 ? window.slice(0, lastSpace) : window;
  return stripTrailingPunctuation(truncated);
}

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.,;:—\-\s]+$/, "");
}
