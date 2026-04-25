/**
 * Candidate finder: review/color-class-crossref
 * Criteria: wcag22:1.4.1, wcag21:1.4.1, section508:1194.22.c, en301549:9.1.4.1
 * Spec: https://www.w3.org/TR/WCAG22/#use-of-color
 *
 * Cross-references CSS class definitions whose dominant/only declarations are
 * color-related (e.g., `.correct { color: green }`, `.error { color: red }`)
 * with HTML/JSX usage of those class names. Emits a candidate at each *usage*
 * site so the agent can verify the design carries a non-color reinforcement.
 *
 * This is a deterministic CSS-to-markup cross-reference:
 *   1. Parse CSS files to collect class rules where color is the only or
 *      dominant declaration (no meaningful non-color visual signal in the rule).
 *   2. Find every HTML/JSX element that applies one of those class names.
 *   3. Emit a candidate at the usage site. Reason text names the class, the
 *      color value, and the usage tag so the agent can verify in one Read.
 *
 * The finder does NOT try to decide whether the design violates 1.4.1 — that
 * requires reading the page context (icons, labels, patterns). It points at
 * the usage; the agent decides.
 *
 * Per the AI-first consumer model: no heuristic suppression, no filename-
 * pattern gates, no threshold checks. Every usage site of a color-dominant
 * class surfaces as a candidate. The reason text carries the dismissal signal
 * (class name + color) so triage is one Read away.
 *
 * Scope: afterProject — cross-file, CSS definitions in one pass, HTML/JSX
 * usages in another, no re-parsing.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import { walkCssRules, walkHtmlElements, walkJsxElements } from "../../engine/ast-helpers.ts";
import type { CssStylesheet, HtmlDocument, TsxModule } from "../../types/ast.ts";
import type { ProjectCandidateContext, ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = [
  "wcag22:1.4.1",
  "wcag21:1.4.1",
  "section508:1194.22.c",
  "en301549:9.1.4.1",
] as const;

// ---------------------------------------------------------------------------
// CSS analysis — what makes a class "color-dominant"
// ---------------------------------------------------------------------------

/**
 * Properties that convey color information to the user. A CSS rule that
 * contains only these properties carries meaning solely through color,
 * which is the pattern WCAG 1.4.1 requires non-color reinforcement for.
 */
const COLOR_PROPERTIES: ReadonlySet<string> = new Set([
  "color",
  "background-color",
  "background",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "fill",
  "stroke",
  "caret-color",
  "column-rule-color",
  "text-decoration-color",
]);

/**
 * Properties that add a non-color visual distinction (shape, texture,
 * weight, decoration, spacing). If a CSS class rule includes ANY of these
 * alongside its color declaration, the class is providing a secondary
 * non-color signal and the agent likely does not need to look further
 * (though they still may). We still emit a candidate for rules that have
 * a color property even when a non-color property is present — the agent
 * should decide, not the scanner. But we annotate the reason text to note
 * when there is a likely non-color companion so the agent can dismiss
 * fast.
 *
 * We track these to enrich reason text, not to suppress candidates.
 */
const NON_COLOR_VISUAL_PROPERTIES: ReadonlySet<string> = new Set([
  "font-weight",
  "font-style",
  "text-decoration",
  "text-decoration-line",
  "text-decoration-style",
  "border",
  "border-style",
  "border-width",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "outline",
  "outline-style",
  "outline-width",
  "font-size",
  "letter-spacing",
  "background-image",
  "content",
  "list-style",
  "opacity",
  "visibility",
  "display",
]);

/**
 * A class name is eligible for cross-referencing when:
 *   - The rule's selector is a simple class selector (starts with `.`, no
 *     descendant combinators, attribute selectors, or pseudo-elements that
 *     would make the selector context-dependent at usage time).
 *   - The rule has at least one color-related declaration.
 *
 * Returns the class name (without the `.` prefix) if eligible, else null.
 */
function extractSimpleClassName(selector: string): string | null {
  const trimmed = selector.trim();
  // Accept only a single simple class selector: `.foo` or `.foo-bar`.
  // Reject compound selectors (`.foo.bar`), descendant selectors (`.foo .bar`),
  // attribute-qualified selectors (`.foo[type=text]`), tag-qualified (`.foo p`),
  // pseudo-class (`.foo:hover`), pseudo-element (`.foo::before`), and
  // multi-selector (`.foo, .bar`).
  if (!trimmed.startsWith(".")) return null;
  if (trimmed.includes(",")) return null;
  if (
    trimmed.includes(" ") ||
    trimmed.includes(">") ||
    trimmed.includes("+") ||
    trimmed.includes("~")
  )
    return null;
  if (trimmed.includes("[") || trimmed.includes(":") || trimmed.includes("*")) return null;
  // Compound selectors: `.foo.bar` — has two class tokens.
  const className = trimmed.slice(1); // remove leading `.`
  // Class names should not contain `.` after the first character
  if (className.includes(".")) return null;
  // Must be a valid CSS class name token
  if (className.length === 0) return null;
  return className;
}

