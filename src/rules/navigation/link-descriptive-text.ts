/**
 * Rule: navigation/link-descriptive-text
 * Satisfies: wcag22:2.4.4, wcag21:2.4.4, wcag22:4.1.2, wcag21:4.1.2,
 *            wcag22:2.4.9, wcag21:2.4.9
 * Spec (Link Purpose):            https://www.w3.org/TR/WCAG22/#link-purpose-in-context
 * Spec (Name, Role, Val):         https://www.w3.org/TR/WCAG22/#name-role-value
 * Spec (Link Purpose Link Only):  https://www.w3.org/TR/WCAG22/#link-purpose-link-only
 *
 * > The purpose of each link can be determined from the link text alone
 * > or from the link text together with its programmatically determined
 * > link context. (SC 2.4.4)
 *
 * > For all user interface components (including but not limited to:
 * > form elements, links …), the name and role can be programmatically
 * > determined. (SC 4.1.2)
 *
 * > A mechanism is available to allow the purpose of each link to be
 * > identified from link text alone. (SC 2.4.9, AAA)
 *
 * This rule covers four unnamed-link failure modes:
 *
 *   1. GENERIC-PHRASE PATH — the anchor has visible text, but the text
 *      is a known non-descriptive phrase: "click here", "here", "read
 *      more", "more", "link", "this link", etc. These tell a screen-
 *      reader user nothing when the link is read out of context (Tab,
 *      VoiceOver rotor, links dialog). Fires SC 2.4.4.
 *
 *   2. ICON-ONLY PATH — the anchor has no computed accessible name at
 *      all: no text, no `aria-label`, no `aria-labelledby`, no `title`,
 *      and every element descendant is purely presentational. The
 *      canonical shape is `<a href="…"><i class="fa fa-twitter"></i></a>`
 *      — AT announces "link," keyboard users land on it, and there is
 *      nothing to hear. Fires SC 2.4.4 AND SC 4.1.2 (no computable
 *      name). Presentational descendants are stripped before computing
 *      the visible name:
 *        - icon-font glyphs (`fa-*`, `material-icons`, `bi-*`,
 *          `glyphicon*`, `icofont*`, `<ion-icon>`),
 *        - decorative `<img>` (`alt=""`, `aria-hidden="true"`, or
 *          `role="presentation" | "none"`),
 *        - any element with `aria-hidden="true"` or `role="presentation"
 *          | "none"`.
 *
 *   2b. NAME-VIA-TITLE-FALLBACK PATH (info-severity candidate) — the
 *      anchor would be icon-only or generic-phrase, BUT a `title`
 *      attribute supplies a non-empty descriptive value. Per ARIA 1.2
 *      §4.3 "Accessible Name and Description Computation" step 5+ of 5,
 *      `title` is a *last-resort* name source many screen readers
 *      suppress (NVDA at default verbosity reads it as the description,
 *      not the name; VoiceOver in some modes does the same). The link
 *      MIGHT have a usable name on some user agents and not others —
 *      the agent reading the file is the right arbiter. Fires at
 *      severity `info` with `variantKey: "name-via-title-fallback"` so
 *      the agent verifies SR support rather than treating the link as
 *      definitively broken (warning) or definitively fine (silent).
 *      `aria-label` / `aria-labelledby` outrank `title` and silence
 *      this path — the legitimate `<a title="Open in new tab"
 *      aria-label="Foo">` pattern stays clean.
 *
 *   3. DUPLICATE-NAME-DIFFERENT-HREF PATH — two or more anchors in the
 *      same file AND the same landmark scope share the same normalized
 *      accessible name BUT point at different destinations. A screen-
 *      reader user navigating by link list (VoiceOver rotor, JAWS
 *      links dialog) hears the same name for each entry but lands
 *      somewhere different — exactly the "purpose cannot be determined
 *      from link text" failure WCAG 2.4.4 describes. WCAG's spec
 *      rationale explicitly permits the looser variant where two links
 *      share a name AND a destination (they're the same link; AT
 *      announces "visited" state on re-encounter and the user is not
 *      deceived) — so same-name + same-href stays silent here. WCAG
 *      also names "programmatically determined link context" as a
 *      disambiguator (landmarks ARE that context per ARIA-in-HTML), so
 *      same-name + different-href across DIFFERENT landmarks (e.g. a
 *      "Learn more" in `<nav>` and a "Learn more" in `<main>`) is also
 *      silent — the screen-reader links list groups by landmark and
 *      the user always knows which region they are inspecting. Fires
 *      SC 2.4.4 (link text + context cannot distinguish within ONE
 *      landmark scope) and SC 2.4.9 AAA (link text alone must identify
 *      purpose). Anchors without an `href` attribute are excluded from
 *      grouping because they are not activatable controls. Templated
 *      hrefs (`href="{{ item.url }}"`) are skipped — at static time
 *      they look identical but expand to N URLs at runtime, and the
 *      static view cannot distinguish "all the same destination" from
 *      "all distinct destinations." The agent reading the surrounding
 *      template loop is the right arbiter.
 *
 * Pairs with `aria/icon-font-hidden`: that rule fires when the link IS
 * labeled AND an icon child is unannotated (double-announce risk); this
 * rule fires when the link has NO label AND only presentational
 * children (silent link). Icon-only and duplicate-name paths cannot
 * both fire on the same anchor (icon-only has an empty accessible name,
 * which is excluded from the duplicate-name grouping step). The
 * generic-phrase path CAN co-fire with the duplicate-name path on the
 * same anchor — both are real concerns (the text is generic AND the
 * links lead to different destinations under the same name) and
 * surfacing both keeps the agent's triage honest.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsForTag,
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  truncateForEcho,
} from "../../engine/ast-helpers.ts";
import {
  htmlSubtreeHasStrippedDirective,
  htmlSubtreeRenderedTextIsOnlyTemplateDirective,
  stripTemplateDirectives,
  TEMPLATE_DIRECTIVE_INTERPOLATION_UNRESOLVED,
  TEMPLATE_DIRECTIVE_STRIPPED_SUFFIX,
} from "../../input/parsers/html-template-directives.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import {
  checkDuplicateHrefHtml as checkDuplicateHrefHtmlImpl,
  checkDuplicateHrefJsx as checkDuplicateHrefJsxImpl,
} from "./link-duplicate-name.ts";
import {
  emitTitleFallbackGenericHtml,
  emitTitleFallbackGenericJsx,
  emitTitleFallbackIconOnlyHtml,
  emitTitleFallbackIconOnlyJsx,
} from "./link-title-fallback.ts";

/**
 * Phrases that are never acceptable as link text on their own. Matched
 * case-insensitively after trimming trailing punctuation. Curated list
 * — overzealous matching here burns user trust, so we keep it tight.
 *
 * The set covers four shapes of generic-pronoun / placeholder text that
 * AT users hear out of context (links list, VoiceOver rotor, Tab):
 *   1. bare pronouns/determiners — "this", "that", "the", "here", "there"
 *   2. pronoun + noun ("link"/"page") — "this link", "that link",
 *      "the link", "this page", "that page"
 *   3. "click"/"more"/"info"/"details" family — "click", "click here",
 *      "more", "more info", "more information", "more details", "details",
 *      "info", "read more", "learn more"
 *   4. literal noun on its own — "link"
 *
 * Surface-don't-suppress doctrine applies: a flagged candidate the agent
 * decides is contextualized (e.g. inside a heading) is one file read away
 * from dismissal; a missed silent-link-text generic stays silent.
 */
