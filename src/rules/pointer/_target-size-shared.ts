/**
 * Shared CSS / HTML / JSX scanning logic for pointer/target-size and
 * pointer/target-size-enhanced. The two rules share an identical
 * detection model — the only differences are:
 *
 *   - the minimum threshold (24 CSS px for AA / SC 2.5.8 vs 44 for AAA / SC 2.5.5),
 *   - the human-readable SC label embedded in messages and suggestions,
 *   - the `satisfies` array on each `defineRule` call.
 *
 * Rather than duplicate ~400 lines of scanning code per level, both
 * rules consume this module via `scanCss(ctx, opts)`, `scanHtml(ctx, opts)`
 * and `scanJsx(ctx, opts)` with a `TargetSizeOpts` thresholding context.
 *
 * Not a public API — keep the surface narrow.
 */

import {
  getHtmlAttribute,
  getJsxAttributeString,
  walkCssRules,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import { resolveTailwindClasses } from "../../input/resolvers/theme.ts";
import type {
  CssRule as AstCssRule,
  CssDeclaration,
  CssStylesheet,
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type { EmittedViolation, RuleContext } from "../../types/rule.ts";
import {
  applyDeclToBox,
  type BoxResult,
  finalizeBox,
  formatBoxSize,
  newBox,
  paddingFromDecl,
  parsePaddingShorthand,
  parsePx,
  truncate,
} from "./target-size-helpers.ts";

/** Threshold + SC labelling for one of the two target-size rules. */
export interface TargetSizeOpts {
  /** Minimum target dimension in CSS pixels (24 for AA, 44 for AAA). */
  readonly minPx: number;
  /** Short SC label embedded in messages — e.g. "WCAG 2.2 SC 2.5.8". */
  readonly scLabel: string;
  /** Tailwind class hint for the suggestion text — e.g. "w-6 h-6" / "w-11 h-11". */
  readonly fixTailwindClasses: string;
}

/** Tag names that are inherently interactive pointer targets. */
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set(["button", "a"]);

/** input[type=...] values that are pointer-interactive. */
const INTERACTIVE_INPUT_TYPES: ReadonlySet<string> = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "image",
]);

/** input[type=...] values where sizing is user-agent-determined per the SC exception. */
const USER_AGENT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "range",
  "color",
  "file",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/** Text-flow containers that trigger the WCAG "Inline" exception. */
const TEXT_FLOW_TAGS: ReadonlySet<string> = new Set(["p", "li", "td", "th", "dd", "dt"]);

// ---------------------------------------------------------------------------
// CSS pass
// ---------------------------------------------------------------------------

interface SizeRead {
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly widthDecl: CssDeclaration | undefined;
  readonly heightDecl: CssDeclaration | undefined;
}

interface PaddingRead {
  readonly horizontalPx: number;
  readonly verticalPx: number;
}

interface SingleAxisRead {
  px: number | null;
  decl: CssDeclaration | undefined;
  isExplicit: boolean;
}

function applyAxisDecl(
  axis: SingleAxisRead,
  decl: CssDeclaration,
  explicit: boolean,
  px: number,
): void {
  if (axis.px === null || (!axis.isExplicit && explicit)) {
    axis.px = px;
    axis.decl = decl;
    axis.isExplicit = explicit;
  }
}

function collectDeclaredSize(cssRule: AstCssRule): SizeRead | null {
  const w: SingleAxisRead = { px: null, decl: undefined, isExplicit: false };
  const h: SingleAxisRead = { px: null, decl: undefined, isExplicit: false };
  for (const decl of cssRule.declarations) {
    const prop = decl.property.toLowerCase();
    const px = parsePx(decl.value);
    if (px === null) continue;
    if (prop === "width" || prop === "min-width") {
      applyAxisDecl(w, decl, prop === "width", px);
    } else if (prop === "height" || prop === "min-height") {
      applyAxisDecl(h, decl, prop === "height", px);
    }
  }
  if (w.px === null && h.px === null) return null;
  return { widthPx: w.px, heightPx: h.px, widthDecl: w.decl, heightDecl: h.decl };
}

function collectPaddingPx(cssRule: AstCssRule): PaddingRead {
  let horizontal = 0;
  let vertical = 0;
  for (const decl of cssRule.declarations) {
    const contribution = paddingFromDecl(decl.property.toLowerCase(), decl.value);
    if (contribution === null) continue;
    horizontal = Math.max(horizontal, contribution.h);
    vertical = Math.max(vertical, contribution.v);
  }
  return { horizontalPx: horizontal, verticalPx: vertical };
}

function isUndersized(size: SizeRead, padding: PaddingRead, minPx: number): boolean {
  const widthEff =
    size.widthPx === null ? Number.POSITIVE_INFINITY : size.widthPx + padding.horizontalPx * 2;
  const heightEff =
    size.heightPx === null ? Number.POSITIVE_INFINITY : size.heightPx + padding.verticalPx * 2;
  return widthEff < minPx || heightEff < minPx;
}

