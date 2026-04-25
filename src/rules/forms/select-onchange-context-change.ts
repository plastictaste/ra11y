/**
 * Rule: forms/select-onchange-context-change
 * Satisfies: wcag22:3.2.2, wcag21:3.2.2, section508:3.2.2, en301549:9.3.2.2
 * Spec: https://www.w3.org/TR/WCAG22/#on-input
 *
 * > Changing the setting of any user interface component does not
 * > automatically cause a change of context unless the user has been
 * > advised of the behavior before using the component.
 *
 * Source: https://www.w3.org/TR/WCAG22/#on-input
 *
 * Flags `<select onchange="…navigate|location|window.open|submit…">`
 * patterns where merely picking an option triggers a context change
 * (navigation, form submission, opening a new window). The `<select>`'s
 * setting is changed by the user adjusting focus through options
 * (especially with arrow keys), and a navigation or submit on every
 * change traps keyboard users on the first option they hover.
 *
 * Detection grammar — three substrates, the same handler-text probe:
 *
 *   1. HTML literal handler:
 *        `<select onchange="location.href=this.value">`
 *      The attribute value is matched directly.
 *   2. JSX inline handler:
 *        `<select onChange={(e) => router.push(e.target.value)}>`
 *      The expression `raw` text is matched.
 *   3. JSX function-reference handler:
 *        `<select onChange={handleChange}>` where `handleChange`'s body,
 *      anywhere in the same file, contains a navigation/submit token.
 *      Single-file static scope only — the agent can grep across files
 *      faster than an in-process resolver could (and a wrong cross-file
 *      guess is worse than pointing honestly).
 *
 * Token list (case-sensitive on identifier names — ALL-CAPS variants
 * like `LOCATION` are not the DOM `location` global):
 *
 *   - `location.`        — `location.href = …`, `window.location = …`
 *   - `window.open`      — opens a new window/tab
 *   - `submit()`         — `this.form.submit()`, `formRef.current.submit()`
 *   - `navigate(`        — React Router v6 `useNavigate`
 *   - `router.push`      — Next.js / Vue Router
 *   - `Router.push`      — Next.js capitalised import
 *
 * Decorative `onchange` (state update only — `setValue(e.target.value)`,
 * a controlled-component pattern, calling a callback prop) stays
 * silent. The token grammar is deliberately narrow — encoding "any
 * function call" as a violation would punish every controlled select.
 *
 * The rule does NOT detect `aria-describedby` or sibling prose telling
 * the user "selecting an option will load the page" — WCAG 3.2.2's
 * exception ("unless the user has been advised") is conceptual and the
 * deterministic escape hatch is `<!-- ra11y-disable wcag22:3.2.2 -->`
 * once the agent verifies the warning is present. Encoding "we saw a
 * <p> nearby that said 'navigates'" as suppression would be heuristic
 * silencing of a clear failure pattern.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttribute,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, JsxElement, TsxModule } from "../../types/ast.ts";

/**
 * Tokens whose presence in a `<select>` change handler indicates a
 * context change. Matched as plain substrings — the patterns are
 * specific enough that substring detection is reliable (`router.push`
 * is rarely a false-positive token in a select handler).
 *
 * Case-sensitive: `location.`, `window.open`, `Router.push` etc. are
 * the canonical DOM/library spellings; ALL-CAPS or lower-then-upper
 * variants are user-defined identifiers that happen to share the name,
 * not the DOM `location` global or a real router.
 */
const CONTEXT_CHANGE_TOKENS: readonly string[] = [
  "location.",
  "window.open",
  "submit()",
  "navigate(",
  "router.push",
  "Router.push",
];

/**
 * Identifier-character class for boundary checks when locating a
 * function declaration in the source. Mirrors the JS identifier
 * grammar (letters, digits, `_`, `$`).
 */
const IDENT_BOUNDARY = /[A-Za-z0-9_$]/;

