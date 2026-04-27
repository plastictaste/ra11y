/**
 * Sibling-collapse helpers for `forms/labels-required` (-
 * INPUT-SIBLING-COLLAPSE).
 *
 * When ≥3 direct-child labelable controls under one parent share the
 * same `(tagName, type, attributes-modulo-id)` fingerprint AND all
 * fail the rule's label check, the rule emits ONE canonical finding
 * carrying `siblingInstances: [{ line, id? }, …]` instead of N near-
 * identical findings. The agent reads one row carrying the full per-
 * sibling line/id trail; the silent-miss surface is preserved (the
 * collapsed finding still fires — surface-don't-suppress).
 *
 * Honest-aggregation discipline (AI-first doctrine, "Labeled buckets
 * are suppression too"): collapse only emits when the group label is
 * provable from the AST — NOT a heuristic. The four preconditions
 * every collapse decision satisfies, ALL from direct AST evidence:
 *
 *   1. Same DOM parent node.
 *   2. Same `(tagName, type, attributes-modulo-id)` fingerprint.
 *   3. ≥3 siblings (deliberate-cluster threshold; pairs stay
 *      individually emitted because the rollup carries no group
 *      meaning at that count).
 *   4. Every member fails the rule's label check (the rule is the
 *      only emitter — it owns the predicate; this helper consumes
 *      the predicate's verdict via the `failingByParent` map).
 *
 * The HTML and JSX branches share the collapse-decision shape but
 * compute fingerprints over different attribute models (HTML
 * attributes are case-insensitive name/value pairs; JSX attributes
 * are case-sensitive and may carry literal-string OR expression
 * values). The two `compute*CollapseDecisions` functions live here
 * to keep the rule file under its line budget; the rule consumes
 * them through the {@link ComputedCollapse} return shape.
 *
 * See `docs/kb/architecture/ai-first-consumer.md` "Labeled buckets
 * are suppression too" for the rationale: a label is honest only when
 * it is correct 100% of the time from the scanner's evidence. Same-
 * parent + same-fingerprint satisfies that bar; looser rules
 * (e.g. "any two inputs of the same type on the page") would not.
 */

import {
  getHtmlAttribute,
  getJsxAttributeString,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, JsxNode, TsxModule } from "../../types/ast.ts";

/**
 * One sibling captured by a collapsed finding's `siblingInstances`
 * list. Mirrors the corresponding field on
 * {@link import("../../types/violation.ts").Violation#siblingInstances}.
 * `id` is omitted (rather than emitted as `""`) when the sibling has
 * no id attribute, per CLAUDE.md §1 "Ambiguous field shapes are
 * dishonest."
 */
export type SiblingInstance = { line: number; id?: string };

/**
 * Minimum sibling count to collapse N near-identical findings into ONE
 * canonical finding. Three is the smallest group that still reads as
 * a deliberate visual cluster (one-time-code digit set, day-of-week
 * checkbox set, quiz radio-button set); pairs are arguably noise
 * reduction with no group meaning, so we keep them individually
 * emitted.
 */
export const SIBLING_COLLAPSE_THRESHOLD = 3;

/**
 * Result of the per-parent collapse pass:
 *
 *   - `primary`: maps the canonical (first-in-source-order) element of
 *     each collapsed group to the ordered `siblingInstances` list
 *     (including the canonical's own `(line, id?)` as the first entry,
 *     per the "consumers can iterate without a second lookup" contract
 *     on `Violation#siblingInstances`).
 *   - `consumed`: the non-canonical members of every collapsed group;
 *     the rule's per-element loop skips these so the rollup speaks
 *     once.
 */
export interface ComputedCollapse<E> {
  readonly primary: ReadonlyMap<E, readonly SiblingInstance[]>;
  readonly consumed: ReadonlySet<E>;
}

// ---------------------------------------------------------------------------
// HTML branch
// ---------------------------------------------------------------------------

/**
 * Predicate the rule supplies so this helper can ask "would the rule
 * emit a finding on this HTML element?" without re-deriving the answer
 * itself. The rule keeps ownership of the label-check semantics; this
 * helper only consumes the verdict.
 */
export type HtmlFailingPredicate = (el: HtmlElement) => boolean;

/**
 * Walks every parent (document root + every element) and groups its
 * direct-child labelable controls that fail the supplied predicate by
 * parent. Each entry is the ordered list of failing direct-child
 * controls under one parent — the input the collapse decision
 * operates on.
 */
export function collectFailingHtmlControls(
  doc: HtmlDocument,
  labelableTags: ReadonlySet<string>,
  isFailing: HtmlFailingPredicate,
  walk: (root: HtmlDocument | HtmlElement) => Iterable<HtmlElement>,
): Map<HtmlDocument | HtmlElement, HtmlElement[]> {
  const out = new Map<HtmlDocument | HtmlElement, HtmlElement[]>();
  const consider = (parent: HtmlDocument | HtmlElement): void => {
    const failing: HtmlElement[] = [];
    for (const child of parent.children) {
      if (child.kind !== "HtmlElement") continue;
      if (!labelableTags.has(child.tagName.toLowerCase())) continue;
      if (!isFailing(child)) continue;
      failing.push(child);
    }
    if (failing.length > 0) out.set(parent, failing);
  };
  consider(doc);
  for (const el of walk(doc)) consider(el);
  return out;
}