export function scanCss(ctx: RuleContext & { ast: CssStylesheet }, opts: TargetSizeOpts): void {
  for (const cssRule of walkCssRules(ctx.ast)) {
    if (!selectorLooksInteractive(cssRule.selector)) continue;
    const size = collectDeclaredSize(cssRule);
    if (size === null) continue;
    const padding = collectPaddingPx(cssRule);
    if (!isUndersized(size, padding, opts.minPx)) continue;
    const decl = size.widthDecl ?? size.heightDecl;
    if (decl === undefined) continue;
    const sizeText = formatBoxSize({ widthPx: size.widthPx, heightPx: size.heightPx });
    ctx.emit({
      severity: "warning",
      location: {
        filePath: ctx.filePath,
        line: decl.loc.start.line,
        column: decl.loc.start.column,
      },
      message: `Selector \`${cssRule.selector}\` targets an interactive control sized ${sizeText} — below the ${opts.scLabel} minimum of ${opts.minPx}×${opts.minPx} CSS pixels.`,
      suggestion: buildCssSuggestion(cssRule.selector, size, padding, sizeText, opts),
    });
  }
}

function buildCssSuggestion(
  selector: string,
  size: SizeRead,
  padding: PaddingRead,
  sizeText: string,
  opts: TargetSizeOpts,
): string {
  const w = size.widthPx;
  const h = size.heightPx;
  const needsWidth = w !== null && w < opts.minPx;
  const needsHeight = h !== null && h < opts.minPx;
  const padDelta = Math.max(needsWidth ? opts.minPx - w : 0, needsHeight ? opts.minPx - h : 0) / 2;
  const fixSize: string[] = [];
  if (needsWidth) fixSize.push(`width: ${opts.minPx}px`);
  if (needsHeight) fixSize.push(`height: ${opts.minPx}px`);
  const padHint =
    padding.horizontalPx === 0 && padding.verticalPx === 0
      ? `add \`padding: ${Math.ceil(padDelta)}px;\` so the touch target reaches at least ${opts.minPx}×${opts.minPx}`
      : `increase \`padding\` from the current ${padding.horizontalPx}px/${padding.verticalPx}px so total target reaches ${opts.minPx}px on both axes`;
  return `\`${selector}\` declares ${sizeText}. Either set \`${fixSize.join("; ")};\`, or ${padHint}. If this control is inline within a sentence or sized by surrounding line-height, the WCAG "Inline" exception applies — suppress with a comment explaining why.`;
}

