/**
 * Helpers for the `name-via-title-fallback` info-severity path of
 * `navigation/link-descriptive-text`. See that rule's header for the
 * failure mode's normative grounding (ARIA 1.2 §4.3 "Accessible Name
 * and Description Computation" step 5+ of 5 — `title` is a last-resort
 * name source many SRs suppress). Factored out to keep the rule file
 * under the 500-effective-line file budget; the predicate and its
 * caller-side branching stay in the rule file because they are
 * intertwined with the icon-only / generic-phrase decision tree.
 *
 * Severity is `info`, not `warning` — per AI-first consumer doctrine,
 * "reason text and severity must agree". The reason concedes the
 * predicate may not hold (some SRs DO announce title; the agent's
 * target audience may not include NVDA-default-verbosity users); the
 * severity reflects "please verify" rather than "this is broken".
 *
 * `aria-label` / `aria-labelledby` outrank `title` upstream and silence
 * this path entirely — the legitimate `<a title="Open in new tab"
 * aria-label="Foo">` pattern stays clean (title is supplementary
 * tooltip content there, not the name). Predicate:
 * `getTitleNameFallback*` in `link-descriptive-text.ts`.
 */

import { truncateForEcho } from "../../engine/ast-helpers.ts";
import type { HtmlElement, JsxElement } from "../../types/ast.ts";

/** Local copy of the rule's emit signature — kept narrow so this helper
 * file does not pull the full `EmittedViolation` type with its transitive
 * re-exports. Mirrors the shape used by `link-duplicate-name.ts`. */
type FallbackEmit = (v: {
  severity: "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  variantKey: "name-via-title-fallback";
}) => void;

/** Reason text for the icon-only branch of the title-fallback path. */
function buildIconOnlyMessage(tagName: string, title: string): string {
  return (
    `<${tagName}> has no visible text and only \`title="${truncateForEcho(title)}"\` as a name ` +
    "source — per ARIA 1.2 §4.3 step 5+, `title` is a last-resort name fallback that NVDA " +
    "(default verbosity) and VoiceOver (in some modes) suppress. Verify your target screen " +
    "readers announce this title; if not, replace with `aria-label` or a visible " +
    '`<span class="sr-only">` child.'
  );
}

/** Reason text for the generic-phrase branch of the title-fallback path. */
function buildGenericMessage(tagName: string, title: string, generic: string): string {
  return (
    `<${tagName}> visible text "${generic}" is a generic phrase; the only descriptive name ` +
    `source is \`title="${truncateForEcho(title)}"\` — per ARIA 1.2 §4.3 step 5+, \`title\` is ` +
    "a last-resort fallback that NVDA (default verbosity) and VoiceOver (in some modes) " +
    "suppress, so users on those AT hear only the generic phrase. Verify your target screen " +
    "readers announce the title; if not, move the descriptive text into an `aria-label` or " +
    "into the visible link text."
  );
}

/** Concrete-fix suggestion text. `destinationHint` is supplied by the
 * caller so this file doesn't reach into the parser; the hint is
 * already truncated for echo by the caller. */
function buildSuggestion(title: string): string {
  const echoed = truncateForEcho(title);
  return (
    `Move the descriptive text from \`title\` to \`aria-label\` (e.g. aria-label="${echoed}"), ` +
    `or add a visually-hidden \`<span class="sr-only">${echoed}</span>\` child. ` +
    "`title` may stay as a hover tooltip if desired, but it should not be the link's " +
    "only programmatic name."
  );
}

export function emitTitleFallbackIconOnlyHtml(
  a: HtmlElement,
  title: string,
  emit: FallbackEmit,
): void {
  emit({
    severity: "info",
    location: { filePath: "", line: a.loc.start.line, column: a.loc.start.column },
    message: buildIconOnlyMessage("a", title),
    suggestion: buildSuggestion(title),
    variantKey: "name-via-title-fallback",
  });
}

export function emitTitleFallbackGenericHtml(
  a: HtmlElement,
  title: string,
  generic: string,
  emit: FallbackEmit,
): void {
  emit({
    severity: "info",
    location: { filePath: "", line: a.loc.start.line, column: a.loc.start.column },
    message: buildGenericMessage("a", title, generic),
    suggestion: buildSuggestion(title),
    variantKey: "name-via-title-fallback",
  });
}

export function emitTitleFallbackIconOnlyJsx(
  el: JsxElement,
  title: string,
  emit: FallbackEmit,
): void {
  emit({
    severity: "info",
    location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
    message: buildIconOnlyMessage(el.tagName, title),
    suggestion: buildSuggestion(title),
    variantKey: "name-via-title-fallback",
  });
}

export function emitTitleFallbackGenericJsx(
  el: JsxElement,
  title: string,
  generic: string,
  emit: FallbackEmit,
): void {
  emit({
    severity: "info",
    location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
    message: buildGenericMessage(el.tagName, title, generic),
    suggestion: buildSuggestion(title),
    variantKey: "name-via-title-fallback",
  });
}
