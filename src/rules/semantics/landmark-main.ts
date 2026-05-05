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
import { classifyHtmlFile, looksLikeFullPage } from "../../engine/layout-partial.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";
import type { FileContext } from "../../types/rule.ts";
import type { ViolationEvidence } from "../../types/violation.ts";
import { extension } from "../../utils/path.ts";

/**
 * True when `filePath` is a Markdown source file routed through
 * `parseMarkdown` (`.md`, `.markdown`, `.mkdn`). Mirrors the
 * `isMarkdownSourceFile` predicate in `semantics/heading-hierarchy.ts`
 * and `semantics/table-caption-missing.ts` — every document-shape rule
 * needs the same predicate because the markdown adapter strips ATX
 * headings, frontmatter, and the document envelope before this rule
 * runs, so the rule's view of the file is systematically partial. Kept
 * local (not factored to a shared helper) so a change to the predicate
 * shape in one rule doesn't silently couple to the others.
 */
function isMarkdownSourceFile(filePath: string): boolean {
  const ext = extension(filePath);
  return ext === ".md" || ext === ".markdown" || ext === ".mkdn";
}

/**
 * Structured `couldBeWrongBecause` code surfaced when the missing-
 * `<main>` emission rests on a markdown source file (`.md` /
 * `.markdown` / `.mkdn`). The markdown adapter strips frontmatter,
 * fenced code blocks, ATX headings, and the document envelope before
 * this rule runs, so the rule's view of the page is the embedded-HTML
 * residue only — the rendered page assembled by the static-site
 * generator's parent layout almost certainly supplies `<main>` from a
 * sibling layout file the static scanner cannot see in one pass. Pairs
 * with the `info` severity downgrade on the same branch so the
 * attention-budgeting signal matches the reason text per
 * `docs/kb/architecture/ai-first-consumer.md` "Reason text and severity
 * must agree" (conceded-uncertainty extension). The agent reads the
 * markdown source, follows `layout:` frontmatter to the parent layout,
 * and dismisses with a source-level pragma when confirmed.
 */
