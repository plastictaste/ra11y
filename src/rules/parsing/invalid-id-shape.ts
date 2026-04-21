/**
 * Rule: parsing/invalid-id-shape
 * Satisfies: wcag21:4.1.1
 * Spec: https://www.w3.org/TR/WCAG21/#parsing
 *
 * > In content implemented using markup languages, elements have complete
 * > start and end tags, elements are nested according to their
 * > specifications, elements do not contain duplicate attributes, and any
 * > IDs are unique, except where the specifications allow these features.
 *
 * Source: https://www.w3.org/TR/WCAG21/#parsing
 *
 * WCAG 2.2 removed SC 4.1.1 Parsing because modern HTML parsers recover
 * from malformed markup. We cite wcag21:4.1.1 only (WCAG 2.1, Section
 * 508, and EN 301 549 still reference it); no wcag22 SC is claimed —
 * see the sibling `parsing/duplicate-id` rule which also uses 4.1.2 /
 * 1.3.1 because a duplicate id literally breaks ARIA name resolution,
 * whereas a malformed id is a parsing-only concern.
 *
 * Catches three clearly-broken id shapes the HTML spec disallows:
 *   1. `id="#something"` — author confused id syntax with the CSS
 *      selector / URL fragment prefix. Canonical real-world case.
 *   2. `id="has whitespace"` — HTML ids must contain at least one
 *      character and MUST NOT contain any ASCII whitespace.
 *      (https://html.spec.whatwg.org/#the-id-attribute)
 *   3. `id=""` or `id=" "` — the spec requires the id to contain at
 *      least one character; an empty value can never match a
 *      getElementById lookup, an aria-labelledby reference, or a
 *      label[for] association.
 *
 * Intentionally does NOT flag ids that start with a digit — HTML5
 * permits them, many CSS frameworks use them deliberately, and the
 * false-positive rate of treating them as broken is high. Leading-digit
 * ids stay legal and silent.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  truncateForEcho,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

export const rule = defineRule({
  id: "parsing/invalid-id-shape",
  satisfies: ["wcag21:4.1.1"],
  severity: "error",
  scope: "document",
  fixClass: "mechanical",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "id attribute values must be non-empty, must not contain whitespace, and must not start with '#' (URL fragment syntax).",
    rationale:
      "The HTML spec requires id to contain at least one character and forbids ASCII whitespace. An empty id never matches getElementById, so ARIA references, label[for] associations, and anchor links silently fail. A whitespace-bearing id tokenizes as multiple ids under the spec's space-separated parsing — CSS selectors, getElementById, and aria-labelledby all mis-resolve. A leading '#' (id=\"#top\") is the author confusing id syntax with CSS selector / URL fragment syntax; the '#' becomes part of the id literal, so href=\"#top\" cannot find the target.",
    goodExample: `<section id="main-content">…</section>`,
    badExample: `<section id="#main-content">…</section>\n<section id="">…</section>\n<section id="main content">…</section>`,
    normativeQuote:
      "In content implemented using markup languages, elements have complete start and end tags, elements are nested according to their specifications, elements do not contain duplicate attributes, and any IDs are unique, except where the specifications allow these features.",
    references: [
      "https://www.w3.org/TR/WCAG21/#parsing",
      "https://html.spec.whatwg.org/multipage/dom.html#the-id-attribute",
      "https://www.w3.org/WAI/WCAG21/Techniques/general/F77",
    ],
  },
  afterFile(ctx) {
    if (ctx.language === "html") {
      const doc = ctx.ast as HtmlDocument;
      for (const element of walkHtmlElements(doc)) {
        checkHtmlElement(ctx, element);
      }
      return;
    }
    if (ctx.language === "tsx" || ctx.language === "jsx") {
      const module = ctx.ast as TsxModule;
      for (const element of walkJsxElements(module)) {
        checkJsxElement(ctx, element);
      }
      return;
    }
  },
});

interface IdProblem {
  readonly message: string;
  readonly suggestion: string;
}

/**
 * Classifies an id attribute value against the three bad shapes this
 * rule catches. Returns `null` when the value is either absent or a
 * legal id (including leading-digit ids, which are legal HTML5 and
 * stay silent).
 */
