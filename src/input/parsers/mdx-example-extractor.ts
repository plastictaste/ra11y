/**
 * MDX docs-component code-prop extractor.
 *
 * Starlight / Docusaurus / Next MDX docs pipelines routinely ship
 * rendered HTML previews inside a JSX attribute whose value is a
 * template-literal string — canonical shape:
 *
 *   <Example code={`
 *     <form>
 *       <input type="email" class="form-control" id="emailInput">
 *     </form>
 *   `} />
 *
 * The body of the template literal is the HTML the docs site actually
 * renders. The in-house TSX parser correctly sees `<Example>` as a
 * component with a `code={…}` expression attribute — the attribute's
 * `raw` is captured verbatim, but the HTML inside the template literal
 * never enters the JSX element stream. Rules that key off HTML
 * structure (`forms/labels-required`, alt-text, heading hierarchy, …)
 * therefore skip a load-bearing substrate: on Bootstrap's docs site
 * alone, ~110 `.mdx` files ship preview markup this way, none of which
 * reaches the rule pipeline without this pass.
 *
 * What this pass does
 * -------------------
 * Walks the TSX AST for elements whose `tagName` matches a caller-
 * configurable allow-list (default: `Example`, `Demo`, `Playground`).
 * For each match that carries a `code` prop whose value is a
 * substitution-free template literal, extracts the template body,
 * parses it through `parseHtml`, and converts the resulting HTML AST
 * into synthesized JsxElements whose loc positions are offset to the
 * original MDX source so downstream findings carry the correct line
 * and column.
 *
 * What this pass deliberately does NOT do
 * ---------------------------------------
 *  - Expand template-literal substitutions (`${expr}`). A template with
 *    a substitution has dynamic segments the static pipeline cannot
 *    resolve; we skip the whole element rather than parse a partial
 *    body. Honest absence over confidently-wrong findings.
 *  - Interpret non-template `code` values (`code="<form/>"`, `code={someVar}`).
 *    A plain string would already surface under the TSX parser's
 *    attribute handling; an identifier reference is dynamic. Only the
 *    template-literal shape gets the extraction.
 *  - Change existing element emissions. The synthesized HTML-derived
 *    JSX elements are appended; the original `<Example>` element and
 *    its attributes stay in the AST, keyed to their original source
 *    range.
 *  - Rewrite attribute casing beyond three canonical React-ism
 *    translations (`class` → `className`, `for` → `htmlFor`,
 *    `tabindex` → `tabIndex`). These are the HTML→JSX name differences
 *    the JSX-branch of downstream rules looks up by name; preserving
 *    the rest verbatim keeps the synthesized AST honest about what
 *    the source actually says.
 *
 * Zero-dep + error recovery
 * -------------------------
 * Never throws. Returns the synthesized element list plus any parse
 * errors from the HTML sub-parse (offset to MDX positions so an agent
 * can navigate to the authored line). Malformed template bodies
 * degrade gracefully — the HTML parser's recovery produces a partial
 * tree, which we still surface.
 */

import { walkJsxElements } from "../../engine/ast-helpers.ts";
import type {
  HtmlAttribute,
  HtmlElement,
  HtmlNode,
  JsxAttribute,
  JsxAttributeValue,
  JsxElement,
  JsxNode,
  JsxText,
  ParseError,
  SourcePosition,
  TsxModule,
} from "../../types/ast.ts";
import { parseHtml } from "./html.ts";

/** Default allow-list for MDX docs-component recognition. */
export const DEFAULT_EXAMPLE_COMPONENT_NAMES: readonly string[] = ["Example", "Demo", "Playground"];

/**
 * Prop names that, on a docs-allow-list component, carry a template-
 * literal HTML body the extractor descends into. Lowercase; comparison
 * is case-insensitive at the call site so `<Example Code={`…`}/>` and
 * `<Example code={`…`}/>` route through the same path. The list is
 * deliberately narrow — these are the four names canonical to the
 * Starlight / Docusaurus / Next / Bootstrap-docs / Bootstrap-blog MDX
 * conventions; widening would surface false positives on prop names
 * (`type`, `data`) whose template-literal contents are not authored
 * HTML the docs site renders.
 *
 * Drives both the extractor's slot finder and the per-finding
 * `couldBeWrongBecause` propagation: a finding emitted on an element
 * synthesized from a code-demo prop's template body inherits the
 * `template_literal_in_code_demo_prop` reason code so the agent reads
 * the substrate's rhetorical framing (the rendered-preview HTML on a
 * docs page is text the agent should triage by reading the surrounding
 * MDX, not by editing the source file's authored markup).
 */
