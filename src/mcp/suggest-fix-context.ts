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
import { detectVendorContext, type VendorContext } from "./suggest-fix-vendor-context.ts";
import { buildSourceContext } from "./tools-helpers.ts";
import { warningsField } from "./warnings.ts";

export interface SuggestFixContext {
  readonly inheritedFromWrapper: { readonly wrapperName: string } | null;
  readonly sourceContext: string;
  readonly scanWarnings: readonly string[];
  readonly tailwindDetected: boolean;
  readonly vendorContext: VendorContext | null;
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
  return { inheritedFromWrapper, sourceContext, scanWarnings, tailwindDetected, vendorContext };
}
