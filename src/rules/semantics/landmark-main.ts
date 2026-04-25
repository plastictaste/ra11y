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
 * evidence to warrant a landmark — see `looksLikeFullPage()` in
 * `src/engine/layout-partial.ts` for the layered branches (explicit
 * landmarks, h1 + body content, or heading + list + interactive).
 * Fragments without a body are typically components, not pages, and
 * we don't assume they need a landmark. JSX files are out of scope
 * because a JSX fragment rarely represents a full page — apps use
 * router layouts to add the main landmark at the shell level, and
 * we'd produce false positives flagging every route component.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  directHtmlChildren,
  findHtmlElementsByTag,
  getHtmlAttribute,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import { isHtmlLayoutOrPartial, looksLikeFullPage } from "../../engine/layout-partial.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";
import type { FileContext } from "../../types/rule.ts";

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
    const bodies = findHtmlElementsByTag(doc, "body");

    // Layout / partial detection. Jekyll / Hugo / ERB / Razor layouts
    // compose the rendered page from this file's markup PLUS another
    // file's content (`{{ content }}`, `<%= yield %>`, `@RenderBody()`,
    // `{% include %}`). Static analysis can't see the composed DOM, so
    // a "missing <main>" emit shaped as a confident finding is dishonest
    // — the <main> might live in a sibling partial. Per
    // docs/kb/architecture/ai-first-consumer.md "Surface, don't
    // suppress" + "No heuristic suppression," the rule still surfaces
    // on these files so the agent sees the gap, but attaches
    // `couldBeWrongBecause` + a fragment-shape message suffix so an
    // agent routes to the parent/partial chain in one read. The
    // deterministic escape hatch is the source-level disable pragma.
    const layoutOrPartial = isHtmlLayoutOrPartial(doc, ctx.source);

    // Bodyless files that also don't look like layout partials are
    // just fragments (alt-text snippet, test-rule fixture, component
    // sketch) — skip as before. Bodyless files that DO look like
    // partials get the enriched emit.
    if (bodies.length === 0) {
      if (!layoutOrPartial) return;
      emitBodylessPartial(ctx, doc);
      return;
    }
    // Only flag on documents that look like real pages — skip
    // minimal documents (e.g. email templates, OG meta shells,
    // and test fixtures for other rules) without enough page-shape
    // evidence. See `looksLikeFullPage()` in
    // `src/engine/layout-partial.ts` for the layered branches.
    if (!looksLikeFullPage(bodies[0] as HtmlElement, doc)) return;

    const mains = collectMainLandmarks(doc);
    if (mains.length === 0) {
      emitMissingMain(ctx, bodies[0], doc, layoutOrPartial);
      return;
    }
    if (mains.length > 1) emitDuplicateMains(ctx, mains);
  },
});

/** Collects every `<main>` / `role="main"` landmark in the document. */
function collectMainLandmarks(doc: HtmlDocument): readonly HtmlElement[] {
  const out: HtmlElement[] = [];
  for (const el of walkHtmlElements(doc)) {
    if (isMainLandmark(el)) out.push(el);
  }
  return out;
}

/**
 * Emits the layout-partial enriched "missing <main>" finding on a file
 * with no `<body>` but that clears {@link isHtmlLayoutOrPartial}
 * (e.g. Jekyll `_includes/top.html` with `<html>` + `<head>` but no
 * body close). Anchors the finding at the first `<html>` tag when one
 * exists — same line the user reads first — or falls back to 1:1.
 *
 * No body-shape descriptor is appended here: the bodyless-partial
 * branch genuinely has no body to describe, and the partial-suffix
 * already names the dismissal hatch (the composition directive).
 */
function emitBodylessPartial(ctx: FileContext, doc: HtmlDocument): void {
  const htmlElements = findHtmlElementsByTag(doc, "html");
  const anchor = htmlElements[0];
  ctx.emit(buildLayoutPartialEmit(anchor?.loc.start.line ?? 1, anchor?.loc.start.column ?? 1, ""));
}

/**
 * Emits the "missing <main>" finding on a page that looks like a full
 * document. When the file ALSO looks like a layout/partial (Jekyll
 * `_layouts/default.html` with `{{ content }}` and no local <main>),
 * the emit is enriched with `couldBeWrongBecause` instead of firing at
 * full confidence — the <main> may live in the included child.
 *
 * Both branches inject a per-file body-shape descriptor (see
 * {@link describeBodyShape}) so the message text varies by file: the
 * 18-fire-identical-sentence shape (Q7-LANDMARK-MAIN-REASON-IDENTICAL)
 * collapsed dismissal/triage signal — every fire on a single scan
 * produced the same prose. Encoding the body's direct-child tally and
 * the sibling-landmark presence into the message gives the agent
 * per-finding evidence it can act on without re-reading the source.
 */
