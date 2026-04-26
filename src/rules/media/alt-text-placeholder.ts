/**
 * Rule: media/alt-text-placeholder
 * Satisfies: wcag22:1.1.1, wcag21:1.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * > All non-text content that is presented to the user has a text
 * > alternative that serves the equivalent purpose, except for the
 * > situations listed below: controls, input, time-based media,
 * > tests, sensory, CAPTCHA, decoration/formatting/invisible.
 *
 * Source: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * `media/alt-text-missing` catches `<img>` with no `alt` and `<img>`
 * with a whitespace-only `alt` value. This rule catches a narrower
 * band: `<img>` that HAS a non-empty `alt` attribute whose content
 * is generic placeholder boilerplate which defeats the purpose of a
 * text alternative — screen-reader users hear the literal words
 * "image," "screenshot," or "TODO" instead of a description of what
 * the image conveys. The boilerplate strings are the things humans
 * type when they know `alt` is required but don't know what to write
 * or are copying a scaffold.
 *
 * Spec hook: WCAG 2 Understanding 1.1.1 is explicit that the text
 * alternative must "serve the equivalent purpose" — boilerplate alt
 * that restates the medium ("image") or the authoring intent
 * ("TODO") carries no equivalent information and therefore fails.
 *
 * Placeholder categories (matched against the whole normalized alt,
 * case-insensitive):
 *
 *   1. Medium / role words — "image", "picture", "photo", "pic",
 *      "img", "screenshot", "graphic", "icon", "logo". (`logo` is a
 *      role-noun rather than a medium, but the failure mode is the
 *      same: `alt="logo"` on a brand mark restates the visual role
 *      instead of identifying the brand.)
 *   2. Authoring placeholders — "placeholder", "todo", "fixme",
 *      "fix me", "change me".
 *   3. Meta words — "alt", "alt text", "description", "describe this".
 *   4. Single-word repetition — e.g. `alt="image image"` or
 *      `alt="todo todo todo"`.
 *   5. Role-noun-led phrases — short alts that begin with a medium /
 *      role word followed by `of`, e.g. `alt="image of mountain"` or
 *      `alt="photo of dog"`. Capped at 4 tokens total: longer alts
 *      (`alt="An image of Lake Tahoe at sunset is shown"`) are real
 *      descriptions and pass. The phrase must START with the role
 *      noun — `alt="Acme Corp logo"` (proper-name-plus-role) is fine
 *      because the description carries the brand identity.
 *   6. Sequential positional labels — carousel-slide / numbered-image
 *      shapes such as `alt="First slide"`, `alt="Slide 1"`,
 *      `alt="Image 3"`, `alt="Photo 7"`. These are the canonical
 *      "I'll describe this later" placeholder that ships in design-
 *      system carousel docs, template kits, and starter themes; the
 *      author's intent is positional, not descriptive, and screen-
 *      reader users hear "first slide" instead of what the slide
 *      shows. Matched as whole-alt by the patterns in
 *      `SEQUENTIAL_LABEL_PATTERNS`.
 *   7. Alt restates the src basename — `<img src="balloons.gif"
 *      alt="balloons">` or `<img src="/path/to/team-photo.jpg"
 *      alt="Team Photo">`. The author has typed (or auto-generated)
 *      the filename stem as the alt; screen-reader users hear the
 *      filename verbatim and learn nothing about the image. The
 *      basename stem is extracted from the URL (query / hash
 *      stripped, extension dropped), normalized by replacing `-` /
 *      `_` / `+` with spaces and lowercasing. The check fires when
 *      the alt's normalized form equals the basename-stem, or when
 *      the alt's tokens are a non-empty subset of the stem's tokens
 *      (so `alt="Team Photo"` against `team-photo.jpg` fires, and
 *      `alt="photo"` against `team-photo.jpg` also fires). The
 *      inverse direction is intentionally NOT matched —
 *      `<img src="logo.png" alt="Acme Corp logo">` adds brand
 *      information beyond the filename and stays a good case. Very
 *      short basenames (≤2 chars after normalization) are skipped
 *      — `x.jpg` / `a.png` are too likely to coincidentally match
 *      short alt text. Dynamic `src` (JSX expression value) is not
 *      checked because the parser only exposes string-literal
 *      attribute values.
 *
 * Matching is whole-alt-only outside of the bounded phrase form
 * above. `alt="Aerial image of Paris"` passes because the medium
 * word is embedded in a real description; `alt="image"` and
 * `alt="image of Paris"` trigger because the entire alt is the
 * boilerplate. This keeps the rule honest — we have no way to
 * decide that an arbitrary longer string is merely padded
 * boilerplate, and the agent can read the surrounding file to make
 * that call.
 *
 * Surfaces covered: `<img>` and `<input type="image">` in HTML and
 * JSX, plus JSX wrappers declared via `nativeWrappers: { Wrap: "img" }`
 * (the same opt-in used by `media/alt-text-missing`). SVG `<image>`
 * and `role="img"` elements use `aria-label` / child `<title>`
 * instead of `alt`; they are out of scope here — their
 * accessible-name channel doesn't carry an `alt` attribute to check.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  findJsxElementsForTag,
  getHtmlAttribute,
  getJsxAttributeString,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

export const rule = defineRule({
  id: "media/alt-text-placeholder",
  satisfies: ["wcag22:1.1.1", "wcag21:1.1.1"],
  severity: "warning",
  scope: "node",
  fixClass: "mechanical",
  wrapperTreatsAsElement: "img",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      'Flags <img> / <input type="image"> whose alt value is generic boilerplate ("image", "screenshot", "TODO", "placeholder") that carries no information about what the image conveys.',
    rationale:
      'WCAG 1.1.1 requires a text alternative that "serves the equivalent purpose." Boilerplate alt text — restating the medium ("image", "screenshot"), authoring markers ("TODO", "placeholder"), or meta words ("description") — conveys no information about the content, so the requirement is not met. Screen-reader users are announced the filler word verbatim and learn nothing about the image.',
    goodExample: `<img src="chart.png" alt="Quarterly revenue growth 2024-2026: $1.2M to $3.8M." />`,
    badExample: `<img src="chart.png" alt="image" />`,
    normativeQuote:
      "All non-text content that is presented to the user has a text alternative that serves the equivalent purpose.",
    references: [
      "https://www.w3.org/TR/WCAG22/#non-text-content",
      "https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html",
      "https://www.w3.org/WAI/tutorials/images/",
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
      checkJsx(ctx.ast as TsxModule, ctx.wrappersForElement, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

// ---------------------------------------------------------------------------
// Placeholder classification
// ---------------------------------------------------------------------------

/**
 * Generic medium-words — saying an image is an "image" adds no
 * information. `screenshot` and `graphic` live here too because the
 * same logic applies: the medium is already implied by the element.
 */
