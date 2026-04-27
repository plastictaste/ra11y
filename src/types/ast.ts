/**
 * AST node types produced by ra11y's in-house parsers.
 *
 * Three independent AST dialects — TSX/JSX, HTML, CSS — each with its own
 * discriminated node union. Rules narrow `RuleContext.ast` by reading
 * `RuleContext.language` first.
 *
 * These types are intentionally minimal in v0.0.x. They grow with the
 * parsers. Any change here is a potentially breaking ADR.
 *
 * See docs/kb/architecture/input-parsers.md.
 */

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

/** Byte-offset range in the source file. */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** Human-friendly position. Both line and column are 1-based. */
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

/** Every AST node carries its source range. */
export interface BaseNode {
  readonly range: SourceRange;
  readonly loc: { readonly start: SourcePosition; readonly end: SourcePosition };
}

/** Parse errors — parsers emit these alongside a partial AST; they never throw. */
export interface ParseError {
  readonly message: string;
  readonly position: SourcePosition;
  readonly recoverable: boolean;
  /**
   * Optional snake_case token identifying the *kind* of parse failure
   * structurally rather than via prose. Populated when the parser knows
   * the failure category is itself the actionable signal (e.g. routing
   * rather than authored-source content) — the report layer then
   * surfaces this as `partialParseFiles[].reason` instead of the
   * historical prose `message`. Absent when the parser is reporting a
   * genuine authored-source error and the prose `message` is the
   * actionable signal. Codes share the structured-warning vocabulary
   * (snake_case, stable across releases).
   */
  readonly code?: string;
  /**
   * Optional additive evidence accompanying {@link code}: the source
   * fragment whose interpretation triggered the error. For the
   * `tsx_parser_on_non_jsx_input` case this is the literal `<tagName>`
   * read from the source (e.g. `"<r.length>"` on a minified `.js`
   * `r.length<b.length` comparison). Surfaced as
   * `partialParseFiles[].triggerToken` so the agent can grep against
   * historical reports without the parser pretending the fragment was
   * an authored JSX element. Present only when {@link code} is.
   */
  readonly triggerToken?: string;
}

// ---------------------------------------------------------------------------
// HTML AST
// ---------------------------------------------------------------------------

export interface HtmlDocument extends BaseNode {
  readonly kind: "HtmlDocument";
  readonly children: readonly HtmlNode[];
}

export type HtmlNode = HtmlElement | HtmlText | HtmlComment | HtmlDoctype;

export interface HtmlElement extends BaseNode {
  readonly kind: "HtmlElement";
  readonly tagName: string;
  readonly attributes: readonly HtmlAttribute[];
  readonly children: readonly HtmlNode[];
  readonly selfClosing: boolean;
}

export interface HtmlAttribute extends BaseNode {
  readonly kind: "HtmlAttribute";
  readonly name: string;
  readonly value: string | null;
  readonly quote: '"' | "'" | null;
}

export interface HtmlText extends BaseNode {
  readonly kind: "HtmlText";
  readonly value: string;
  /**
   * True when the parser stripped at least one template directive
   * (`{{ … }}`, `{% … %}`, `<% … %>`, `<%= … %>`, `<%# … %>`, or a
   * `{% capture %}…{% endcapture %}` / `{% comment %}…{% endcomment %}`
   * block) from this node's rendered value. Rules that consume
   * visible text use this flag to append a `template_directive_stripped`
   * signal to their reason text so the agent knows the check ran
   * against the rendered-text shape rather than the raw source.
   * Absent when no directive was present — the shape stays terse on
   * the no-template majority of HTML files.
   */
  readonly containsTemplateDirective?: boolean;
}

export interface HtmlComment extends BaseNode {
  readonly kind: "HtmlComment";
  readonly value: string;
}

export interface HtmlDoctype extends BaseNode {
  readonly kind: "HtmlDoctype";
  readonly value: string;
}

// ---------------------------------------------------------------------------
// CSS AST
// ---------------------------------------------------------------------------

export interface CssStylesheet extends BaseNode {
  readonly kind: "CssStylesheet";
  readonly rules: readonly CssNode[];
}

export type CssNode = CssRule | CssAtRule | CssComment;