export const rule = defineRule({
  id: "forms/select-onchange-context-change",
  satisfies: ["wcag22:3.2.2", "wcag21:3.2.2", "section508:3.2.2", "en301549:9.3.2.2"],
  severity: "error",
  scope: "node",
  fixClass: "guidance",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Flags <select onchange> handlers that navigate, submit, or open a new window — selecting an option triggers a context change without explicit user activation.",
    rationale:
      'WCAG 3.2.2 (On Input, Level A) forbids unannounced context changes from a user adjusting a control\'s setting. A `<select>` whose `onchange` navigates the page or submits the form fails this universally for keyboard users: arrow-key navigation through options walks the page away from them on every keystroke. Sighted mouse users are also surprised when picking the wrong option commits an unintended action with no confirmation. The fix is almost always to pair the `<select>` with a separate `<button>` ("Go", "Apply", "Submit") that the user activates explicitly — that is the user request the spec requires.',
    goodExample: `<form>
  <select name="lang">
    <option value="en">English</option>
    <option value="fr">Français</option>
  </select>
  <button type="submit">Apply</button>
</form>`,
    badExample: `<select onchange="location.href=this.value">
  <option value="/en">English</option>
  <option value="/fr">Français</option>
</select>`,
    normativeQuote:
      "Changing the setting of any user interface component does not automatically cause a change of context unless the user has been advised of the behavior before using the component.",
    references: [
      "https://www.w3.org/TR/WCAG22/#on-input",
      "https://www.w3.org/WAI/WCAG22/Understanding/on-input.html",
      "https://www.w3.org/WAI/WCAG22/Techniques/failures/F36",
      "https://www.w3.org/WAI/WCAG22/Techniques/failures/F37",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, ctx.emit);
      return;
    }
    if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkJsx(ctx.ast as TsxModule, ctx.source, ctx.emit);
    }
  },
});

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const select of findHtmlElementsByTag(doc, "select")) {
    const handler = getHtmlAttribute(select, "onchange");
    if (handler === null) continue;
    const token = firstMatchingToken(handler);
    if (token === null) continue;
    emit({
      severity: "error",
      location: {
        filePath: "",
        line: select.loc.start.line,
        column: select.loc.start.column,
      },
      message: `<select onchange="…"> handler contains \`${token}\` — choosing an option triggers a context change without explicit user activation.`,
      suggestion: buildSuggestion(token, "html"),
    });
  }
}

function checkJsx(module: TsxModule, source: string, emit: Emit): void {
  for (const select of findJsxElementsByTag(module, "select")) {
    const finding = inspectJsxSelect(select, source);
    if (finding === null) continue;
    emit({
      severity: "error",
      location: {
        filePath: "",
        line: select.loc.start.line,
        column: select.loc.start.column,
      },
      message: finding.message,
      suggestion: buildSuggestion(finding.token, "jsx"),
    });
  }
}

interface JsxFinding {
  readonly token: string;
  readonly message: string;
}

function inspectJsxSelect(select: JsxElement, source: string): JsxFinding | null {
  const attr = getJsxAttribute(select, "onChange") ?? getJsxAttribute(select, "onchange");
  if (!attr?.value) return null;

  // Inline string handler — `<select onChange="location.href=…">` (rare
  // in JSX but valid syntax). Match the literal.
  if (attr.value.kind === "StringLiteral") {
    const token = firstMatchingToken(attr.value.value);
    if (token === null) return null;
    return {
      token,
      message: `<select onChange="…"> handler contains \`${token}\` — choosing an option triggers a context change without explicit user activation.`,
    };
  }

  // Expression handler — `<select onChange={…}>`. Two shapes:
  //
  //   (a) Inline body: `(e) => router.push(e.target.value)`,
  //       `function(e) { window.open(e.target.value) }`. The raw
  //       expression text is the body.
  //   (b) Reference: `handleChange`. The raw is just the identifier;
  //       resolve it to a function declaration in the same file and
  //       match against THAT body.
  //
  // The parser preserves the wrapping braces in `raw` (e.g.
  // `"{handleChange}"`), so strip them before inspecting.
  const raw = stripExpressionBraces(attr.value.raw);
  const inlineToken = firstMatchingToken(raw);
  if (inlineToken !== null) {
    return {
      token: inlineToken,
      message: `<select onChange={…}> inline handler contains \`${inlineToken}\` — choosing an option triggers a context change without explicit user activation.`,
    };
  }

  const ref = extractIdentifier(raw);
  if (ref === null) return null;

  const refBody = findFunctionBody(source, ref);
  if (refBody === null) return null;

  const refToken = firstMatchingToken(refBody);
  if (refToken === null) return null;
  return {
    token: refToken,
    message: `<select onChange={${ref}}> — \`${ref}\` body contains \`${refToken}\`, so choosing an option triggers a context change without explicit user activation.`,
  };
}

/**
 * Returns the bare identifier when `raw` is exactly `<ident>` —
 * `handleChange`, `_onChange`, `$dispatch`. Whitespace tolerated. Any
 * other shape (`(e) => …`, `function`, member access, call expression)
 * returns null because we don't have a function reference to resolve.
 */
function extractIdentifier(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * The TSX parser preserves the wrapping `{ … }` on JSX expression
 * attribute values' `raw` field — `onChange={handleChange}` shows up
 * as `raw: "{handleChange}"`. Strip the outer braces (and surrounding
 * whitespace) so the inspection sees the bare expression. Returns the
 * input unchanged when the braces aren't present (defensive — newer
 * parsers may strip them themselves).
 */
function stripExpressionBraces(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Locates the body of a function declaration named `name` anywhere in
 * the source file and returns the body text between `{` and the
 * matching `}`. Three declaration shapes covered, deliberately the
 * common ones:
 *
 *   function name(…) { … }
 *   const name = (…) => { … }    // and let/var, with or without arg parens
 *   const name = (…) => expr     // arrow without braces — body is the expression
 *   const name = function (…) { … }
 *
 * Returns null when no declaration is found OR when the declaration
 * uses a shape we can't statically read (object-method shorthand,
 * destructured re-exports, dynamic assignment). Honest miss.
 */
