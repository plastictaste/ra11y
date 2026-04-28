/**
 * Reason-text enrichment helpers for the `review/timing` finder.
 *
 * Two narrow, non-suppressing classifiers used by `timing.ts` to
 * annotate `setTimeout` / `setInterval` candidates with dismissal
 * signals the agent would otherwise re-derive:
 *
 *   - {@link durationClassClause} — when the duration argument is
 *     not a numeric literal (member-access, identifier, call, or a
 *     computed expression), the clause names the *kind* of expression
 *     so the agent's dismissal path is "follow the binding" rather
 *     than "guess from the verbatim slice." Numeric literals get no
 *     clause — the value speaks for itself.
 *   - {@link vendorBundleClause} — when the cited file's basename
 *     matches a canonical vendor library bundle name (`bootstrap.js`,
 *     `jquery-1.10.2.js`, `popper.js`, etc.), the clause notes the
 *     match so the agent can choose to dismiss after one read of the
 *     file. Strictly additive: candidate stays at the same
 *     confidence, every WCAG criterion stays attached, no severity
 *     change. The dedicated content-level vendor-banner detector
 * is not yet shipped — once
 *     it lands as a project-wide primitive this filename probe should
 *     defer to it.
 *
 * Kept local to `src/review/` rather than promoted to a shared
 * primitive: the vendor-banner detector will eventually replace this
 * filename probe with a content-level signal, and surfacing the
 * placeholder in a wider import surface would invite drive-by reuse
 * before the real shape is settled. See ai-first-consumer.md on
 * "encode the duration/size/count in the reason text as additive
 * context" and "no heuristic suppression."
 *
 * Also exposes {@link buildVendorContext}, the structured-payload
 * companion to the reason-text clause: when the cited file matches
 * either the vendor-bundle-basename predicate above or the minified-
 * shape predicate in `timing-minified.ts`, the helper returns a
 * `ReviewCandidateVendorContext` carrying `redirectTo:
 * "consumer-override"`. The checklist surface uses the field to
 * downgrade item priority when every grounded candidate ships it,
 * matching the doctrine line "Reason / priority / fix-description
 * must agree across all three channels."
 */

import type { ReviewCandidateVendorContext } from "../../types/review.ts";
import { isMinifiedForEnrichment } from "./timing-minified.ts";

/**
 * Canonical vendor library bundle filenames that frequently appear in
 * scan trees as authored-shape (non-minified) drops — `bootstrap.js`,
 * `jquery-1.10.2.js`, `popper.js`. The minified-filename variants
 * (`bootstrap.min.js`, `jquery.min.js`) are already covered by
 * `timing-minified.ts`; this list catches the unminified dumps that
 * field reports surface.
 *
 * Longer alternatives (e.g. `jquery-ui`) come first so the alternation
 * picks the more specific name when both would match — without that
 * ordering, `jquery-ui.js` would capture as `jquery` with the rest
 * absorbed by the `(?:[-_.][^/]*)?` suffix.
 */
const VENDOR_BUNDLE_BASENAME_PATTERN =
  /^(jquery-ui|bootstrap|jquery|popper|tether|hammer|lodash|underscore|moment|prototype|mootools|dojo|ext|yui|slick|swiper|backbone|knockout)(?:[-_.][^/]*)?\.js$/i;

/**
 * Classification of a setTimeout/setInterval duration expression for
 * reason-text enrichment purposes.
 */
type DurationClass = "literal" | "member" | "call" | "identifier" | "expression";

/**
 * Numeric literal forms accepted as "self-evident" — the agent reads
 * the value directly. Covers integer, decimal, exponent, hex, binary,
 * octal, and BigInt with optional `_` separators. Deliberately excludes
 * `+1000` / `-1000` / parenthesised expressions so a unary form is
 * caught by the "expression" classifier, signalling that the agent
 * should examine the operands.
 */
const NUMERIC_LITERAL_PATTERN =
  /^(?:0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9_]+)?)n?$/;

/**
 * Member-access chain (with optional `?.`) rooted at `this` or an
 * ordinary identifier. Captures `self.options.interval`,
 * `this._config.delay`, `cfg?.timeout`. A trailing `()` would have
 * been classified as "call" first, so plain dotted identifiers fall
 * through to "member" here.
 */
const MEMBER_ACCESS_PATTERN = /^(?:this\b|[A-Za-z_$][\w$]*)(?:\??\.[A-Za-z_$][\w$]*)+$/;

/**
 * Call-expression pattern. Loose by design — we only need to
 * distinguish "this duration came from a function call" from the
 * other shapes; we don't validate the argument list.
 */
const CALL_EXPRESSION_PATTERN = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\s*\(.*\)$/;

/** Bare identifier shape (`delay`, `_TICK_MS`, `$timeout`). */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

/**
 * Classify the duration argument of a setTimeout/setInterval call.
 * The classification feeds an additive clause appended to the reason
 * text — confidence, severity, and visibility do NOT depend on the
 * result, per ai-first-consumer.md ("Numeric-threshold heuristics are
 * suppression"; "encode the duration … as additive context").
 */
