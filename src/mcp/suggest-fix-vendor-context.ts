/**
 * Vendor-context detection for `suggest_fix`. When the target file is a
 * build artifact OR matches a vendor-library banner, the response is
 * restructured so the primary fix path becomes "override the failing
 * selector in your own stylesheet" — editing vendor bytes in place
 * defeats the purpose of vendoring (the next dependency bump nukes the
 * edit). The original in-vendor edit/guidance is demoted to an
 * alternative so the agent can still see what the rule would have
 * proposed against the source file.
 *
 * Doctrine bar (`docs/kb/architecture/ai-first-consumer.md` —
 * "Heuristic-mislabeled meta sub-fields are dishonest" + "Don't
 * duplicate capability the agent already has"): the `signal` field
 * names an evidence type the scanner actually has — either a
 * {@link BuildArtifactSignal} (path-based or content-based predicate
 * that already powers `meta.scannedBuildArtifacts`) or a vendor-library
 * banner match (the curated regex table powering
 * `meta.scannedBuildArtifacts.vendorLibraries`). No filename guessing,
 * no "looks vendored to me" pattern — only signals the agent can re-
 * derive from the file's bytes. The agent can dismiss a false-positive
 * vendor classification (a hand-authored `dist/` directory) by reading
 * the surfaced `evidence` and ignoring the `vendorContext`; the
 * original in-vendor edit is still in `alternatives[]` for that case.
 *
 * Pure function, no I/O. Composes the existing classifier helpers
 * rather than re-implementing predicates so the wire-side definition
 * of "vendor" stays in lockstep with `meta.scannedBuildArtifacts`.
 *
 * pairs with-
 * CSS (closed): Q6 stops the next-step *target* from pointing at a
 * vendor file when an authored same-rule sibling exists; this module
 * stops the suggested *fix* from rewriting vendor bytes when no such
 * sibling exists (the suggest_fix scan is single-file by design — there
 * is no "go fix the consumer instead" reroute available).
 */

import {
  type BuildArtifactClassification,
  type BuildArtifactSignal,
  classifyBuildArtifactDetailed,
  detectVendorLibraries,
} from "./build-artifacts.ts";

/**
 * Discriminated `signal` payload for {@link VendorContext}. Each
 * variant names an evidence type the scanner actually has — the doctrine
 * bar from `ai-first-consumer.md` "Heuristic-mislabeled meta sub-fields
 * are dishonest." Both variants are deterministic from the file's
 * (path, source) inputs alone:
 *
 *   - `kind: "build-artifact"` — the file matches one of the predicates
 *     in {@link classifyBuildArtifactDetailed} (`.min.` infix, hashed
 *     filename, bundler-output dir, data-URL CSS, Tailwind escape,
 *     long-line + corroborator). The full classification + signal pair
 *     is forwarded so the agent sees the same evidence as
 *     `meta.scannedBuildArtifacts`.
 *   - `kind: "vendor-library"` — the file's first non-blank line matches
 *     one of the curated banner regexes in
 *     `VENDOR_LIBRARY_BANNERS`. The library identifier (and version
 *     when the banner carried one) is forwarded so the agent reads the
 *     same evidence as `meta.scannedBuildArtifacts.vendorLibraries`.
 *
 * The two variants are NOT mutually exclusive in principle (a vendored
 * `bootstrap.min.css` matches both), but {@link detectVendorContext}
 * prefers the `vendor-library` variant when both fire — naming the
 * library is more actionable for the override-recommendation prose
 * than naming the underlying minification predicate.
 */
export type VendorContextSignal =
  | {
      readonly kind: "build-artifact";
      readonly classification: BuildArtifactClassification;
      readonly evidence: BuildArtifactSignal;
    }
  | {
      readonly kind: "vendor-library";
      readonly library: string;
      readonly version?: string;
    };

/**
 * Output of {@link detectVendorContext}. `redirectTo` is a stable
 * enum the agent reads to learn *what* the restructure was for — the
 * single value `"consumer-override"` names the override-the-failing-
 * selector-in-your-own-stylesheet recommendation that lives on the
 * primary fix lane when this context is present. Future redirects
 * (e.g. `"upstream-bug-report"` for known-buggy library versions)
 * would extend the enum.
 */
export interface VendorContext {
  readonly signal: VendorContextSignal;
  readonly redirectTo: "consumer-override";
}

