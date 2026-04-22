/**
 * Template-directive poison defense for suggest_fix response shapes.
 *
 * Rules that harvest visible text can inadvertently carry raw
 * Liquid/Jinja/ERB directives through into a `fixPaths.primary.edit`
 * or `primary.editCandidate` `newText` — when that reaches the
 * agent, a mechanical apply would paste `aria-label="{% for … %}…"`
 * into a static attribute and ship a broken accessible name on
 * every render. Per docs/kb/architecture/ai-first-consumer.md
 * "Ambiguous field shapes are dishonest" a poisoned `newText` is
 * worse than an omitted `edit`.
 *
 * The defense lives here (separate from the response-builder file)
 * so `src/mcp/tool-suggest-fix-internals.ts` stays under the MCP-
 * handler 150-effective-line budget.
 *
 * Scope: `newText` only. `oldText` is intentionally NOT checked —
 * it must literal-match the source file, which for a Liquid
 * template legitimately contains directives; stripping them would
 * silently break the find-and-replace.
 */

import { stripTemplateDirectives } from "../input/parsers/html-template-directives.ts";
import type { FixPath } from "../types/violation.ts";

/**
 * Caveat string emitted on the response when an `edit` / `editCandidate`
 * was dropped for carrying template directives in `newText`. Phrased so
 * the agent learns *why* the proposal was withheld and can safely
 * compose its own edit from `sourceContext` instead of guessing.
 */
export const POISONED_NEWTEXT_CAVEAT =
  "primary.edit dropped: proposed newText contained Liquid/Jinja/ERB template directives ({% … %}, {{ … }}, or <% … %>) that would render literally if applied to a static attribute. Compose the edit from sourceContext, preserving the surrounding template syntax.";

/**
 * True when `text` carries a Liquid/Jinja interpolation, Liquid/Jinja
 * tag, or ERB span — any of which is dishonest to interpolate into a
 * `newText` field that an agent might paste verbatim into the source
 * file. Detection delegates to `stripTemplateDirectives` so the check
 * stays in lockstep with the parser-side strip semantics.
 *
 * Returns true when stripping the input changes its content (i.e. at
 * least one directive span was removed). Empty input is not poisoned —
 * that's a different field-shape problem and would have been caught by
 * the upstream rule.
 */
export function newTextIsPoisonedByTemplateDirectives(newText: string): boolean {
  return stripTemplateDirectives(newText).stripped;
}

/**
 * Result of sanitizing one `FixPath` against template-directive poison.
 * Flags let the caller decide whether to downgrade `kind` and emit a
 * caveat; `path` is the rebuilt `FixPath` with poisoned fields omitted.
 */
export interface SanitizedFixPath {
  readonly path: FixPath;
  readonly editDropped: boolean;
  readonly candidateDropped: boolean;
}

/**
 * Sanitize a `FixPath`'s structured edit fields against template-
 * directive poisoning of `newText`. Returns the path unchanged when no
 * poison is present; returns a path with `edit` / `editCandidate`
 * dropped when poison is detected.
 *
 * Why both fields are checked:
 *   - `edit` populates `kind: "edit"` and is what `apply_fix` and Edit
 *     will actually run. Poison here is the canonical mistake.
 *   - `editCandidate` is the softer "starting point" sibling — agents
 *     still crib from it when composing their own edit, so emitting a
 *     poisoned candidate carries the same downstream risk.
 */
export function sanitizeFixPathAgainstPoison(path: FixPath): SanitizedFixPath {
  const editPoisoned =
    path.edit !== undefined && newTextIsPoisonedByTemplateDirectives(path.edit.newText);
  const candidatePoisoned =
    path.editCandidate !== undefined &&
    newTextIsPoisonedByTemplateDirectives(path.editCandidate.newText);
  if (!(editPoisoned || candidatePoisoned)) {
    return { path, editDropped: false, candidateDropped: false };
  }
  // Rebuild the path without the poisoned fields. `label` and any
  // other future-proof keys flow through verbatim.
  const { edit: _edit, editCandidate: _editCandidate, ...rest } = path;
  const cleaned: FixPath = {
    ...rest,
    ...(editPoisoned || path.edit === undefined ? {} : { edit: path.edit }),
    ...(candidatePoisoned || path.editCandidate === undefined
      ? {}
      : { editCandidate: path.editCandidate }),
  };
  return { path: cleaned, editDropped: editPoisoned, candidateDropped: candidatePoisoned };
}