const MARKDOWN_RESIDUE_NO_MAIN_VISIBLE = "markdown_residue_no_main_visible";

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

    // Unified fragment / layout-or-partial classification. The shared
    // {@link classifyHtmlFile} helper computes BOTH labels from a single
    // signal-computation pass so the rule's enrichment branch and the
    // meta-channel `analysisCoverage.fragmentFiles[]` builder consume
    // the SAME predicate (per Q15 closure and
    // docs/kb/architecture/ai-first-consumer.md "Per-tool lane and
    // warning-set classification must agree"). The two labels mean:
    //
    //   `isFragment`: leaf-fragment shape — no `<html>`/`<body>`
    //   envelope, no layout-composition directive, not under a
    //   `_layouts/` path. Component-fragment files (alt-text snippet,
    //   test-rule fixture, component sketch) and partials under
    //   `_includes/`, `_partials/`, `partials/`, `components/` land
    //   here. The "missing <main>" emit is suppressed outright on
    //   these files; the duplicate-<main> emit continues to fire
    //   because multiple `<main>` elements in the same file is a real
    //   observable ordering bug regardless of whether the envelope is
    //   supplied elsewhere. The fragment-shape suppression is honest
    //   per docs/kb/architecture/ai-first-consumer.md because
    //   classification is structural evidence (root-tag absence,
    //   front-matter delimiter, fragment-path segment) — not a
    //   heuristic guess about composition. Pairs with the matching
    //   gate on `semantics/heading-hierarchy`.
    //
    //   `isLayoutOrPartial`: file participates in layout composition —
    //   asymmetric `<html>`/`<body>` (layout-opener / layout-closer
    //   partials), Jekyll / Eleventy front-matter `layout:`, or a
    //   composition directive (`{{ content }}`, `<%= yield %>`,
    //   `@RenderBody()`, `{% include %}`). Static analysis can't see
    //   the composed DOM, so a "missing <main>" emit shaped as a
    //   confident finding is dishonest — the `<main>` might live in a
    //   sibling partial. Per docs/kb/architecture/ai-first-consumer.md
    //   "Surface, don't suppress" + "No heuristic suppression," the
    //   rule still surfaces on these files so the agent sees the gap,
    //   but attaches `couldBeWrongBecause` + a fragment-shape message
    //   suffix so an agent routes to the parent/partial chain in one
    //   read. The deterministic escape hatch is the source-level
    //   disable pragma. Layout-partial enrichment fires only on files
    //   that are partials BUT NOT fragments — fragment-shaped files
    //   are suppressed by the gate above (the stronger signal).
    const { isFragment: fragment, isLayoutOrPartial: layoutOrPartial } = classifyHtmlFile(
      doc,
      ctx.source,
      ctx.filePath,
    );

    // Bodyless files that also don't look like layout partials are
    // just fragments (alt-text snippet, test-rule fixture, component
    // sketch) — skip as before. Bodyless files that DO look like
    // partials get the enriched emit, unless the file is also classified
    // as a fragment (front-matter, fragment-path) in which case the
    // gate above suppresses the emit outright.
    const markdownResidue = isMarkdownSourceFile(ctx.filePath);
    if (bodies.length === 0) {
      if (fragment) return;
      if (!layoutOrPartial) return;
      emitBodylessPartial(ctx, doc, markdownResidue);
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
      // Fragment-file gate: suppress the missing-<main> emit on files
      // whose composed parent supplies the landmark.
      if (fragment) return;
      emitMissingMain(ctx, bodies[0], doc, layoutOrPartial, markdownResidue);
      return;
    }
    // Multiple-<main> emits fire even on fragment-classified files —
    // declaring two <main> landmarks in the same file is a real
    // observable ordering bug regardless of whether the file is
    // composed into a parent layout.
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
function emitBodylessPartial(ctx: FileContext, doc: HtmlDocument, markdownResidue: boolean): void {
  const htmlElements = findHtmlElementsByTag(doc, "html");
  const anchor = htmlElements[0];
  ctx.emit(
    buildLayoutPartialEmit(
      anchor?.loc.start.line ?? 1,
      anchor?.loc.start.column ?? 1,
      "",
      undefined,
      markdownResidue,
    ),
  );
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
 * 18-fire-identical-sentence shape
 * collapsed dismissal/triage signal — every fire on a single scan
 * produced the same prose. Encoding the body's direct-child tally and
 * the sibling-landmark presence into the message gives the agent
 * per-finding evidence it can act on without re-reading the source.
 *
 * On the full-confidence branch (non-layout-partial) we additionally
 * check two layered downgrades — both close speculative-emission gaps
 * per docs/kb/architecture/ai-first-consumer.md "Heuristic emission is
 * the symmetric twin of heuristic suppression" + "Reason text and
 * severity must agree":
 *
 *   1. Isolated-component-demo shape (≤2 element children with ≤1
 *      non-`<script>`) — the body looks like a visual-test / examples
 *      / demos page composed into a parent layout elsewhere. Tagged
 *      with `isolated_component_demo_page` + severity `info`.
 *   2. Largest-block-guess shape (a probable-main candidate exists AND
 *      no sibling landmarks `<nav>` / `<header>` / `<aside>` /
 *      `<footer>` are present anywhere in the document). The
 *      probable-candidate hint is itself a "largest non-landmark block"
 *      ranking that depends on rendered layout, not static AST — when
 *      the page also lacks any positive multi-landmark evidence,
 *      asserting the page genuinely needs `<main>` requires guessing at
 *      composition we cannot observe in-file. Tagged with
 *      `largest_block_guess_unobservable` + severity `info`.
 *
 * The two downgrade branches are disjoint by construction: branch 1
 * is the more specific narrative (single-wrapper demo) and takes
 * precedence; branch 2 covers the broader speculative-emission case
 * where there's a probable wrapping target but no in-file evidence the
 * page is intentionally multi-landmark. When sibling landmarks ARE
 * present, the missing `<main>` is the only landmark-graph gap and the
 * emission is observable from in-file evidence — severity stays
 * `warning`. The predicate is in-file only — we don't depend on
 * cross-context build-artifact classification because the agent
 * already has that signal from `scannedBuildArtifacts` in scan_project
 * meta. The layout-partial branch already carries its own stronger
 * code and is not double-tagged: a layout/partial is provably not a
 * demo page (it has a composition directive) and the largest-block
 * guess on a partial points at a candidate the composed child may
 * supply via its own envelope; stacking codes dilutes the per-finding
 * signal the agent reads first.
 */
function emitMissingMain(
  ctx: FileContext,
  body: HtmlElement | undefined,
  doc: HtmlDocument,
  layoutOrPartial: boolean,
  markdownResidue: boolean,
): void {
  const line = body?.loc.start.line ?? 1;
  const column = body?.loc.start.column ?? 1;
  const shape = body ? describeBodyShape(body, doc) : "";
  const probable = body ? findProbableMainCandidate(body) : undefined;
  const candidateSuffix = probable ? ` ${describeProbableCandidate(probable)}` : "";
  if (layoutOrPartial) {
    ctx.emit(buildLayoutPartialEmit(line, column, shape, probable, markdownResidue));
    return;
  }
  const shapeSuffix = shape ? ` ${shape}` : "";
  const downgrade = resolveDowngrade(body, doc, probable);
  ctx.emit({
    severity: downgrade.severity,
    location: { filePath: "", line, column },
    message: `${downgrade.headline}${shapeSuffix}${candidateSuffix}`,
    suggestion: buildMissingMainSuggestion(probable),
    ...(downgrade.code ? { couldBeWrongBecause: [downgrade.code] } : {}),
    ...(probable ? { evidence: probableCandidateEvidence(probable) } : {}),
  });
}

/**
 * Resolves the severity / headline / `couldBeWrongBecause` code triple
 * for a missing-`<main>` emit on the non-layout-partial branch. Two
 * speculative-emission downgrades are layered in precedence order:
 *
 *   1. {@link ISOLATED_COMPONENT_DEMO_CODE} — single-wrapper body shape
 *      (≤2 direct element children with ≤1 non-`<script>`). The more
 *      specific narrative; wins when both predicates match.
 *   2. {@link LARGEST_BLOCK_GUESS_CODE} — a probable-main candidate
 *      exists AND the document carries no sibling `<header>` / `<nav>`
 *      / `<footer>` / `<aside>` landmarks. Without sibling landmarks
 *      we lack positive in-file evidence the page is multi-landmark,
 *      and the largest-block ranking depends on rendered layout
 *      (unobservable from static AST).
 *
 * Both downgrades produce severity `info` so the attention-budgeting
 * signal matches the conceded uncertainty in `couldBeWrongBecause` —
 * per docs/kb/architecture/ai-first-consumer.md "Reason text and
 * severity must agree" + "Heuristic emission is the symmetric twin of
 * heuristic suppression." When neither predicate matches the page has
 * positive in-file landmark evidence and the emit fires at full
 * `warning` confidence with the canonical headline.
 */
function resolveDowngrade(
  body: HtmlElement | undefined,
  doc: HtmlDocument,
  probable: ProbableMainCandidate | undefined,
): { severity: "warning" | "info"; headline: string; code: string | undefined } {
  if (body && isIsolatedComponentBodyShape(body)) {
    return {
      severity: "info",
      headline:
        "Document has no <main> landmark, but the body shape (single wrapper element +/- a <script>) matches an isolated component demo page — verify whether this file is the full page envelope or a single-component demo composed into a parent layout elsewhere.",
      code: ISOLATED_COMPONENT_DEMO_CODE,
    };
  }
  if (probable !== undefined && collectSiblingLandmarks(doc).length === 0) {
    return {
      severity: "info",
      headline:
        "Document has no <main> landmark and no sibling <header>/<nav>/<footer>/<aside> landmarks either — verify whether this page intends multiple landmarks (the largest-non-landmark-block ranking is unobservable from static analysis), is a composed fragment whose parent layout supplies the envelope, or is a single-region page where adding <main> around the existing wrapper is the intended fix.",
      code: LARGEST_BLOCK_GUESS_CODE,
    };
  }
  return {
    severity: "warning",
    headline:
      "Document has no <main> landmark. Screen-reader users expect exactly one main landmark per page.",
    code: undefined,
  };
}

/**
 * Structured `couldBeWrongBecause` code surfaced when the body looks
 * like a single-component demo / visual-test / examples page rather
 * than a real consumer-facing page. The shape we recognise: ≤2 direct
 * element children of `<body>`, with at most one non-`<script>` element
 * — i.e. one component wrapper plus an optional script tag. Pages
 * under `tests/visual/`, `examples/`, `demos/` typically render a
 * single component into a bare body shell with no surrounding chrome,
 * and a confident "missing <main>" emit on every such file produces
 * dozens of identical fires the agent has to dismiss one-by-one.
 *
 * The code is additive enrichment, not suppression — the candidate
 * stays in the primary list, the agent reads the code and decides
 * whether the file is in fact a real page that lacks a landmark or an
 * isolated component demo composed elsewhere. Severity is downgraded
 * to `info` on this branch so the attention-budgeting signal matches
 * the conceded uncertainty — per docs/kb/architecture/ai-first-
 * consumer.md "Reason text and severity must agree" and "Heuristic
 * emission is the symmetric twin of heuristic suppression."
 *
 * Predicate is in-file only (does not consult cross-context
 * `scannedBuildArtifacts` or path-segment classification) — when a
 * page-tree-wide build-artifact signal is available, the agent
 * already reads it from scan_project meta.
 */
const ISOLATED_COMPONENT_DEMO_CODE = "isolated_component_demo_page";

/**
 * Structured `couldBeWrongBecause` code surfaced when the missing-
 * `<main>` emission rests on a "largest non-landmark block" guess
 * — the {@link findProbableMainCandidate} ranking — AND the document
 * carries no sibling `<header>` / `<nav>` / `<footer>` / `<aside>`
 * landmarks anywhere. Without sibling landmarks the page lacks any
 * positive in-file evidence that it intends multiple landmarks, and
 * the largest-block ranking depends on rendered layout (which the
 * static AST cannot observe). The emission still surfaces so the agent
 * sees the gap, but severity downgrades to `info` and the message
 * frames the question rather than asserting the predicate — per
 * docs/kb/architecture/ai-first-consumer.md "Reason text and severity
 * must agree" + "Heuristic emission is the symmetric twin of heuristic
 * suppression."
 *
 * Disjoint from {@link ISOLATED_COMPONENT_DEMO_CODE}: when both
 * predicates match, the more specific isolated-demo narrative wins.
 * The two codes are never stacked. Predicate is in-file only — no
 * cross-context lookups.
 */
const LARGEST_BLOCK_GUESS_CODE = "largest_block_guess_unobservable";

/**
 * True when `<body>` has at most 2 direct element children AND at most
 * 1 of them is a non-`<script>` element. This is the "single component
 * + maybe a script" shape used by demo / visual-test / examples
 * pages. See {@link ISOLATED_COMPONENT_DEMO_CODE} for rationale.
 *
 * Counts elements only — text and comment nodes are ignored, matching
 * the body-shape descriptor's accounting.
 */
function isIsolatedComponentBodyShape(body: HtmlElement): boolean {
  let elementChildren = 0;
  let nonScriptElementChildren = 0;
  for (const child of directHtmlChildren(body)) {
    if (child.kind !== "HtmlElement") continue;
    elementChildren += 1;
    if (child.tagName.toLowerCase() !== "script") nonScriptElementChildren += 1;
  }
  return elementChildren <= 2 && nonScriptElementChildren <= 1;
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
 * (e.g. Jekyll `_layouts/default.html`).
 *
 * On HTML inputs, severity stays at `warning` — same as the full-
 * confidence emit — because the layout-partial concession is signalled
 * by `couldBeWrongBecause` + the message suffix, not severity (per
 * CLAUDE.md §14 "Don't downgrade priority to hide things").
 *
 * On Markdown inputs (`.md` / `.markdown` / `.mkdn`), severity
 * downgrades to `info` and the {@link MARKDOWN_RESIDUE_NO_MAIN_VISIBLE}
 * code is added alongside {@link PARTIAL_OR_LAYOUT_CODE}. The markdown
 * adapter strips frontmatter, ATX headings, and the document envelope
 * before this rule runs — so when a Jekyll post (`---\nlayout: post\n
 * ---\n# Title\n…`) reaches us, the residue is the embedded-HTML body
 * only and the rendered page assembled by `_layouts/post.html` almost
 * certainly supplies `<main>` from a sibling layout file. The reason
 * text already concedes this ("the composed page may carry <main> from
 * a sibling file"); per `docs/kb/architecture/ai-first-consumer.md`
 * "Reason text and severity must agree" (conceded-uncertainty
 * extension), the severity must agree with the conceded reason — so we
 * step the attention-budget axis down (warning → info) on the markdown
 * branch only. Mirrors the `residueAdjustedSeverity` helper in
 * `src/rules/semantics/heading-hierarchy.ts`.
 */
function buildLayoutPartialEmit(
  line: number,
  column: number,
  bodyShape: string,
  probable: ProbableMainCandidate | undefined,
  markdownResidue: boolean,
): {
  severity: "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  couldBeWrongBecause: readonly string[];
  evidence?: ViolationEvidence;
} {
  const shapeSuffix = bodyShape ? ` ${bodyShape}` : "";
  const candidateSuffix = probable ? ` ${describeProbableCandidate(probable)}` : "";
  const residueSuffix = markdownResidue ? MARKDOWN_RESIDUE_SUFFIX : "";
  const codes = markdownResidue
    ? [PARTIAL_OR_LAYOUT_CODE, MARKDOWN_RESIDUE_NO_MAIN_VISIBLE]
    : [PARTIAL_OR_LAYOUT_CODE];
  return {
    severity: markdownResidue ? "info" : "warning",
    location: { filePath: "", line, column },
    message: `Document has no <main> landmark.${PARTIAL_OR_LAYOUT_SUFFIX}${residueSuffix}${shapeSuffix}${candidateSuffix}`,
    suggestion:
      "Document has no <main> in this file, but it looks like a layout wrapper or template partial — the <main> may be authored in the included/yielded file. Verify against the parent layout or partial chain; if this file is the root layout, add <main> around the composition point (typically surrounding the {{ content }} / <%= yield %> / @RenderBody site). Use a <!-- ra11y-disable semantics/landmark-main --> pragma if the composition is deliberate and the <main> lives in sibling files.",
    couldBeWrongBecause: codes,
    ...(probable ? { evidence: probableCandidateEvidence(probable) } : {}),
  };
}

/**
 * Suffix appended to the layout-partial message when the host file is
 * markdown source. Pairs with the severity downgrade and the
 * {@link MARKDOWN_RESIDUE_NO_MAIN_VISIBLE} code so the agent reads in
 * one pass why the emit is at `info` rather than `warning`. Mirrors the
 * `MARKDOWN_RESIDUE_NOTE_SUFFIX` shape in
 * `src/rules/semantics/heading-hierarchy.ts`.
 */
const MARKDOWN_RESIDUE_SUFFIX =
  " Note: this file is markdown source (.md/.markdown/.mkdn). The markdown adapter stripped frontmatter and the document envelope before this rule ran, so the rule sees only the embedded-HTML residue — the rendered page assembled by the SSG's parent layout (e.g. `_layouts/post.html`) almost certainly supplies <main> from a sibling layout file the static scanner cannot see in one pass. Read the markdown source's `layout:` frontmatter to find the parent layout, or add a source-level disable pragma if the composition is intentional.";

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
 * 18-fire-identical-message shape
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
// `semantics/heading-hierarchy` can share it (per-
// MISSING-H1-VARIANT) — the predicate is the conceptual opposite of
// `looksLikePartialFile`, and keeping both in the same module gives one
// canonical answer to "is this file a page or a fragment?"

// ---------------------------------------------------------------------------
// Probable-main candidate
// ---------------------------------------------------------------------------

/**
 * Direct-child tags excluded from probable-main candidate selection
 * because they are themselves landmarks (and so cannot be the wrapping
 * candidate the rule recommends) or contribute no rendered content.
 *
 * Distinct from {@link NON_VISIBLE_DIRECT_CHILD_TAGS} (descriptor-only)
 * because `<main>` is irrelevant here (the rule fires only when no
 * `<main>` exists) but `<header>`/`<nav>`/`<aside>`/`<footer>` are not
 * eligible candidates: wrapping the navigation in `<main>` would be
 * worse than the missing landmark. The body-shape descriptor includes
 * landmarks in its tally; the candidate selector excludes them.
 */
const PROBABLE_MAIN_EXCLUDED_TAGS: ReadonlySet<string> = new Set([
  "header",
  "footer",
  "nav",
  "aside",
  "script",
  "style",
  "noscript",
  "template",
]);

interface ProbableMainCandidate {
  readonly tag: string;
  readonly line: number;
  readonly selectorHint?: string;
}

/**
 * Picks the largest non-landmark top-level block under `<body>` that
 * could plausibly be wrapped in `<main>` or relabelled with
 * `role="main"`. Reproducible from the AST:
 *
 *   1. Walk `<body>`'s direct element children, skipping
 *      {@link PROBABLE_MAIN_EXCLUDED_TAGS}.
 *   2. Score each candidate by descendant-element count (recursively).
 *   3. Pick the highest score; ties broken by document order (the
 *      first child wins, matching the agent's "the first wrapping
 *      target the file presents" reading).
 *
 * Returns `undefined` when the body has no eligible children — the
 * rule fires without a hint in that case (per AI-first doctrine,
 * present-when-meaningful: omit the field when no plausible candidate
 * exists). This branch covers degenerate page shapes where every
 * direct child is a landmark or non-visible tag.
 */
function findProbableMainCandidate(body: HtmlElement): ProbableMainCandidate | undefined {
  let best: { el: HtmlElement; score: number; index: number } | undefined;
  let index = 0;
  for (const child of directHtmlChildren(body)) {
    if (child.kind !== "HtmlElement") continue;
    const tag = child.tagName.toLowerCase();
    index += 1;
    if (PROBABLE_MAIN_EXCLUDED_TAGS.has(tag)) continue;
    const score = countDescendantElements(child);
    if (best === undefined || score > best.score || (score === best.score && index < best.index)) {
      best = { el: child, score, index };
    }
  }
  if (best === undefined) return undefined;
  const tag = best.el.tagName.toLowerCase();
  const selectorHint = buildSelectorHint(best.el, tag);
  return {
    tag,
    line: best.el.loc.start.line,
    ...(selectorHint === undefined ? {} : { selectorHint }),
  };
}

/** Counts every element node strictly below `el` in document order. */
function countDescendantElements(el: HtmlElement): number {
  let n = 0;
  for (const _ of walkHtmlElements(el)) n += 1;
  return n;
}

/**
 * Builds a CSS-style selector hint (`div#content`, `div.app-shell`,
 * `section#main-content.layout`) from the candidate's tag plus its
 * `id` and first `class` token, when present. Returns `undefined` for
 * bare elements with no identifying attribute — the agent reads the
 * tag from the `tag` field directly and the hint would add no signal.
 *
 * Only the first whitespace-separated class token is included to keep
 * the hint stable on long class lists (Tailwind, BEM cascades). When
 * both `id` and `class` are present both are included so the hint
 * reads as authored.
 */
function buildSelectorHint(el: HtmlElement, tag: string): string | undefined {
  const id = getHtmlAttribute(el, "id");
  const cls = getHtmlAttribute(el, "class");
  const firstClass = cls?.trim().split(/\s+/)[0];
  const parts: string[] = [];
  if (id && id.trim().length > 0) parts.push(`#${id.trim()}`);
  if (firstClass && firstClass.length > 0) parts.push(`.${firstClass}`);
  if (parts.length === 0) return undefined;
  return `${tag}${parts.join("")}`;
}

/**
 * Renders the probable-candidate prose enrichment appended to the
 * missing-`<main>` message. Reads as e.g. "Consider wrapping
 * `<div#content>` (line 42) in `<main>` or adding `role=\"main\"` to
 * it." When no selector hint is available, falls back to bare tag
 * notation (`<div>`).
 */
function describeProbableCandidate(probable: ProbableMainCandidate): string {
  const display = probable.selectorHint ?? probable.tag;
  return `Consider wrapping <${display}> (line ${probable.line}) in <main> or adding role="main" to it.`;
}

/**
 * Builds the structured `evidence` sub-shape for the probable-candidate
 * variant. See {@link ViolationEvidence} for the union contract.
 */
function probableCandidateEvidence(probable: ProbableMainCandidate): ViolationEvidence {
  return {
    kind: "landmark-main-probable-candidate",
    tag: probable.tag,
    line: probable.line,
    ...(probable.selectorHint === undefined ? {} : { selectorHint: probable.selectorHint }),
  };
}

/**
 * Builds the suggestion string for the missing-`<main>` emit. When a
 * probable candidate is available, names it explicitly so the agent
 * reads a concrete edit target alongside the criterion-level guidance.
 */
function buildMissingMainSuggestion(probable: ProbableMainCandidate | undefined): string {
  const base =
    'Document has no <main>. Wrap the primary content region — typically the main article/content below the header/nav — in <main> or add role="main" to an existing container. Do not wrap the <header>, <nav>, or <footer> regions in the main landmark.';
  if (probable === undefined) return base;
  const display = probable.selectorHint ?? probable.tag;
  return `${base} The largest non-landmark block in this file is <${display}> (line ${probable.line}); consider wrapping it in <main> or adding role="main" to it.`;
}
