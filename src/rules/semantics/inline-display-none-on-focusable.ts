/**
 * Rule: semantics/inline-display-none-on-focusable
 * Satisfies: wcag22:2.4.3, wcag21:2.4.3, wcag22:4.1.2, wcag21:4.1.2
 * Spec (Focus Order): https://www.w3.org/TR/WCAG22/#focus-order
 * Spec (Name, Role, Value): https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * > If a Web page can be navigated sequentially and the navigation
 * > sequences affect meaning or operation, focusable components receive
 * > focus in an order that preserves meaning and operability.
 *
 * Source: https://www.w3.org/TR/WCAG22/#focus-order
 *
 * Flags elements with an inline `style="display: none"` declaration that
 * are themselves focusable (`<a href>`, `<button>`, `<input>` (non-hidden),
 * `<select>`, `<textarea>`, `<summary>`, `<details>`, `<iframe>`,
 * `<area href>`, `<audio controls>`, `<video controls>`, or any element
 * with a tabindex that keeps it in the tab order) — or that contain a
 * focusable descendant.
 *
 * The canonical anti-pattern is dead navigation residue or
 * progressive-disclosure markup that toggles `display:none` without
 * scoping it to a media query and without removing the descendant from
 * the tab order:
 *
 *   <li style="display:none;"><a href="#topnav">HOME</a></li>
 *
 * Browsers omit `display:none` subtrees from the rendering AND from the
 * accessibility tree AND from the tab order, so in the canonical case
 * the user-visible behavior is "fine" — but the moment the inline style
 * is toggled or removed (the most common runtime mutation) the dead
 * focus target is back in the tab order with potentially stale labels,
 * stale `href` targets, and no aria treatment. Static-deterministic:
 * either the inline declaration is present or it isn't.
 *
 * Distinct from `aria/hidden-focus` — that rule flags `aria-hidden="true"`
 * on a focusable element (an a11y-tree-only hide that leaves focus
 * intact); this rule flags `display:none` on or above a focusable
 * element (a render+tree+focus hide that, when toggled, exposes the
 * focusable subtree without the matching aria treatment).
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type { FixPaths } from "../../types/violation.ts";

/**
 * HTML tag names that are natively focusable. Some of these are
 * *conditionally* focusable (only when a specific attribute is present
 * or absent) — see `isConditionallyFocusable` below. Mirrors the table
 * in `aria/hidden-focus.ts` because both rules answer the same
 * "is this element focusable?" question against the same HTML spec.
 */
const NATIVELY_FOCUSABLE: ReadonlySet<string> = new Set([
  "a",
  "area",
  "audio",
  "button",
  "details",
  "iframe",
  "input",
  "select",
  "summary",
  "textarea",
  "video",
]);

/** Tags whose focusability depends on another attribute. */
const CONDITIONAL_FOCUSABLE: ReadonlySet<string> = new Set([
  "a",
  "area",
  "audio",
  "input",
  "video",
]);

export const rule = defineRule({
  id: "semantics/inline-display-none-on-focusable",
  satisfies: ["wcag22:2.4.3", "wcag21:2.4.3", "wcag22:4.1.2", "wcag21:4.1.2"],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      'Elements with an inline style="display:none" declaration must not be focusable themselves and must not contain focusable descendants. The moment the inline style is toggled off, the focusable subtree returns to the tab order without aria treatment.',
    rationale:
      'Inline `style="display:none"` removes the element from the rendering, the accessibility tree, AND the tab order — so the user-visible behavior is fine while the style is active. The failure mode is the runtime toggle: scripts that flip `display:none` to `display:block` (progressive disclosure, single-page-app route swaps, dead-nav residue exposed by a debug flag) re-expose every focusable descendant in tab order with whatever stale `href` / `tabindex` / label they carried. Static analysis cannot observe the toggle, but the markup pattern itself is the warning sign — Focus Order (2.4.3) is about the sequence focus follows, and a hidden subtree of focusable controls that can rejoin that sequence at any moment violates the predictability the SC requires. Name/Role/Value (4.1.2) is the secondary failure: when the toggle exposes the subtree mid-interaction, focus may land on a control whose programmatic name no longer matches the visible context.',
    goodExample: `<li hidden><a href="#topnav">HOME</a></li>`,
    badExample: `<li style="display:none;"><a href="#topnav">HOME</a></li>`,
    normativeQuote:
      "If a Web page can be navigated sequentially and the navigation sequences affect meaning or operation, focusable components receive focus in an order that preserves meaning and operability.",
    references: [
      "https://www.w3.org/TR/WCAG22/#focus-order",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://html.spec.whatwg.org/multipage/interaction.html#focusable-area",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
    } else if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkJsx(ctx.ast as TsxModule, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  fixPaths: FixPaths;
}) => void;

type Violation = {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  fixPaths: FixPaths;
};

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const el of walkHtmlElements(doc)) {
    if (!hasInlineDisplayNone(getHtmlAttribute(el, "style"))) continue;
    const direct = checkHtmlDirectFocusable(el);
    if (direct) {
      emit(direct);
      continue;
    }
    const descendant = findHtmlFocusableDescendant(el);
    if (descendant) {
      emit(buildDescendantViolation(el.tagName, descendant.tagName, el.loc.start));
    }
  }
}