/**
 * Returns a {@link VendorContext} when the (filePath, source) pair
 * matches either the build-artifact classifier or the vendor-library
 * banner table; `null` otherwise.
 *
 * Preference order when both fire: vendor-library wins. The library
 * name composes a more actionable override prose ("override the
 * failing selector by loading your own stylesheet AFTER `bootstrap`")
 * than the underlying build-artifact predicate ("override … in a CSS
 * file you load after this minified bundle"). The build-artifact
 * detail is still discoverable via `meta.scannedBuildArtifacts` on
 * `scan_project` calls — this module's job is to drive the per-call
 * override recommendation, not to enumerate every signal.
 *
 * Both detectors are pure over the (filePath, source) input — no fs,
 * no network. Cost is one regex pass over the source for the long-line
 * probe (only when cheaper signals miss) plus the curated banner table
 * regex test on the first non-blank line. Cheap enough to call on
 * every suggest_fix invocation without budget impact.
 */
export function detectVendorContext(filePath: string, source: string): VendorContext | null {
  // Vendor-library detection runs first because its label is more
  // actionable on the override prose (see preference comment in the
  // type doc above). `detectVendorLibraries` is the batch helper; we
  // pass a single-element array and read the first match.
  const vendorLibraries = detectVendorLibraries([{ filePath, source }]);
  const vendorLibrary = vendorLibraries[0];
  if (vendorLibrary !== undefined) {
    return {
      signal: {
        kind: "vendor-library",
        library: vendorLibrary.library,
        ...(vendorLibrary.version === undefined ? {} : { version: vendorLibrary.version }),
      },
      redirectTo: "consumer-override",
    };
  }
  const buildArtifact = classifyBuildArtifactDetailed(filePath, source);
  if (buildArtifact !== null) {
    return {
      signal: {
        kind: "build-artifact",
        classification: buildArtifact.classification,
        evidence: buildArtifact.signal,
      },
      redirectTo: "consumer-override",
    };
  }
  return null;
}

/**
 * Builds the human-readable override-prose primary explanation for a
 * `kind: "guidance"` suggest_fix response with a {@link VendorContext}
 * attached. The explanation names *what* to do (override the failing
 * selector in a stylesheet you control), *why* (editing the vendor
 * file in place is defeated by the next dependency bump), and *how*
 * (load order + selector specificity). Composed from the vendor file's
 * basename and the {@link VendorContext} signal so the prose reads as
 * file-specific even though no consumer-stylesheet path is known.
 *
 * The `failingSelector` argument carries the rule's own selector
 * evidence when available — populated from the violation's `snippet`
 * by the caller, which is the most reliable source the suggest_fix
 * surface has for "what selector to override." When the rule didn't
 * emit a snippet, the prose falls back to "the selector flagged
 * above" — still actionable because the agent has the violation's
 * `location.line` to read from the file.
 *
 * Pure function over its inputs — no fs, no formatting state.
 */
export function buildOverridePrimaryExplanation(
  filePath: string,
  vendorContext: VendorContext,
  failingSelector: string | undefined,
): string {
  const basename = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  const selectorPhrase =
    failingSelector !== undefined && failingSelector.length > 0
      ? `the failing selector (\`${failingSelector}\`)`
      : "the failing selector flagged above";
  const sourceLabel =
    vendorContext.signal.kind === "vendor-library"
      ? `the \`${vendorContext.signal.library}\` library bundle (\`${basename}\`)`
      : `a build artifact (\`${basename}\`)`;
  const orderingHint =
    vendorContext.signal.kind === "vendor-library"
      ? `Load your override stylesheet AFTER \`${vendorContext.signal.library}\` so the cascade order resolves to your declaration`
      : `Load your override stylesheet AFTER this artifact so the cascade order resolves to your declaration`;
  return [
    `Override ${selectorPhrase} in your own stylesheet rather than editing ${sourceLabel} in place.`,
    `Editing the artifact directly is defeated by the next build/dependency bump.`,
    `${orderingHint}; if the bundle's selector is already specific, match its specificity (or add an extra class on the same element) so your declaration wins on the cascade.`,
  ].join(" ");
}

/**
 * Short label for the `primary.approach` field on the override-recommendation
 * lane. Stable string the agent reads as the one-line summary of the
 * `primary.explanation` block.
 */
export const OVERRIDE_PRIMARY_APPROACH = "Override the failing selector in your own stylesheet";

/**
 * Short label for the alternative entry that demotes the original
 * in-vendor-file edit/guidance. Mirrors the
 * {@link OVERRIDE_PRIMARY_APPROACH} format so the two lanes read as
 * peers — consumer-override-first vs in-vendor-edit-fallback.
 */
export const IN_VENDOR_EDIT_ALTERNATIVE_APPROACH =
  "Edit the vendor file in place (only when you've forked the dependency)";
