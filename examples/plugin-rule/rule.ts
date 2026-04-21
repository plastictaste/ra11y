/**
 * Example ra11y rule plugin — `example/no-title-only-label`.
 *
 * Flags HTML `<button>` / `<a>` elements whose only accessible name
 * source is the `title` attribute. The `title` attribute is unreliable
 * as an accessible name:
 *
 *   - Mobile browsers don't show tooltips at all.
 *   - Screen readers treat it inconsistently (some announce it,
 *     some don't, some only after a delay).
 *   - It's invisible to keyboard users unless they Tab to the
 *     element, which itself relies on the element being focusable.
 *
 * The rule demonstrates the plugin seam ADR 0022 reserved: a
 * user-authored rule composed via `createRegistry({ rules: [...] })`
 * becomes visible to every registry-reading tool (list_rules,
 * scan, scan_project, checklist) without any internal ra11y
 * edit. See `examples/plugin-rule/README.md` for how to thread it
 * through an `McpSession` or CLI invocation.
 *
 * Deliberately small. One `afterFile` handler, one AST-helper call,
 * one `ctx.emit` — so the file stays focused on the plugin-API shape,
 * not on AST walking. For a full-featured rule template, see
 * `src/rules/document/meta-refresh.ts`.
 */

// In a real consumer this is:
//   import { defineRule } from "@ra11y/core/plugin";
// For the in-repo example, use the relative path so the smoke test
// (`bun test.ts`) can run without publishing or linking.
import { defineRule } from "../../src/api/plugin.ts";
import { findHtmlElementsByTag, getHtmlAttribute } from "../../src/engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement } from "../../src/types/ast.ts";

export const rule = defineRule({
  id: "example/no-title-only-label",
  satisfies: ["wcag22:4.1.2", "wcag22:1.1.1"],
  severity: "warning",
  scope: "document",
  fixClass: "guidance",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      "Do not rely on the `title` attribute as the only accessible name — it's unreliable on mobile and inconsistent across screen readers.",
    rationale:
      "The title attribute renders as a browser tooltip on desktop mouse-over, but mobile browsers don't show tooltips, keyboard-only users can't trigger them, and screen-reader support is inconsistent. Use aria-label or visible text instead.",
    goodExample: `<button aria-label="Close">×</button>`,
    badExample: `<button title="Close">×</button>`,
    references: [
      "https://www.w3.org/TR/WCAG22/#non-text-content",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.tpgi.com/using-the-html-title-attribute-updated/",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;
    for (const tag of ["button", "a"] as const) {
      for (const el of findHtmlElementsByTag(doc, tag)) {
        if (!hasOnlyTitleAsLabel(el)) continue;
        ctx.emit({
          severity: "warning",
          location: {
            filePath: ctx.filePath,
            line: el.loc.start.line,
            column: el.loc.start.column,
          },
          message: `<${tag}> relies on the \`title\` attribute as its only accessible name. Mobile and keyboard users will see no label at all.`,
          suggestion: `Replace \`title\` with \`aria-label\` (or add visible text inside the element). Example: <${tag} aria-label="…">…</${tag}>.`,
        });
      }
    }
  },
});

/**
 * True when the element has a non-empty `title` attribute AND no
 * other accessible-name source (visible text child, `aria-label`,
 * `aria-labelledby`, or — for `<a>` — `alt` on a descendant image).
 * The check is intentionally narrow: the example demonstrates the
 * plugin seam, not a complete accessible-name computation.
 */
function hasOnlyTitleAsLabel(el: HtmlElement): boolean {
  const title = getHtmlAttribute(el, "title");
  if (title === null || title.trim().length === 0) return false;
  if (hasNonEmptyAttribute(el, "aria-label")) return false;
  if (hasNonEmptyAttribute(el, "aria-labelledby")) return false;
  if (hasVisibleText(el)) return false;
  return true;
}

function hasNonEmptyAttribute(el: HtmlElement, name: string): boolean {
  const value = getHtmlAttribute(el, name);
  return value !== null && value.trim().length > 0;
}

/**
 * Approximates "has visible text" by walking the element's children
 * for any HtmlText node with non-whitespace content. Misses imgs
 * with `alt`, nested labeled elements, and the rest of the
 * accessible-name algorithm — adequate for the example.
 */
function hasVisibleText(el: HtmlElement): boolean {
  for (const child of el.children) {
    if (child.kind === "HtmlText" && child.value.trim().length > 0) return true;
  }
  return false;
}

export default rule;
