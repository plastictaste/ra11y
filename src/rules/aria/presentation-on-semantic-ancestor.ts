/**
 * Rule: aria/presentation-on-semantic-ancestor
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, section508:1.3.1, en301549:9.1.3.1, wcag22:4.1.2, wcag21:4.1.2, section508:4.1.2, en301549:9.4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available
 * > in text.
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * Flags `role="presentation"` / `role="none"` on a semantic host element
 * (`<table>`, `<ul>`, `<ol>`, `<dl>`, `<figure>`, `<form>`) whose subtree
 * contains the semantic children that *encode* the host's meaning — `<th>`
 * or `<caption>` inside a `<table>`, `<li>` inside `<ul>`/`<ol>`, `<dt>` /
 * `<dd>` inside `<dl>`, `<figcaption>` inside `<figure>`, `<legend>` inside
 * `<form>`. The presentational role tells assistive technology to treat
 * the host as a generic container — which silently strips the table /
 * list / figure / form-landmark semantics that the children depend on for
 * their announcement and navigation contracts.
 *
 * The companion rule `semantics/layout-table-no-presentation-role` flags
 * the *opposite* mistake: a `<table>` that looks like layout (no `<th>`,
 * no `<caption>`, no scope/headers) but hasn't been declared
 * `role="presentation"` yet. This rule catches the inverse — a
 * `<table role="presentation">` that *does* contain `<th>` / `<caption>`
 * and is therefore stripping real semantics that the markup intended to
 * convey.
 *
 * Why this is its own rule rather than a `conflicting-role` extension:
 * the semantic-host pairs are conditional on subtree contents, not on
 * the host element alone. `<table role="presentation">` is fine when the
 * table is layout scaffolding (an email template, a side-by-side panel),
 * and breaks when the table has `<th>` headers. The predicate is the
 * combination, not either signal alone.
 *
 * ARIA's "conditional role stripping" (WAI-ARIA 1.2 §presentation): a
 * user agent will *automatically* drop `role="presentation"` from an
 * element with required-children semantics — but this only fires on a
 * narrow set (the children themselves are what trigger it), and the
 * stripping is unreliable across browser/AT combinations. The static
 * detection here is independent of the runtime stripping: even where a
 * UA does strip the role, the markup is still misleading and the next
 * refactor that rearranges the children may end up with the role
 * actually applied. Removing `role="presentation"` from a host whose
 * subtree carries the children's semantics is the correct fix; if the
 * intent really was layout, the children should also be replaced
 * (`<th>` → `<td>`, `<li>` content moved to flow elements, etc.).
 *
 * Severity is `warning`: the static signal is unambiguous (host + role +
 * semantic child are all literally present in the source), but the
 * remediation depends on author intent — strip the role to keep the
 * semantics, or restructure the children to make it real layout. The
 * suggestion offers both fixes.
 *
 * Coverage table:
 *
 *   | Host       | Triggering descendants            |
 *   |------------|-----------------------------------|
 *   | <table>    | <th>, <caption>                   |
 *   | <ul>, <ol> | <li>                              |
 *   | <dl>       | <dt>, <dd>                        |
 *   | <figure>   | <figcaption>                      |
 *   | <form>     | <legend>                          |
 *
 * Descent stops at any nested same-host element (a `<ul>` inside a
 * `<ul role="presentation">` is evaluated independently — finding a
 * `<li>` inside the inner `<ul>` does not rescue the outer rule).
 *
 * Exclusions:
 *   - Hosts without `role="presentation"` / `role="none"`. Other roles
 *     (`role="grid"`, `role="list"`, `role="region"`, etc.) are explicit
 *     ARIA opt-ins to a *different* contract and are out of scope here —
 *     other rules cover them.
 *   - Empty role (`role=""`) is treated as absent and the rule does not
 *     fire (the host's implicit semantics are still in effect).
 *   - Expression-valued `role={...}` in JSX is treated as "declared"
 *     because we cannot read the runtime value statically; the rule
 *     skips the element to avoid a false positive on conditional roles.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";

export const rule = defineRule({
  id: "aria/presentation-on-semantic-ancestor",
  satisfies: [
    "wcag22:1.3.1",
    "wcag21:1.3.1",
    "section508:1.3.1",
    "en301549:9.1.3.1",
    "wcag22:4.1.2",
    "wcag21:4.1.2",
    "section508:4.1.2",
    "en301549:9.4.1.2",
  ],
  severity: "warning",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      'Flags role="presentation" / role="none" on a semantic host (<table>, <ul>, <ol>, <dl>, <figure>, <form>) whose subtree contains the children that encode that host\'s semantics (<th>/<caption>, <li>, <dt>/<dd>, <figcaption>, <legend>) — the role silently strips semantics those children depend on.',
    rationale:
      'role="presentation" / role="none" on a host element tells assistive technology "treat this as a generic container, ignore the implicit semantics." When the host\'s subtree contains the children that carry those semantics — <th> headers in a <table>, <li> items in a list, <dt>/<dd> pairs in a definition list, <figcaption> in a figure, <legend> in a form — stripping the host\'s role breaks the children\'s announcement and navigation contracts: a <th> outside a recognized <table> is just a styled cell with no row/column semantics; an <li> outside a recognized list is just an indented bullet with no "1 of N" announcement; a <figcaption> outside a recognized <figure> is just floating text. WAI-ARIA 1.2 specifies a "conditional role stripping" behavior for some pairs (the UA may ignore role="presentation" on an element with required children for an explicit role), but the behavior is uneven across browser/AT combinations and depends on the children matching exactly — the static-source pattern is still misleading and fragile across refactors. Detecting it cheaply at scan time prevents the silent semantics loss.',
    goodExample: `<table>
  <caption>Quarterly results</caption>
  <thead><tr><th scope="col">Quarter</th><th scope="col">Revenue</th></tr></thead>
  <tbody><tr><td>Q1</td><td>$1.2M</td></tr></tbody>
</table>

<ul>
  <li>First</li>
  <li>Second</li>
</ul>

<table role="presentation">
  <tr><td>Layout cell A</td><td>Layout cell B</td></tr>
</table>`,
    badExample: `<table role="presentation">
  <caption>Quarterly results</caption>
  <thead><tr><th scope="col">Quarter</th><th scope="col">Revenue</th></tr></thead>
  <tbody><tr><td>Q1</td><td>$1.2M</td></tr></tbody>
</table>

<ul role="none">
  <li>First</li>
  <li>Second</li>
</ul>

<figure role="presentation">
  <img src="chart.png" alt="">
  <figcaption>Revenue over time</figcaption>
</figure>`,
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/TR/wai-aria-1.2/#presentation",
      "https://www.w3.org/TR/wai-aria-1.2/#none",
      "https://www.w3.org/TR/html-aria/",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
      return;
    }
    if (
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
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

/**
 * Per-host semantic-child triggers. The host is the *outer* element that
 * carries `role="presentation"` / `role="none"`; the trigger tags are the
 * children whose presence inside the host's subtree (with descent
 * stopping at nested same-host elements) signals the host's semantics
 * are being depended on by descendants.
 */