const GENERIC_PHRASES: ReadonlySet<string> = new Set([
  // Bare pronouns / determiners.
  "this",
  "that",
  "the",
  "here",
  "there",
  // Pronoun + noun.
  "this link",
  "that link",
  "the link",
  "this page",
  "that page",
  // Click / more / info / details family.
  "click",
  "click here",
  "more",
  "more info",
  "more information",
  "more details",
  "details",
  "info",
  "read more",
  "learn more",
  // Literal noun.
  "link",
]);

/** JSX tags that represent a link. Covers the common React router libs. */
const JSX_LINK_TAGS: ReadonlySet<string> = new Set(["a", "Link", "NavLink", "Anchor"]);

export const rule = defineRule({
  id: "navigation/link-descriptive-text",
  satisfies: [
    "wcag22:2.4.4",
    "wcag21:2.4.4",
    "wcag22:4.1.2",
    "wcag21:4.1.2",
    "wcag22:2.4.9",
    "wcag21:2.4.9",
  ],
  severity: "warning",
  scope: "node",
  fixClass: "guidance",
  // Opt in: wrapper components declared as rendering `<a>` via the
  // object form of `nativeWrappers` also get checked. `ctx.wrappersForElement`
  // surfaces the matching names; checkJsx iterates them alongside the
  // baseline `JSX_LINK_TAGS` list.
  wrapperTreatsAsElement: "a",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Link text must identify the link's destination — never a generic phrase like 'click here' or 'read more', and never an icon-only anchor without an accessible name.",
    rationale:
      "Screen readers read links out of context — users scan the links list, Tab through them, or use the VoiceOver rotor. A link that says 'here' tells users nothing. An icon-only link (`<a><i class=\"fa-twitter\"></i></a>`) has no text at all — AT announces 'link' with silence behind it, and keyboard users land on an unlabeled control. Both failure modes violate SC 2.4.4 (Link Purpose); the icon-only case also violates SC 4.1.2 (Name, Role, Value) because no name can be programmatically determined.",
    goodExample: `<a href="/docs/api">Read the API reference</a>`,
    badExample: `<a href="/twitter"><i class="fa fa-twitter"></i></a>`,
    normativeQuote:
      "The purpose of each link can be determined from the link text alone or from the link text together with its programmatically determined link context.",
    references: [
      "https://www.w3.org/TR/WCAG22/#link-purpose-in-context",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G91",
      "https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA8",
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
  afterFile(ctx) {
    // Same-page pass: when two or more anchors in the SAME file share
    // the same normalized accessible name BUT point at different hrefs,
    // every occurrence is reported. This complements `check()` — the
    // node-scoped pass fires on generic-phrase and icon-only failures
    // per anchor, while `afterFile` sees whole-file state and catches
    // the "ambiguous-destination" failure mode that only manifests
    // when ≥2 anchors share a name across distinct destinations. See
    // rule header (path 3) for rationale and scope boundaries (same-
    // name + same-href is intentionally silent — the spec rationale
    // permits it).
    if (ctx.language === "html") {
      checkDuplicateHrefHtmlImpl(
        ctx.ast as HtmlDocument,
        visibleTextExcludingPresentationalHtml,
        (v) => ctx.emit(v),
      );
    } else if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkDuplicateHrefJsxImpl(
        ctx.ast as TsxModule,
        JSX_LINK_TAGS,
        ctx.wrappersForElement,
        visibleTextExcludingPresentationalJsx,
        (v) => ctx.emit(v),
      );
    }
  },
});

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  /**
   * Sub-variant discriminator folded into the `findingId` hash. This
   * rule satisfies three distinct concerns that can legitimately
   * co-fire on the same anchor (SC 2.4.4 generic-phrase / SC 2.4.4 +
   * 4.1.2 icon-only / SC 2.4.4 + 2.4.9 duplicate-name). Without a
   * variant key the co-fires collide on `findingId` and the agent's
   * suppress + dedup flows silently merge them. See
   * and the `variantKey`
   * field doc on `EmittedViolation`.
   */
  variantKey?: string;
  /**
   * Structured uncertainty codes (e.g.
   * `template_directive_interpolation_unresolved`) propagated to the
   * stamped Violation. Conditional spread at the runner site keeps
   * `couldBeWrongBecause: []` off the wire per CLAUDE.md §1.
   */
  couldBeWrongBecause?: readonly string[];
}) => void;

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const a of findHtmlElementsByTag(doc, "a")) {
    if (!hasHtmlAttribute(a, "href")) continue;
    checkHtmlAnchor(a, emit);
  }
}

