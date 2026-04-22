/**
 * Helpers for the duplicate-same-href path of
 * `navigation/link-descriptive-text`. See that rule's header for the
 * failure mode's normative grounding (SC 2.4.4 + 2.4.9). Factored out
 * to keep the rule file under the 500-line file budget and to make the
 * pass unit-testable in isolation via the rule's public test surface.
 *
 * Scope boundaries encoded here:
 *   - Group anchors by `(normalizedName, href)`. Same-name-different-href
 *     is intentionally silent (legitimate nav patterns exist).
 *   - Normalized name = trim + collapse internal whitespace + lowercase
 *     (matches the convention the generic-phrase path uses).
 *   - Href normalization = trim only. `#` and `#` stay duplicate;
 *     `#foo` and `#bar` stay distinct.
 *   - Anchors without an href attribute are excluded — they are not
 *     activatable controls, so the "link list" concern doesn't apply.
 *   - `aria-labelledby` defers to the agent (no cross-element name
 *     resolution); JSX expression children likewise defer (runtime
 *     value invisible to static analysis).
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
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

/** Local copy of the emit signature — matches the shape the rule uses
 * for its per-file emits. Kept narrow so this helper file never pulls
 * the full EmittedViolation type with its transitive re-exports. */
type DupEmit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

/** Trim + collapse internal whitespace + lowercase. */
export function normalizeAccessibleName(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLowerCase();
}

interface AnchorRecord {
  readonly line: number;
  readonly column: number;
  readonly href: string;
  readonly normalizedName: string;
  readonly rawName: string;
}

/** Emits one violation per occurrence in any `(name, href)` group of size ≥2. */
function emitDuplicateGroups(records: readonly AnchorRecord[], emit: DupEmit): void {
  const groups = new Map<string, AnchorRecord[]>();
  for (const rec of records) {
    const key = `${rec.normalizedName}${rec.href}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(rec);
    } else {
      groups.set(key, [rec]);
    }
  }
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    emitBucket(bucket, emit);
  }
}

function emitBucket(bucket: readonly AnchorRecord[], emit: DupEmit): void {
  const lines = bucket.map((r) => r.line);
  const echoName = truncateForEcho(bucket[0]?.rawName.trim() ?? "");
  const echoHref = truncateForEcho(bucket[0]?.href ?? "");
  const count = bucket.length;
  const suggestion =
    `Differentiate these ${count} duplicates by either (a) giving each a distinct ` +
    `aria-label that describes what makes it unique (e.g. the product it sits next to), ` +
    `or (b) merging them into a single link if they truly point at the same destination ` +
    `and the repetition is an oversight, or (c) expanding the link text to include the ` +
    `differentiating context visible nearby (e.g. "Buy Now — Basic Plan" vs ` +
    `"Buy Now — Pro Plan").`;
  for (const rec of bucket) {
    const others = lines.filter((l) => l !== rec.line);
    const otherLines = others.length === 0 ? "" : ` (also at line ${others.join(", ")})`;
    emit({
      severity: "warning",
      location: { filePath: "", line: rec.line, column: rec.column },
      message:
        `${count} links on this page use the same accessible name "${echoName}" ` +
        `and the same href="${echoHref}"${otherLines}; a screen reader user ` +
        "navigating by link list (VoiceOver rotor, JAWS links dialog) cannot distinguish " +
        "them (SC 2.4.4 + 2.4.9).",
      suggestion,
    });
  }
}

/** Effective accessible name for an HTML anchor, or null when grouping
 * should defer (empty name / aria-labelledby present). */
export function accessibleNameForHtmlAnchor(
  el: HtmlElement,
  visibleText: (root: HtmlElement) => string,
): string | null {
  const ariaLabel = getHtmlAttribute(el, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return ariaLabel;
  if (hasHtmlAttribute(el, "aria-labelledby")) return null;
  const title = getHtmlAttribute(el, "title");
  if (title !== null && title.trim().length > 0) return title;
  const visible = visibleText(el);
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
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return ariaLabel;
  if (hasJsxAttribute(el, "aria-labelledby")) return null;
  const title = getJsxAttributeString(el, "title");
  if (title !== null && title.trim().length > 0) return title;
  const hasExpressionChild = el.children.some((c) => c.kind === "JsxExpression");
  if (hasExpressionChild) return null;
  const visible = visibleText(el);
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
    const href = getHtmlAttribute(a, "href");
    if (href === null) continue;
    const name = accessibleNameForHtmlAnchor(a, visibleText);
    if (name === null) continue;
    const normalizedName = normalizeAccessibleName(name);
    if (normalizedName.length === 0) continue;
    records.push({
      line: a.loc.start.line,
      column: a.loc.start.column,
      href: href.trim(),
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
    const href = getJsxAttributeString(el, "href") ?? getJsxAttributeString(el, "to");
    if (href === null) continue;
    const name = accessibleNameForJsxAnchor(el, visibleText);
    if (name === null) continue;
    const normalizedName = normalizeAccessibleName(name);
    if (normalizedName.length === 0) continue;
    records.push({
      line: el.loc.start.line,
      column: el.loc.start.column,
      href: href.trim(),
      normalizedName,
      rawName: name,
    });
  }
  emitDuplicateGroups(records, emit);
}