interface ColorClassDef {
  /** The class name (without `.`). */
  readonly className: string;
  /** Color property that triggered the classification (first one found). */
  readonly colorProperty: string;
  /** Raw value of the color declaration. */
  readonly colorValue: string;
  /**
   * True when the rule ALSO has a non-color visual property, meaning the
   * CSS class provides a companion non-color signal. The reason text
   * annotates this so agents can dismiss quickly.
   */
  readonly hasNonColorCompanion: boolean;
}

/**
 * Scans a CSS stylesheet and returns the set of color-dominant class
 * definitions. A class qualifies when:
 *   - Its selector is a simple single class selector.
 *   - It declares at least one color-related property.
 */
function collectColorClasses(stylesheet: CssStylesheet): readonly ColorClassDef[] {
  const defs: ColorClassDef[] = [];
  for (const rule of walkCssRules(stylesheet)) {
    const className = extractSimpleClassName(rule.selector);
    if (className === null) continue;

    let firstColorDecl: { property: string; value: string } | null = null;
    let hasNonColor = false;

    for (const decl of rule.declarations) {
      const prop = decl.property.toLowerCase();
      if (COLOR_PROPERTIES.has(prop) && firstColorDecl === null) {
        firstColorDecl = { property: prop, value: decl.value.trim() };
      }
      if (NON_COLOR_VISUAL_PROPERTIES.has(prop)) {
        hasNonColor = true;
      }
    }

    if (firstColorDecl === null) continue;

    defs.push({
      className,
      colorProperty: firstColorDecl.property,
      colorValue: firstColorDecl.value,
      hasNonColorCompanion: hasNonColor,
    });
  }
  return defs;
}

// ---------------------------------------------------------------------------
// Class-name extraction from HTML class attribute and JSX className prop
// ---------------------------------------------------------------------------

/**
 * Splits a class-attribute value into individual class name tokens.
 * Handles extra whitespace gracefully.
 */