const MEDIUM_WORDS: ReadonlySet<string> = new Set([
  "image",
  "picture",
  "photo",
  "pic",
  "img",
  "screenshot",
  "graphic",
  "icon",
  // `logo` is a role-noun rather than a medium, but the failure
  // mode is identical: `alt="logo"` on a brand mark restates the
  // visual role and tells screen-reader users nothing about WHICH
  // brand. Real-world fields: countless template themes ship
  // `<img src="img/logo.png" alt="logo">` — the alt should name the
  // organization (e.g. `alt="Acme Corp"`).
  "logo",
]);

/**
 * Role nouns that can lead a "X of Y" phrase. Subset of
 * `MEDIUM_WORDS` — `screenshot of …` is conventional and usually
 * descriptive enough that we'd over-flag, while `image of`,
 * `picture of`, `photo of`, `graphic of`, `icon of`, `logo of` are
 * the canonical "no-information-added" phrasings that wrap a single
 * subject.
 */
const PHRASE_LEAD_ROLE_WORDS: ReadonlySet<string> = new Set([
  "image",
  "picture",
  "photo",
  "graphic",
  "icon",
  "logo",
]);

/**
 * Maximum token count for a "<role> of …" phrase to be flagged.
 * Bounded so genuine descriptive prose ("An image of Lake Tahoe at
 * sunset reflecting the mountains") passes — only the short phrasing
 * that adds nothing beyond the role noun ("image of mountain",
 * "photo of dog") triggers. Encoded as a constant rather than a
 * tunable threshold: this is the structural cap on "the entire alt
 * IS the role-led phrase," not a heuristic on continuous evidence.
 */
const PHRASE_MAX_TOKENS = 4;

/** Authoring placeholders — fingerprints of scaffold or copy-paste boilerplate. */
const AUTHORING_WORDS: ReadonlySet<string> = new Set([
  "placeholder",
  "todo",
  "fixme",
  "fix me",
  "change me",
]);

/**
 * Meta words — the author typed the name of the attribute or the
 * concept of "a description" instead of writing one. Same failure
 * mode: no information about the image.
 */