export const CODE_DEMO_PROP_NAMES: readonly string[] = [
  "code",
  "example",
  "source",
  "template",
];

const CODE_DEMO_PROP_NAME_SET: ReadonlySet<string> = new Set<string>(CODE_DEMO_PROP_NAMES);

/**
 * Per-finding `couldBeWrongBecause` reason code propagated to every
 * violation whose `(filePath, line)` falls inside a code-demo prop's
 * template-literal body the MDX extractor descended into. Snake_case
 * identifier the agent matches on the `couldBeWrongBecause` array.
 *
 * Pairs structurally with the corpus-level
 * `jsx_code_demo_prop_parsed_as_live_dom` warning the scan-time helper
 * surfaces from the same evidence set: the warning names "this corpus
 * carries code-demo descents," the per-finding reason names "this
 * specific finding fired inside one." Surface, don't suppress per
 * `docs/kb/architecture/ai-first-consumer.md` — the rule still emits
 * (the markup is structurally what the rule's predicate names); the
 * triage signal is additive so the agent decides whether the finding
 * is rhetorical (a bad-pattern preview the docs page intentionally
 * shows) or real (a paste-into-your-app example that's silently broken).
 */
export const CODE_DEMO_PROP_REASON_CODE = "template_literal_in_code_demo_prop";

/** HTML attribute name → JSX attribute name canonical translations. */
const HTML_TO_JSX_ATTR: ReadonlyMap<string, string> = new Map([
  ["class", "className"],
  ["for", "htmlFor"],
  ["tabindex", "tabIndex"],
]);

/** Void (self-closing) HTML tag names — mirrors the HTML parser's set. */
const VOID_TAGS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

export interface MdxExampleExtractionResult {
  /** JSX elements synthesized from parsed HTML bodies. */
  readonly elements: readonly JsxElement[];
  /**
   * Parse errors from the HTML sub-parses, with positions already
   * offset to the MDX source. Appended to the MDX parser's error list
   * so the caller sees one honest `ParseError[]` keyed to the file.
   */
  readonly errors: readonly ParseError[];
  /**
   * Per-extraction evidence — one entry per successful descent into a
   * code-demo prop's template-literal body. Drives the corpus-level
   * `jsx_code_demo_prop_parsed_as_live_dom` warning (caller cross-
   * references against finding-bearing files) and the per-finding
   * `couldBeWrongBecause` propagation (caller maps each finding's
   * line into the per-file ranges to decide whether the
   * {@link CODE_DEMO_PROP_REASON_CODE} reason applies).
   *
   * `propName` is lowercase (the source-side casing is normalized so
   * downstream consumers can branch on stable identifiers per CLAUDE.md
   * §1 "Ambiguous field shapes are dishonest"). `bodyStartLine` /
   * `bodyEndLine` are 1-based MDX-source line numbers spanning the
   * template-literal content (not including the backtick delimiters);
   * findings whose `location.line` falls inside `[bodyStartLine,
   * bodyEndLine]` were emitted on synthesized elements derived from
   * this prop's body.
   */
  readonly propMatches: readonly CodeDemoPropMatch[];
}

/**
 * Per-extraction evidence record. One entry per successful descent
 * into a code-demo prop's template-literal body. Separate type-export
 * because the scan-time-warnings aggregator and per-finding
 * `couldBeWrongBecause` propagator both consume the shape.
 */
export interface CodeDemoPropMatch {
  /** Lowercase prop name (one of {@link CODE_DEMO_PROP_NAMES}). */
  readonly propName: string;
  /** JSX tag name carrying the prop (e.g. `Example`, `Demo`, `Playground`). */
  readonly tagName: string;
  /** 1-based MDX-source line of the prop's template-literal opening backtick. */
  readonly propLine: number;
  /** 1-based MDX-source first line of the template-literal body content. */
  readonly bodyStartLine: number;
  /** 1-based MDX-source last line of the template-literal body content. */
  readonly bodyEndLine: number;
}