const SEMANTIC_HOSTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["table", new Set(["th", "caption"])],
  ["ul", new Set(["li"])],
  ["ol", new Set(["li"])],
  ["dl", new Set(["dt", "dd"])],
  ["figure", new Set(["figcaption"])],
  ["form", new Set(["legend"])],
]);

const PRESENTATIONAL_ROLES: ReadonlySet<string> = new Set(["presentation", "none"]);

// ---------------------------------------------------------------------------
// Shared suggestion / message builders
// ---------------------------------------------------------------------------

function buildMessage(host: string, role: string, child: string): string {
  return (
    `<${host} role="${role}"> contains <${child}> which depends on the <${host}>'s implicit semantics. ` +
    `role="${role}" tells assistive technology to ignore those semantics, silently stripping the contract <${child}> needs to be announced correctly.`
  );
}

function buildSuggestion(host: string, role: string, child: string): string {
  const childList = childrenForHost(host);
  return (
    `This <${host}> is marked role="${role}", but its subtree contains <${child}> — a child whose semantics depend on the <${host}> being recognized as ${describeHostSemantics(host)}. ` +
    `If the <${host}> is genuinely meaningful (its ${childList} carries information AT users need), remove role="${role}" so the implicit ${describeHostSemantics(host)} semantics survive. ` +
    `If the <${host}> is layout scaffolding and the role really is intentional, replace the semantic children too — change <${child}> elements to non-semantic equivalents (e.g. ${replacementHint(host, child)}) so the markup matches the intent.`
  );
}

function describeHostSemantics(host: string): string {
  switch (host) {
    case "table":
      return "a data table with rows and columns";
    case "ul":
      return "an unordered list";
    case "ol":
      return "an ordered list";
    case "dl":
      return "a description list";
    case "figure":
      return "a figure with a caption";
    case "form":
      return "a form landmark";
    default:
      return `a <${host}>`;
  }
}

function childrenForHost(host: string): string {
  const triggers = SEMANTIC_HOSTS.get(host);
  if (!triggers) return "structure";
  const list = [...triggers].map((t) => `<${t}>`).join(" / ");
  return list;
}