/**
 * Per-anchor branching for the HTML pass. Extracted from `checkHtml`
 * to keep that function under Biome's cognitive-complexity ceiling.
 *
 * Resolution order mirrors ARIA 1.2 §4.3 with one project-specific
 * branch:
 *   1. `aria-label` / `aria-labelledby` provides a non-duplicate name
 *      → silent (a reliable name source).
 *   2. visible text empty → icon-only path (downgrade to title-fallback
 *      info if `title` exists, else warning).
 *   3. visible text is a generic phrase → generic-phrase path
 *      (downgrade to title-fallback info if `title` exists, else
 *      warning).
 *   4. visible text is real and not a generic phrase → silent.
 */
function checkHtmlAnchor(a: HtmlElement, emit: Emit): void {
  // Compute visible text stripped of presentational descendants
  // (icon-font glyphs, decorative <img>, any aria-hidden subtree).
  // The stripped view mirrors what assistive tech actually hears:
  //   - icon-font text (Material Icons ligatures like "home") is
  //     rendered as a glyph, not announced as a word; strip it.
  //   - <img> contributes its non-empty `alt` as text.
  //   - <svg> with a <title> child contributes the title text.
  const strippedText = visibleTextExcludingPresentationalHtml(a);

  // `aria-label` / `aria-labelledby` are reliable name sources;
  // `title` is NOT (handled below as a last-resort fallback per
  // ARIA 1.2 §4.3 step 5+ of 5). aria-label that duplicates visible
  // text falls through so the body's generic-phrase signal still
  // surfaces.
  if (hasAriaAccessibleNameOverrideHtml(a, strippedText)) return;

  const titleFallback = getTitleNameFallbackHtml(a, strippedText);

  if (strippedText.trim().length === 0) {
    if (titleFallback !== null) {
      emitTitleFallbackIconOnlyHtml(a, titleFallback, emit);
      return;
    }
    emitIconOnlyHtml(a, emit);
    return;
  }

  const generic = matchesGenericPhrase(strippedText);
  if (!generic) return;
  if (titleFallback !== null) {
    emitTitleFallbackGenericHtml(a, titleFallback, generic, emit);
    return;
  }
  emitGenericPhraseHtml(a, generic, emit);
}