/**
 * Walks `module.jsxElements` for elements matching `allowList` and
 * returns the per-extraction evidence WITHOUT synthesizing JSX
 * elements or running the HTML sub-parse. Strict subset of
 * {@link extractMdxExampleCode}'s slot-finder pass — same predicate
 * (allow-listed component AND a {@link CODE_DEMO_PROP_NAMES} prop
 * carrying a pure template literal), strictly cheaper.
 *
 * Used by the parse-aggregation seam to recover the per-file evidence
 * the {@link import("../../mcp/session.ts").McpSession} parse cache
 * threw away — `session.parseFile` returns only the {@link import("../../engine/scanner.ts").ParsedFile}
 * shape (`{ filePath, source, ast }`), so the caller re-derives the
 * matches over the cached source + AST when surfacing the corpus-level
 * `jsx_code_demo_prop_parsed_as_live_dom` warning. Pure over its
 * inputs; idempotent across calls.
 *
 * Returns an empty array on the common case (no docs-component
 * descents on this file) so the wire shape stays present-when-
 * meaningful at the warning-channel seam without an additional
 * conditional spread.
 */
export function detectCodeDemoPropMatches(
  source: string,
  module: TsxModule,
  allowList: readonly string[] = DEFAULT_EXAMPLE_COMPONENT_NAMES,
): readonly CodeDemoPropMatch[] {
  if (allowList.length === 0) return [];
  const allow = new Set(allowList);
  const out: CodeDemoPropMatch[] = [];
  for (const el of walkJsxElements(module)) {
    if (!allow.has(el.tagName)) continue;
    const slot = findTemplateCodeSlot(source, el);
    if (!slot) continue;
    const body = extractTemplateBody(source, slot.openBacktickOffset);
    if (!body) continue;
    const bodyText = body.text;
    let bodyEndLine = body.start.line;
    for (let i = 0; i < bodyText.length; i += 1) {
      if (bodyText[i] === "\n") bodyEndLine += 1;
    }
    out.push({
      propName: slot.propName,
      tagName: el.tagName,
      propLine: countNewlinesBefore(source, slot.openBacktickOffset) + 1,
      bodyStartLine: body.start.line,
      bodyEndLine,
    });
  }
  return out;
}

/**
 * Walks `module.jsxElements` for elements matching `allowList`,
 * extracts their template-literal `code` prop body, parses it as HTML,
 * and returns synthesized JSX elements positioned in the MDX source.
 *
 * `source` is the original MDX buffer — same string the TSX parser
 * saw (after MDX's blank-in-place transforms). The passes preserve
 * character offsets, so positions computed here resolve to the
 * author's line/column.
 */
export function extractMdxExampleCode(
  source: string,
  module: TsxModule,
  allowList: readonly string[],
): MdxExampleExtractionResult {
  if (allowList.length === 0) return { elements: [], errors: [], propMatches: [] };
  const allow = new Set(allowList);
  const elements: JsxElement[] = [];
  const errors: ParseError[] = [];
  const propMatches: CodeDemoPropMatch[] = [];
  for (const el of walkJsxElements(module)) {
    if (!allow.has(el.tagName)) continue;
    const extracted = extractFromOneElement(source, el);
    if (!extracted) continue;
    elements.push(...extracted.elements);
    errors.push(...extracted.errors);
    propMatches.push(...extracted.propMatches);
  }
  return { elements, errors, propMatches };
}

/**
 * Extracts the HTML substrate from a single allow-listed element.
 * Returns `null` when the element has no usable `code` template
 * literal (no code prop, non-template expression, unterminated body,
 * contains substitutions, etc.). Split out from {@link extractMdxExampleCode}
 * to keep the per-element work focused and the outer walk simple.
 */