/**
 * From the per-parent failing-control list, decide which HTML elements
 * collapse into a primary sibling-rollup finding and which stay
 * individually emitted. See {@link ComputedCollapse} for the return
 * shape contract.
 *
 * Singletons and pairs (count < {@link SIBLING_COLLAPSE_THRESHOLD})
 * are never collapsed — they fall through to the per-element emit
 * path with unchanged behaviour.
 */
export function computeHtmlCollapseDecisions(
  failingByParent: ReadonlyMap<HtmlDocument | HtmlElement, readonly HtmlElement[]>,
): ComputedCollapse<HtmlElement> {
  const primary = new Map<HtmlElement, SiblingInstance[]>();
  const consumed = new Set<HtmlElement>();
  for (const failing of failingByParent.values()) {
    collapseHtmlOneParent(failing, primary, consumed);
  }
  return { primary, consumed };
}

function collapseHtmlOneParent(
  failing: readonly HtmlElement[],
  primary: Map<HtmlElement, SiblingInstance[]>,
  consumed: Set<HtmlElement>,
): void {
  const groups = new Map<string, HtmlElement[]>();
  for (const el of failing) {
    const key = htmlSiblingFingerprint(el);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [el]);
    else list.push(el);
  }
  for (const members of groups.values()) {
    if (members.length < SIBLING_COLLAPSE_THRESHOLD) continue;
    const canonical = members[0];
    if (canonical === undefined) continue;
    const instances: SiblingInstance[] = members.map((m) => htmlInstanceFor(m));
    primary.set(canonical, instances);
    for (let i = 1; i < members.length; i += 1) {
      const sibling = members[i];
      if (sibling !== undefined) consumed.add(sibling);
    }
  }
}

function htmlInstanceFor(el: HtmlElement): SiblingInstance {
  const id = getHtmlAttribute(el, "id");
  return id !== null && id.length > 0
    ? { line: el.loc.start.line, id }
    : { line: el.loc.start.line };
}

/**
 * `(tagName, attributes-modulo-id)` fingerprint for an HTML labelable
 * control. Two siblings share a fingerprint iff they have the same
 * tag and the same set of non-`id` attribute `(name, value)` pairs in
 * case-insensitive, sorted-by-name form. `id` is stripped because it
 * is the only attribute that legitimately varies across visually-
 * identical cluster members (`<input id="otp-1">`, `<input id="otp-2">`, …).
 *
 * Per AI-first doctrine ("Labeled buckets are suppression too"), the
 * fingerprint is fully provable from the AST — no heuristic on names
 * or content. Two non-cluster inputs that happen to share class +
 * type + every other attribute would also collapse, which is the
 * correct behaviour: an agent reading one finding with
 * `siblingInstances` sees the full per-line trail and can confirm or
 * split as needed.
 */
function htmlSiblingFingerprint(el: HtmlElement): string {
  const parts: string[] = [el.tagName.toLowerCase()];
  const pairs: string[] = [];
  for (const attr of el.attributes) {
    const name = attr.name.toLowerCase();
    if (name === "id") continue;
    pairs.push(`${name}=${attr.value ?? ""}`);
  }
  pairs.sort();
  parts.push(pairs.join(" "));
  return parts.join("");
}

// ---------------------------------------------------------------------------
// JSX branch
// ---------------------------------------------------------------------------

/**
 * Predicate the rule supplies so this helper can ask "would the rule
 * emit a finding on this element?" without re-deriving the answer
 * itself. The rule keeps ownership of the label-check semantics; this
 * helper only consumes the verdict.
 */
export type JsxFailingPredicate = (el: JsxElement) => boolean;

/**
 * JSX equivalent of {@link computeHtmlCollapseDecisions}. Walks every
 * JsxElement parent (and the module's top-level elements treated as a
 * synthetic root) and collapses ≥3 direct-child intrinsic
 * `<input>` / `<select>` / `<textarea>` failing siblings sharing a
 * `(tagName, attributes-modulo-id)` fingerprint into one canonical
 * finding. Mirrors the HTML branch so an OTP cluster authored in JSX
 * sees the same one-row-with-siblingInstances rollup as in HTML.
 *
 * Wrappers and polymorphic `<Tag as="input">` resolutions are skipped
 * — clusters of those are rare and the fingerprint would be less
 * stable across the resolution boundary; per-element emit on those is
 * the safer default.
 */
export function computeJsxCollapseDecisions(
  module: TsxModule,
  intrinsicTags: ReadonlySet<string>,
  isFailing: JsxFailingPredicate,
): ComputedCollapse<JsxElement> {
  const parents: { children: readonly JsxNode[] }[] = [{ children: module.jsxElements }];
  for (const el of walkJsxElements(module)) parents.push({ children: el.children });
  const primary = new Map<JsxElement, SiblingInstance[]>();
  const consumed = new Set<JsxElement>();
  for (const parent of parents) {
    collapseJsxOneParent(parent.children, intrinsicTags, isFailing, primary, consumed);
  }
  return { primary, consumed };
}