export interface CssRule extends BaseNode {
  readonly kind: "CssRule";
  readonly selector: string;
  readonly declarations: readonly CssDeclaration[];
}

export interface CssDeclaration extends BaseNode {
  readonly kind: "CssDeclaration";
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
}

export interface CssAtRule extends BaseNode {
  readonly kind: "CssAtRule";
  readonly name: string;
  readonly params: string;
  readonly children: readonly CssNode[];
}

export interface CssComment extends BaseNode {
  readonly kind: "CssComment";
  readonly value: string;
}

// ---------------------------------------------------------------------------
// TSX/JSX AST — minimal surface for v0.0.x. Real parser arrives later.
// ---------------------------------------------------------------------------

export interface TsxModule extends BaseNode {
  readonly kind: "TsxModule";
  readonly jsxElements: readonly JsxElement[];
}

export interface JsxElement extends BaseNode {
  readonly kind: "JsxElement";
  readonly tagName: string;
  readonly attributes: readonly JsxAttribute[];
  readonly children: readonly JsxNode[];
  readonly selfClosing: boolean;
  /**
   * True when the opening tag contained at least one `{...spread}`
   * expression. Finders that reason about "does this element have
   * content / a label / required props" should treat this as
   * "may have it via props" — static analysis cannot see what the
   * spread expands to.
   */
  readonly hasSpreadProps: boolean;
  /**
   * Provenance marker for elements the parser inserted from non-JSX
   * source — currently only Storybook `StoryObj` `args` bindings,
   * where `<Button {...args} />` is what Storybook renders but the
   * source contains only the `args` data literal. Absent on every JSX
   * element that came from real `<Tag/>` syntax in the source.
   * Downstream consumers (rules, reporters) can read this to label
   * findings as derived rather than directly observed; today no rule
   * branches on it — the marker is honest provenance, not a behavior
   * switch.
   *
   * Per `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field
   * shapes are dishonest": present-when-meaningful via conditional
   * spread, never an empty object on real elements.
   */
  readonly synthesized?: SyntheticElementOrigin;
}

/** Where a synthesized JSX element came from. */
export type SyntheticElementOrigin =
  | {
      readonly source: "storybook-args";
      /**
       * The variable-declarator name (e.g. `Primary` for
       * `export const Primary: StoryObj<typeof Button> = { args: {…} }`).
       * Lets a reporter say "synthesized from the Primary story" without
       * re-parsing.
       */
      readonly storyName: string;
    }
  | {
      readonly source: "mdx-example-code";
      /**
       * The MDX parent component name whose `code={`…`}` template-literal
       * prop was extracted and re-parsed as HTML — one of the configured
       * allow-list entries (default `Example` / `Demo` / `Playground`).
       * Starlight/MDX docs-component conventions ship the rendered HTML
       * inside this prop; the in-house MDX parser extracts it so HTML-
       * bearing rules (`forms/labels-required`, alt-text, heading
       * hierarchy, etc.) see the substrate they'd otherwise skip.
       */
      readonly componentName: string;
    };

export type JsxNode = JsxElement | JsxText | JsxExpression;

export interface JsxAttribute extends BaseNode {
  readonly kind: "JsxAttribute";
  readonly name: string;
  /** `null` for shorthand attributes (`<img hidden />`). */
  readonly value: JsxAttributeValue | null;
}

export type JsxAttributeValue =
  | { readonly kind: "StringLiteral"; readonly value: string }
  | { readonly kind: "Expression"; readonly raw: string };

export interface JsxText extends BaseNode {
  readonly kind: "JsxText";
  readonly value: string;
}

export interface JsxExpression extends BaseNode {
  readonly kind: "JsxExpression";
  readonly raw: string;
}

// ---------------------------------------------------------------------------
// Discriminated union tying language → AST root
// ---------------------------------------------------------------------------

export type Ast =
  | {
      readonly language: "html";
      readonly root: HtmlDocument;
      readonly errors: readonly ParseError[];
    }
  | {
      readonly language: "css";
      readonly root: CssStylesheet;
      readonly errors: readonly ParseError[];
    }
  | {
      readonly language: "tsx" | "jsx" | "ts" | "js";
      readonly root: TsxModule;
      readonly errors: readonly ParseError[];
    };
