/**
 * Dynamic-content-container detector.
 *
 * Static-scan blind spot: a vanilla-JS demo HTML page often ships an
 * empty container (`<div id="buttons"></div>`) plus a sibling
 * `<script src="script.js"></script>` that builds the interactive
 * controls at runtime via `document.createElement` / `appendChild` /
 * `innerHTML`. ra11y's static rules see no buttons, no labels, no
 * landmarks — every rule is honest at the markup horizon, the page
 * legitimately carries no automated findings, and the response shape
 * reads as "clean page" when the truthful answer is "static scan
 * cannot evaluate runtime-generated DOM."
 *
 * Per AI-first doctrine "Zero-output success is ambiguous failure"
 * (`docs/kb/architecture/ai-first-consumer.md`): when the response is a
 * structurally-runtime-rendered shell, the warning channel must say so
 * explicitly so the agent can spot-check the cited script(s) against
 * the empty container's id, OR scope a follow-up audit at the runtime
 * layer (browser-driven probe). The deterministic source-level disable
 * pragma (`<!-- ra11y-disable -->`) is the durable escape hatch once
 * the agent has investigated.
 *
 * Predicate (all three must hold for a single document):
 *
 *   1. Body has ≤ {@link MAX_BODY_VISIBLE_CHILDREN} non-script visible
 *      children — keeps the predicate scoped to genuinely-empty page
 *      shells; a populated page with one stray empty `<div id>` does not
 *      fire.
 *   2. Body contains at least one EMPTY element with an `id` attribute,
 *      from a small set of layout/landmark candidate tags (`div`,
 *      `main`, `section`, `article`). The id-attribute requirement
 *      filters incidental empty `<div>` separators (which never carry an
 *      id) out of the predicate; runtime-render mount points
 *      conventionally carry one.
 *   3. Body has a sibling `<script src="...">` referencing an external
 *      JS file (relative path or any non-template URL). Inline `<script>`
 *      blocks alone do NOT fire the predicate — the canonical demo
 *      shape this detector closes is "external script populates the
 *      container," and an inline-script-only page already exposes its
 *      runtime logic to in-tool grep so the warning channel adds little.
 *
 * Pure over its inputs. Output is deterministic across runs (sorted-
 * ascending file list; per-file sorted-ascending id list and script-src
 * list). Empty result when no scanned HTML page meets the conjunction.
 *
 * Pairs structurally with the runtime-mutation-on-populated-DOM detector
 * (a different evidence axis) — this detector names the never-populated-
 * at-parse-time axis specifically.
 */

import { findHtmlElementsByTag, getHtmlAttribute } from "../engine/ast-helpers.ts";
import type { ParsedFile } from "../engine/scanner.ts";
import type { HtmlDocument, HtmlElement, HtmlNode } from "../types/ast.ts";

/**
 * Hard cap on the number of `<body>`-level non-script visible children
 * tolerated before the body is treated as "populated" rather than a
 * runtime-render shell. Three is a heuristic-aware floor: a typical
 * vanilla-JS demo body carries one mount-point container, optionally
 * one heading or short prose paragraph, and the script tag — so up to
 * three non-script children clears every canonical demo shape while
 * keeping richer content pages out of the predicate. Thresholds are
 * generally suspicion-worthy per the doctrine "Numeric-threshold
 * heuristics are suppression," but this one is not a suppression
 * gate — it is a positive-evidence floor in front of a warning
 * (additive signal, not a filter on findings) and the alternative
 * (no floor, fire on any empty-id-with-script-sibling) over-surfaces
 * on populated pages where the warning would mislead the agent.
 */
const MAX_BODY_VISIBLE_CHILDREN = 3;

/**
 * Tag names whose empty `<tag id="...">` shape constitutes the runtime-
 * render mount point this detector recognizes. Covers the canonical
 * `<div id="...">` plus the landmark-named alternatives a developer
 * picks when the mount point is also a semantic landmark
 * (`<main id="root">`, `<section id="app">`, `<article id="post">`).
 * Other shapes (`<span>`, `<aside>`) are intentionally excluded — they
 * are atypical mount-point conventions and over-surfacing on incidental
 * empty `<span id>` separators would dilute the predicate.
 */
