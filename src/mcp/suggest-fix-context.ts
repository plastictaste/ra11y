/**
 * Per-call context collector for the `suggest_fix` handler.
 *
 * Gathers the inputs `buildSuggestFixPayload` needs from one place:
 * the rendered source-context window, scan-warnings derived from the
 * single-file rescan, Tailwind-utility detection, vendor /
 * build-artifact classification, and the inherited-wrapper hint that
 * closes the dead-end `kind: "none"` shape on wrapper call-site
 * lookups.
 *
 * Lives in its own module so `tool-suggest-fix.ts` stays under the
 * MCP-handler line budget enforced by `scripts/check-limits.ts`.
 */

import type { ParsedFile, runScan } from "../engine/scanner.ts";
import { hasTailwindSignal } from "./analysis-coverage-hints.ts";
import type { McpSession } from "./session.ts";
import { detectInheritedWrapperHint } from "./suggest-fix-inherited-hint.ts";
import {
  detectMarkdownHeadingIdCollision,
  detectTemplateDirectiveTarget,
  extractIdAttributeOnLine,
  MARKDOWN_HEADING_COLLISION_REROUTE_RULES,
  type MarkdownHeadingIdCollision,
  TEMPLATE_DIRECTIVE_REROUTE_RULES,
  type TemplateDirectiveContext,
} from "./suggest-fix-template-directive.ts";
import { detectVendorContext, type VendorContext } from "./suggest-fix-vendor-context.ts";
import { buildSourceContext } from "./tools-helpers.ts";
import { warningsField } from "./warnings.ts";

export interface SuggestFixContext {
  readonly inheritedFromWrapper: { readonly wrapperName: string } | null;
  readonly sourceContext: string;
  readonly scanWarnings: readonly string[];
  readonly tailwindDetected: boolean;
  readonly vendorContext: VendorContext | null;
  /**
   * Set when the target line carries a template directive AND the
   * `ruleId` is one of the literal-fill suggestions whose hard-code
   * recommendation reads as dishonest in the presence of a runtime
   * binding (`semantics/empty-heading` today). Drives the
   * verify-binding-at-render-time reroute in
   * `tool-suggest-fix-internals.ts`. Null otherwise.
   *
   * Mutually exclusive with {@link markdownHeadingCollision} at the
   * caller level — the template-directive lane wins when both fire,
   * since template-directive presence is the more general signal.
   */
  readonly templateDirectiveContext: TemplateDirectiveContext | null;
  /**
   * Set when `ruleId === "parsing/duplicate-id"` AND the explicit id
   * value on the target line collides with the slugified text of a
   * later ATX heading in the same source. Drives the
   * markdown-heading-collision reroute in
   * `tool-suggest-fix-internals.ts`. Null otherwise.
   */
  readonly markdownHeadingCollision: MarkdownHeadingIdCollision | null;
}

/**
 * Conditional-spread the three `null | T` reroute fields the
 * `SuggestFixContext` exposes onto a `BuildSuggestFixPayloadArgs`
 * spread. Centralized here so the handler in `tool-suggest-fix.ts`
 * stays under the MCP-handler line budget; the spread shape is
 * present-when-meaningful per CLAUDE.md §1 — `null` means absent,
 * never sentinel-empty.
 */
export function suggestFixRerouteSpread(ctx: SuggestFixContext): {
  readonly inheritedFromWrapper?: { readonly wrapperName: string };
  readonly templateDirectiveContext?: TemplateDirectiveContext;
  readonly markdownHeadingCollision?: MarkdownHeadingIdCollision;
} {
  return {
    ...(ctx.inheritedFromWrapper === null
      ? {}
      : { inheritedFromWrapper: ctx.inheritedFromWrapper }),
    ...(ctx.templateDirectiveContext === null
      ? {}
      : { templateDirectiveContext: ctx.templateDirectiveContext }),
    ...(ctx.markdownHeadingCollision === null
      ? {}
      : { markdownHeadingCollision: ctx.markdownHeadingCollision }),
  };
}

export interface CollectSuggestFixContextArgs {
  readonly session: McpSession;
  readonly parsed: ParsedFile;
  readonly result: ReturnType<typeof runScan>["result"];
  readonly line: number;
  readonly sourceContextOverride: string | undefined;
  readonly cwd: string | undefined;
  readonly filePath: string;
  readonly matchUndefined: boolean;
  /**
   * Resolved rule ID (post criterion-bridge) the caller is invoking
   * suggest_fix for. Threaded so the per-rule reroute predicates
   * (`TEMPLATE_DIRECTIVE_REROUTE_RULES`,
   * `MARKDOWN_HEADING_COLLISION_REROUTE_RULES`) gate their detection
   * on the rule actually being looked up — running the detectors on
   * every rule would burn cycles on rules whose suggestion text is
   * already template-aware.
   */
  readonly ruleId: string;
}

export async function collectSuggestFixContext(
  args: CollectSuggestFixContextArgs,
): Promise<SuggestFixContext> {
  const inheritedFromWrapper = args.matchUndefined
    ? await detectInheritedWrapperHint({
        session: args.session,
        line: args.line,
        cwd: args.cwd,
        filePath: args.filePath,
        ast: args.parsed.ast,
      })
    : null;
  const sourceContext =
    args.sourceContextOverride ?? buildSourceContext(args.parsed.source, args.line);
  const scanWarnings =
    warningsField({
      filesScanned: args.result.filesScanned,
      rootSource: null,
      configSource: undefined,
      analysisCoverage: undefined,
      filesByExtension: undefined,
    }).warnings ?? [];
  const tailwindDetected = hasTailwindSignal([args.parsed]);
  const vendorContext = detectVendorContext(args.parsed.filePath, args.parsed.source);
  const templateDirectiveContext = TEMPLATE_DIRECTIVE_REROUTE_RULES.has(args.ruleId)
    ? detectTemplateDirectiveTarget(args.parsed.source, args.line)
    : null;
  const markdownHeadingCollision = computeMarkdownHeadingCollision(
    args.ruleId,
    args.parsed.source,
    args.line,
  );
  return {
    inheritedFromWrapper,
    sourceContext,
    scanWarnings,
    tailwindDetected,
    vendorContext,
    templateDirectiveContext,
    markdownHeadingCollision,
  };
}

/**
 * Gate + extract for the markdown-heading-id collision lane. Returns
 * `null` when the rule isn't in the reroute set, the target line has
 * no `id="..."` attribute, or no later ATX heading slugifies to the
 * same value. Extracted into its own helper so
 * {@link collectSuggestFixContext} stays under the cognitive-complexity
 * cap.
 */
function computeMarkdownHeadingCollision(
  ruleId: string,
  source: string,
  line: number,
): MarkdownHeadingIdCollision | null {
  if (!MARKDOWN_HEADING_COLLISION_REROUTE_RULES.has(ruleId)) return null;
  const id = extractIdAttributeOnLine(source, line);
  if (id === null) return null;
  return detectMarkdownHeadingIdCollision(source, line, id);
}
