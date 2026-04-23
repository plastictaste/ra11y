/**
 * URL-scheme recognition for the HTML tokenizer's open-side recovery.
 *
 * Markdown autolinks (`<https://example.com>`, `<mailto:alice@x.com>`)
 * survive the `.md` → HTML residue pass and would otherwise tokenize
 * into a synthetic element: the tag-name reader accepts `:` as a name
 * char (XML-style `<svg:circle>` namespaces are real), so `<https:`
 * becomes a `<https:>` element whose unclosed-element recovery then
 * cascades `Unclosed <https:>` / `Unclosed <p>` errors through every
 * following `</p>` / `</li>` / `</td>` on the page.
 *
 * The fix: the tokenizer does a cheap peek before entering
 * `#consumeElement` and bails to the text path whenever the opener
 * matches a URL-scheme keyword followed by `:`. The URL then emits
 * as literal text and surrounding element structure parses normally.
 *
 * Kept as a closed keyword set (rather than "tag ends with `:`") so
 * XML namespace parses continue on the element path. Widening would
 * admit genuine namespace shapes without a matching fixture; narrower
 * would miss schemes the field test has already reproduced.
 *
 * Extracted from `html.ts` so the tokenizer file stays under the
 * per-file line budget and the acceptance surface is visible as a
 * pure helper — mirrors the same extraction `html-template-directives`
 * did for the `{{ … }}` / `{% … %}` / `<%… %>` stripper.
 *
 * See `docs/kb/architecture/input-parsers.md` §"html.ts" for the
 * character-driven recovery contract and
 * `tests/unit/input/parsers/html.test.ts` for the regression guards.
 */

/**
 * URL scheme keywords that must never be treated as HTML element-
 * opener tag names. Letter-only — every keyword in the set is
 * letter-only, so the opener scan reads with `[a-zA-Z]+:` and doesn't
 * need to admit the full RFC 3986 scheme alphabet.
 */
const URL_SCHEME_NAMES: ReadonlySet<string> = new Set([
  "about",
  "data",
  "file",
  "ftp",
  "http",
  "https",
  "javascript",
  "mailto",
  "sms",
  "tel",
  "ws",
  "wss",
]);

/**
 * True when `source[pos]` is `<` followed by a URL-scheme keyword and
 * a trailing `:` (the Markdown-autolink shape). Pure peek — does not
 * mutate the caller's position state.
 *
 * Caller contract: positioned at the `<` of a potential element open,
 * already confirmed by the tokenizer's element-open branch that the
 * character after `<` is a name-start. This helper then validates
 * whether the full name run + trailing `:` matches a URL scheme.
 */
export function looksLikeUrlSchemeOpener(source: string, pos: number): boolean {
  if (source[pos] !== "<") return false;
  let i = pos + 1;
  const nameStart = i;
  while (i < source.length) {
    const ch = source[i];
    if (ch === undefined) return false;
    if (!/[a-zA-Z]/.test(ch)) break;
    i += 1;
  }
  if (i === nameStart) return false;
  if (source[i] !== ":") return false;
  const name = source.slice(nameStart, i).toLowerCase();
  return URL_SCHEME_NAMES.has(name);
}
