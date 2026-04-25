/**
 * Helpers for the duplicate-accessible-name path of
 * `navigation/link-descriptive-text`. See that rule's header for the
 * failure mode's normative grounding (SC 2.4.4 + 2.4.9). Factored out
 * to keep the rule file under the 500-line file budget and to make the
 * pass unit-testable in isolation via the rule's public test surface.
 *
 * Scope boundaries encoded here:
 *   - Group anchors by `(normalizedName, landmarkScope)`. Within each
 *     group, fire only when at least two distinct hrefs appear —
 *     same-name + same-href is permitted by the spec rationale (two
 *     links to the same destination are allowed to share a name; AT
 *     announces "visited" state on re-encounter and the user is not
 *     deceived).
 *   - Landmark scope = the line:column key of the anchor's nearest
 *     landmark-element ancestor, or `"document"` when no such
 *     ancestor exists. Two same-name + different-href anchors in
 *     DIFFERENT landmarks (`<nav>` vs `<main>`) are NOT confusing per
 *     WCAG 2.4.4 — the criterion permits link purpose to be
 *     established from "link text together with its programmatically
 *     determined link context," and landmarks ARE that context (per
 *     ARIA-in-HTML). The screen-reader links list groups by landmark,
 *     so the user always knows which region they are inspecting. The
 *     scoped grouping prevents false positives on the canonical SSG
 *     pattern: "Learn more" in a nav and "Learn more" in main, each
 *     pointing at distinct destinations — both are unambiguous in
 *     their landmark.
 *   - Normalized name = trim + collapse internal whitespace + lowercase
 *     (matches the convention the generic-phrase path uses).
 *   - Href normalization = trim only. `/foo` and `/foo` group as same
 *     destination; `/foo` and `/bar` group as different destinations.
 *   - Anchors without an href attribute are excluded — they are not
 *     activatable controls, so the "link list" concern doesn't apply.
 *   - `aria-labelledby` defers to the agent (no cross-element name
 *     resolution); JSX expression children likewise defer (runtime
 *     value invisible to static analysis).
 *   - Templated hrefs (`href="{{ item.url }}"`) are skipped — at static
 *     time they look like one URL, but at runtime they expand to N
 *     distinct URLs we cannot enumerate. Both the false-positive
 *     ("they're all duplicates") and false-negative ("only one href so
 *     no different-href group") risks are unacceptable for SSG sources.
 */

import {
  findJsxElementsForTag,
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  truncateForEcho,
} from "../../engine/ast-helpers.ts";
import { stripTemplateDirectives } from "../../input/parsers/html-template-directives.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";

/**
 * Native HTML elements whose presence in the ancestor chain establishes
 * a programmatic landmark scope per ARIA-in-HTML. Anchors nested inside
 * one of these are scoped to that landmark for the duplicate-name
 * grouping; anchors with no such ancestor are scoped to `"document"`.
 *
 * `header` and `footer` are listed unconditionally rather than gated
 * on body-level placement (as `semantics/duplicate-landmark-unlabeled`
 * does) — the goal here is to scope same-name links to a programmatic
 * region the screen-reader links list disambiguates by. Even a
 * `<header>` nested inside an `<article>` (technically a generic group,
 * not a `banner` landmark) still groups its anchors visually with that
 * article's content, so cross-`<header>` same-name + different-href
 * pairs are still distinguishable in context. The looser scoping keeps
 * the rule honest in the asymmetric-failure-mode sense: missing a
 * scoping signal would re-introduce the cross-landmark false positive.
 *
 * `section` is included even though sectioning content is only a
 * landmark when given an accessible name — the duplicate-link concern
 * is about disambiguation, and a scoped section still provides
 * scoping in the visual/structural sense.
 */
const LANDMARK_TAGS: ReadonlySet<string> = new Set([
  "nav",
  "main",
  "header",
  "footer",
  "aside",
  "form",
  "section",
]);

/**
 * Explicit ARIA `role` values that promote any element to a landmark
 * scope. Mirrors ARIA-in-HTML §5.4 landmark roles.
 */
const LANDMARK_ROLES: ReadonlySet<string> = new Set([
  "navigation",
  "main",
  "banner",
  "contentinfo",
  "complementary",
  "region",
  "search",
  "form",
]);

/** Scope key used when an anchor has no enclosing landmark element. */
const DOCUMENT_SCOPE = "document";