function replacementHint(host: string, child: string): string {
  if (host === "table") {
    if (child === "th") return "<th> → <td>";
    if (child === "caption") return "<caption> → a sibling <p> or remove it";
    return `restructure <${child}>`;
  }
  if (host === "ul" || host === "ol") {
    return `<li> → <div> or flow content`;
  }
  if (host === "dl") {
    return `<dt> / <dd> → <p> with bold/regular text`;
  }
  if (host === "figure") {
    return `<figcaption> → a sibling <p>`;
  }
  if (host === "form") {
    return `<legend> → a heading element`;
  }
  return `restructure <${child}>`;
}

// ---------------------------------------------------------------------------
// HTML branch
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const [host] of SEMANTIC_HOSTS) {
    for (const element of findHtmlElementsByTag(doc, host)) {
      const role = htmlPresentationalRole(element);
      if (role === null) continue;
      const child = htmlFirstSemanticChild(element, host);
      if (child === null) continue;
      emit({
        severity: "warning",
        location: {
          filePath: "",
          line: element.loc.start.line,
          column: element.loc.start.column,
        },
        message: buildMessage(host, role, child),
        suggestion: buildSuggestion(host, role, child),
      });
    }
  }
}

/**
 * Returns the literal presentational-role token (`"presentation"` /
 * `"none"`) when the element has `role="presentation"` or `role="none"`,
 * else null. The role attribute is a space-separated fallback chain;
 * only the first non-empty token is the primary role for AT, so we
 * match against that. `role=""` is treated as absent.
 */
function htmlPresentationalRole(element: HtmlElement): string | null {
  const role = getHtmlAttribute(element, "role");
  if (role === null) return null;
  const token = firstToken(role);
  if (token === null) return null;
  return PRESENTATIONAL_ROLES.has(token) ? token : null;
}

/**
 * Returns the first triggering child tag found in the element's
 * subtree, or null if none. Descent stops at nested same-host elements
 * (an inner `<ul>` inside the outer `<ul>`'s subtree is opaque) so each
 * host is evaluated against only the children it directly governs.
 */
function htmlFirstSemanticChild(host: HtmlElement, hostTag: string): string | null {
  const triggers = SEMANTIC_HOSTS.get(hostTag);
  if (!triggers) return null;
  let found: string | null = null;
  const visit = (node: HtmlNode): void => {
    if (found !== null) return;
    if (node.kind !== "HtmlElement") return;
    const tag = node.tagName.toLowerCase();
    if (tag === hostTag) return; // do not descend into a nested same-host element
    if (triggers.has(tag)) {
      found = tag;
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of host.children) visit(child);
  return found;
}

// ---------------------------------------------------------------------------
// JSX branch
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const [host] of SEMANTIC_HOSTS) {
    for (const element of findJsxElementsByTag(module, host)) {
      const role = jsxPresentationalRole(element);
      if (role === null) continue;
      const child = jsxFirstSemanticChild(element, host);
      if (child === null) continue;
      emit({
        severity: "warning",
        location: {
          filePath: "",
          line: element.loc.start.line,
          column: element.loc.start.column,
        },
        message: buildMessage(host, role, child),
        suggestion: buildSuggestion(host, role, child),
      });
    }
  }
}

/**
 * Same semantics as `htmlPresentationalRole` but for JSX. Expression-
 * valued `role={...}` is treated as "not statically a presentational
 * role" and the rule skips the element — the runtime value might be
 * anything, and false positives on conditional roles are the documented
 * authoring footgun.
 */
function jsxPresentationalRole(element: JsxElement): string | null {
  const literal = getJsxAttributeString(element, "role");
  // Absent OR expression-valued. Either way we can't confirm it's a
  // presentational literal, so skip — the rule conservatively does not
  // fire on `role={...}` to avoid false positives on conditional roles.
  if (literal === null) return null;
  const token = firstToken(literal);
  if (token === null) return null;
  return PRESENTATIONAL_ROLES.has(token) ? token : null;
}

function jsxFirstSemanticChild(host: JsxElement, hostTag: string): string | null {
  const triggers = SEMANTIC_HOSTS.get(hostTag);
  if (!triggers) return null;
  let found: string | null = null;
  const visit = (node: JsxNode): void => {
    if (found !== null) return;
    if (node.kind !== "JsxElement") return;
    const tag = node.tagName;
    if (tag === hostTag) return;
    if (triggers.has(tag)) {
      found = tag;
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of host.children) visit(child);
  return found;
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * The first non-empty token of an attribute value. ARIA's `role`
 * attribute allows a space-separated fallback chain; only the first
 * token is the primary role applied by AT, so the rule keys off that.
 * Lowercased so `role="PRESENTATION"` still matches.
 */
function firstToken(value: string): string | null {
  for (const raw of value.split(/\s+/)) {
    const token = raw.trim();
    if (token.length > 0) return token.toLowerCase();
  }
  return null;
}
