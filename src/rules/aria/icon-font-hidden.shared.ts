/**
 * Shared internals for `aria/icon-font-hidden` and its sibling
 * second-pass module `icon-font-hidden.title-relies.ts`.
 *
 * Splits the rule across two files to keep each under the limits-guard
 * file ceiling. Holding the shared helpers here (rather than in the
 * main rule file) breaks the import cycle that would otherwise form
 * (main → sibling for `check*TitleOnlyIconRow`; sibling → main for
 * `detectIconFont` etc.).
 *
 * Nothing in this file is exported from the package — it is an
 * internal implementation detail of the rule.
 */

import {
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
} from "../../engine/ast-helpers.ts";
import type { HtmlElement, HtmlNode, JsxElement, JsxNode } from "../../types/ast.ts";

export type IconFontFamily =
  | "font-awesome"
  | "material-icons"
  | "bootstrap-icons"
  | "ionicons"
  | "glyphicons"
  | "icofont";

export interface IconFontMatch {
  readonly family: IconFontFamily;
  /** The specific token that triggered detection — echoed in messages. */
  readonly token: string;
}

/**
 * Emitter contract shared between the main rule's check driver and the
 * title-only second pass.
 *
 * `variantKey` is folded into the `findingId` hash by the engine. The
 * rule emits two kinds of finding against the same line:
 *   - the original "double-announce" finding (no variantKey)
 *   - the "relies-on-title" anti-pattern finding
 * Without a variantKey, both collapse to the same `findingId` and
 * suppress / dedup flows would silently merge them.
 *
 * `classEvidence` carries the icon-host class attribute (omitted when
 * absent — Ionicons custom elements have no class) for the per-rule
 * coverage rollup.
 */
export type Emit = (v: {
  severity: "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  classEvidence?: string;
  variantKey?: string;
}) => void;

/** Font Awesome style tokens (v4/v5/v6 weights + pro variants). */
const FA_STYLE_TOKENS: ReadonlySet<string> = new Set([
  "fa",
  "fas",
  "far",
  "fab",
  "fal",
  "fad",
  "fat",
  "fass",
]);

/** Material Icons base class tokens (v1 + Material Symbols family). */
const MATERIAL_EXACT_TOKENS: ReadonlySet<string> = new Set([
  "material-icons",
  "material-icons-outlined",
  "material-icons-round",
  "material-icons-rounded",
  "material-icons-sharp",
  "material-icons-two-tone",
]);

/** Roles on the ancestor that mean "this is an interactive control." */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
]);

/** Native tag names that are always interactive and take an accessible name. */
export const INTERACTIVE_TAGS: ReadonlySet<string> = new Set(["button", "summary"]);

// ---------------------------------------------------------------------------
// Icon-font detection
// ---------------------------------------------------------------------------

/**
 * Classifies the given tag + class-attribute pair as an icon-font host
 * or not. Returns the matching family plus the token that drove the
 * detection so downstream messages can echo concrete evidence instead
 * of generic "icon font" phrasing. Null when the element is not an
 * icon-font host.
 *
 * The caller is responsible for hoisting this check behind the "is
 * the element inside a labeled interactive ancestor?" gate — this
 * function has no opinion on ancestry.
 */
export function detectIconFont(tagName: string, classValue: string | null): IconFontMatch | null {
  const tagLower = tagName.toLowerCase();
  // Ionicons `<ion-icon>` custom element needs no class to identify.
  if (tagLower === "ion-icon") return { family: "ionicons", token: "ion-icon" };
  if (classValue === null) return null;
  const tokens = classValue.split(/\s+/u).filter((t) => t.length > 0);
  return matchIconFontTokens(tagLower, tokens);
}