/** True if the element introduces a landmark scope. */
function isHtmlLandmark(el: HtmlElement): boolean {
  if (LANDMARK_TAGS.has(el.tagName.toLowerCase())) return true;
  const role = (getHtmlAttribute(el, "role") ?? "").toLowerCase();
  return LANDMARK_ROLES.has(role);
}

function isJsxLandmark(el: JsxElement): boolean {
  if (LANDMARK_TAGS.has(el.tagName.toLowerCase())) return true;
  const role = (getJsxAttributeString(el, "role") ?? "").toLowerCase();
  return LANDMARK_ROLES.has(role);
}

/**
 * Walks the HTML tree once, returning a map from each `<a>` element to
 * the scope key of its nearest enclosing landmark — or `"document"`
 * when none exists. The scope key is the landmark element's position
 * (`"L:line:column"`), unique within a file. Used by the duplicate-
 * name grouping to keep cross-landmark same-name links apart.
 */
function buildHtmlAnchorScopes(doc: HtmlDocument): Map<HtmlElement, string> {
  const scopes = new Map<HtmlElement, string>();
  const visit = (children: readonly HtmlNode[], scope: string): void => {
    for (const node of children) {
      if (node.kind !== "HtmlElement") continue;
      if (node.tagName.toLowerCase() === "a") {
        scopes.set(node, scope);
      }
      const nextScope = isHtmlLandmark(node)
        ? `L:${node.loc.start.line}:${node.loc.start.column}`
        : scope;
      visit(node.children, nextScope);
    }
  };
  visit(doc.children, DOCUMENT_SCOPE);
  return scopes;
}

/**
 * JSX counterpart of `buildHtmlAnchorScopes`. Recurses from each
 * top-level `module.jsxElements` root, propagating the nearest landmark
 * ancestor as the scope key. Records every JsxElement encountered (not
 * just tag-name matches) so polymorphic anchors (`<Box as="a">`,
 * mapped wrappers) resolved by `findJsxElementsForTag` downstream can
 * still look up their scope without a re-walk.
 */
function buildJsxAnchorScopes(module: TsxModule): Map<JsxElement, string> {
  const scopes = new Map<JsxElement, string>();
  const visit = (node: JsxNode, scope: string): void => {
    if (node.kind !== "JsxElement") return;
    scopes.set(node, scope);
    const nextScope = isJsxLandmark(node)
      ? `L:${node.loc.start.line}:${node.loc.start.column}`
      : scope;
    for (const child of node.children) visit(child, nextScope);
  };
  for (const root of module.jsxElements) {
    visit(root, DOCUMENT_SCOPE);
  }
  return scopes;
}

/** Local copy of the emit signature — matches the shape the rule uses
 * for its per-file emits. Kept narrow so this helper file never pulls
 * the full EmittedViolation type with its transitive re-exports.
 *
 * `variantKey` is optional and, when set, is folded into the finding's
 * `findingId` hash so this helper's "duplicate-name" findings don't
 * collide with the parent rule's "generic-phrase" / "icon-only" emits
 * when both fire on the same anchor. See
 * Q6-FINDINGID-COLLISION-SAMEFILE-SAMELINE. */
type DupEmit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  variantKey?: string;
}) => void;