function extractFromOneElement(source: string, el: JsxElement): MdxExampleExtractionResult | null {
  const slot = findTemplateCodeSlot(source, el);
  if (!slot) return null;
  const body = extractTemplateBody(source, slot.openBacktickOffset);
  if (!body) return null;
  const htmlResult = parseHtml(body.text);
  const lineOffset = body.start.line - 1;
  const columnOffsetFirstLine = body.start.column - 1;
  const bodyOffset = body.start.offset;
  const elements: JsxElement[] = [];
  for (const node of htmlResult.root.children) {
    const converted = convertHtmlNodeToJsx(
      node,
      el.tagName,
      lineOffset,
      columnOffsetFirstLine,
      bodyOffset,
    );
    if (converted && converted.kind === "JsxElement") elements.push(converted);
  }
  const errors: ParseError[] = htmlResult.errors.map((err) => ({
    message: err.message,
    position: offsetSourcePosition(err.position, lineOffset, columnOffsetFirstLine, bodyOffset),
    recoverable: err.recoverable,
  }));
  // Body line range — bodyStartLine is the first line of body content
  // (the line of the character AFTER the opening backtick); bodyEndLine
  // is the last line of body content (one line before the closing
  // backtick when the close sits on its own line, the same line
  // otherwise). The detector keeps the range inclusive on both ends so
  // a single-line code-demo prop (`<Example code={`<input/>`} />`) maps
  // to `bodyStartLine === bodyEndLine` and a finding emitted on that
  // line falls inside the range. Per AI-first doctrine
  // "Surface, don't suppress" — the range is purely additive context;
  // the rule's predicate is unchanged.
  const bodyText = body.text;
  let bodyEndLine = body.start.line;
  for (let i = 0; i < bodyText.length; i += 1) {
    if (bodyText[i] === "\n") bodyEndLine += 1;
  }
  const propMatch: CodeDemoPropMatch = {
    propName: slot.propName,
    tagName: el.tagName,
    propLine: countNewlinesBefore(source, slot.openBacktickOffset) + 1,
    bodyStartLine: body.start.line,
    bodyEndLine,
  };
  return { elements, errors, propMatches: [propMatch] };
}

