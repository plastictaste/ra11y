/**
 * Rule: parsing/duplicate-id
 * Satisfies: wcag21:4.1.1, wcag22:4.1.2 / wcag21:4.1.2, wcag22:1.3.1 / wcag21:1.3.1
 * Spec: https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * WCAG 2.2 removed 4.1.1 Parsing because modern HTML parsers recover
 * from malformed markup. But duplicate IDs still break ARIA
 * relationships — they affect Name/Role/Value determination (4.1.2)
 * and programmatic relationships (1.3.1), which are live in both
 * 2.1 and 2.2. We keep citing 2.1:4.1.1 for legacy conformance
 * targets (Section 508, EN 301 549 both reference 2.1).
 *
 * Walks an HTML document collecting every `id=…` value, then emits
 * a violation at every occurrence after the first. Document-scoped.
 */

import { defineRule } from "../../api/plugin.ts";
import { getHtmlAttribute, walkHtmlElements } from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";

export const rule = defineRule({
  id: "parsing/duplicate-id",
  satisfies: ["wcag21:4.1.1", "wcag22:1.3.1", "wcag21:1.3.1", "wcag22:4.1.2", "wcag21:4.1.2"],
  severity: "error",
  scope: "document",
  fixClass: "mechanical",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      "Element IDs must be unique within a document. Duplicate IDs break aria-labelledby, label associations, and anchor navigation.",
    rationale:
      "Screen readers and browsers use element IDs to resolve aria-labelledby, aria-describedby, label[for], and anchor-link targets. When two elements share an ID, the resolution is undefined — getElementById returns only the first match, so the accessible name, description, or label of the second element is lost.",
    goodExample: `<input id="email"> <label for="email">Email</label>`,
    badExample: `<input id="email"> <input id="email">`,
    normativeQuote:
      "In content implemented using markup languages, IDs are unique, except where the specifications allow these features.",
    references: [
      "https://www.w3.org/TR/WCAG21/#parsing",
      "https://www.w3.org/WAI/WCAG21/Techniques/general/F77",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;

    // First pass: collect every id in the document so we can propose a
    // suffix candidate the agent can paste without re-checking uniqueness.
    const allIds = new Set<string>();
    for (const element of walkHtmlElements(doc)) {
      const id = getHtmlAttribute(element, "id");
      if (id && id.length > 0) allIds.add(id);
    }

    const seen = new Map<string, HtmlElement>();

    for (const element of walkHtmlElements(doc)) {
      const id = getHtmlAttribute(element, "id");
      if (!id || id.length === 0) continue;
      const first = seen.get(id);
      if (!first) {
        seen.set(id, element);
        continue;
      }
      const candidate = proposeUniqueId(id, allIds);
      ctx.emit({
        severity: "error",
        location: {
          filePath: "",
          line: element.loc.start.line,
          column: element.loc.start.column,
        },
        message: `Duplicate id="${id}" — first defined on <${first.tagName}> at line ${first.loc.start.line}, duplicated on <${element.tagName}> at line ${element.loc.start.line}.`,
        suggestion: `Duplicate id="${id}" — first defined on <${first.tagName}> at line ${first.loc.start.line}, duplicated on this <${element.tagName}>. Rename the second to id="${candidate}" (next free suffix) or remove it if no aria-labelledby / aria-describedby / aria-controls / label[for] / href="#${id}" references it. ARIA attribute references and getElementById resolve to the first match silently, so the duplicate is currently unreachable by any of those hooks.`,
      });
    }
  },
});

/**
 * Proposes a unique id derived from `base` that does not collide with any
 * id already present in the document.
 *
 * If `base` ends with a run of digits (e.g. `section2`), strip the digits and
 * start counting from `(n + 1)`; otherwise start at `2`. Walks upward until a
 * free slot is found.
 */
function proposeUniqueId(base: string, taken: ReadonlySet<string>): string {
  const match = base.match(/^(.*?)(\d+)$/);
  const root = match ? match[1] : base;
  const start = match ? Number.parseInt(match[2] ?? "1", 10) + 1 : 2;
  // Guard against pathological inputs that would loop forever.
  for (let n = start; n < start + 1000; n++) {
    const candidate = `${root}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-unique`;
}
