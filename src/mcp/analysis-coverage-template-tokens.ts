/**
 * Template-interpolation token detection, extracted from
 * `analysis-coverage.ts` so the parent module stays under the
 * effective-line budget. These three functions are pure string
 * scanners — no AST, no imports — and are easiest to read and test
 * in isolation.
 */

/**
 * Counts template-interpolation tokens in `source`, accumulating them
 * by normalized literal into `into`. Replaces the earlier
 * `detectTemplateEngines` family classifier — that function stamped
 * deterministic-sounding family tokens
 * ("handlebars-or-mustache", "jinja-or-liquid", "erb-or-ejs") on what
 * was at best a heuristic guess: the same `{{ x }}` shape appears in
 * Handlebars, Mustache, Liquid, Jinja, Vue, Angular, and (with a `$`
 * prefix) GitHub-Actions workflow expressions. Stamping a family on
 * top of the surface evidence misled an agent every time the corpus
 * happened to be the wrong dialect for the label.
 *
 * Doctrine ("Heuristic-mislabeled meta sub-fields are dishonest"):
 * the field's `reason`-shaped sub-tokens must clear the same
 * "provable from the code" bar as a labeled bucket. Family attribution
 * fails that bar — Vue, Angular, and Liquid all share `{{ x }}` with
 * no in-file way to distinguish them, and `${{ x }}` GitHub-Actions
 * expressions in `.yml` documentation embedded in `.md` files inflated
 * the false-positive rate further. The honest shape surfaces the raw
 * interpolation token + count and lets the agent disambiguate dialect
 * by reading the surrounding file.
 *
 * Tokens emitted:
 *   - `"{{x}}"` — bare double-brace interpolation (Handlebars,
 *     Mustache, Liquid plain interpolation, Jinja interpolation, Vue,
 *     Angular). JSX/Astro attribute-spread `={{ ... }}` (`overrides=
 *     {{ body: x }}`) is excluded — the outer `{` is the JSX
 *     expression boundary, not template evidence.
 *   - `"{%x%}"` — control block (Jinja `{% extends %}`, Liquid
 *     `{% include %}`, Nunjucks, Twig). Whitespace-control `{%-` and
 *     `-%}` variants count as the same token shape — surfacing the
 *     Liquid-specific dash to the agent is the agent's concern, not
 *     the scanner's.
 *   - `"<%x%>"` — ERB / EJS scriptlet (and the `<%=` / `<%-` variants).
 *   - `"${{x}}"` — GitHub-Actions workflow expression (or the
 *     same shape inside a JS template literal). Surfaced as a
 *     distinct token so an agent reading a `.yml`-documenting `.md`
 *     can immediately tell the evidence is workflow expressions, not
 *     Handlebars.
 *
 * The function is invoked once per parsed HTML-family file. The
 * caller-supplied `into` map accumulates counts across the scan; the
 * outer assembler later sorts the densest token first for the wire
 * shape. Liquid whitespace-strip (`{{-` / `-}}`) and Liquid filter-
 * pipe evidence are intentionally NOT given their own tokens — those
 * are dialect-disambiguation signals the agent reads from the file
 * itself, and giving them a stamp recreates the family-label problem
 * one level down.
 */
export function detectTemplateInterpolation(source: string, into: Map<string, number>): void {
  const doubleBrace = countDoubleBraceTokens(source);
  if (doubleBrace.bare > 0) into.set("{{x}}", (into.get("{{x}}") ?? 0) + doubleBrace.bare);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: "${{x}}" is a literal map key naming the GitHub-Actions token shape, not a template expression
  if (doubleBrace.dollar > 0) into.set("${{x}}", (into.get("${{x}}") ?? 0) + doubleBrace.dollar);

  // Control blocks: `{% ... %}` plus the `{%-` / `-%}` whitespace-
  // control variants. Counted by raw occurrences — a Jekyll layout
  // with eight `{% include %}` stamps the token eight times so the
  // densest-first ranking surfaces real-volume signals over a stray
  // example block.
  const controlBlocks = countMatches(source, /\{%-?[\s\S]*?-?%\}/g);
  if (controlBlocks > 0) into.set("{%x%}", (into.get("{%x%}") ?? 0) + controlBlocks);

  // ERB/EJS scriptlets: `<% ... %>`, `<%= ... %>`, `<%- ... %>`.
  const erbScriptlets = countMatches(source, /<%[=-]?[\s\S]*?%>/g);
  if (erbScriptlets > 0) into.set("<%x%>", (into.get("<%x%>") ?? 0) + erbScriptlets);
}

/**
 * Splits `{{ ... }}` occurrences in `source` by their immediate
 * prefix: `=` (JSX attribute-spread, dropped), `$` (GitHub-Actions /
 * template-literal expression — its own token), everything else
 * (bare double-brace interpolation). Extracted from
 * {@link detectTemplateInterpolation} so the outer dispatcher stays
 * under the cognitive-complexity cap.
 */
function countDoubleBraceTokens(source: string): {
  readonly bare: number;
  readonly dollar: number;
} {
  let bare = 0;
  let dollar = 0;
  for (const match of source.matchAll(/\{\{[^}]+\}\}/g)) {
    const start = match.index;
    if (start === undefined) continue;
    const prevChar = start > 0 ? source[start - 1] : "";
    if (prevChar === "=") continue;
    if (prevChar === "$") {
      dollar += 1;
      continue;
    }
    bare += 1;
  }
  return { bare, dollar };
}

/**
 * Returns the count of regex matches in `source`. The match objects
 * are intentionally discarded — only the count matters for token
 * tally accumulation. Pulled out of the dispatcher so each shape
 * counter is one `countMatches` call instead of an inline loop.
 */
function countMatches(source: string, pattern: RegExp): number {
  let n = 0;
  for (const _ of source.matchAll(pattern)) n += 1;
  return n;
}
