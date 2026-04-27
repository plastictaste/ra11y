/**
 * Template-directive context detection for `suggest_fix`.
 *
 * When the target line of a `suggest_fix` lookup carries a templating
 * directive (Mustache/Handlebars `{{ ... }}`, Liquid/Jinja
 * `{% ... %}`, ERB `<%= ... %>` / `<%- ... %>` / `<% ... %>`, JSP
 * `<jsp:...>`, JS template literal `${...}`), the rule's literal
 * "fill with primary section title" / "rename to id=output2" suggestion
 * is dishonest — the heading body / id value resolves at render time
 * from the binding, not statically. The suggest_fix surface restructures
 * the response so the primary fix lane reframes as "verify the binding
 * resolves to non-empty text at render time" and the rule's original
 * mechanical/guidance text is demoted to an alternative.
 *
 * Doctrine bar (`docs/kb/architecture/ai-first-consumer.md` —
 * "Reason / priority / fix-description must agree across all three
 * channels" + "No heuristic suppression"): the detector fires only on
 * deterministic token presence — it does NOT speculate about runtime
 * binding values. The agent reading the reframed lane decides whether
 * the binding is trusted; the demoted in-vendor-style alternative still
 * ships the rule's literal proposal so the agent can see what the rule
 * would have proposed if the directive resolves to empty at render time.
 *
 * This composes with the existing template-aware emit downgrades — when
 * `semantics/empty-heading` already emits at `warning` with
 * `couldBeWrongBecause: ["template_directive_interpolation_unresolved"]`,
 * the suggest_fix reframe is the consistent companion that keeps the
 * primary lane's prose channel from contradicting the reason channel.
 *
 * Pure functions, no I/O. Sibling of `suggest-fix-vendor-context.ts`
 * (the vendor-classified file reroute); both feed the per-call
 * restructure path in `tool-suggest-fix-internals.ts`.
 */

/**
 * Discriminated kind of detected directive. Each variant names a token
 * family that is deterministic from the source bytes alone — the doctrine
 * bar from `ai-first-consumer.md` "Heuristic-mislabeled meta sub-fields
 * are dishonest." The agent reads `kind` to learn which template flavor
 * is in play (different SSGs / runtimes interpret each differently);
 * `tokens` carries the literal substrings matched so the agent can
 * cross-reference against the line.
 */
export type TemplateDirectiveKind =
  | "mustache-or-liquid-interpolation"
  | "liquid-or-jinja-tag"
  | "erb-or-ejs-scriptlet"
  | "jsp-tag"
  | "js-template-literal";

/**
 * Output of {@link detectTemplateDirectiveTarget}. `redirectTo` is a
 * stable enum the agent reads to learn *what* the restructure was for —
 * the single value `"verify-binding-at-render-time"` names the
 * "the heading/id is interpolated; verify the binding resolves" prose
 * that lives on the primary fix lane when this context is present.
 */
export interface TemplateDirectiveContext {
  readonly kinds: readonly TemplateDirectiveKind[];
  readonly tokens: readonly string[];
  readonly redirectTo: "verify-binding-at-render-time";
}

/**
 * Output of {@link detectMarkdownHeadingIdCollision}. Names the heading
 * text the markdown adapter would slugify into the same id, plus the
 * 1-based source line of the heading. The agent uses both to decide
 * which side of the collision to keep — the explicit id or the
 * heading-derived auto-id.
 */
export interface MarkdownHeadingIdCollision {
  readonly id: string;
  readonly headingText: string;
  readonly headingLine: number;
  readonly redirectTo: "resolve-markdown-heading-collision";
}

/**
 * Pattern table: each entry pairs a deterministic regex with the
 * {@link TemplateDirectiveKind} it represents. Anchored on distinctive
 * openers so a stray `{` inside JSX attribute syntax or literal text
 * doesn't false-fire. Order does not matter — every pattern is tested
 * against the same input.
 */
