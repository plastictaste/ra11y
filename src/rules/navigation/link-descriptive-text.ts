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
 * This rule covers three unnamed-link failure modes:
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
 *   3. DUPLICATE SAME-HREF PATH — two or more anchors in the same file
 *      share the same normalized accessible name AND the same `href`.
 *      A screen-reader user navigating by link list (VoiceOver rotor,
 *      JAWS links dialog) sees two identical-looking entries and cannot
 *      tell them apart; the `href` being the same means only one of
 *      the two destinations is reachable from the links list. The
 *      strictly-worse variant of the "same name, different href"
 *      pattern (which is legitimate when paired with unique aria-label
 *      or surrounding context — e.g. three "Read more" links under
 *      three blog cards) — so that looser variant stays silent here
 *      and the agent decides via the file content. Fires SC 2.4.4
 *      (programmatically determined context cannot distinguish) and
 *      SC 2.4.9 AAA (link text alone must identify purpose). Anchors
 *      without an `href` attribute are excluded from grouping because
 *      they are not activatable controls.
 *
 * Pairs with `aria/icon-font-hidden`: that rule fires when the link IS
 * labeled AND an icon child is unannotated (double-announce risk); this
 * rule fires when the link has NO label AND only presentational
 * children (silent link). Icon-only and duplicate-href paths cannot
 * both fire on the same anchor (icon-only has an empty accessible name,
 * which is excluded from the duplicate-href grouping step). The
 * generic-phrase path CAN co-fire with the duplicate-href path on the
 * same anchor — both are real concerns (the text is generic AND the
 * links are indistinguishable in context) and surfacing both keeps the
 * agent's triage honest.
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
import { htmlSubtreeHasStrippedDirective } from "../../input/parsers/html-template-directives.ts";
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
} from "./link-duplicate-href.ts";

/**
 * Phrases that are never acceptable as link text on their own. Matched
 * case-insensitively after trimming trailing punctuation. Curated list
 * — overzealous matching here burns user trust, so we keep it tight.
 */
const GENERIC_PHRASES: ReadonlySet<string> = new Set([
  "click here",
  "click",
  "here",
  "read more",
  "more",
  "link",
  "this link",
  "this",
  "more info",
  "more information",
  "details",
  "learn more",
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
    // the same normalized accessible name AND the same `href`, every
    // occurrence is reported. This complements `check()` — the node-
    // scoped pass fires on generic-phrase and icon-only failures per
    // anchor, while `afterFile` sees whole-file state and catches the
    // "indistinguishable-duplicate" failure mode that only manifests
    // when ≥2 anchors share identity. See rule header (path 3) for
    // rationale and scope boundaries (same-name-different-href is
    // intentionally silent here).
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
}) => void;

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const a of findHtmlElementsByTag(doc, "a")) {
    if (!hasHtmlAttribute(a, "href")) continue;
    if (hasAccessibleNameOverrideHtml(a)) continue;

    // Compute visible text stripped of presentational descendants
    // (icon-font glyphs, decorative <img>, any aria-hidden subtree).
    // The stripped view mirrors what assistive tech actually hears:
    //   - icon-font text (Material Icons ligatures like "home") is
    //     rendered as a glyph, not announced as a word; strip it.
    //   - <img> contributes its non-empty `alt` as text.
    //   - <svg> with a <title> child contributes the title text.
    // Branch on the stripped result:
    //   - empty → icon-only failure (2.4.4 + 4.1.2)
    //   - matches a generic phrase → 2.4.4 generic-phrase path
    //   - otherwise → clean.
    const strippedText = visibleTextExcludingPresentationalHtml(a);

    if (strippedText.trim().length === 0) {
      emitIconOnlyHtml(a, emit);
      continue;
    }

    const generic = matchesGenericPhrase(strippedText);
    if (!generic) continue;

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
    });
  }
}

function emitIconOnlyHtml(a: HtmlElement, emit: Emit): void {
  const iconEvidence = collectIconEvidenceHtml(a);
  emit({
    severity: "warning",
    location: { filePath: "", line: a.loc.start.line, column: a.loc.start.column },
    message: buildIconOnlyMessage("a", iconEvidence),
    suggestion: buildIconOnlySuggestion(getHtmlAttribute(a, "href"), iconEvidence),
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
  const emitEl = (el: JsxElement): void => {
    if (seen.has(el)) return;
    seen.add(el);
    if (hasAccessibleNameOverrideJsx(el)) return;
    if (!(hasJsxAttribute(el, "href") || hasJsxAttribute(el, "to"))) return;

    const strippedText = visibleTextExcludingPresentationalJsx(el);
    // Runtime JSX expression children (`<a>{label}</a>`) may carry a
    // name we can't see statically — avoid a false-positive icon-only
    // report on those. The generic-phrase path only fires on exact
    // matches of the stripped static text, so expression children are
    // already ignored there; the icon-only path needs the explicit
    // guard because it fires on *absence* of text.
    const hasExpressionChild = el.children.some((c) => c.kind === "JsxExpression");

    if (strippedText.trim().length === 0 && !hasExpressionChild) {
      emitIconOnlyJsx(el, emit);
      return;
    }

    const generic = matchesGenericPhrase(strippedText);
    if (!generic) return;
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
    });
  };
  // Pass the full set of tag names (native `<a>` + framework link tags
  // + mapped wrappers) as the "wrappers" argument; `findJsxElementsForTag`
  // treats them all as equivalent native/wrapper matches for `"a"`,
  // and layers polymorphic resolution on top.
  const wrappers = new Set<string>([...JSX_LINK_TAGS, ...wrappersForA]);
  wrappers.delete("a"); // bare <a> is already the `targetTag` channel.
  for (const el of findJsxElementsForTag(module, "a", wrappers)) {
    emitEl(el);
  }
}

function emitIconOnlyJsx(el: JsxElement, emit: Emit): void {
  const iconEvidence = collectIconEvidenceJsx(el);
  const href = getJsxAttributeString(el, "href") ?? getJsxAttributeString(el, "to");
  emit({
    severity: "warning",
    location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
    message: buildIconOnlyMessage(el.tagName, iconEvidence),
    suggestion: buildIconOnlySuggestion(href, iconEvidence),
  });
}

function hasAccessibleNameOverrideHtml(el: HtmlElement): boolean {
  const ariaLabel = getHtmlAttribute(el, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasHtmlAttribute(el, "aria-labelledby")) return true;
  const title = getHtmlAttribute(el, "title");
  if (title !== null && title.trim().length > 0) return true;
  return false;
}

function hasAccessibleNameOverrideJsx(el: JsxElement): boolean {
  const ariaLabel = getJsxAttributeString(el, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasJsxAttribute(el, "aria-labelledby")) return true;
  const title = getJsxAttributeString(el, "title");
  if (title !== null && title.trim().length > 0) return true;
  return false;
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
  // Turn "/docs/api-reference" into "api reference" so the suggestion
  // reads like a real user-facing link title.
  const cleaned =
    href
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

// Duplicate same-href detection (SC 2.4.4 + 2.4.9) is implemented in
// `link-duplicate-href.ts` and invoked from `afterFile()` above. The
// helper is private to this rule (no other rule imports it); splitting
// the module keeps this file under the 500-effective-line file budget.