function findFunctionBody(source: string, name: string): string | null {
  const escaped = escapeForRegex(name);
  // function name(args) { … }
  const fnDecl = new RegExp(`\\bfunction\\s+${escaped}\\s*\\([^)]*\\)\\s*\\{`);
  const fnMatch = fnDecl.exec(source);
  if (fnMatch !== null) {
    const bodyStart = fnMatch.index + fnMatch[0].length;
    const body = extractBracedBody(source, bodyStart - 1);
    if (body !== null) return body;
  }

  // const/let/var name = function (args) { … }
  const fnExpr = new RegExp(
    `\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*function\\s*\\*?\\s*\\([^)]*\\)\\s*\\{`,
  );
  const exprMatch = fnExpr.exec(source);
  if (exprMatch !== null) {
    const bodyStart = exprMatch.index + exprMatch[0].length;
    const body = extractBracedBody(source, bodyStart - 1);
    if (body !== null) return body;
  }

  // const/let/var name = (args) => { … } | (args) => expr | arg => expr
  const arrowDecl = new RegExp(
    `\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*`,
  );
  const arrowMatch = arrowDecl.exec(source);
  if (arrowMatch !== null) {
    const after = arrowMatch.index + arrowMatch[0].length;
    if (source[after] === "{") {
      const body = extractBracedBody(source, after);
      if (body !== null) return body;
    } else {
      // Expression-bodied arrow — the body is everything until the next
      // statement terminator. Conservative: walk to end-of-line or
      // semicolon, whichever comes first. Never crosses block braces.
      return extractExpressionBody(source, after);
    }
  }

  return null;
}

/**
 * Given an index pointing at `{`, returns the substring inside the
 * brace pair (matching nested braces). Returns null when the braces
 * never balance (truncated source, malformed JS).
 */
function extractBracedBody(source: string, openBraceIndex: number): string | null {
  if (source[openBraceIndex] !== "{") return null;
  let depth = 1;
  for (let i = openBraceIndex + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(openBraceIndex + 1, i);
    }
  }
  return null;
}

/**
 * For an expression-bodied arrow (`= () => expr`), returns `expr` up
 * to the next semicolon, comma, or end-of-line (whichever comes first).
 * Conservative — won't follow into braces or nested calls past EOL.
 */
function extractExpressionBody(source: string, startIndex: number): string {
  let i = startIndex;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (ch === ";" || ch === "\n" || ch === ",")) {
      break;
    }
    i++;
  }
  return source.slice(startIndex, i);
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the first context-change token found in `text`, or null.
 * Membership rules:
 *   - `location.` requires that the preceding char is NOT an identifier
 *     character — guards against `LOCATION.` (different identifier) and
 *     `myLocation.foo` (custom property). The DOM `location` global is
 *     a bare identifier.
 *   - The other tokens (`window.open`, `submit()`, `navigate(`,
 *     `router.push`, `Router.push`) are specific enough to rely on
 *     plain substring matching.
 */
function firstMatchingToken(text: string): string | null {
  for (const token of CONTEXT_CHANGE_TOKENS) {
    if (token === "location.") {
      if (matchesLocationToken(text)) return token;
      continue;
    }
    if (text.includes(token)) return token;
  }
  return null;
}

/**
 * True when `text` contains the bare-identifier `location.` pattern
 * — i.e. `location` not preceded by an identifier character. This
 * matches `location.href`, `window.location.assign`, `;location.foo`,
 * `(location.bar)`. It does NOT match `myLocation.foo` (preceded by
 * `y`) or `LOCATION.foo` (different casing — the case-sensitive
 * `includes` of the literal substring `location.` would reject that
 * already, and this function preserves the same case discipline).
 */
function matchesLocationToken(text: string): boolean {
  let from = 0;
  while (true) {
    const idx = text.indexOf("location.", from);
    if (idx === -1) return false;
    if (idx === 0) return true;
    const prev = text[idx - 1] ?? "";
    if (!IDENT_BOUNDARY.test(prev)) return true;
    from = idx + 1;
  }
}

function buildSuggestion(token: string, language: "html" | "jsx"): string {
  const example =
    language === "html"
      ? `<select name="lang">\n  <option value="/en">English</option>\n  <option value="/fr">Français</option>\n</select>\n<button type="submit">Apply</button>`
      : `<select value={lang} onChange={(e) => setLang(e.target.value)}>\n  <option value="en">English</option>\n  <option value="fr">Français</option>\n</select>\n<button type="button" onClick={() => router.push(\`/$\{lang}\`)}>Apply</button>`;
  return `Selecting an option fires the change handler on every focused option (arrow-key navigation walks the page away from keyboard users on each keystroke). Pair the <select> with an explicit submit/apply button: keep the change handler limited to local state, and put the \`${token}\` call behind a <button> the user activates deliberately. Example:\n\n${example}`;
}