/** Count newline characters in `source` strictly before `offset`. */
function countNewlinesBefore(source: string, offset: number): number {
  let n = 0;
  const stop = Math.min(offset, source.length);
  for (let i = 0; i < stop; i += 1) {
    if (source[i] === "\n") n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Slot discovery — locating the `code={`…`}` shape in the element's source
// ---------------------------------------------------------------------------

interface CodePropSlot {
  /** Absolute offset in `source` of the opening backtick of the template. */
  readonly openBacktickOffset: number;
  /**
   * Lowercase prop name that matched. One of {@link CODE_DEMO_PROP_NAMES}
   * — recorded so the per-extraction evidence carries the verbatim
   * predicate axis the agent reads on `propMatches[].propName`.
   */
  readonly propName: string;
}

/**
 * Locates an attribute on `element` whose name is in
 * {@link CODE_DEMO_PROP_NAMES} (case-insensitive) AND whose value is a
 * pure template literal, and returns the offset of the opening backtick
 * in `source` plus the lowercase matched prop name. Returns `null` when
 * the element has no such prop, the prop isn't an expression, the
 * expression isn't a template literal, or the template contains
 * substitutions (`${…}`).
 *
 * When multiple code-demo props happen to coexist on one element, the
 * first match wins — `attributes[]` preserves source order so the
 * iteration order is stable. Real-world docs sites use exactly one of
 * the four names per component; the iteration order only matters for
 * defense in depth.
 */
function findTemplateCodeSlot(source: string, element: JsxElement): CodePropSlot | null {
  for (const attr of element.attributes) {
    const lower = attr.name.toLowerCase();
    if (!CODE_DEMO_PROP_NAME_SET.has(lower)) continue;
    if (!attr.value || attr.value.kind !== "Expression") continue;
    if (!isPureTemplateExpression(attr.value.raw)) continue;
    const slot = locateBacktickInSource(source, attr.range.start, attr.range.end);
    if (!slot) continue;
    return { openBacktickOffset: slot.openBacktickOffset, propName: lower };
  }
  return null;
}

/**
 * Validates that `raw` is exactly `{` + optional whitespace + a
 * substitution-free template literal + optional whitespace + `}`.
 * Rejects identifiers, concatenations, `String.raw(...)` calls, and
 * any template containing `${…}`.
 */
function isPureTemplateExpression(raw: string): boolean {
  // raw is the full `{…}` expression; expect `{` + optional ws + backtick.
  if (raw.length < 3 || raw[0] !== "{") return false;
  let i = 1;
  while (i < raw.length && isWs(raw[i])) i += 1;
  if (raw[i] !== "`") return false;
  const afterBacktick = findMatchingBacktickSkippingEscapes(raw, i);
  if (afterBacktick === -1) return false;
  // Substitution-free body — `${` inside disqualifies the whole pass.
  if (containsSubstitution(raw.slice(i + 1, afterBacktick))) return false;
  // After the closing backtick, only whitespace then `}` may follow.
  let j = afterBacktick + 1;
  while (j < raw.length && isWs(raw[j])) j += 1;
  return j === raw.length - 1 && raw[j] === "}";
}

/**
 * Locates the opening backtick of the template literal inside the
 * attribute's source span. The TSX parser captures the expression
 * `raw` verbatim, but we need the original-source offset to key
 * downstream positions; this walk finds it. Returns just the offset —
 * the caller pairs the offset with the matched lowercase prop name to
 * assemble the {@link CodePropSlot} record.
 */
function locateBacktickInSource(
  source: string,
  attrStart: number,
  attrEnd: number,
): { readonly openBacktickOffset: number } | null {
  const openBrace = source.indexOf("{", attrStart);
  if (openBrace === -1 || openBrace >= attrEnd) return null;
  let k = openBrace + 1;
  while (k < attrEnd && isWs(source[k])) k += 1;
  if (source[k] !== "`") return null;
  return { openBacktickOffset: k };
}

function isWs(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

/**
 * Returns the offset of the matching closing backtick for the template
 * literal opened at `openOffset`, honouring `\` escapes. Returns -1 if
 * unterminated.
 */
function findMatchingBacktickSkippingEscapes(s: string, openOffset: number): number {
  let i = openOffset + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i;
    i += 1;
  }
  return -1;
}

/**
 * True when a template-literal body contains an unescaped `${…}`
 * substitution. Permissive recogniser — a bare `$` followed by `{`
 * counts, since the TSX parser's raw capture doesn't distinguish
 * escapes per the spec.
 */
function containsSubstitution(body: string): boolean {
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "\\") {
      i += 1;
      continue;
    }
    if (body[i] === "$" && body[i + 1] === "{") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Body extraction — slice out the template body and anchor its position
// ---------------------------------------------------------------------------

interface ExtractedBody {
  /** HTML-ready text (template body, unescaped backticks). */
  readonly text: string;
  /** Source-space position of the first character of the body. */
  readonly start: SourcePosition;
}

/**
 * Extracts the template-literal body starting at `openBacktickOffset`
 * (the source offset of the opening `` ` ``). Returns `null` if the
 * closing backtick is missing.
 *
 * Unescapes `\`` → `` ` ``; every other escape survives verbatim since
 * HTML doesn't interpret JS escapes. Positions reflect the raw source
 * so offsets stay directly mappable; the unescape only shifts character
 * content, not the position of the first body character.
 */
function extractTemplateBody(source: string, openBacktickOffset: number): ExtractedBody | null {
  const closing = findMatchingBacktickSkippingEscapes(source, openBacktickOffset);
  if (closing === -1) return null;
  const bodyStart = openBacktickOffset + 1;
  const rawBody = source.slice(bodyStart, closing);
  const text = unescapeBackticks(rawBody);
  return { text, start: computePosition(source, bodyStart) };
}

/**
 * Replaces `\\\`` with `\``. No other JS escapes are interpreted — HTML
 * reads literal characters, so `\\n` stays `\\n` (not a newline),
 * `\\\\` stays `\\\\`, etc. Backtick-specific because that's the one
 * character that ends the template.
 */
function unescapeBackticks(body: string): string {
  if (body.indexOf("\\`") === -1) return body;
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "\\" && body[i + 1] === "`") {
      out += "`";
      i += 1;
      continue;
    }
    out += body[i];
  }
  return out;
}

/**
 * Computes the 1-based (line, column, offset) of `offset` in `source`.
 * Linear O(offset); called once per extraction so the cost is bounded.
 */
function computePosition(source: string, offset: number): SourcePosition {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column, offset };
}

// ---------------------------------------------------------------------------
// HTML → JSX conversion — same structural shape, offset positions
// ---------------------------------------------------------------------------

/**
 * Offsets an HTML-parser SourcePosition onto the MDX source grid.
 *
 * Line math: HTML parser line 1 → MDX line (bodyStart.line); line N →
 * MDX line (bodyStart.line + N - 1).
 * Column math: body-line-1 columns add `columnOffsetFirstLine`; all
 * other lines keep their column verbatim (the template body starts
 * mid-line only on line 1, and every subsequent newline resets column
 * to 1 in both grids).
 * Offset math: HTML offset 0 corresponds to bodyStartOffset in source.
 */