const TEMPLATE_DIRECTIVE_PATTERNS: ReadonlyArray<{
  readonly kind: TemplateDirectiveKind;
  readonly pattern: RegExp;
}> = [
  // Mustache / Handlebars / Liquid interpolation: `{{ x }}`, `{{- x -}}`.
  { kind: "mustache-or-liquid-interpolation", pattern: /\{\{-?\s[\s\S]*?-?\}\}/ },
  // Liquid / Jinja / Nunjucks tag: `{% if %}`, `{%- for -%}`.
  { kind: "liquid-or-jinja-tag", pattern: /\{%-?[\s\S]*?-?%\}/ },
  // ERB / EJS scriptlet: `<%= x %>`, `<%- x %>`, `<% x %>`, `<%# c %>`.
  { kind: "erb-or-ejs-scriptlet", pattern: /<%[=\-#]?[\s\S]*?%>/ },
  // JSP custom tag namespace: `<jsp:include …>`, `<c:out value=…>`.
  { kind: "jsp-tag", pattern: /<(?:jsp|c|fmt|fn|sql|x):[A-Za-z]/ },
  // JS template literal interpolation: `${x}`. Only counted when sitting
  // inside backticks on the same line — a bare `${x}` outside a template
  // literal would not be a runtime interpolation and could false-fire on
  // shell expansions or string-formatting helpers. The line-scoped check
  // happens in `detectTemplateDirectiveTarget` after the candidate line
  // is isolated; this pattern is the cheap pre-filter.
  { kind: "js-template-literal", pattern: /\$\{[^}]*\}/ },
];

/**
 * True when `line` carries a JS template literal (backtick-quoted
 * string) somewhere on the same line as the `${...}` interpolation.
 * Cheap heuristic — anchors the JS-template-literal kind on the
 * presence of at least one backtick adjacent to the line's directive
 * span so `<input value="$\{x\}">` (a literal price-formatting string)
 * doesn't false-fire. False negatives on multi-line backtick blocks
 * are tolerable: the tokens-check still records every other directive
 * flavor, and the JS-template-literal kind is the rarest of the five.
 */
function lineCarriesBacktick(line: string): boolean {
  return line.indexOf("`") !== -1;
}

/**
 * Extracts the 1-based `targetLine` from `source` plus its immediate
 * neighbors (±2 lines) so multi-line tags like `{% include 'x'\n   foo:
 * bar %}` are still detected when the violation's `location.line` lands
 * on the opener-only or closer-only row. The window is intentionally
 * narrow — the goal is to catch tag spans straddling the violation
 * line, not to scan the whole file (that would risk false-positives on
 * unrelated directives elsewhere in the source).
 */
function targetLineWindow(source: string, targetLine: number): string {
  const lines = source.split("\n");
  // 0-based slice indices: target line at index (targetLine - 1); take
  // 2 above + 2 below inclusive. `Math.max(0, …)` clamps the start to
  // the top of the file; the end is inclusive of `targetLine + 1` so
  // `slice` (end-exclusive) takes one past it.
  const start = Math.max(0, targetLine - 3);
  const end = Math.min(lines.length, targetLine + 2);
  return lines.slice(start, end).join("\n");
}

/**
 * Detects template-directive presence in the source window around the
 * violation's target line. Returns a {@link TemplateDirectiveContext}
 * naming every directive kind that fired plus the literal substrings
 * matched, or `null` when no directive is present.
 *
 * Scope is intentionally narrow (±1 line around the target) so an
 * unrelated `{{ ... }}` elsewhere in the file does NOT trigger a
 * reroute — the reroute is honest only when the directive actually
 * sits in the violation's neighborhood.
 *
 * Pure over its (source, targetLine) inputs.
 */
export function detectTemplateDirectiveTarget(
  source: string,
  targetLine: number,
): TemplateDirectiveContext | null {
  const window = targetLineWindow(source, targetLine);
  if (window.length === 0) return null;
  const kinds: TemplateDirectiveKind[] = [];
  const tokens: string[] = [];
  for (const { kind, pattern } of TEMPLATE_DIRECTIVE_PATTERNS) {
    const match = window.match(pattern);
    if (match === null) continue;
    if (kind === "js-template-literal" && !lineCarriesBacktick(window)) continue;
    kinds.push(kind);
    tokens.push(match[0]);
  }
  if (kinds.length === 0) return null;
  return {
    kinds,
    tokens,
    redirectTo: "verify-binding-at-render-time",
  };
}

/**
 * Slugifies a heading text the way mainstream markdown adapters
 * (kramdown, GitHub, MkDocs, Hugo) generate auto-ids: lowercase, strip
 * non-alphanumeric runs to `-`, trim trailing `-`. Conservative —
 * different SSGs apply slightly different rules (some preserve dots,
 * some collapse leading numbers), but the canonical case the backlog
 * captured (`## Output` → `output`, `## Section Two` → `section-two`)
 * matches across every adapter. Edge cases (Unicode normalization,
 * collision suffixes like `-1`, `-2`) are out of scope — the agent
 * reads the surfaced collision pair and decides whether to keep the
 * explicit id or rely on the auto-id.
 */
function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Walks `source` for ATX-style markdown headings (`# Title`, `## Title`)
 * appearing AFTER `afterLine` and returns the first whose slugified
 * text matches `id`. Returns `null` when no such heading exists.
 *
 * Restricted to ATX headings (`#`-prefixed) because Setext headings
 * (`Title\n===`) are stripped without preserving the title-line
 * position in our markdown adapter — the line-anchored slug match
 * would be unreliable. Limited to headings AFTER the duplicate-id
 * target so the collision is forward-looking (the agent's explicit
 * id collides with an auto-id the SSG will generate downstream).
 */
function findMatchingMarkdownHeadingAfter(
  source: string,
  id: string,
  afterLine: number,
): { headingText: string; headingLine: number } | null {
  const lines = source.split("\n");
  for (let i = afterLine; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    // ATX heading: up to 3 leading spaces (CommonMark indent ceiling),
    // then 1-6 `#` chars, then space, then text. The leading-`#` anchor
    // prevents false-fire on paragraph text that happens to contain a
    // `#` mid-line.
    const match = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match === null) continue;
    const text = match[2];
    if (text === undefined) continue;
    if (slugifyHeading(text) === id) {
      // Lines are 0-indexed in the array; report 1-based source line.
      return { headingText: text, headingLine: i + 1 };
    }
  }
  return null;
}