function emitGenericPhraseHtml(a: HtmlElement, generic: string, emit: Emit): void {
  // Honest signal: if the link text had template directives stripped
  // (e.g. `<a>{{ icon }} Read more</a>` → "Read more"), let the agent
  // know the generic-phrase match was against the stripped shape.
  // Directives are not heuristically suppressed — they're removed
  // because the rule's premise (visible text) genuinely excludes them
  // — but the agent should be able to distinguish "literally 'read
  // more'" from "rendered-into-'read more'".
  const strippedSuffix = htmlSubtreeHasStrippedDirective(a)
    ? " (template_directive_stripped: the link text contained template expressions that were stripped before the generic-phrase check; residual visible text still matches the generic phrase)"
    : "";
  emit({
    severity: "warning",
    location: {
      filePath: "",
      line: a.loc.start.line,
      column: a.loc.start.column,
    },
    message: `Link text "${generic}" is not descriptive — screen readers reading this out of context tell users nothing about where they'll end up.${strippedSuffix}`,
    suggestion: buildSuggestion(getHtmlAttribute(a, "href"), generic),
    variantKey: "generic-phrase",
  });
}

function emitIconOnlyHtml(a: HtmlElement, emit: Emit): void {
  const iconEvidence = collectIconEvidenceHtml(a);
  // Surface-don't-suppress (per docs/kb/architecture/ai-first-consumer.md):
  // when the link's only rendered content was a Liquid/Jinja/ERB
  // expression stripped by the parser (`<a>{{ post.title }}</a>`,
  // `<a><%= name %></a>`), keep the candidate at severity `warning` —
  // static analysis can't see whether the expression resolves non-empty
  // — but rephrase the reason so the agent routes to "verify rendered
  // output" in one read instead of looping through suggest_fix on a
  // template-directive false positive. Mirrors the parallel handling in
  // semantics/empty-heading. The narrower predicate
  // (`htmlSubtreeRenderedTextIsOnlyTemplateDirective`) catches the
  // canonical "only directive in body" cases; the broader
  // `htmlSubtreeHasStrippedDirective` is retained as a fallback so a
  // mixed body with both icon-evidence AND a stripped directive still
  // gets the suffix-style hint without hijacking the template-directive
  // branch.
  const onlyDirective = htmlSubtreeRenderedTextIsOnlyTemplateDirective(a);
  const templateStripped = onlyDirective || htmlSubtreeHasStrippedDirective(a);
  const baseMessage = templateStripped
    ? buildIconOnlyTemplateMessage("a")
    : buildIconOnlyMessage("a", iconEvidence);
  emit({
    severity: "warning",
    location: { filePath: "", line: a.loc.start.line, column: a.loc.start.column },
    message: templateStripped ? `${baseMessage}${TEMPLATE_DIRECTIVE_STRIPPED_SUFFIX}` : baseMessage,
    suggestion: buildIconOnlySuggestion(getHtmlAttribute(a, "href"), iconEvidence),
    variantKey: "icon-only",
    // Per AI-first consumer doctrine, the conceded-uncertainty axis
    // gets a structured code so an agent (and the meta-reviewer
    // occurrence-count gate) can match the template-directive
    // dimension across rules. Only attached when the predicate is
    // narrowly the directive case — not when icon-evidence + a
    // separate stripped span both contributed.
    ...(onlyDirective
      ? { couldBeWrongBecause: [TEMPLATE_DIRECTIVE_INTERPOLATION_UNRESOLVED] }
      : {}),
  });
}

function checkJsx(module: TsxModule, wrappersForA: ReadonlySet<string>, emit: Emit): void {
  // Three resolution channels feed this check:
  //   1. baseline JSX link tags — `<a>`, `<Link>`, `<NavLink>`, `<Anchor>`.
  //   2. `wrappersForA` — PascalCase wrappers the user declared as
  //      rendering `<a>` via `nativeWrappers`.
  //   3. polymorphic `as="a"` / `asChild` → `<a>` — surfaced by
  //      `findJsxElementsForTag` once per matching element.
  // Dedupe across (1)+(2) by building a union of the tag/wrapper names
  // and iterating it alongside the polymorphic sweep driven by the
  // native tag literal `"a"`.
  const seen = new Set<JsxElement>();
  // Pass the full set of tag names (native `<a>` + framework link tags
  // + mapped wrappers) as the "wrappers" argument; `findJsxElementsForTag`
  // treats them all as equivalent native/wrapper matches for `"a"`,
  // and layers polymorphic resolution on top.
  const wrappers = new Set<string>([...JSX_LINK_TAGS, ...wrappersForA]);
  wrappers.delete("a"); // bare <a> is already the `targetTag` channel.
  for (const el of findJsxElementsForTag(module, "a", wrappers)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!(hasJsxAttribute(el, "href") || hasJsxAttribute(el, "to"))) continue;
    checkJsxAnchor(el, emit);
  }
}

/**
 * Per-anchor branching for the JSX pass. Mirrors `checkHtmlAnchor` —
 * extracted to keep `checkJsx` under Biome's cognitive-complexity
 * ceiling. See `checkHtmlAnchor` for the resolution-order rationale.
 */