/** Trim + collapse internal whitespace + lowercase. */
export function normalizeAccessibleName(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Strip template directives (`{{ … }}`, `{% … %}`, `<% … %>`) before
 * the name/href reaches the grouping or echo. Attribute values are
 * never stripped at parse time, so raw Liquid in `aria-label`,
 * `title`, or `href` would otherwise (a) group everything-expanding-
 * to-Liquid under one key and (b) echo raw directive text back at the
 * agent as "the duplicate name". Both are false positives the
 * Q4-LABEL-IN-NAME-LIQUID-STRIP-MISSING audit calls out.
 */
function stripDirectives(text: string): string {
  return stripTemplateDirectives(text).value;
}

interface AnchorRecord {
  readonly line: number;
  readonly column: number;
  readonly href: string;
  readonly normalizedName: string;
  readonly rawName: string;
  /**
   * Scope key for the anchor's nearest enclosing landmark element, or
   * `"document"` when none exists. Two anchors with the same
   * `normalizedName` but different `landmarkScope` values are NOT
   * grouped together — the screen-reader links list disambiguates by
   * landmark, so cross-landmark same-name + different-href pairs are
   * not a 2.4.4 violation.
   */
  readonly landmarkScope: string;
}

/**
 * Emits one violation per anchor in any name-group whose hrefs are not
 * all identical. The group key is `(normalizedName, landmarkScope)` —
 * anchors in different landmarks (or one in a landmark and one at the
 * document root) form distinct groups, so cross-landmark same-name
 * pairs never trigger. Within a single scope, the group must have
 * ≥2 records AND ≥2 distinct hrefs; groups where every record points
 * at the same href are silent (the spec rationale permits two-or-more
 * links to the same destination sharing a name).
 */
function emitDuplicateGroups(records: readonly AnchorRecord[], emit: DupEmit): void {
  const groups = new Map<string, AnchorRecord[]>();
  for (const rec of records) {
    const key = `${rec.landmarkScope} ${rec.normalizedName}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(rec);
    } else {
      groups.set(key, [rec]);
    }
  }
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const distinctHrefs = new Set(bucket.map((r) => r.href));
    if (distinctHrefs.size < 2) continue;
    emitBucket(bucket, distinctHrefs, emit);
  }
}

function emitBucket(
  bucket: readonly AnchorRecord[],
  distinctHrefs: ReadonlySet<string>,
  emit: DupEmit,
): void {
  const lines = bucket.map((r) => r.line);
  const echoName = truncateForEcho(bucket[0]?.rawName.trim() ?? "");
  const count = bucket.length;
  const distinctCount = distinctHrefs.size;
  const hrefSample = [...distinctHrefs].slice(0, 3).map((h) => truncateForEcho(h));
  const hrefList =
    distinctCount <= hrefSample.length
      ? hrefSample.map((h) => `"${h}"`).join(", ")
      : `${hrefSample.map((h) => `"${h}"`).join(", ")}, …`;
  const suggestion =
    `Differentiate these ${count} links by either (a) giving each a distinct ` +
    `aria-label that names the destination (e.g. the post title or product it sits next to), ` +
    `or (b) expanding the visible link text to include the differentiating context ` +
    `(e.g. "Read more about accessible navigation" instead of "Read more"), ` +
    `or (c) if some are truly redundant pointers at one destination, removing the duplicates.`;
  for (const rec of bucket) {
    const others = lines.filter((l) => l !== rec.line);
    const otherLines = others.length === 0 ? "" : ` (also at line ${others.join(", ")})`;
    emit({
      severity: "warning",
      location: { filePath: "", line: rec.line, column: rec.column },
      message:
        `${count} links on this page share the accessible name "${echoName}" ` +
        `but point at ${distinctCount} different destinations (${hrefList})${otherLines}; ` +
        "a screen reader user navigating by link list (VoiceOver rotor, JAWS links dialog) " +
        "hears the same name for each but lands somewhere different (SC 2.4.4 + 2.4.9).",
      suggestion,
      // Disambiguates this emission from the parent rule's
      // "generic-phrase" / "icon-only" emits at the same `(file,
      // line)` — the two concerns can legitimately co-fire on one
      // anchor (the link text is generic AND the destinations differ).
      // Q6-FINDINGID-COLLISION-SAMEFILE-SAMELINE.
      variantKey: "duplicate-name",
    });
  }
}

/** Effective accessible name for an HTML anchor, or null when grouping
 * should defer (empty name / aria-labelledby present / name was purely
 * template-directive with nothing left after strip). */
export function accessibleNameForHtmlAnchor(
  el: HtmlElement,
  visibleText: (root: HtmlElement) => string,
): string | null {
  const ariaLabel = getHtmlAttribute(el, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) {
    const stripped = stripDirectives(ariaLabel);
    if (stripped.trim().length === 0) return null;
    return stripped;
  }
  if (hasHtmlAttribute(el, "aria-labelledby")) return null;
  const title = getHtmlAttribute(el, "title");
  if (title !== null && title.trim().length > 0) {
    const stripped = stripDirectives(title);
    if (stripped.trim().length === 0) return null;
    return stripped;
  }
  const visible = stripDirectives(visibleText(el));
  if (visible.trim().length === 0) return null;
  return visible;
}

/** Effective accessible name for a JSX anchor, or null when grouping
 * should defer (empty name / aria-labelledby / expression child). */