/**
 * Detects the markdown-heading-collision case for `parsing/duplicate-id`
 * suggest_fix lookups: the explicit id on the violation line collides
 * with the auto-id a markdown adapter will generate from a later
 * heading whose slugified text matches the same value.
 *
 * Inputs:
 *   - `source` — the raw file source the suggest_fix scan parsed.
 *   - `targetLine` — 1-based line of the duplicate-id violation.
 *   - `id` — the conflicting id value extracted from the violation
 *     snippet / source line. The detector accepts the value verbatim;
 *     the caller is responsible for unquoting / trimming.
 *
 * Returns a {@link MarkdownHeadingIdCollision} when a matching ATX
 * heading sits AFTER `targetLine` in the source; `null` otherwise.
 *
 * Pure over its inputs. Cost is one O(n) pass over `source` lines past
 * `targetLine`.
 */
export function detectMarkdownHeadingIdCollision(
  source: string,
  targetLine: number,
  id: string,
): MarkdownHeadingIdCollision | null {
  if (id.length === 0) return null;
  const found = findMatchingMarkdownHeadingAfter(source, id, targetLine);
  if (found === null) return null;
  return {
    id,
    headingText: found.headingText,
    headingLine: found.headingLine,
    redirectTo: "resolve-markdown-heading-collision",
  };
}