const MOUNT_POINT_TAG_NAMES: ReadonlySet<string> = new Set(["div", "main", "section", "article"]);

/**
 * Per-file evidence record produced by the detector. One entry per HTML
 * file matching the predicate. Drives the
 * `dynamic_content_container_detected` warning code's paired
 * `warningsDetails` payload.
 *
 * - `path` — absolute path to the HTML file (verbatim from
 *   `ParsedFile.filePath`).
 * - `bodyChildCount` — number of non-script visible children directly
 *   under `<body>`. Always ≤ {@link MAX_BODY_VISIBLE_CHILDREN}; the
 *   predicate would not have fired otherwise. Lets the agent see
 *   whether the shell is canonical (1–3 children) without re-reading
 *   the file.
 * - `emptyContainerIds` — sorted-ascending, de-duplicated list of `id`
 *   values from the empty mount-point candidates the predicate matched.
 *   Always carries at least one entry when the warning fires.
 * - `scriptSources` — sorted-ascending, de-duplicated list of `src`
 *   values from the external `<script src>` siblings. Always carries
 *   at least one entry when the warning fires.
 */
export interface DynamicContentContainerEntry {
  readonly path: string;
  readonly bodyChildCount: number;
  readonly emptyContainerIds: readonly string[];
  readonly scriptSources: readonly string[];
}

/**
 * Detects scanned HTML files that match the runtime-render shell shape.
 * Returns sorted-ascending entries (by `path`) so the wire output is
 * deterministic across runs. Empty array when no file matches the
 * conjunction; callers conditional-spread on `length > 0`.
 */