function offsetSourcePosition(
  pos: SourcePosition,
  lineOffset: number,
  columnOffsetFirstLine: number,
  bodyStartOffset: number,
): SourcePosition {
  return {
    line: pos.line + lineOffset,
    column: pos.line === 1 ? pos.column + columnOffsetFirstLine : pos.column,
    offset: pos.offset + bodyStartOffset,
  };
}

function convertHtmlNodeToJsx(
  node: HtmlNode,
  componentName: string,
  lineOffset: number,
  columnOffsetFirstLine: number,
  bodyStartOffset: number,
): JsxNode | null {
  if (node.kind === "HtmlElement") {
    return convertHtmlElement(
      node,
      componentName,
      lineOffset,
      columnOffsetFirstLine,
      bodyStartOffset,
    );
  }
  if (node.kind === "HtmlText") {
    return convertHtmlText(node, lineOffset, columnOffsetFirstLine, bodyStartOffset);
  }
  // HtmlComment / HtmlDoctype drop — JSX has no direct analogue and no
  // rule reads comments/doctypes off the JSX AST.
  return null;
}

function convertHtmlElement(
  el: HtmlElement,
  componentName: string,
  lineOffset: number,
  columnOffsetFirstLine: number,
  bodyStartOffset: number,
): JsxElement {
  const attributes: JsxAttribute[] = [];
  for (const attr of el.attributes) {
    attributes.push(convertHtmlAttribute(attr, lineOffset, columnOffsetFirstLine, bodyStartOffset));
  }
  const children: JsxNode[] = [];
  for (const child of el.children) {
    const converted = convertHtmlNodeToJsx(
      child,
      componentName,
      lineOffset,
      columnOffsetFirstLine,
      bodyStartOffset,
    );
    if (converted) children.push(converted);
  }
  const tagLower = el.tagName.toLowerCase();
  const selfClosing = el.selfClosing || VOID_TAGS.has(tagLower);
  return {
    kind: "JsxElement",
    range: {
      start: el.range.start + bodyStartOffset,
      end: el.range.end + bodyStartOffset,
    },
    loc: {
      start: offsetSourcePosition(el.loc.start, lineOffset, columnOffsetFirstLine, bodyStartOffset),
      end: offsetSourcePosition(el.loc.end, lineOffset, columnOffsetFirstLine, bodyStartOffset),
    },
    tagName: el.tagName,
    attributes,
    children,
    selfClosing,
    hasSpreadProps: false,
    synthesized: { source: "mdx-example-code", componentName },
  };
}

function convertHtmlAttribute(
  attr: HtmlAttribute,
  lineOffset: number,
  columnOffsetFirstLine: number,
  bodyStartOffset: number,
): JsxAttribute {
  const name = HTML_TO_JSX_ATTR.get(attr.name.toLowerCase()) ?? attr.name;
  const value: JsxAttributeValue | null =
    attr.value === null ? null : { kind: "StringLiteral", value: attr.value };
  return {
    kind: "JsxAttribute",
    range: {
      start: attr.range.start + bodyStartOffset,
      end: attr.range.end + bodyStartOffset,
    },
    loc: {
      start: offsetSourcePosition(
        attr.loc.start,
        lineOffset,
        columnOffsetFirstLine,
        bodyStartOffset,
      ),
      end: offsetSourcePosition(attr.loc.end, lineOffset, columnOffsetFirstLine, bodyStartOffset),
    },
    name,
    value,
  };
}

function convertHtmlText(
  text: {
    readonly value: string;
    readonly range: { start: number; end: number };
    readonly loc: { start: SourcePosition; end: SourcePosition };
  },
  lineOffset: number,
  columnOffsetFirstLine: number,
  bodyStartOffset: number,
): JsxText {
  return {
    kind: "JsxText",
    range: {
      start: text.range.start + bodyStartOffset,
      end: text.range.end + bodyStartOffset,
    },
    loc: {
      start: offsetSourcePosition(
        text.loc.start,
        lineOffset,
        columnOffsetFirstLine,
        bodyStartOffset,
      ),
      end: offsetSourcePosition(text.loc.end, lineOffset, columnOffsetFirstLine, bodyStartOffset),
    },
    value: text.value,
  };
}