/**
 * Extracts the literal id value from the source line at `line` when an
 * `id="..."` / `id='...'` attribute is present. Returns `null` when no
 * id attribute is on the line (the duplicate-id rule's emit always
 * lands on a line that carries `id=`, but the suggest_fix surface may
 * hit drift cases — the detector returns `null` rather than guessing).
 *
 * Captures both single- and double-quoted values; unquoted HTML id
 * attributes are out of scope (the duplicate-id rule's emit predicate
 * doesn't fire on them either, so missing them here doesn't drop a
 * real collision).
 */
export function extractIdAttributeOnLine(source: string, line: number): string | null {
  const lines = source.split("\n");
  const target = lines[line - 1];
  if (target === undefined) return null;
  const match = target.match(/\bid\s*=\s*["']([^"']+)["']/);
  return match === null ? null : (match[1] ?? null);
}

/**
 * Short label for the `primary.approach` field on the
 * verify-binding-at-render-time lane. Stable string the agent reads as
 * the one-line summary of the `primary.explanation` block. Mirrors the
 * vendor module's {@link OVERRIDE_PRIMARY_APPROACH} format so the two
 * reroute lanes read as peers.
 */
export const VERIFY_BINDING_PRIMARY_APPROACH =
  "Verify the template binding resolves to non-empty text at render time";

/**
 * Short label for the alternative entry that demotes the rule's
 * original mechanical / guidance suggestion when a template-directive
 * reroute fires. Mirrors the
 * {@link IN_VENDOR_EDIT_ALTERNATIVE_APPROACH} format.
 */
export const HARDCODE_FALLBACK_ALTERNATIVE_APPROACH =
  "Hard-code the value (only when the binding genuinely should not vary at runtime)";

/**
 * Short label for the `primary.approach` on the markdown-heading-id
 * collision lane. Names the cross-reference choice — keep the explicit
 * id or rely on the auto-generated one — without prejudicing which the
 * agent should pick.
 */
export const RESOLVE_MARKDOWN_COLLISION_PRIMARY_APPROACH =
  "Resolve the collision with the markdown-adapter's auto-generated heading id";

/**
 * Builds the human-readable primary explanation for a template-directive
 * reroute. Names *what* to do (verify the binding cannot resolve to
 * empty at render time), *why* (static analysis cannot see the rendered
 * output), and *how* (test fixtures, defaults like
 * `{{ x | default: "fallback" }}`, source-level disable when the
 * binding is trusted). Composed from the directive kinds + tokens so
 * the prose reads as binding-specific even when the rule didn't emit
 * a snippet.
 */
export function buildVerifyBindingPrimaryExplanation(
  ruleId: string,
  context: TemplateDirectiveContext,
): string {
  const directiveLabel = describeDirectiveKinds(context.kinds);
  const tokenSample = context.tokens[0];
  const tokenPhrase =
    tokenSample === undefined ? "" : ` (e.g. \`${truncateForExplanation(tokenSample)}\`)`;
  return [
    `The target line carries a ${directiveLabel} template binding${tokenPhrase};`,
    `the rule's "fill in a value" / "rename to a unique suffix" suggestion would hard-code over the binding,`,
    `losing the runtime substitution. Verify the binding cannot resolve to empty / collide at render time —`,
    `add a fallback (Liquid \`| default: "..."\`, Jinja \`| default("...")\`, ERB \`presence || "..."\`),`,
    `cover the empty-binding path in a test fixture, or if the binding is trusted to always produce`,
    `valid content suppress at source with`,
    `\`<!-- ra11y-disable ${ruleId} -->\` (HTML / Markdown / ERB) or`,
    `\`{/* ra11y-disable ${ruleId} */}\` (JSX / TSX) to make the dismissal durable across re-runs.`,
  ].join(" ");
}