function checkJsxAnchor(el: JsxElement, emit: Emit): void {
  const strippedText = visibleTextExcludingPresentationalJsx(el);
  // See `checkHtml` — aria-label / aria-labelledby duplicates of the
  // visible text don't count as overrides; `title` is NOT in that
  // group because it's a last-resort ARIA name source many SRs
  // suppress (handled below as a downgrade-to-info path).
  if (hasAriaAccessibleNameOverrideJsx(el, strippedText)) return;
  // Runtime JSX expression children (`<a>{label}</a>`) may carry a
  // name we can't see statically — avoid a false-positive icon-only
  // report on those. The generic-phrase path only fires on exact
  // matches of the stripped static text, so expression children are
  // already ignored there; the icon-only path needs the explicit
  // guard because it fires on *absence* of text.
  const hasExpressionChild = el.children.some((c) => c.kind === "JsxExpression");

  const titleFallback = getTitleNameFallbackJsx(el, strippedText);

  if (strippedText.trim().length === 0 && !hasExpressionChild) {
    if (titleFallback !== null) {
      emitTitleFallbackIconOnlyJsx(el, titleFallback, emit);
      return;
    }
    emitIconOnlyJsx(el, emit);
    return;
  }

  const generic = matchesGenericPhrase(strippedText);
  if (!generic) return;
  if (titleFallback !== null) {
    emitTitleFallbackGenericJsx(el, titleFallback, generic, emit);
    return;
  }
  emitGenericPhraseJsx(el, generic, emit);
}

function emitGenericPhraseJsx(el: JsxElement, generic: string, emit: Emit): void {
  emit({
    severity: "warning",
    location: {
      filePath: "",
      line: el.loc.start.line,
      column: el.loc.start.column,
    },
    message: `<${el.tagName}> text "${generic}" is not descriptive — screen readers reading this out of context tell users nothing about where they'll end up.`,
    suggestion: buildSuggestion(
      getJsxAttributeString(el, "href") ?? getJsxAttributeString(el, "to"),
      generic,
    ),
    variantKey: "generic-phrase",
  });
}

function emitIconOnlyJsx(el: JsxElement, emit: Emit): void {
  const iconEvidence = collectIconEvidenceJsx(el);
  const href = getJsxAttributeString(el, "href") ?? getJsxAttributeString(el, "to");
  emit({
    severity: "warning",
    location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
    message: buildIconOnlyMessage(el.tagName, iconEvidence),
    suggestion: buildIconOnlySuggestion(href, iconEvidence),
    variantKey: "icon-only",
  });
}

/**
 * Returns true when the element carries a *reliable* accessible-name
 * override — `aria-label` or `aria-labelledby`. These sources are
 * announced by every major screen reader (NVDA / JAWS / VoiceOver /
 * TalkBack / Orca) at default verbosity; when either supplies a name
 * that differs from the visible text, the link has a real programmatic
 * name and this rule's three failure modes don't apply. When the
 * `aria-label` value is an exact (case-insensitive, whitespace-trimmed)
 * duplicate of the visible text, it contributes nothing new — AT still
 * announces the single name — so it is NOT treated as an override, and
 * the generic-phrase path continues.
 *
 * `title` is intentionally NOT consulted here. Per ARIA 1.2 §4.3
 * "Accessible Name and Description Computation" step 5+ of 5, `title`
 * is a *last-resort* fallback. Many screen readers suppress it (NVDA
 * at default verbosity reads it as the description, not the name;
 * VoiceOver in some modes does the same). Treating `title` as a
 * reliable override silently under-fires the canonical icon-only
 * social-link pattern (`<a><i class="fab fa-facebook"></i></a>` with
 * `title="Facebook"`) — the textbook 2.4.4 risk surface. Title is
 * handled by `getTitleNameFallback*` below: it downgrades an otherwise-
 * fired finding to an info-severity "name-via-title-fallback"
 * candidate so the agent reads the file and verifies SR support.
 *
 * `aria-labelledby` is treated as a reliable override even though this
 * rule does not chase the referenced DOM nodes' text — the presence
 * of the attribute signals the author intentionally wired up a
 * cross-element name source, and AT supports it broadly.
 */
function hasAriaAccessibleNameOverrideHtml(el: HtmlElement, visibleText: string): boolean {
  const normVisible = normalizeOverride(visibleText);
  const ariaLabel = getHtmlAttribute(el, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) {
    if (normalizeOverride(ariaLabel) !== normVisible) return true;
  }
  if (hasHtmlAttribute(el, "aria-labelledby")) return true;
  return false;
}