function collapseJsxOneParent(
  children: readonly JsxNode[],
  intrinsicTags: ReadonlySet<string>,
  isFailing: JsxFailingPredicate,
  primary: Map<JsxElement, SiblingInstance[]>,
  consumed: Set<JsxElement>,
): void {
  const failing = collectJsxFailingDirectChildren(children, intrinsicTags, isFailing);
  if (failing.length < SIBLING_COLLAPSE_THRESHOLD) return;
  const groups = groupJsxByFingerprint(failing);
  for (const members of groups.values()) {
    recordCollapsedJsxGroup(members, primary, consumed);
  }
}

function collectJsxFailingDirectChildren(
  children: readonly JsxNode[],
  intrinsicTags: ReadonlySet<string>,
  isFailing: JsxFailingPredicate,
): JsxElement[] {
  const failing: JsxElement[] = [];
  for (const child of children) {
    if (child.kind !== "JsxElement") continue;
    if (!intrinsicTags.has(child.tagName.toLowerCase())) continue;
    if (!isFailing(child)) continue;
    failing.push(child);
  }
  return failing;
}

function groupJsxByFingerprint(failing: readonly JsxElement[]): Map<string, JsxElement[]> {
  const groups = new Map<string, JsxElement[]>();
  for (const el of failing) {
    const key = jsxSiblingFingerprint(el);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [el]);
    else list.push(el);
  }
  return groups;
}

function recordCollapsedJsxGroup(
  members: readonly JsxElement[],
  primary: Map<JsxElement, SiblingInstance[]>,
  consumed: Set<JsxElement>,
): void {
  if (members.length < SIBLING_COLLAPSE_THRESHOLD) return;
  const canonical = members[0];
  if (canonical === undefined) return;
  primary.set(
    canonical,
    members.map((m) => jsxInstanceFor(m)),
  );
  for (let i = 1; i < members.length; i += 1) {
    const sibling = members[i];
    if (sibling !== undefined) consumed.add(sibling);
  }
}

function jsxInstanceFor(el: JsxElement): SiblingInstance {
  const id = getJsxAttributeString(el, "id");
  return id !== null && id.length > 0
    ? { line: el.loc.start.line, id }
    : { line: el.loc.start.line };
}

/**
 * JSX `(tagName, attributes-modulo-id)` fingerprint. Mirrors
 * {@link htmlSiblingFingerprint} but operates on the JSX attribute
 * shape: literal-string values surface verbatim; expression values
 * surface their raw text (so `maxLength={1}` and `maxLength={1}`
 * fingerprint identically across siblings, but `maxLength={count}`
 * and `maxLength={1}` do not — agent gets per-element findings when
 * the resolved value differs at all in source). Bare attributes
 * (`<input required />`) surface with an empty value. A `{...spread}`
 * marker is appended so an element with spread props does not
 * fingerprint identically to a sibling without spread.
 */
function jsxSiblingFingerprint(el: JsxElement): string {
  const parts: string[] = [el.tagName];
  const pairs: string[] = [];
  for (const attr of el.attributes) {
    if (attr.name === "id") continue;
    let valueText = "";
    if (attr.value === null) valueText = "";
    else if (attr.value.kind === "StringLiteral") valueText = attr.value.value;
    else valueText = attr.value.raw;
    pairs.push(`${attr.name}=${valueText}`);
  }
  pairs.sort();
  parts.push(pairs.join(" "));
  if (el.hasSpreadProps) parts.push("|spread");
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Message builder for the canonical sibling-rollup finding
// ---------------------------------------------------------------------------

/**
 * Message for the canonical sibling-rollup finding (-
 * SIBLING-COLLAPSE). Names the cluster shape and the rollup count so an
 * agent reading the message alone knows it is one finding standing in
 * for N siblings — and knows to read `siblingInstances` for the per-
 * sibling line/id trail. The structured `siblingInstances` field
 * carries the per-sibling detail; the message is the prose counterpart.
 */
export function buildSiblingCollapsedMessage(
  tagName: string,
  type: string | null,
  count: number,
): string {
  const descriptor = type ? `<${tagName} type="${type}">` : `<${tagName}>`;
  const others = count - 1;
  return (
    `${descriptor} has no accessible name — and ${others} adjacent sibling ${tagName}` +
    ` element${others === 1 ? "" : "s"} sharing the same parent and the same` +
    ` (tag, type, attributes-modulo-id) shape are also missing labels (collapsed into one` +
    ` finding; see siblingInstances for the per-sibling line/id trail). This is the shape of a` +
    ` deliberate visual cluster (one-time-code digit set, day-of-week checkbox set, quiz radio` +
    ` group); the fix is usually a single group-level label (\`<fieldset><legend>\` or` +
    ` \`role="group"\` + \`aria-labelledby\`) covering every sibling, not N per-input edits.`
  );
}