function emitMissingMain(
  ctx: FileContext,
  body: HtmlElement | undefined,
  doc: HtmlDocument,
  layoutOrPartial: boolean,
): void {
  const line = body?.loc.start.line ?? 1;
  const column = body?.loc.start.column ?? 1;
  const shape = body ? describeBodyShape(body, doc) : "";
  if (layoutOrPartial) {
    ctx.emit(buildLayoutPartialEmit(line, column, shape));
    return;
  }
  const shapeSuffix = shape ? ` ${shape}` : "";
  ctx.emit({
    severity: "warning",
    location: { filePath: "", line, column },
    message: `Document has no <main> landmark. Screen-reader users expect exactly one main landmark per page.${shapeSuffix}`,
    suggestion:
      'Document has no <main>. Wrap the primary content region — typically the main article/content below the header/nav — in <main> or add role="main" to an existing container. Do not wrap the <header>, <nav>, or <footer> regions in the main landmark.',
  });
}

/**
 * Emits one finding per "extra" main landmark so the fix is
 * unambiguous. ARIA requires exactly one main landmark — every
 * duplicate site needs the author's attention.
 */
function emitDuplicateMains(ctx: FileContext, mains: readonly HtmlElement[]): void {
  const suggestion = buildMultipleMainSuggestion(mains);
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

/**
 * Structured `couldBeWrongBecause` code surfaced when the scanned file
 * looks like a layout wrapper or template partial (no `<html>`/`<body>`,
 * Jekyll `layout:` front-matter, or a composition directive such as
 * `{% include %}` / `{{ content }}` / `<%= yield %>` / `@RenderBody`).
 * The scanner can't see the composed DOM — a sibling partial may carry
 * the `<main>` — so the finding is emitted with this code rather than
 * suppressed (docs/kb/architecture/ai-first-consumer.md §"Surface,
 * don't suppress") and rather than at full confidence (§"No heuristic
 * suppression"). Agents read the directive + parent chain and decide;
 * the deterministic escape hatch is a source-level disable pragma.
 */
const PARTIAL_OR_LAYOUT_CODE = "partial_or_layout_file_requires_composed_check";

const PARTIAL_OR_LAYOUT_SUFFIX =
  " This file looks like a layout wrapper or template partial (no <body>, Jekyll layout: front-matter, or {% include %} / {{ content }} / <%= yield %> / @RenderBody directive) — the composed page may carry <main> from a sibling file. Verify against the parent/partial chain before acting, or add a source-level disable pragma if the composition is intentional.";

/**
 * Builds the layout-partial emit. Shared between the two branches that
 * trigger it: a bodyless partial
 * (e.g. Jekyll `_includes/top.html`) and a body-carrying layout file
 * whose `{{ content }}` holds the main landmark in a sibling page
 * (e.g. Jekyll `_layouts/default.html`). Severity stays at `warning`
 * — same as the full-confidence emit — because the downgrade is
 * signalled by `couldBeWrongBecause` + the message suffix, not by
 * severity (per CLAUDE.md §14 "Don't downgrade priority to hide things").
 */
function buildLayoutPartialEmit(
  line: number,
  column: number,
  bodyShape: string,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  couldBeWrongBecause: readonly string[];
} {
  const shapeSuffix = bodyShape ? ` ${bodyShape}` : "";
  return {
    severity: "warning",
    location: { filePath: "", line, column },
    message: `Document has no <main> landmark.${PARTIAL_OR_LAYOUT_SUFFIX}${shapeSuffix}`,
    suggestion:
      "Document has no <main> in this file, but it looks like a layout wrapper or template partial — the <main> may be authored in the included/yielded file. Verify against the parent layout or partial chain; if this file is the root layout, add <main> around the composition point (typically surrounding the {{ content }} / <%= yield %> / @RenderBody site). Use a <!-- ra11y-disable semantics/landmark-main --> pragma if the composition is deliberate and the <main> lives in sibling files.",
    couldBeWrongBecause: [PARTIAL_OR_LAYOUT_CODE],
  };
}

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

/**
 * Tags that contribute no rendered output to the page — excluded from
 * the body-shape direct-child tally so a body whose only direct
 * children are `<script>` / `<style>` does not produce an empty
 * "(0 visible direct children)" descriptor. Mirrors the
 * `NON_VISIBLE_TAGS` set in `src/engine/layout-partial.ts` (kept local
 * here so changes to one don't silently couple to the other — the
 * descriptor is presentation, the predicate is policy).
 */
const NON_VISIBLE_DIRECT_CHILD_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "noscript",
  "template",
]);

/**
 * Sibling-landmark tags surfaced in the body-shape descriptor when
 * present. Tells the agent at a glance whether the page already has
 * other landmark structure (so a missing `<main>` is the only gap)
 * or whether it has zero landmarks of any kind (so the page is
 * structurally landmark-less, a stronger 1.3.1 signal).
 */