export function detectDynamicContentContainers(
  files: readonly ParsedFile[],
): readonly DynamicContentContainerEntry[] {
  const out: DynamicContentContainerEntry[] = [];
  for (const file of files) {
    if (file.ast.language !== "html") continue;
    const entry = classifyDocument(file.ast.root as HtmlDocument, file.filePath);
    if (entry !== undefined) out.push(entry);
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Per-document classification: returns the per-file evidence record
 * when the document satisfies all three predicate halves, `undefined`
 * otherwise. Walks the document's `<body>` once — the predicate is
 * gated on body-direct-child shape, so descending deeper would let
 * nested decorative content leak past the body-child-count guard.
 */
function classifyDocument(doc: HtmlDocument, path: string): DynamicContentContainerEntry | undefined {
  const bodies = findHtmlElementsByTag(doc, "body");
  const body = bodies[0];
  if (body === undefined) return undefined;
  const visibleChildren = collectVisibleBodyChildren(body);
  if (visibleChildren.bodyChildCount > MAX_BODY_VISIBLE_CHILDREN) return undefined;
  if (visibleChildren.emptyMountPoints.length === 0) return undefined;
  if (visibleChildren.externalScripts.length === 0) return undefined;
  const emptyContainerIds = uniqueSorted(
    visibleChildren.emptyMountPoints.map((el) => getHtmlAttribute(el, "id") ?? ""),
  ).filter((id) => id.length > 0);
  if (emptyContainerIds.length === 0) return undefined;
  const scriptSources = uniqueSorted(
    visibleChildren.externalScripts.map((el) => getHtmlAttribute(el, "src") ?? ""),
  ).filter((src) => src.length > 0);
  if (scriptSources.length === 0) return undefined;
  return {
    path,
    bodyChildCount: visibleChildren.bodyChildCount,
    emptyContainerIds,
    scriptSources,
  };
}

/**
 * Triage shape returned by {@link collectVisibleBodyChildren}. The
 * orchestrator uses each field for one predicate half — the body-child
 * count, the empty-mount-point list, and the external-script list — so
 * tracking them separately keeps the orchestrator's branching flat.
 */
interface VisibleBodyChildren {
  readonly bodyChildCount: number;
  readonly emptyMountPoints: readonly HtmlElement[];
  readonly externalScripts: readonly HtmlElement[];
}

/**
 * Walks the body's direct children once and partitions them into the
 * three predicate-relevant signals: count of non-script visible
 * children (the body-shape gate), empty mount-point candidates
 * (`<div id>` / `<main id>` / `<section id>` / `<article id>` whose
 * children carry no rendered content), and external `<script src>`
 * siblings.
 *
 * "Visible" here means not whitespace-only text and not an HTML
 * comment — both of which appear as `body.children` entries in the
 * parsed AST but render no content. Counting them would inflate the
 * body-shape gate against shells that legitimately match the
 * predicate (every authored HTML demo has at least one indentation
 * whitespace text node between siblings).
 */
function collectVisibleBodyChildren(body: HtmlElement): VisibleBodyChildren {
  let bodyChildCount = 0;
  const emptyMountPoints: HtmlElement[] = [];
  const externalScripts: HtmlElement[] = [];
  for (const child of body.children) {
    if (!isVisibleNode(child)) continue;
    if (child.kind !== "HtmlElement") {
      bodyChildCount += 1;
      continue;
    }
    const tagLower = child.tagName.toLowerCase();
    if (tagLower === "script") {
      // External-source `<script src="...">` siblings drive predicate
      // half 3; inline `<script>` (no `src`) is not a sibling-script
      // signal but still counts toward the body-child shape (it IS a
      // visible-rendered child as far as runtime evaluation goes).
      const src = getHtmlAttribute(child, "src");
      if (src !== null && src.length > 0 && !isTemplateExpressionLikeSrc(src)) {
        externalScripts.push(child);
      } else {
        bodyChildCount += 1;
      }
      continue;
    }
    bodyChildCount += 1;
    if (
      MOUNT_POINT_TAG_NAMES.has(tagLower) &&
      isEmptyContainer(child) &&
      hasIdAttribute(child)
    ) {
      emptyMountPoints.push(child);
    }
  }
  return { bodyChildCount, emptyMountPoints, externalScripts };
}

/**
 * True when the node renders to no observable content: `HtmlText`
 * carrying only whitespace and `HtmlComment` are filtered out so the
 * body-shape gate counts authored elements rather than pretty-print
 * artifacts.
 */
function isVisibleNode(node: HtmlNode): boolean {
  if (node.kind === "HtmlComment" || node.kind === "HtmlDoctype") return false;
  if (node.kind === "HtmlText") return node.value.trim().length > 0;
  return true;
}

/**
 * True when the element's children contain no element-level content and
 * no non-whitespace text. The mount-point predicate is "the container
 * is empty at parse time"; a container with rendered text or nested
 * elements is already authored content, not a runtime-render mount
 * point. HTML comments are tolerated (they render nothing) so a
 * `<div id="x"><!-- populated by script --></div>` shape stays under
 * the predicate.
 */
function isEmptyContainer(element: HtmlElement): boolean {
  for (const child of element.children) {
    if (child.kind === "HtmlComment") continue;
    if (child.kind === "HtmlText" && child.value.trim().length === 0) continue;
    return false;
  }
  return true;
}

/**
 * True when the element carries a non-empty `id` attribute. Used to
 * narrow the empty-mount-point predicate to authored mount points
 * (`<div id="root">`) rather than incidental empty `<div>` shapes that
 * appear in spacer / clearfix patterns.
 */
function hasIdAttribute(element: HtmlElement): boolean {
  const id = getHtmlAttribute(element, "id");
  return id !== null && id.length > 0;
}

/**
 * True when the `src` value carries a templating-directive shape
 * (`{theme}`, `{{path}}`, `<%= asset %>`, `${bundle}`, `{% raw %}`)
 * the static parser saw as text rather than a resolved URL. Skipping
 * template-expression `src` values keeps the warning's evidence
 * honest — a `<script src={{...}}>` is not a deterministic external
 * sibling because the parser cannot tell whether it resolves to an
 * authored bundle or a runtime-injected stub.
 */
function isTemplateExpressionLikeSrc(src: string): boolean {
  return (
    src.includes("{{") ||
    src.includes("<%") ||
    src.includes("${") ||
    src.includes("{%") ||
    /\{[A-Za-z_]/.test(src)
  );
}

/**
 * Returns the input array de-duplicated (string equality) and sorted
 * ascending. Used to render `emptyContainerIds` and `scriptSources`
 * with a deterministic wire shape across runs — the per-file walk
 * may produce duplicates when a script `src` repeats, and sorting +
 * de-duping at the boundary keeps the predicate authoritative
 * without each call site re-stating it.
 */
function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