function hasAriaAccessibleNameOverrideJsx(el: JsxElement, visibleText: string): boolean {
  const normVisible = normalizeOverride(visibleText);
  const ariaLabel = getJsxAttributeString(el, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) {
    if (normalizeOverride(ariaLabel) !== normVisible) return true;
  }
  if (hasJsxAttribute(el, "aria-labelledby")) return true;
  return false;
}

/**
 * Returns the `title` attribute value when title is the *only* candidate
 * name source for this anchor — i.e. no `aria-label` and no
 * `aria-labelledby` are present (or aria-label exists but is an exact
 * duplicate of the visible text and the visible text is generic / empty),
 * AND the title is non-empty AND not a duplicate of the visible text.
 *
 * When this returns non-null, the caller emits an info-severity
 * `name-via-title-fallback` candidate rather than the warning-severity
 * generic-phrase or icon-only finding — title MIGHT carry the real name
 * for the user but the SR support is unreliable, so the finding asks
 * the agent to verify rendered SR behavior rather than asserting the
 * link is broken.
 *
 * Returns null when:
 *   - title attribute absent or whitespace-only
 *   - title is an exact (case-insensitive, trimmed) duplicate of the
 *     visible text (announced once, not twice — no fallback in play)
 *   - aria-label exists with a non-duplicate value (already handled
 *     by `hasAriaAccessibleNameOverride*` upstream as a reliable
 *     override; title is supplementary tooltip content here)
 *   - aria-labelledby exists (already handled upstream)
 *
 * The aria-label-with-duplicate-of-visible-text case is rare but
 * deliberately falls through to title-fallback handling: an aria-label
 * that just echoes the body text isn't a real name source, and if a
 * non-duplicate title is present alongside, the title is the only thing
 * adding name content — same fallback uncertainty applies.
 */
function getTitleNameFallbackHtml(el: HtmlElement, visibleText: string): string | null {
  const title = getHtmlAttribute(el, "title");
  if (title === null || title.trim().length === 0) return null;
  const normVisible = normalizeOverride(visibleText);
  if (normalizeOverride(title) === normVisible) return null;
  return title.trim();
}

function getTitleNameFallbackJsx(el: JsxElement, visibleText: string): string | null {
  const title = getJsxAttributeString(el, "title");
  if (title === null || title.trim().length === 0) return null;
  const normVisible = normalizeOverride(visibleText);
  if (normalizeOverride(title) === normVisible) return null;
  return title.trim();
}

/**
 * Canonicalize for exact-duplicate comparison: lowercase, collapse
 * internal whitespace, strip leading/trailing whitespace, drop trailing
 * decorative punctuation/arrows (`.!?→>»…`). The same trailing-glyph
 * rule that `matchesGenericPhrase` uses — keeps the comparison strict
 * on wording while tolerating typographic cues a `title`/`aria-label`
 * attribute rarely carries (the common authoring pattern is a plain
 * `title="Click here"` paired with a body `"Click here →"`).
 */
function normalizeOverride(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[.!?→>»…]+$/u, "")
    .trim();
}

function matchesGenericPhrase(text: string): string | null {
  const normalized = text
    .trim()
    .toLowerCase()
    // Strip trailing punctuation and arrows so "Click here →" still matches.
    .replace(/[.!?→>»…]+$/u, "")
    .trim();
  if (normalized.length === 0) return null;
  if (GENERIC_PHRASES.has(normalized)) return normalized;
  return null;
}

function buildSuggestion(href: string | null, phrase: string): string {
  if (!href) {
    return `Replace "${phrase}" with text that describes what the link does, e.g. "View the API reference" instead of "Click here".`;
  }
  // `destination` is derived from a user-authored href path tail —
  // single-segment URLs with long slugs (`/blog/2026/<lorem-ipsum>`)
  // would otherwise echo the slug straight into the suggestion text.
  const destination = truncateForEcho(destinationHint(href));
  if (destination) {
    return `Replace "${phrase}" with text that describes the destination, e.g. "View ${destination}". Alternatively, add an aria-label describing the link's purpose.`;
  }
  return `Replace "${phrase}" with a destination-describing phrase, or add an aria-label.`;
}

