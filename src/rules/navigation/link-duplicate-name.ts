/**
 * Helpers for the duplicate-accessible-name path of
 * `navigation/link-descriptive-text`. See that rule's header for the
 * failure mode's normative grounding (SC 2.4.4 + 2.4.9). Factored out
 * to keep the rule file under the 500-line file budget and to make the
 * pass unit-testable in isolation via the rule's public test surface.
 *
 * Scope boundaries encoded here:
 *   - Group anchors by `normalizedName`. Within each group, fire only
 *     when at least two distinct hrefs appear — same-name + same-href
 *     is permitted by the spec rationale (two links to the same
 *     destination are allowed to share a name; AT announces "visited"
 *     state on re-encounter and the user is not deceived).
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
  findHtmlElementsByTag,
  findJsxElementsForTag,
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  truncateForEcho,
} from "../../engine/ast-helpers.ts";
import { stripTemplateDirectives } from "../../input/parsers/html-template-directives.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

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
}

/**
 * Emits one violation per anchor in any name-group whose hrefs are not
 * all identical. The group must have ≥2 records AND ≥2 distinct hrefs;
 * groups where every record points at the same href are silent (the
 * spec rationale permits two-or-more links to the same destination
 * sharing a name).
 */
function emitDuplicateGroups(records: readonly AnchorRecord[], emit: DupEmit): void {
  const groups = new Map<string, AnchorRecord[]>();
  for (const rec of records) {
    const bucket = groups.get(rec.normalizedName);
    if (bucket) {
      bucket.push(rec);
    } else {
      groups.set(rec.normalizedName, [rec]);
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
  for (const a of findHtmlElementsByTag(doc, "a")) {
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
    records.push({
      line: el.loc.start.line,
      column: el.loc.start.column,
      href: hrefStripped,
      normalizedName,
      rawName: name,
    });
  }
  emitDuplicateGroups(records, emit);
}