function classifyIdValue(raw: string, tagName: string): IdProblem | null {
  const tag = `<${tagName}>`;
  if (raw.length === 0) {
    return {
      message: `${tag} has an empty id attribute — the HTML spec requires id to contain at least one character, so ARIA references, label[for] associations, and anchor links cannot resolve to this element.`,
      suggestion: `Remove the id attribute from ${tag}, or set it to a meaningful value (e.g. id="main-content"). An empty id never matches getElementById, aria-labelledby, or href="#…" — it is silently unreachable.`,
    };
  }
  if (/^\s+$/.test(raw)) {
    const echo = truncateForEcho(raw);
    return {
      message: `${tag} has a whitespace-only id="${echo}" — the HTML spec forbids ASCII whitespace in ids and requires at least one non-whitespace character.`,
      suggestion: `Replace the whitespace-only value with a meaningful id on ${tag} (e.g. id="main-content"), or remove the attribute entirely if nothing references it. A whitespace-only id never matches getElementById, aria-labelledby, or href="#…".`,
    };
  }
  if (raw.startsWith("#")) {
    const echo = truncateForEcho(raw);
    const stripped = truncateForEcho(raw.slice(1));
    return {
      message: `${tag} has id="${echo}" — the '#' prefix is CSS selector / URL fragment syntax, not part of the id value itself.`,
      suggestion: `HTML ids do not include the '#' — that prefix is the CSS selector / URL fragment syntax used to *reference* an id. Strip the leading '#' on ${tag}: change id="${echo}" to id="${stripped}". Callers reference it as href="#${stripped}" or the CSS selector #${stripped}.`,
    };
  }
  if (/\s/.test(raw)) {
    const echo = truncateForEcho(raw);
    const dashed = truncateForEcho(raw.replace(/\s+/g, "-"));
    return {
      message: `${tag} has id="${echo}" which contains whitespace — the HTML spec forbids ASCII whitespace in id values.`,
      suggestion: `HTML ids cannot contain spaces, tabs, or newlines — the parser would split "${echo}" into multiple tokens. Replace the whitespace with a hyphen or switch to camelCase on ${tag}: change id="${echo}" to id="${dashed}" (or id="${camelCase(raw)}").`,
    };
  }
  return null;
}

/**
 * Converts a whitespace-bearing id into camelCase: lowercases the first
 * token, capitalizes each subsequent token's first letter, and strips
 * the whitespace. `"hero banner section"` → `"heroBannerSection"`. Used
 * as an alternate suggestion alongside hyphen-joining.
 */
function camelCase(value: string): string {
  const parts = value
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return value;
  const [first, ...rest] = parts;
  const head = (first ?? "").toLowerCase();
  const tail = rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join("");
  return truncateForEcho(`${head}${tail}`);
}

function checkHtmlElement(
  ctx: Parameters<NonNullable<typeof rule.afterFile>>[0],
  element: HtmlElement,
): void {
  // Walk the raw attribute list to distinguish absent from empty; a
  // boolean `id` (shorthand with no value) parses to value: null here,
  // which we also treat as "empty id" — semantically equivalent to id="".
  for (const attr of element.attributes) {
    if (attr.name.toLowerCase() !== "id") continue;
    // Template-directive-bearing values (e.g. `id="{{ slug }}"`,
    // `id="{% if x %}a{% endif %}"`) are opaque to static analysis —
    // the scanner cannot know the rendered form. Skip rather than
    // emit a confident-but-wrong finding.
    const rawValue = attr.value ?? "";
    if (rawValue.includes("{{") || rawValue.includes("{%")) continue;
    const problem = classifyIdValue(rawValue, element.tagName);
    if (!problem) continue;
    ctx.emit({
      severity: "error",
      location: {
        filePath: "",
        line: attr.loc.start.line,
        column: attr.loc.start.column,
      },
      message: problem.message,
      suggestion: problem.suggestion,
    });
    return;
  }
  // Fallback: also consult the case-insensitive helper in case the
  // parser normalizes attribute casing in a way the loop above didn't
  // anticipate. No-op when already handled.
  void getHtmlAttribute(element, "id");
}

function checkJsxElement(
  ctx: Parameters<NonNullable<typeof rule.afterFile>>[0],
  element: JsxElement,
): void {
  for (const attr of element.attributes) {
    if (attr.name !== "id") continue;
    // Only literal string values are in scope — `id={dynamic}` is
    // opaque to static analysis; the agent reads the binding.
    if (!attr.value || attr.value.kind !== "StringLiteral") continue;
    const rawValue = attr.value.value;
    const problem = classifyIdValue(rawValue, element.tagName);
    if (!problem) continue;
    ctx.emit({
      severity: "error",
      location: {
        filePath: "",
        line: attr.loc.start.line,
        column: attr.loc.start.column,
      },
      message: problem.message,
      suggestion: problem.suggestion,
    });
    return;
  }
}