function destinationHint(href: string): string {
  // Strip template directives first so href="{{ item.url }}" reduces
  // to an empty hint rather than echoing the raw Liquid token back.
  // The rule's suggestion-builder already falls through cleanly when
  // the hint is empty.
  const stripped = stripTemplateDirectives(href).value;
  // Turn "/docs/api-reference" into "api reference" so the suggestion
  // reads like a real user-facing link title.
  const cleaned =
    stripped
      .replace(/^https?:\/\/[^/]+/, "")
      .replace(/[?#].*$/, "")
      .replace(/^\//, "")
      .replace(/\.[a-zA-Z0-9]+$/, "")
      .split("/")
      .pop() ?? "";
  return cleaned.replace(/[-_]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Icon-only detection (SC 4.1.2 + 2.4.4)
// ---------------------------------------------------------------------------

/**
 * An element child is "presentational" for accessible-name purposes
 * when it contributes no text to the name. Three families trigger:
 *   - icon-font glyphs (`<i class="fa fa-*">`, `<span class="material-
 *     icons">`, Bootstrap Icons `bi-*`, Glyphicons, Icofont, `<ion-icon>`)
 *   - decorative `<img>` (`alt=""`, `aria-hidden="true"`, or
 *     `role="presentation" | "none"`)
 *   - any element with `aria-hidden="true"` or `role="presentation" |
 *     "none"` (the author has explicitly opted it out of the a11y tree)
 *
 * Scoped locally to this rule because no shared accessible-name
 * computer exists yet — the sibling `aria/icon-font-hidden` rule has
 * its own parallel implementation. A future refactor can hoist both
 * into `src/utils/accessible-name.ts`; neither rule depends on the
 * other at runtime.
 */

/** Font Awesome style tokens (v4/v5/v6 weights + pro variants). */
const FA_STYLE_TOKENS: ReadonlySet<string> = new Set([
  "fa",
  "fas",
  "far",
  "fab",
  "fal",
  "fad",
  "fat",
  "fass",
]);

/** Material Icons base class tokens (v1 + Material Symbols family). */
const MATERIAL_EXACT_TOKENS: ReadonlySet<string> = new Set([
  "material-icons",
  "material-icons-outlined",
  "material-icons-round",
  "material-icons-rounded",
  "material-icons-sharp",
  "material-icons-two-tone",
]);

/** Returns a short label (e.g. "Font Awesome `fa-twitter`") when the
 * element is an icon-font host, else null. */
function detectIconFontLabel(tagName: string, classValue: string | null): string | null {
  const tagLower = tagName.toLowerCase();
  if (tagLower === "ion-icon") return "Ionicons (<ion-icon>)";
  if (classValue === null) return null;
  const tokens = classValue.split(/\s+/u).filter((t) => t.length > 0);
  for (const raw of tokens) {
    const hit = matchIconToken(tagLower, raw);
    if (hit !== null) return hit;
  }
  return null;
}

/** Per-token classifier. Split from the loop to keep cognitive
 * complexity under Biome's ceiling. */
function matchIconToken(tagLower: string, raw: string): string | null {
  const tok = raw.toLowerCase();
  if (FA_STYLE_TOKENS.has(tok) || tok.startsWith("fa-")) return `Font Awesome \`${raw}\``;
  if (MATERIAL_EXACT_TOKENS.has(tok) || tok.startsWith("material-symbols-"))
    return `Material Icons \`${raw}\``;
  if (tok.startsWith("bi-") && (tagLower === "i" || tagLower === "span"))
    return `Bootstrap Icons \`${raw}\``;
  if (tok === "glyphicon" || tok.startsWith("glyphicon-")) return `Glyphicons \`${raw}\``;
  if (tok === "icofont" || tok.startsWith("icofont-")) return `Icofont \`${raw}\``;
  if (tok === "ionicon") return `Ionicons \`${raw}\``;
  return null;
}

function isHtmlElementPresentational(el: HtmlElement): boolean {
  if (getHtmlAttribute(el, "aria-hidden") === "true") return true;
  const role = (getHtmlAttribute(el, "role") ?? "").toLowerCase();
  if (role === "presentation" || role === "none") return true;
  if (detectIconFontLabel(el.tagName, getHtmlAttribute(el, "class")) !== null) return true;
  if (el.tagName.toLowerCase() === "img") {
    const alt = getHtmlAttribute(el, "alt");
    if (alt !== null && alt.trim().length === 0) return true;
  }
  return false;
}

function isJsxElementPresentational(el: JsxElement): boolean {
  if (getJsxAttributeString(el, "aria-hidden") === "true") return true;
  const role = (getJsxAttributeString(el, "role") ?? "").toLowerCase();
  if (role === "presentation" || role === "none") return true;
  const classValue = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
  if (detectIconFontLabel(el.tagName, classValue) !== null) return true;
  if (el.tagName.toLowerCase() === "img") {
    const alt = getJsxAttributeString(el, "alt");
    if (alt !== null && alt.trim().length === 0) return true;
  }
  return false;
}

/** Subtree text excluding presentational descendants. Non-presentational
 * `<img>` elements contribute their `alt` as text (WAI name-computation:
 * step F). If any subtree is presentational, its text contribution is
 * zero. */
function visibleTextExcludingPresentationalHtml(root: HtmlElement): string {
  let out = "";
  const visit = (node: HtmlNode): void => {
    if (node.kind === "HtmlText") {
      out += node.value;
      return;
    }
    if (node.kind !== "HtmlElement") return;
    if (isHtmlElementPresentational(node)) return;
    if (node.tagName.toLowerCase() === "img") {
      const alt = getHtmlAttribute(node, "alt");
      if (alt !== null && alt.trim().length > 0) out += ` ${alt} `;
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of root.children) visit(child);
  return out;
}

function visibleTextExcludingPresentationalJsx(root: JsxElement): string {
  let out = "";
  const visit = (node: JsxNode): void => {
    if (node.kind === "JsxText") {
      out += node.value;
      return;
    }
    if (node.kind !== "JsxElement") return;
    if (isJsxElementPresentational(node)) return;
    if (node.tagName.toLowerCase() === "img") {
      const alt = getJsxAttributeString(node, "alt");
      if (alt !== null && alt.trim().length > 0) out += ` ${alt} `;
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of root.children) visit(child);
  return out;
}

/**
 * Walks the subtree once, returning a concatenated list of the labels
 * of each presentational descendant (e.g. `Font Awesome \`fa-twitter\``,
 * `aria-hidden subtree`). Echoed in the violation message so the agent
 * sees what the scanner actually saw — not a generic "icon only" hint.
 * Capped at 3 entries to keep messages terse.
 */
function collectIconEvidenceHtml(root: HtmlElement): readonly string[] {
  const found: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind !== "HtmlElement") return;
    const iconLabel = detectIconFontLabel(node.tagName, getHtmlAttribute(node, "class"));
    if (iconLabel !== null) {
      found.push(iconLabel);
    } else if (getHtmlAttribute(node, "aria-hidden") === "true") {
      found.push(`<${node.tagName} aria-hidden="true">`);
    } else if (node.tagName.toLowerCase() === "img") {
      const alt = getHtmlAttribute(node, "alt");
      if (alt !== null && alt.trim().length === 0) found.push('<img alt="">');
    }
    for (const child of node.children) visit(child);
  };
  for (const child of root.children) visit(child);
  return found.slice(0, 3);
}

function collectIconEvidenceJsx(root: JsxElement): readonly string[] {
  const found: string[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind !== "JsxElement") return;
    const classValue =
      getJsxAttributeString(node, "className") ?? getJsxAttributeString(node, "class");
    const iconLabel = detectIconFontLabel(node.tagName, classValue);
    if (iconLabel !== null) {
      found.push(iconLabel);
    } else if (getJsxAttributeString(node, "aria-hidden") === "true") {
      found.push(`<${node.tagName} aria-hidden="true">`);
    } else if (node.tagName.toLowerCase() === "img") {
      const alt = getJsxAttributeString(node, "alt");
      if (alt !== null && alt.trim().length === 0) found.push('<img alt="">');
    }
    for (const child of node.children) visit(child);
  };
  for (const child of root.children) visit(child);
  return found.slice(0, 3);
}

function buildIconOnlyMessage(tagName: string, evidence: readonly string[]): string {
  const evidenceText = evidence.length > 0 ? ` (only ${evidence.join(", ")})` : "";
  return (
    `<${tagName}> has no accessible name — no text, no aria-label, no aria-labelledby, ` +
    `and every child is presentational${evidenceText}. Screen readers announce "link" with ` +
    "nothing behind it; keyboard users land on an unlabeled control (SC 2.4.4 + 4.1.2)."
  );
}

/**
 * Reason text for the icon-only branch when the link's content was a
 * template directive (`{{ … }}`, `{% … %}`, `<%= … %>`) that the parser
 * stripped before the visible-text computation. Static analysis cannot
 * see the rendered string; framing the finding as "interpolated content
 * — verify rendered output" rather than "no accessible name" matches
 * what the agent actually needs to investigate.
 */
function buildIconOnlyTemplateMessage(tagName: string): string {
  return (
    `<${tagName}> link content is interpolated (template directive); ` +
    "verify rendered output is non-empty — static analysis stripped a " +
    "Liquid/Jinja/ERB expression so the link's accessible name is " +
    "knowable only at render time. SC 2.4.4 / 4.1.2 require a non-empty " +
    "accessible name; an expression resolving to empty would silently " +
    "leave the link without a name."
  );
}

function buildIconOnlySuggestion(href: string | null, evidence: readonly string[]): string {
  const destination = href ? truncateForEcho(destinationHint(href)) : "";
  const hint = destination ? `, e.g. aria-label="Open ${destination}"` : "";
  const iconRef = evidence[0] ?? "icon";
  return (
    `Add an accessible name to the link: set aria-label="…" on the <a>${hint}, ` +
    'or add a visually-hidden <span class="sr-only">…</span> child alongside the icon, ' +
    `or use aria-labelledby to reference a visible heading. The ${iconRef} itself should ` +
    `stay aria-hidden="true"; it is decoration once the link has a real name.`
  );
}

// Duplicate-name-different-href detection (SC 2.4.4 + 2.4.9) is
// implemented in `link-duplicate-name.ts` and invoked from
// `afterFile()` above. The helper is private to this rule (no other
// rule imports it); splitting the module keeps this file under the
// 500-effective-line file budget.