function matchIconFontTokens(tagLower: string, tokens: readonly string[]): IconFontMatch | null {
  for (const raw of tokens) {
    const hit = matchIconFontToken(tagLower, raw);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Classifies a single class token against each known icon-font family.
 * Split out from the token loop to keep per-function cyclomatic
 * complexity under Biome's `noExcessiveCognitiveComplexity` ceiling —
 * the family list is growing and one long switch ran afoul of the
 * limit. Returns null when the token matches nothing.
 */
function matchIconFontToken(tagLower: string, raw: string): IconFontMatch | null {
  const tok = raw.toLowerCase();
  if (FA_STYLE_TOKENS.has(tok) || tok.startsWith("fa-")) {
    return { family: "font-awesome", token: raw };
  }
  if (MATERIAL_EXACT_TOKENS.has(tok) || tok.startsWith("material-symbols-")) {
    return { family: "material-icons", token: raw };
  }
  // `bi-*` glyph tokens ride alongside the `bi` base class in Bootstrap
  // Icons v1 — the `bi-*` slug is the surer signal (bare `bi` can collide
  // with unrelated class names like `bi` for "business intelligence").
  if (tok.startsWith("bi-") && (tagLower === "i" || tagLower === "span")) {
    return { family: "bootstrap-icons", token: raw };
  }
  if (tok === "glyphicon" || tok.startsWith("glyphicon-")) {
    return { family: "glyphicons", token: raw };
  }
  if (tok === "icofont" || tok.startsWith("icofont-")) {
    return { family: "icofont", token: raw };
  }
  if (tok === "ionicon") return { family: "ionicons", token: raw };
  return null;
}

// ---------------------------------------------------------------------------
// Accessible-name computation (scoped to what the rule needs)
// ---------------------------------------------------------------------------

/**
 * Returns the HTML element's accessible name (best-effort, scoped to
 * the authoring inputs this rule cares about). Order of precedence
 * mirrors the simplified WAI name-computation algorithm, with one
 * deliberate omission:
 *   1. `aria-labelledby` (treated as "named" when attribute is present
 *      — we don't dereference the target here; the rule's gate is "is
 *      the ancestor labeled?", and the author opting into labelledby
 *      counts as an explicit name declaration).
 *   2. `aria-label` with non-empty trimmed value.
 *   3. Visible text content. We deliberately subtract text contributed
 *      by icon-font children — a `<button><i class="fa-search"></i></button>`
 *      should NOT count as labeled because it has no real text.
 *
 * `title` is intentionally NOT in this list. The HTML spec gives `title`
 * a path into name computation as a last-resort fallback, but in real
 * AT behavior it is unreliable: VoiceOver iOS ignores `title` for links
 * entirely, several screen reader / browser pairs surface it only as a
 * tooltip rather than the announced name, and the WAI-ARIA APG warns
 * against `title` as a sole accessible-name source. If we credited
 * `title` here, the existing icon-font-hidden suggestion ("the parent
 * already carries the accessible name — add aria-hidden to the icon")
 * would actively teach the anti-pattern, regressing a `<a title="X">
 * <i class="fa-…"></i></a>` row to no reliable name on iOS. The
 * separate `checkHtmlTitleOnlyIconRow` pass catches that anti-pattern
 * as its own finding instead.
 */
export function accessibleNameHtml(el: HtmlElement): string | null {
  if (hasHtmlAttribute(el, "aria-labelledby")) return "aria-labelledby";
  const label = getHtmlAttribute(el, "aria-label");
  if (label !== null && label.trim().length > 0) return label.trim();
  const visible = visibleTextExcludingIconsHtml(el);
  if (visible.trim().length > 0) return visible.trim();
  return null;
}

function visibleTextExcludingIconsHtml(root: HtmlElement): string {
  let out = "";
  for (const child of root.children) {
    out += visibleTextNodeHtml(child);
  }
  return out;
}

function visibleTextNodeHtml(node: HtmlNode): string {
  if (node.kind === "HtmlText") return node.value;
  if (node.kind !== "HtmlElement") return "";
  if (detectIconFont(node.tagName, getHtmlAttribute(node, "class")) !== null) return "";
  return visibleTextExcludingIconsHtml(node);
}

export function accessibleNameJsx(el: JsxElement): string | null {
  if (hasJsxAttribute(el, "aria-labelledby")) return "aria-labelledby";
  const label = getJsxAttributeString(el, "aria-label");
  if (label !== null && label.trim().length > 0) return label.trim();
  const visible = visibleTextExcludingIconsJsx(el);
  if (visible.trim().length > 0) return visible.trim();
  // Runtime-valued children (`<button>{label}</button>`) likely carry a
  // name we can't see statically. Treat as labeled — false-positive
  // avoidance dominates false-negatives for the icon-font case.
  for (const child of el.children) {
    if (child.kind === "JsxExpression") return "expression-child";
  }
  // `title` is intentionally NOT a name source here — see
  // `accessibleNameHtml` JSDoc. The `checkJsxTitleOnlyIconRow` pass
  // catches the title-only anti-pattern as a separate finding.
  return null;
}

function visibleTextExcludingIconsJsx(root: JsxElement): string {
  let out = "";
  for (const child of root.children) {
    out += visibleTextNodeJsx(child);
  }
  return out;
}

function visibleTextNodeJsx(node: JsxNode): string {
  if (node.kind === "JsxText") return node.value;
  if (node.kind !== "JsxElement") return "";
  const classValue =
    getJsxAttributeString(node, "className") ?? getJsxAttributeString(node, "class");
  if (detectIconFont(node.tagName, classValue) !== null) return "";
  return visibleTextExcludingIconsJsx(node);
}

// ---------------------------------------------------------------------------
// Aria-hidden / role=presentation predicate (icon side)
// ---------------------------------------------------------------------------

export function isHtmlIconHidden(el: HtmlElement): boolean {
  if (getHtmlAttribute(el, "aria-hidden") === "true") return true;
  const role = (getHtmlAttribute(el, "role") ?? "").toLowerCase();
  return role === "presentation" || role === "none";
}

export function isJsxIconHidden(el: JsxElement): boolean {
  if (getJsxAttributeString(el, "aria-hidden") === "true") return true;
  const role = (getJsxAttributeString(el, "role") ?? "").toLowerCase();
  return role === "presentation" || role === "none";
}

// ---------------------------------------------------------------------------
// Family display name
// ---------------------------------------------------------------------------

export function familyName(family: IconFontFamily): string {
  switch (family) {
    case "font-awesome":
      return "Font Awesome";
    case "material-icons":
      return "Material Icons";
    case "bootstrap-icons":
      return "Bootstrap Icons";
    case "ionicons":
      return "Ionicons";
    case "glyphicons":
      return "Glyphicons";
    case "icofont":
      return "Icofont";
  }
}