function checkHtmlDirectFocusable(el: HtmlElement): Violation | null {
  const tag = el.tagName.toLowerCase();
  if (isHtmlElementFocusable(el, tag)) {
    return buildDirectViolation(el.tagName, el.loc.start);
  }
  return null;
}

function isHtmlElementFocusable(el: HtmlElement, tag: string): boolean {
  if (isHtmlTabindexFocusable(el)) return true;
  if (!NATIVELY_FOCUSABLE.has(tag)) return false;
  if (!CONDITIONAL_FOCUSABLE.has(tag)) return true;
  return isHtmlConditionallyFocusable(el, tag);
}

function isHtmlTabindexFocusable(el: HtmlElement): boolean {
  const raw = getHtmlAttribute(el, "tabindex");
  if (raw === null) return false;
  return keepsInTabOrder(raw);
}

function isHtmlConditionallyFocusable(el: HtmlElement, tag: string): boolean {
  if (tag === "a" || tag === "area") return hasHtmlAttribute(el, "href");
  if (tag === "audio" || tag === "video") return hasHtmlAttribute(el, "controls");
  if (tag === "input") {
    const type = getHtmlAttribute(el, "type");
    return type === null || type.toLowerCase() !== "hidden";
  }
  return false;
}

function findHtmlFocusableDescendant(root: HtmlElement): HtmlElement | null {
  for (const child of root.children) {
    const hit = findHtmlFocusableInNode(child);
    if (hit) return hit;
  }
  return null;
}

function findHtmlFocusableInNode(node: HtmlNode): HtmlElement | null {
  if (node.kind !== "HtmlElement") return null;
  const tag = node.tagName.toLowerCase();
  if (isHtmlElementFocusable(node, tag)) return node;
  for (const child of node.children) {
    const hit = findHtmlFocusableInNode(child);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const el of walkJsxElements(module)) {
    if (isJsxPascalCase(el.tagName)) continue;
    if (!hasInlineDisplayNone(getJsxAttributeString(el, "style"))) continue;
    const direct = checkJsxDirectFocusable(el);
    if (direct) {
      emit(direct);
      continue;
    }
    const descendant = findJsxFocusableDescendant(el);
    if (descendant) {
      emit(buildDescendantViolation(el.tagName, descendant.tagName, el.loc.start));
    }
  }
}

function checkJsxDirectFocusable(el: JsxElement): Violation | null {
  if (isJsxElementFocusable(el)) {
    return buildDirectViolation(el.tagName, el.loc.start);
  }
  return null;
}

function isJsxElementFocusable(el: JsxElement): boolean {
  if (isJsxTabindexFocusable(el)) return true;
  const tag = el.tagName;
  if (!NATIVELY_FOCUSABLE.has(tag)) return false;
  if (!CONDITIONAL_FOCUSABLE.has(tag)) return true;
  return isJsxConditionallyFocusable(el, tag);
}

function isJsxTabindexFocusable(el: JsxElement): boolean {
  const raw = getJsxAttributeString(el, "tabIndex") ?? getJsxAttributeString(el, "tabindex");
  if (raw === null) return false;
  return keepsInTabOrder(raw);
}

function isJsxConditionallyFocusable(el: JsxElement, tag: string): boolean {
  if (tag === "a" || tag === "area") return hasJsxAttribute(el, "href");
  if (tag === "audio" || tag === "video") return hasJsxAttribute(el, "controls");
  if (tag === "input") {
    const type = getJsxAttributeString(el, "type");
    return type === null || type.toLowerCase() !== "hidden";
  }
  return false;
}

function findJsxFocusableDescendant(root: JsxElement): JsxElement | null {
  for (const child of root.children) {
    const hit = findJsxFocusableInNode(child);
    if (hit) return hit;
  }
  return null;
}

function findJsxFocusableInNode(node: JsxNode): JsxElement | null {
  if (node.kind !== "JsxElement") return null;
  // React components (PascalCase) are opaque — we cannot know whether
  // they render focusable content, so we do not descend into them.
  if (isJsxPascalCase(node.tagName)) return null;
  if (isJsxElementFocusable(node)) return node;
  for (const child of node.children) {
    const hit = findJsxFocusableInNode(child);
    if (hit) return hit;
  }
  return null;
}