function selectorLooksInteractive(selector: string): boolean {
  const s = selector.toLowerCase();
  if (/(^|[\s>+~,])(button|a)\b/.test(s)) return true;
  if (
    s.includes('[role="button"]') ||
    s.includes("[role='button']") ||
    s.includes("[role=button]")
  ) {
    return true;
  }
  if (/input\s*\[\s*type\s*=\s*['"]?(button|submit|reset|checkbox|radio|image)['"]?\s*\]/.test(s)) {
    return true;
  }
  if (/(^|[\s.>+~,])(\.btn|\.button|\.icon-btn|\.icon-button)\b/.test(s)) return true;
  if (/[\w-]*button[\w-]*/.test(s) && !s.includes("submit-success")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// JSX pass — Tailwind className resolution on interactive elements
// ---------------------------------------------------------------------------

export function scanJsx(ctx: RuleContext & { ast: TsxModule }, opts: TargetSizeOpts): void {
  const ancestors = buildJsxAncestorMap(ctx.ast);
  for (const el of walkJsxElements(ctx.ast)) {
    if (!isInteractiveJsx(el)) continue;
    if (jsxIsInsideTextFlow(el, ancestors)) continue;
    const className = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
    if (className === null) continue;
    const sized = analyzeTailwindClasses(className, opts.minPx);
    if (sized === null) continue;
    ctx.emit(
      buildMarkupViolation(
        el.tagName,
        ctx.filePath,
        el.loc.start,
        "className",
        className,
        sized,
        opts,
      ),
    );
  }
}

function buildJsxAncestorMap(module: TsxModule): Map<JsxElement, JsxElement[]> {
  const out = new Map<JsxElement, JsxElement[]>();
  const visit = (node: JsxNode, stack: JsxElement[]): void => {
    if (node.kind !== "JsxElement") return;
    out.set(node, [...stack]);
    stack.push(node);
    for (const child of node.children) visit(child, stack);
    stack.pop();
  };
  for (const root of module.jsxElements) visit(root, []);
  return out;
}

function jsxIsInsideTextFlow(el: JsxElement, ancestors: Map<JsxElement, JsxElement[]>): boolean {
  const stack = ancestors.get(el) ?? [];
  return stack.some((a) => TEXT_FLOW_TAGS.has(a.tagName.toLowerCase()));
}

function isInteractiveJsx(el: JsxElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (getJsxAttributeString(el, "role") === "button") return true;
  if (tag === "input") return isInteractiveInputType(getJsxAttributeString(el, "type"));
  return false;
}

function isInteractiveInputType(typeAttr: string | null): boolean {
  const type = (typeAttr ?? "text").toLowerCase();
  if (USER_AGENT_INPUT_TYPES.has(type)) return false;
  return INTERACTIVE_INPUT_TYPES.has(type);
}

function analyzeTailwindClasses(className: string, minPx: number): BoxResult | null {
  const decls = resolveTailwindClasses(className);
  if (decls.length === 0) return null;
  const box = newBox();
  for (const d of decls) applyDeclToBox(box, d.property, d.value);
  return finalizeBox(box, className, minPx);
}

function buildMarkupViolation(
  tag: string,
  filePath: string,
  pos: { line: number; column: number },
  attr: string,
  raw: string,
  sized: BoxResult,
  opts: TargetSizeOpts,
): EmittedViolation {
  const sizeText = formatBoxSize(sized);
  return {
    severity: "warning",
    location: { filePath, line: pos.line, column: pos.column },
    message: `<${tag} ${attr}="${truncate(raw, 40)}"> resolves to a ${sizeText} pointer target — below the ${opts.scLabel} minimum of ${opts.minPx}×${opts.minPx} CSS pixels.`,
    suggestion: markupFixSuggestion(attr, sized, opts),
  };
}

function markupFixSuggestion(attr: string, sized: BoxResult, opts: TargetSizeOpts): string {
  if (attr === "style") {
    return `Increase \`width\` and \`height\` to at least ${opts.minPx}px each, or add padding on each side so the total touch target reaches ${opts.minPx}×${opts.minPx} CSS pixels. If this control is inline within prose, the WCAG "Inline" exception applies.`;
  }
  const padHint =
    sized.paddingHorizontalPx === 0 && sized.paddingVerticalPx === 0
      ? `, or add padding so the total touch area reaches ${opts.minPx}×${opts.minPx}`
      : "";
  return `Replace the sizing classes with \`${opts.fixTailwindClasses}\` (${opts.minPx}×${opts.minPx} CSS pixels)${padHint}. If this control is inline within prose or its size is constrained by surrounding line-height, the WCAG "Inline" exception applies — suppress with a comment explaining why.`;
}

// ---------------------------------------------------------------------------
// HTML pass — `style="..."` and `class="..."` Tailwind
// ---------------------------------------------------------------------------

export function scanHtml(ctx: RuleContext & { ast: HtmlDocument }, opts: TargetSizeOpts): void {
  const ancestors = buildHtmlAncestorMap(ctx.ast);
  for (const el of walkHtmlElements(ctx.ast)) {
    if (!isInteractiveHtml(el)) continue;
    if (htmlIsInsideTextFlow(el, ancestors)) continue;
    const style = getHtmlAttribute(el, "style");
    if (style !== null) {
      const sized = analyzeInlineStyle(style, opts.minPx);
      if (sized !== null) {
        ctx.emit(
          buildMarkupViolation(el.tagName, ctx.filePath, el.loc.start, "style", style, sized, opts),
        );
        continue;
      }
    }
    const className = getHtmlAttribute(el, "class");
    if (className !== null) {
      const sized = analyzeTailwindClasses(className, opts.minPx);
      if (sized !== null) {
        ctx.emit(
          buildMarkupViolation(
            el.tagName,
            ctx.filePath,
            el.loc.start,
            "class",
            className,
            sized,
            opts,
          ),
        );
      }
    }
  }
}

function buildHtmlAncestorMap(doc: HtmlDocument): Map<HtmlElement, HtmlElement[]> {
  const out = new Map<HtmlElement, HtmlElement[]>();
  const visit = (node: HtmlNode, stack: HtmlElement[]): void => {
    if (node.kind !== "HtmlElement") return;
    out.set(node, [...stack]);
    stack.push(node);
    for (const child of node.children) visit(child, stack);
    stack.pop();
  };
  for (const child of doc.children) visit(child, []);
  return out;
}

function htmlIsInsideTextFlow(
  el: HtmlElement,
  ancestors: Map<HtmlElement, HtmlElement[]>,
): boolean {
  const stack = ancestors.get(el) ?? [];
  return stack.some((a) => TEXT_FLOW_TAGS.has(a.tagName.toLowerCase()));
}

function isInteractiveHtml(el: HtmlElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (getHtmlAttribute(el, "role") === "button") return true;
  if (tag === "input") return isInteractiveInputType(getHtmlAttribute(el, "type"));
  return false;
}

function analyzeInlineStyle(style: string, minPx: number): BoxResult | null {
  const box = newBox();
  for (const part of style.split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    // padding shorthand needs special handling because applyDeclToBox
    // routes through paddingFromDecl, which already calls parsePaddingShorthand.
    if (prop === "padding") {
      const parsed = parsePaddingShorthand(value);
      if (parsed !== null) {
        box.padH = Math.max(box.padH, parsed.horizontal);
        box.padV = Math.max(box.padV, parsed.vertical);
      }
      continue;
    }
    applyDeclToBox(box, prop, value);
  }
  return finalizeBox(box, style, minPx);
}