const SIBLING_LANDMARK_TAGS: readonly string[] = ["header", "nav", "footer", "aside"];

/**
 * Builds a per-file body-shape descriptor that fills in the
 * dismissal/triage signal a fixed boilerplate sentence cannot — the
 * 18-fire-identical-message shape (Q7-LANDMARK-MAIN-REASON-IDENTICAL)
 * left every fire on a single scan reading the same prose, so the agent
 * had to re-read each cited file to triage. The descriptor encodes:
 *
 *   1. Total visible direct-child count of `<body>` (excludes
 *      `<script>` / `<style>` / `<noscript>` / `<template>` per
 *      {@link NON_VISIBLE_DIRECT_CHILD_TAGS}). Distinguishes "body
 *      with one wrapper div" from "body with twelve sibling sections".
 *   2. Top tag-name tally for those visible direct children
 *      (descending by count, ties broken alphabetically, capped at 3
 *      kinds). Matches the backlog phrasing "body contains [n] sibling
 *      sections / divs / forms".
 *   3. Sibling-landmark presence anywhere in the document — either
 *      "other landmark elements present: header, nav" (page already
 *      has structure, missing `<main>` is the only gap) or "no other
 *      landmark elements present" (page is structurally
 *      landmark-less; AT users have nothing to jump to).
 *
 * Pure function over the parsed document — same shape semantics as
 * `inspectBody()` in `src/engine/layout-partial.ts`. Returns `""` when
 * the body has zero visible direct children AND no sibling landmarks
 * (degenerate input the caller can render without a suffix).
 */
function describeBodyShape(body: HtmlElement, doc: HtmlDocument): string {
  const counts = new Map<string, number>();
  let visibleDirectChildren = 0;
  for (const child of directHtmlChildren(body)) {
    if (child.kind !== "HtmlElement") continue;
    const tag = child.tagName.toLowerCase();
    if (NON_VISIBLE_DIRECT_CHILD_TAGS.has(tag)) continue;
    visibleDirectChildren += 1;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  const siblingLandmarks = collectSiblingLandmarks(doc);

  if (visibleDirectChildren === 0 && siblingLandmarks.length === 0) return "";

  const parts: string[] = [];
  if (visibleDirectChildren > 0) {
    const tally = formatTagTally(counts);
    const noun = visibleDirectChildren === 1 ? "child" : "children";
    parts.push(`Body has ${visibleDirectChildren} visible direct ${noun} (${tally}).`);
  }
  if (siblingLandmarks.length > 0) {
    parts.push(`Other landmark elements present: ${siblingLandmarks.join(", ")}.`);
  } else {
    parts.push(
      "No other landmark elements present (no <header>, <nav>, <footer>, or <aside>) — AT users have no jump-to-content target anywhere on the page.",
    );
  }
  return parts.join(" ");
}

/**
 * Collects the sibling-landmark tag names that appear anywhere in the
 * document, in the canonical order from {@link SIBLING_LANDMARK_TAGS}.
 * Walks the whole tree (not just `<body>` direct children) because
 * authored HTML often nests landmarks inside layout wrappers and a
 * presence-only signal stays correct across nesting depth.
 */
function collectSiblingLandmarks(doc: HtmlDocument): readonly string[] {
  const present = new Set<string>();
  for (const el of walkHtmlElements(doc)) {
    const tag = el.tagName.toLowerCase();
    if (tag === "header" || tag === "nav" || tag === "footer" || tag === "aside") {
      present.add(tag);
    }
  }
  return SIBLING_LANDMARK_TAGS.filter((tag) => present.has(tag));
}

/**
 * Formats the visible-direct-child tag tally as "3 div, 1 header, 1
 * footer" — descending by count, ties broken alphabetically, capped
 * at 3 kinds with a `"+ N more"` suffix when more kinds exist. The
 * cap keeps the message bounded on shapes like a body with 8
 * different one-off children; the count itself stays in the leading
 * `Body has N visible direct children` count so no signal is lost.
 */
function formatTagTally(counts: ReadonlyMap<string, number>): string {
  const entries = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const TOP = 3;
  const head = entries.slice(0, TOP).map(([tag, count]) => `${count} ${tag}`);
  if (entries.length > TOP) head.push(`+ ${entries.length - TOP} more`);
  return head.join(", ");
}

// `looksLikeFullPage` lives in `src/engine/layout-partial.ts` so that
// `semantics/heading-hierarchy` can share it (per Q3-HEADING-HIERARCHY-
// MISSING-H1-VARIANT) — the predicate is the conceptual opposite of
// `looksLikePartialFile`, and keeping both in the same module gives one
// canonical answer to "is this file a page or a fragment?"