function splitClassNames(classAttr: string): readonly string[] {
  return classAttr.split(/\s+/).filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Cross-reference: emit candidates at usage sites
// ---------------------------------------------------------------------------

/**
 * Build a lookup map from class name → ColorClassDef for efficient
 * per-usage lookup.
 */
function buildClassIndex(defs: readonly ColorClassDef[]): ReadonlyMap<string, ColorClassDef> {
  const map = new Map<string, ColorClassDef>();
  for (const def of defs) {
    // Last-writer wins on duplicates (same class name, different CSS files).
    // The candidate reason text carries the color value, so triage still works.
    map.set(def.className, def);
  }
  return map;
}

function buildReason(
  tagName: string,
  className: string,
  colorProperty: string,
  colorValue: string,
  hasNonColorCompanion: boolean,
): string {
  const companionNote = hasNonColorCompanion
    ? " (CSS rule also has a non-color visual property — verify it provides sufficient non-color differentiation)"
    : " — verify a non-color affordance (icon, label, pattern, underline) is present alongside this color";
  return (
    `<${tagName}> uses class "${className}" which is defined with ${colorProperty}: ${colorValue}` +
    companionNote
  );
}

/**
 * Emits candidates for each matched color class on a given element.
 * Shared by HTML and JSX branches; caller supplies the tag name, file,
 * location, and class token list.
 */
function emitForMatchedClasses(
  classNames: readonly string[],
  tagName: string,
  filePath: string,
  line: number,
  column: number,
  classIndex: ReadonlyMap<string, ColorClassDef>,
  candidates: ReviewCandidate[],
): void {
  const seen = new Set<string>();
  for (const cls of classNames) {
    if (seen.has(cls)) continue;
    const def = classIndex.get(cls);
    if (!def) continue;
    seen.add(cls);
    const reason = buildReason(
      tagName,
      def.className,
      def.colorProperty,
      def.colorValue,
      def.hasNonColorCompanion,
    );
    for (const criterionId of CRITERION_IDS) {
      candidates.push({
        criterionId,
        location: { filePath, line, column },
        reason,
        // Confidence "high": deterministic class-name lookup — the CSS
        // definition is a literal color-only class and the usage is a
        // literal class attribute value. The agent must still decide
        // whether the design has non-color reinforcement in context
        // (adjacent icons, surrounding labels), but the static evidence
        // (class name, color value, usage site) is exact.
        confidence: "high",
      });
    }
  }
}

function scanHtmlForColorClassUsages(
  root: HtmlDocument,
  filePath: string,
  classIndex: ReadonlyMap<string, ColorClassDef>,
  candidates: ReviewCandidate[],
): void {
  for (const el of walkHtmlElements(root)) {
    let classAttr: string | null = null;
    for (const attr of el.attributes) {
      if (attr.name.toLowerCase() === "class") {
        classAttr = attr.value;
        break;
      }
    }
    if (!classAttr || classAttr.trim().length === 0) continue;
    const classNames = splitClassNames(classAttr);
    emitForMatchedClasses(
      classNames,
      el.tagName.toLowerCase(),
      filePath,
      el.loc.start.line,
      el.loc.start.column,
      classIndex,
      candidates,
    );
  }
}

function scanJsxForColorClassUsages(
  root: TsxModule,
  filePath: string,
  classIndex: ReadonlyMap<string, ColorClassDef>,
  candidates: ReviewCandidate[],
): void {
  for (const el of walkJsxElements(root)) {
    // Get the className attribute value. Only string-literal values are
    // inspectable — expression values (`className={styles.foo}`) hide the
    // class names from static analysis. Per AI-first doctrine, we cannot
    // make up class names from expressions, so we skip them honestly.
    let classAttr: string | null = null;
    for (const attr of el.attributes) {
      if (attr.name !== "className") continue;
      if (attr.value?.kind === "StringLiteral") {
        classAttr = attr.value.value;
      }
      break;
    }
    if (!classAttr || classAttr.trim().length === 0) continue;
    const classNames = splitClassNames(classAttr);
    emitForMatchedClasses(
      classNames,
      el.tagName,
      filePath,
      el.loc.start.line,
      el.loc.start.column,
      classIndex,
      candidates,
    );
  }
}

export const finder = defineCandidateFinder({
  id: "review/color-class-crossref",
  criterionIds: [...CRITERION_IDS],
  // Project scope because we need to read CSS files and then find HTML/JSX
  // usages across the whole scanned tree. The `find` hook sees one file at
  // a time; `afterProject` sees every file's pre-parsed AST.
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx", ".css"] },
  docs: {
    description:
      "Cross-references CSS class definitions whose sole or dominant declaration is a color property with HTML/JSX usage of those class names — surfaces usage sites where color may be the only visual indicator.",
    reviewPrompt:
      "The class applied to this element is defined in CSS using only (or primarily) a color property. Verify that the information conveyed by this color difference is also available through a non-color means — an icon, a label, a border style, an underline, or a pattern. If color is the only distinction (e.g. green=correct, red=incorrect) and no non-color cue is present, this is a WCAG 1.4.1 failure.",
    references: [
      "https://www.w3.org/TR/WCAG22/#use-of-color",
      "https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html",
      "https://www.w3.org/WAI/WCAG22/Techniques/failures/F81",
    ],
  },
  afterProject(ctx: ProjectCandidateContext): readonly ReviewCandidate[] {
    const candidates: ReviewCandidate[] = [];

    // Phase 1: collect color-dominant class definitions from CSS files.
    const allColorDefs: ColorClassDef[] = [];
    for (const file of ctx.files) {
      if (file.ast.language !== "css") continue;
      const stylesheet = file.ast.root as CssStylesheet;
      const defs = collectColorClasses(stylesheet);
      for (const d of defs) allColorDefs.push(d);
    }

    if (allColorDefs.length === 0) return candidates;

    const classIndex = buildClassIndex(allColorDefs);

    // Phase 2: find usages of those class names in HTML and JSX files.
    for (const file of ctx.files) {
      if (file.ast.language === "html") {
        scanHtmlForColorClassUsages(
          file.ast.root as HtmlDocument,
          file.filePath,
          classIndex,
          candidates,
        );
      } else if (file.ast.language === "tsx" || file.ast.language === "jsx") {
        scanJsxForColorClassUsages(
          file.ast.root as TsxModule,
          file.filePath,
          classIndex,
          candidates,
        );
      }
    }

    return candidates;
  },
});