const META_WORDS: ReadonlySet<string> = new Set([
  "alt",
  "alt text",
  "description",
  "describe this",
]);

/**
 * Sequential positional labels — `First slide`, `Slide 1`, `Image 3`,
 * `Photo 7`, `Picture 12`. The author has typed a positional/numeric
 * placeholder (the carousel-slide antipattern from countless template
 * themes) instead of describing what the image shows. Matched as
 * whole-alt, case-insensitive, on the collapsed (single-spaced) form.
 *
 * - `^(first|second|third|fourth|fifth|next|previous|prev|last)\s+slide$`
 *   covers ordinal-word slide labels — the design-system carousel-doc
 *   default.
 * - `^slide\s+\d+$` covers `Slide 1`, `Slide 12`, etc. — the
 *   template-kit numeric variant.
 * - `^(image|photo|picture)\s+\d+$` covers `Image 3`, `Photo 1`,
 *   `Picture 7` — the same author-intent in starter themes that don't
 *   use a carousel idiom but still ship numbered placeholders.
 *
 * `picture` of "Picture 7" overlaps with `MEDIUM_WORDS` lexically but
 * the failure mode is identical (no information about the image), so
 * either category would be honest; we report it as `sequentialLabel`
 * because the numeric tail is the diagnostic the agent should see in
 * the message.
 */
const SEQUENTIAL_LABEL_PATTERNS: readonly RegExp[] = [
  /^(first|second|third|fourth|fifth|next|previous|prev|last)\s+slide$/i,
  /^slide\s+\d+$/i,
  /^(image|photo|picture)\s+\d+$/i,
];

type PlaceholderKind =
  | "medium"
  | "authoring"
  | "meta"
  | "repetition"
  | "rolePhrase"
  | "sequentialLabel"
  | "srcBasename";

interface PlaceholderMatch {
  readonly kind: PlaceholderKind;
  /** The normalized (trimmed, collapsed-whitespace) alt value. */
  readonly normalized: string;
  /**
   * For `srcBasename` matches, the normalized basename-stem extracted
   * from the `src` URL (used in the message / suggestion to make the
   * filename overlap explicit). Empty for other kinds.
   */
  readonly basenameStem?: string;
}

/**
 * Returns the matched placeholder kind when `alt` is whole-match
 * boilerplate, or null when the alt carries real content. Callers
 * must have already ensured the alt attribute is present and
 * non-whitespace — the `media/alt-text-missing` rule owns the
 * empty / absent cases.
 *
 * `src` is the literal string value of the element's `src` attribute
 * (or null if absent / a dynamic JSX expression). When provided, the
 * function additionally classifies as `srcBasename` if the alt
 * restates the URL's basename-stem (the canonical
 * `<img src="balloons.gif" alt="balloons">` antipattern).
 */
function classifyAlt(alt: string, src: string | null = null): PlaceholderMatch | null {
  const collapsed = alt.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  const lower = collapsed.toLowerCase();
  if (MEDIUM_WORDS.has(lower)) return { kind: "medium", normalized: collapsed };
  if (AUTHORING_WORDS.has(lower)) return { kind: "authoring", normalized: collapsed };
  if (META_WORDS.has(lower)) return { kind: "meta", normalized: collapsed };
  const tokens = lower.split(" ");
  // Repetition: collapsed into tokens, every token identical, and
  // more than one token present. Catches `image image`,
  // `todo todo todo`, `pic pic`.
  if (tokens.length >= 2) {
    const first = tokens[0];
    if (first !== undefined && first.length > 0 && tokens.every((t) => t === first)) {
      return { kind: "repetition", normalized: collapsed };
    }
  }
  // Sequential positional label: carousel-slide / numbered-image
  // shapes (`First slide`, `Slide 1`, `Image 3`). Whole-alt, case-
  // insensitive. See SEQUENTIAL_LABEL_PATTERNS for rationale.
  for (const pattern of SEQUENTIAL_LABEL_PATTERNS) {
    if (pattern.test(lower)) {
      return { kind: "sequentialLabel", normalized: collapsed };
    }
  }
  // Role-noun-led phrase: short alt that begins with a role noun
  // and `of`, e.g. "image of mountain", "photo of dog". Bounded by
  // PHRASE_MAX_TOKENS so genuine descriptions pass. Requires the
  // phrase to START with the role noun — `alt="Acme Corp logo"` is
  // proper-name-plus-role and does NOT match.
  if (
    tokens.length >= 3 &&
    tokens.length <= PHRASE_MAX_TOKENS &&
    tokens[1] === "of" &&
    tokens[0] !== undefined &&
    PHRASE_LEAD_ROLE_WORDS.has(tokens[0])
  ) {
    return { kind: "rolePhrase", normalized: collapsed };
  }
  // Alt restates the src basename: extract the basename-stem from
  // the URL (query / hash stripped, extension dropped), normalize
  // separators, and compare. See `matchesSrcBasename` for the rules.
  const stem = extractBasenameStem(src);
  if (stem !== null && matchesSrcBasename(tokens, stem)) {
    return { kind: "srcBasename", normalized: collapsed, basenameStem: stem };
  }
  return null;
}