export function accessibleNameForJsxAnchor(
  el: JsxElement,
  visibleText: (root: JsxElement) => string,
): string | null {
  const ariaLabel = getJsxAttributeString(el, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) {
    const stripped = stripDirectives(ariaLabel);
    if (stripped.trim().length === 0) return null;
    return stripped;
  }
  if (hasJsxAttribute(el, "aria-labelledby")) return null;
  const title = getJsxAttributeString(el, "title");
  if (title !== null && title.trim().length > 0) {
    const stripped = stripDirectives(title);
    if (stripped.trim().length === 0) return null;
    return stripped;
  }
  const hasExpressionChild = el.children.some((c) => c.kind === "JsxExpression");
  if (hasExpressionChild) return null;
  const visible = stripDirectives(visibleText(el));
  if (visible.trim().length === 0) return null;
  return visible;
}

export function checkDuplicateHrefHtml(
  doc: HtmlDocument,
  visibleText: (root: HtmlElement) => string,
  emit: DupEmit,
): void {
  const records: AnchorRecord[] = [];
  // Walk the tree once to map every anchor to its nearest landmark
  // scope; the iteration below reads from this map rather than each
  // anchor re-walking its ancestors.
  const scopes = buildHtmlAnchorScopes(doc);
  for (const [a, landmarkScope] of scopes) {
    if (!hasHtmlAttribute(a, "href")) continue;
    const hrefRaw = getHtmlAttribute(a, "href");
    if (hrefRaw === null) continue;
    // href="{{ item.url }}" renders to N distinct URLs at runtime but
    // looks like one URL at static time. Skip the anchor — the
    // grouping cannot tell whether the N outputs collapse to one
    // destination (silent → false negative on a real different-href
    // case) or fan out (silent on the templated row, which is the
    // honest choice for static analysis). Fully-static hrefs stay
    // unaffected.
    const hrefStripped = stripDirectives(hrefRaw).trim();
    if (hrefStripped.length === 0) continue;
    if (hrefStripped !== hrefRaw.trim()) continue;
    const name = accessibleNameForHtmlAnchor(a, visibleText);
    if (name === null) continue;
    const normalizedName = normalizeAccessibleName(name);
    if (normalizedName.length === 0) continue;
    records.push({
      line: a.loc.start.line,
      column: a.loc.start.column,
      href: hrefStripped,
      normalizedName,
      rawName: name,
      landmarkScope,
    });
  }
  emitDuplicateGroups(records, emit);
}

export function checkDuplicateHrefJsx(
  module: TsxModule,
  linkTags: ReadonlySet<string>,
  wrappersForA: ReadonlySet<string>,
  visibleText: (root: JsxElement) => string,
  emit: DupEmit,
): void {
  const records: AnchorRecord[] = [];
  const wrappers = new Set<string>([...linkTags, ...wrappersForA]);
  wrappers.delete("a");
  // Pre-compute landmark scope for every JsxElement in the module so
  // polymorphic-resolution channels (`<Box as="a">`) and wrapper-
  // mapping resolve to the correct landmark ancestor without a
  // second tree walk.
  const scopes = buildJsxAnchorScopes(module);
  const seen = new Set<JsxElement>();
  for (const el of findJsxElementsForTag(module, "a", wrappers)) {
    if (seen.has(el)) continue;
    seen.add(el);
    const hrefRaw = getJsxAttributeString(el, "href") ?? getJsxAttributeString(el, "to");
    if (hrefRaw === null) continue;
    const hrefStripped = stripDirectives(hrefRaw).trim();
    if (hrefStripped.length === 0) continue;
    // Same guard as HTML — skip template-valued hrefs so the
    // grouping never compares runtime-distinct URLs as equal.
    if (hrefStripped !== hrefRaw.trim()) continue;
    const name = accessibleNameForJsxAnchor(el, visibleText);
    if (name === null) continue;
    const normalizedName = normalizeAccessibleName(name);
    if (normalizedName.length === 0) continue;
    // The walker records every JsxElement in the module, so this
    // lookup always resolves; the fallback exists only to keep the
    // type strict (and to stay safe if a future caller hands in an
    // element from outside the walked module).
    const landmarkScope = scopes.get(el) ?? DOCUMENT_SCOPE;
    records.push({
      line: el.loc.start.line,
      column: el.loc.start.column,
      href: hrefStripped,
      normalizedName,
      rawName: name,
      landmarkScope,
    });
  }
  emitDuplicateGroups(records, emit);
}
