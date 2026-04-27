/**
 * The {@link BuildSuggestFixPayloadArgs} input type for
 * `buildSuggestFixPayload`. Lives in its own module so the routing
 * helper (`tool-suggest-fix-routing.ts`) can depend on the shape
 * without importing from `tool-suggest-fix-internals.ts` — that file
 * imports the routing helper, so co-locating the type would create a
 * circular import.
 *
 * Pure type module — no runtime exports.
 */

import type { Violation } from "../types/violation.ts";
import type {
  MarkdownHeadingIdCollision,
  TemplateDirectiveContext,
} from "./suggest-fix-template-directive.ts";
import type { VendorContext } from "./suggest-fix-vendor-context.ts";

export interface BuildSuggestFixPayloadArgs {
  readonly ruleId: string;
  readonly line: number;
  readonly match: Violation | undefined;
  readonly sourceContext: string;
  readonly source: string;
  /**
   * Canonical file path from the suggest_fix request. Passed through
   * to `verifyCommandStructured.args.file` so the verify hint names the
   * exact same path the fix was computed against — never re-derived
   * here to avoid shape-drift between the request and the verify
   * pointer.
   */
  readonly filePath: string;
  /**
   * Every finding the suggest_fix scan emitted on this file. Used by the
   * `kind: "none"` branch to walk same-rule findings within
   * `NEAREST_FINDING_WINDOW` of the requested line and attach a
   * `nearestFinding` (single match) or `didYouMean[]` (multi match)
   * breadcrumb. Closes the dead-end `kind: "none"` shape — paginated
   * scans drift the line, agents lose the original line, rule renames
   * swap the rule ID out from under the request; without breadcrumbs the
   * agent has to re-scan to recover. Optional so unit tests can omit it;
   * the handler always passes the full per-file violation list.
   */
  readonly sameFileFindings?: readonly Violation[];
  /**
   * Caller-computed response-level warnings, forwarded verbatim onto
   * every outcome shape. Closes the zero-output-success ambiguity
   * documented in CLAUDE.md §1 — the handler knows the scan-confidence
   * signals (`filesScanned`, deprecated-param alias, future codes) and
   * passes them here pre-assembled. Omit or pass an empty array to
   * skip the field entirely (conditional-spread at the assembly site).
   */
  readonly warnings?: readonly string[];
  /**
   * Set when the caller invoked `suggest_fix` with a criterion-ID
   * (`wcag22:N.N.N`, `section508:…`, `en301549:…`) instead of a rule ID
   * AND multiple rules satisfy that criterion. The handler resolves the
   * input to the most-specific rule (smallest `satisfies.length`,
   * alphabetic tie-break) and threads this note onto every outcome so
   * the agent can see which rule was chosen and how. Singleton
   * resolution leaves the field absent — there's no ambiguity to
   * disclose. Free-form ID + non-criterion calls also leave it absent.
   * Conditional-spread per CLAUDE.md §1 "Ambiguous field shapes are
   * dishonest" — sentinel-empty would force the agent to disambiguate.
   */
  readonly disambiguationNote?: string;
  /**
   * Whether the suggest_fix scan parsed any JSX/HTML evidence of
   * Tailwind utility usage. Computed by the handler via
   * `hasTailwindSignal` over the parsed-file set.
   * When `false`, rule-emitted suggestions that append a Tailwind
   * escape-hatch sentence (`focus/outline-visible` is the current sole
   * emitter) read as context-blind advice on a vanilla CSS repo — the
   * prose builder strips that trailing sentence before composing the
   * explanation. Omitted (or `false`) leaves the strip active; `true`
   * keeps the hint intact for a Tailwind project. See CLAUDE.md §1
   * "Ambiguous field shapes are dishonest" + ai-first-consumer.md
   * "context-blind advice."
   */
  readonly tailwindDetected?: boolean;
  /**
   * Set when the target file is a build artifact (matches the
   * `classifyBuildArtifactDetailed` predicate set powering
   * `meta.scannedBuildArtifacts`) OR carries a recognized vendor-library
   * banner (`detectVendorLibraries`). The handler computes a
   * {@link VendorContext} and passes it here. The payload builder
   * restructures the response so the primary fix lane recommends
   * overriding the failing selector in the consumer's own stylesheet,
   * and the original in-vendor edit/guidance is demoted to an
   * alternative — editing vendor bytes in place is defeated by the
   * next dependency bump. Conditional-spread per CLAUDE.md §1 —
   * undefined leaves behavior identical to today.
   */
  readonly vendorContext?: VendorContext;
  /**
   * Inherited-finding hint for the `kind: "none"` branch. Set by the
   * handler when the requested `(filePath, line)` resolves to a
   * registered native-element wrapper call site — i.e. the JSX element
   * at the line is a wrapper name from
   * `LoadedConfig.nativeWrapperElements` / session wrappers. The
   * scan-family multi-file scan synthesized the inherited finding via
   * the post-pass in `src/engine/inherited-findings.ts`, but the
   * suggest_fix single-file rescan can't reproduce it (the wrapper
   * definition file isn't in scope). Threading the hint through closes
   * the dead-end shape so the agent learns the rule fires at the
   * wrapper definition and can route its next call accordingly. See
   * `src/mcp/suggest-fix-inherited-hint.ts` and the doctrine
   * "Cross-surface count invariant" applied to the per-finding lookup
   * channel. Conditional-spread per CLAUDE.md §1 "Ambiguous field
   * shapes are dishonest" — undefined / null is omitted.
   */
  readonly inheritedFromWrapper?: { readonly wrapperName: string };
  /**
   * Set when the target line carries a template directive
   * (Mustache/Handlebars `{{ … }}`, Liquid/Jinja `{% … %}`, ERB/EJS
   * `<% … %>`, JSP `<jsp:…>`, JS template literal `${ … }`) AND the
   * caller's ruleId is one of the literal-fill suggestions whose hard-
   * code recommendation would dishonestly paint over the binding
   * (`semantics/empty-heading` today — see
   * `TEMPLATE_DIRECTIVE_REROUTE_RULES` in
   * `suggest-fix-template-directive.ts`). Drives the
   * verify-binding-at-render-time `kind: "guidance"` reroute via
   * `buildTemplateDirectiveOutcome`; the rule's original suggestion is
   * demoted to `alternatives[0]`.
   *
   * Doctrine: `docs/kb/architecture/ai-first-consumer.md`
   * "Reason / priority / fix-description must agree across all three
   * channels" — when the template binding interpolates at render time,
   * the rule's `fix.description` ("fill with primary section title")
   * contradicts the static-evidence reality. The reroute surfaces the
   * actual question (binding can resolve to empty?) on the primary
   * lane. Conditional-spread per CLAUDE.md §1 — undefined leaves
   * behavior identical to today.
   *
   * Mutually exclusive with {@link markdownHeadingCollision} at the
   * caller level — when both fire, the template-directive lane wins
   * since template-directive presence is the more general signal.
   */
  readonly templateDirectiveContext?: TemplateDirectiveContext;
  /**
   * Set when the caller's ruleId is `parsing/duplicate-id` AND the
   * explicit id value on the target line collides with the slugified
   * text of a later ATX heading in the same source. Drives the
   * markdown-heading-collision `kind: "guidance"` reroute via
   * `buildMarkdownHeadingCollisionOutcome`; the rule's original
   * "rename to next-free suffix" suggestion is demoted to
   * `alternatives[0]`. Conditional-spread per CLAUDE.md §1.
   */
  readonly markdownHeadingCollision?: MarkdownHeadingIdCollision;
}