/**
 * Extracts the normalized basename-stem from a `src` URL. Returns
 * null when the URL has no usable filename component (empty, ends
 * with `/`, or normalizes to an empty stem) or when the stem is too
 * short to be a reliable signal (≤2 chars after normalization —
 * `x.jpg`, `a.png` would coincidentally match short alts).
 *
 * Normalization:
 *  - strip query string (`?…`) and hash (`#…`)
 *  - take the last path segment after `/` or `\`
 *  - drop the final extension (rightmost `.<ext>`)
 *  - replace `-`, `_`, `+`, `.` with spaces
 *  - lowercase, collapse whitespace, trim
 *
 * Examples:
 *   `balloons.gif`                 → `balloons`
 *   `/path/to/team-photo.jpg`      → `team photo`
 *   `https://cdn/x/HERO_BANNER.png?v=2` → `hero banner`
 *   `x.jpg`                        → null (too short)
 *   `/foo/`                        → null (no filename)
 */
function extractBasenameStem(src: string | null): string | null {
  if (src === null) return null;
  // Strip query and hash. URL fragments / query strings are not
  // part of the filename.
  const noQuery = src.split(/[?#]/, 1)[0] ?? "";
  // Take the last path segment. Handle both `/` and `\` since
  // authors sometimes paste Windows paths into JSX.
  const segments = noQuery.split(/[/\\]/);
  const last = segments[segments.length - 1] ?? "";
  if (last.length === 0) return null;
  // Drop the rightmost extension. `team-photo.jpg` → `team-photo`,
  // `photo.tar.gz` → `photo.tar` (good enough — only the final
  // extension is dropped, the rest of the name is normalized).
  const dot = last.lastIndexOf(".");
  const stem = dot > 0 ? last.slice(0, dot) : last;
  // Normalize separators to spaces, lowercase, collapse whitespace.
  const normalized = stem
    .replace(/[-_+.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (normalized.length <= 2) return null;
  return normalized;
}

/**
 * True when the alt's tokens (already lowercased, space-split) match
 * the normalized basename-stem closely enough to count as restatement.
 *
 * Match conditions:
 *  - exact equality of the joined alt and the stem, OR
 *  - alt's tokens are a non-empty subset of the stem's tokens (the
 *    `<img src="team-photo.jpg" alt="photo">` shape — alt is a
 *    sub-word of the basename).
 *
 * The match is intentionally one-sided (alt ⊆ stem only). The
 * inverse direction (stem ⊆ alt) would over-fire on the well-known
 * good shape `<img src="logo.png" alt="Acme Corp logo">` — the alt
 * adds a brand identifier that the src does not, and the existing
 * role-noun-led-phrase logic already classifies bare `alt="logo"`
 * via the `medium` kind. The backlog antipattern is "alt restates
 * src," not "src restates alt."
 */
function matchesSrcBasename(altTokens: readonly string[], stem: string): boolean {
  const altJoined = altTokens.join(" ");
  if (altJoined === stem) return true;
  const stemTokens = stem.split(" ").filter((t) => t.length > 0);
  if (stemTokens.length === 0 || altTokens.length === 0) return false;
  const stemSet = new Set(stemTokens);
  const altSet = new Set(altTokens.filter((t) => t.length > 0));
  if (altSet.size === 0) return false;
  for (const t of altSet) {
    if (!stemSet.has(t)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const seen = new Set<HtmlElement>();
  for (const element of findHtmlElementsByTag(doc, "img")) {
    checkHtmlCandidate(element, seen, emit);
  }
  for (const input of findHtmlElementsByTag(doc, "input")) {
    const type = getHtmlAttribute(input, "type");
    if (type?.toLowerCase() !== "image") continue;
    checkHtmlCandidate(input, seen, emit);
  }
}

function checkHtmlCandidate(element: HtmlElement, seen: Set<HtmlElement>, emit: Emit): void {
  if (seen.has(element)) return;
  seen.add(element);
  const alt = getHtmlAttribute(element, "alt");
  if (alt === null) return;
  const src = getHtmlAttribute(element, "src");
  const match = classifyAlt(alt, src);
  if (!match) return;
  emitHtml(element, match, emit);
}

function emitHtml(element: HtmlElement, match: PlaceholderMatch, emit: Emit): void {
  const tag = element.tagName.toLowerCase();
  emit({
    severity: "warning",
    location: {
      filePath: "",
      line: element.loc.start.line,
      column: element.loc.start.column,
    },
    message: buildMessage(tag, match),
    suggestion: buildSuggestion(tag, match),
  });
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, wrappersForImg: ReadonlySet<string>, emit: Emit): void {
  const seen = new Set<JsxElement>();
  for (const element of findJsxElementsForTag(module, "img", wrappersForImg)) {
    checkJsxCandidate(element, seen, emit);
  }
  for (const input of findJsxElementsByTag(module, "input")) {
    const type = getJsxAttributeString(input, "type");
    if (type?.toLowerCase() !== "image") continue;
    checkJsxCandidate(input, seen, emit);
  }
}

function checkJsxCandidate(element: JsxElement, seen: Set<JsxElement>, emit: Emit): void {
  if (seen.has(element)) return;
  seen.add(element);
  const alt = getJsxAttributeString(element, "alt");
  if (alt === null) return;
  // `getJsxAttributeString` returns null for non-string-literal
  // expressions, so dynamic `src={url}` won't trigger the basename
  // check — we only have evidence to compare when the URL is a
  // static literal.
  const src = getJsxAttributeString(element, "src");
  const match = classifyAlt(alt, src);
  if (!match) return;
  emitJsx(element, match, emit);
}

function emitJsx(element: JsxElement, match: PlaceholderMatch, emit: Emit): void {
  // `element.tagName` is as-authored (`img`, `Image`, `NextImage`);
  // lowercasing keeps messages consistent with the HTML path where
  // the parser lowercases for us.
  const tag = element.tagName;
  emit({
    severity: "warning",
    location: {
      filePath: "",
      line: element.loc.start.line,
      column: element.loc.start.column,
    },
    message: buildMessage(tag, match),
    suggestion: buildSuggestion(tag, match),
  });
}

// ---------------------------------------------------------------------------
// Message / suggestion builders
// ---------------------------------------------------------------------------

const REASONS_BY_KIND: Record<Exclude<PlaceholderKind, "srcBasename">, string> = {
  medium: "restates the medium instead of describing the content",
  authoring: "is an authoring placeholder, not a description",
  meta: "names the attribute instead of describing the content",
  rolePhrase:
    "wraps the subject in a role-noun phrase that adds no information beyond what the medium already implies",
  sequentialLabel:
    "is a sequential positional label (carousel-slide / numbered-image antipattern) — author intent is 'describe later' but it ships as production alt text",
  repetition: "repeats a single word instead of describing the content",
};

function buildMessage(tag: string, match: PlaceholderMatch): string {
  const reason =
    match.kind === "srcBasename"
      ? `restates the src filename ("${match.basenameStem ?? ""}") instead of describing the content`
      : REASONS_BY_KIND[match.kind];
  return `<${tag}> has alt="${match.normalized}" which ${reason}; screen readers announce this boilerplate verbatim and users learn nothing about the image.`;
}

function buildSuggestion(tag: string, match: PlaceholderMatch): string {
  const hint =
    match.kind === "authoring"
      ? `Replace the placeholder alt="${match.normalized}" with a description of what the image conveys in this context.`
      : match.kind === "sequentialLabel"
        ? `Replace alt="${match.normalized}" with a description of what THIS slide / image actually shows (its subject, headline, or caption text). Positional labels like "First slide" or "Image 3" are the carousel-doc default but ship as production placeholder; the slide's content is what the screen-reader user needs.`
        : match.kind === "srcBasename"
          ? `Replace alt="${match.normalized}" with a description of what the image communicates — the filename "${match.basenameStem ?? ""}" is already in the src attribute, so repeating it as alt text adds no information for screen-reader users.`
          : `Replace alt="${match.normalized}" with a description of what the image communicates — not the fact that it is an image.`;
  return `${hint} If the image is purely decorative and the surrounding text already carries the same information, set alt="" so assistive tech skips it. If the <${tag}> is inside a link or button, the alt should describe the destination or action, not the picture.`;
}