/**
 * Builds the markdown-heading-collision primary explanation. Names the
 * adapter behavior (`## Output` slugifies to `id="output"`), the
 * collision shape, and the two resolution paths so the agent can pick
 * which side to change without re-reading the file.
 */
export function buildMarkdownHeadingCollisionExplanation(
  ruleId: string,
  collision: MarkdownHeadingIdCollision,
): string {
  return [
    `The duplicate id="${collision.id}" collides with the auto-id the markdown renderer will generate`,
    `from the heading "${collision.headingText}" at line ${collision.headingLine} (most adapters slugify`,
    `heading text to lowercase-hyphenated form). The rule's "rename to a unique suffix" suggestion would`,
    `treat the auto-id as the canonical owner; either remove the explicit id="${collision.id}" attribute`,
    `(letting the heading's auto-id own the anchor) OR change the heading text so its slug differs from`,
    `the explicit id. Both resolutions are valid — pick based on which anchor the rest of the document`,
    `(and any inbound links) targets. If the explicit id and the heading id are intentionally the same`,
    `target (the explicit id is on a wrapper element promoting the heading anchor),`,
    `suppress at source with \`<!-- ra11y-disable ${ruleId} -->\` to make the dismissal durable.`,
  ].join(" ");
}

/**
 * Describes a directive-kinds tuple in human-readable form for the
 * primary explanation. Single-kind cases get a direct label; multi-
 * kind cases enumerate. Mirrors the vendor module's
 * `vendor-library` vs `build-artifact` label split.
 */
function describeDirectiveKinds(kinds: readonly TemplateDirectiveKind[]): string {
  const labels = kinds.map((k) => DIRECTIVE_KIND_LABELS[k]);
  if (labels.length === 1) return labels[0] ?? "templating";
  if (labels.length === 2) return `${labels[0]} + ${labels[1]}`;
  return labels.join(", ");
}

const DIRECTIVE_KIND_LABELS: Readonly<Record<TemplateDirectiveKind, string>> = {
  "mustache-or-liquid-interpolation": "Mustache/Handlebars/Liquid interpolation",
  "liquid-or-jinja-tag": "Liquid/Jinja/Nunjucks tag",
  "erb-or-ejs-scriptlet": "ERB/EJS scriptlet",
  "jsp-tag": "JSP custom tag",
  "js-template-literal": "JS template literal",
};

/**
 * Caps a directive token string for inclusion in the primary
 * explanation prose. Tokens longer than 60 chars (multi-line
 * `{% include … %}` spans, long ERB blocks) collapse to the leading
 * 60 chars + `…` so the prose stays one-line-friendly.
 */
function truncateForExplanation(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 60) return collapsed;
  return `${collapsed.slice(0, 59)}…`;
}

/**
 * Set of rules where the suggest_fix surface reroutes to the
 * verify-binding-at-render-time lane when a template directive is
 * detected on the target line. Restricted to rules whose canonical
 * suggestion text is a literal "fill in / rename to a hard-coded
 * value" recommendation — those are the suggestions that read as
 * dishonest in the presence of a runtime binding. Other rules (e.g.
 * `keyboard/handler-missing`) emit edits whose surrounding template
 * directives don't invalidate the proposed change, so this reroute
 * is intentionally narrow.
 */
export const TEMPLATE_DIRECTIVE_REROUTE_RULES: ReadonlySet<string> = new Set([
  "semantics/empty-heading",
]);

/**
 * Set of rules where the suggest_fix surface reroutes to the
 * markdown-heading-collision lane when the violation's id collides
 * with the slugified text of a later ATX heading in the same source.
 * Currently only `parsing/duplicate-id` qualifies — that rule's
 * "rename to next-free suffix" suggestion is the one that reads as
 * dishonest when the auto-id will own the same anchor regardless.
 */
export const MARKDOWN_HEADING_COLLISION_REROUTE_RULES: ReadonlySet<string> = new Set([
  "parsing/duplicate-id",
]);