function isJsxPascalCase(tag: string): boolean {
  const first = tag[0];
  return first !== undefined && first >= "A" && first <= "Z";
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * Per HTML spec: a tabindex of -1 removes the element from the
 * sequential tab order (though it remains programmatically focusable).
 * Any other parseable integer keeps the element reachable via Tab.
 * Non-numeric values are treated as "in tab order" because browsers
 * coerce them to 0. Mirrors `aria/hidden-focus`.
 */
function keepsInTabOrder(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed)) return true;
  return parsed !== -1;
}

/**
 * Returns `true` when the inline `style` attribute string contains a
 * `display: none` declaration. Tolerates:
 *   - missing trailing semicolon
 *   - any amount of internal whitespace around the `:`
 *   - case differences (`DISPLAY: NONE`)
 *   - a `!important` flag (`display: none !important`)
 *   - other declarations sharing the same attribute
 *
 * Splits on `;` first, then matches each declaration individually so a
 * value like `background: url(/img;display:none.png)` cannot trigger a
 * false positive — even though that exact URL form is unlikely in
 * practice, the `;` split keeps the matcher to one declaration at a
 * time, which is also what browsers do.
 */
function hasInlineDisplayNone(style: string | null | undefined): boolean {
  if (!style) return false;
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    if (property !== "display") continue;
    const rawValue = part
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    // Strip a trailing `!important` flag if present, then re-trim.
    const value = rawValue.endsWith("!important")
      ? rawValue.slice(0, -"!important".length).trim()
      : rawValue;
    if (value === "none") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Violation builders
// ---------------------------------------------------------------------------

function buildDirectViolation(tagName: string, loc: { line: number; column: number }): Violation {
  const nonFocusablePath =
    tagName === "a" || tagName === "area"
      ? "remove the href attribute (an anchor without href is not in the tab order)"
      : tagName === "input"
        ? 'use type="hidden" or replace the input with a non-interactive element'
        : "replace the native control with an inert element like <span>";
  const fixPaths: FixPaths = {
    primary: {
      label:
        'replace inline style="display:none" with the `hidden` attribute — `hidden` is the HTML-spec-blessed way to hide and untab a subtree, and a future runtime toggle that drops the attribute will leave the matching `[hidden]` selector in your stylesheet pointed at the same element',
    },
    alternatives: [
      {
        label: `if this control is decorative residue (dead nav, build-time stub), remove the element entirely so it never enters the DOM`,
      },
      {
        label: `if this control is a progressive-disclosure target, ${nonFocusablePath}, set tabindex="-1", and toggle aria-expanded on the controlling button — the tab-order removal must outlive the inline style toggle`,
      },
      {
        label:
          "move the visibility decision out of the inline style: scope it to a class with a matching `[aria-hidden]`/`[hidden]` selector, or render conditionally so the focusable subtree never exists while hidden",
      },
    ],
  };
  return {
    severity: "error",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: `<${tagName}> has inline style="display:none" and is itself focusable — when the inline style is toggled off (the common runtime path) the control rejoins the tab order without the surrounding aria treatment a hidden control needs.`,
    suggestion: `Primary fix: ${fixPaths.primary.label}. Alternatives (less likely): (a) ${fixPaths.alternatives[0]?.label}; (b) ${fixPaths.alternatives[1]?.label}; (c) ${fixPaths.alternatives[2]?.label}.`,
    fixPaths,
  };
}

function buildDescendantViolation(
  parentTag: string,
  childTag: string,
  loc: { line: number; column: number },
): Violation {
  const fixPaths: FixPaths = {
    primary: {
      label: `replace inline style="display:none" on the <${parentTag}> with the \`hidden\` attribute — \`hidden\` is the HTML-spec-blessed way to hide and untab a subtree in one declaration`,
    },
    alternatives: [
      {
        label: `if the <${parentTag}> is dead-navigation residue, remove the element entirely so the <${childTag}> never enters the DOM`,
      },
      {
        label: `if this is a progressive-disclosure region, render the <${childTag}> conditionally (so it doesn't exist while collapsed) and drive the visible state from aria-expanded on the controlling button`,
      },
      {
        label: `keep the inline style="display:none" on the <${parentTag}> only as a paint-time hide, and add tabindex="-1" plus the appropriate disabled/aria treatment to every focusable descendant — starting with the <${childTag}> flagged here`,
      },
    ],
  };
  return {
    severity: "error",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: `<${parentTag}> has inline style="display:none" but contains a focusable <${childTag}> descendant — when the inline style is toggled off, the focusable subtree returns to the tab order with whatever stale label, href, or tabindex it carried.`,
    suggestion: `Primary fix: ${fixPaths.primary.label}. Alternatives (less likely): (a) ${fixPaths.alternatives[0]?.label}; (b) ${fixPaths.alternatives[1]?.label}; (c) ${fixPaths.alternatives[2]?.label}.`,
    fixPaths,
  };
}