function classifyDurationExpression(duration: string): DurationClass {
  const text = duration.trim();
  if (NUMERIC_LITERAL_PATTERN.test(text)) return "literal";
  if (MEMBER_ACCESS_PATTERN.test(text)) return "member";
  if (CALL_EXPRESSION_PATTERN.test(text)) return "call";
  if (IDENTIFIER_PATTERN.test(text)) return "identifier";
  return "expression";
}

/**
 * Reason-text suffix attached after the `` duration `…` `` echo when
 * the duration argument is not a numeric literal. Names the kind of
 * expression the agent needs to resolve so the dismissal path is
 * "open the file, follow the binding" rather than "guess from the
 * verbatim slice." Returns `""` for numeric literals so the caller
 * can concatenate unconditionally.
 */
export function durationClassClause(duration: string): string {
  switch (classifyDurationExpression(duration)) {
    case "literal":
      return "";
    case "member":
      return " (member-access reference — agent must resolve the binding chain to determine the actual value)";
    case "call":
      return " (call-expression reference — agent must resolve the function to determine the returned value)";
    case "identifier":
      return " (identifier reference — agent must resolve the binding in scope to determine the actual value)";
    case "expression":
      return " (computed expression — agent must evaluate the operands to determine the actual value)";
  }
}

/**
 * Reason-text suffix attached when the cited file's basename matches
 * a canonical vendor library bundle name
 * ({@link VENDOR_BUNDLE_BASENAME_PATTERN}). Returns `""` when the
 * file is not a recognised vendor bundle.
 *
 * Strictly additive — does not silence, downgrade, or bucket. Per
 * ai-first-consumer.md the candidate stays at the same confidence and
 * every WCAG criterion stays attached. The clause names the matched
 * library so the agent's dismissal — "this is third-party library
 * code, not the page author's timer" — is verifiable in one read.
 */
export function vendorBundleClause(filePath: string): string {
  const basename = vendorBasenameOf(filePath);
  const match = VENDOR_BUNDLE_BASENAME_PATTERN.exec(basename);
  if (!match) return "";
  const library = match[1]?.toLowerCase() ?? basename;
  return ` (file basename matches a canonical vendor library bundle name (\`${library}\`) — call site may be third-party library internals not under the page author's control)`;
}

/**
 * Boolean predicate companion to {@link vendorBundleClause}: returns
 * true when the cited file's basename matches a canonical vendor
 * library bundle name. Exposes the same signal as a structured field
 * so finders can populate `ReviewCandidate.vendorPathHint` for
 * agents that prefer to read the dismissal evidence as a typed
 * boolean instead of (or in addition to) parsing the reason text.
 *
 * Same predicate, same evidence — strictly additive on the response.
 * Per ai-first-consumer.md the field never gates suppression: the
 * candidate still surfaces at the same confidence with every WCAG
 * criterion attached. The agent decides whether to dismiss after
 * reading the file.
 */
export function isVendorBundleBasename(filePath: string): boolean {
  const basename = vendorBasenameOf(filePath);
  return VENDOR_BUNDLE_BASENAME_PATTERN.test(basename);
}

/**
 * Returns the basename portion of a file path, normalised to forward
 * slashes so Windows-style paths classify identically. Mirrors the
 * helper in `timing-minified.ts`; duplicated here so this module's
 * import surface stays self-contained — both files are consumers of
 * the timing finder, not producers of a wider primitive.
 */
function vendorBasenameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

/**
 * Build the structured vendor-context payload for a candidate when
 * the cited file matches one of the finder's vendor-path-shape
 * predicates. Returns `null` for ordinary authored-source paths so the
 * caller conditional-spreads the field away (present-when-meaningful).
 *
 * Preference order when both predicates fire (a vendored
 * `bootstrap.min.js` matches both): `vendor-bundle-basename` wins —
 * naming the library is more actionable than naming the underlying
 * minification predicate, mirroring `detectVendorContext` in
 * `src/mcp/suggest-fix-vendor-context.ts` so the same precedence holds
 * across surfaces. The two predicates are duplicated locally in
 * `timing-vendor.ts` and `timing-minified.ts` rather than imported
 * from `src/mcp/build-artifacts.ts` so the finder layer stays
 * decoupled from the MCP layer (`src/review/` is a content layer).
 *
 * Always pairs with `redirectTo: "consumer-override"` — the only
 * dismissal direction this signal supports. Future redirects (e.g.
 * `"upstream-bug-report"`) would extend the wire enum.
 */
export function buildVendorContext(
  filePath: string,
  source: string,
): ReviewCandidateVendorContext | null {
  if (isVendorBundleBasename(filePath)) {
    return {
      signal: { kind: "vendor-bundle-basename" },
      redirectTo: "consumer-override",
    };
  }
  if (isMinifiedForEnrichment(filePath, source)) {
    return {
      signal: { kind: "minified-shape" },
      redirectTo: "consumer-override",
    };
  }
  return null;
}
