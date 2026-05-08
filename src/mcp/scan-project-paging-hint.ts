/**
 * Paging-hint overlay for scan_project responses that ship
 * `truncated: true` alongside a resumable `nextOffset`. When the page
 * was clipped because the inventory exceeded the caller's `limit`, the
 * pre-existing `nextStep` prose names a per-finding triage call
 * (`suggest_fix` on the top finding) — which is honest for the page
 * the agent received but ignores the rest of the inventory still on
 * disk. An agent following the unmodified prose proceeds to single-
 * finding triage and never pages the rest, silently losing N-K files'
 * worth of findings (where N is `totalFilesWithFindings` and K is the
 * page count actually returned).
 *
 * The fix is additive: prepend a paging hint to the prose AND surface
 * the paging call as the primary structured next-step. The prior
 * triage call moves into `nextStepStructuredAlternatives[]` so an
 * agent that wants to triage the top finding before paging still sees
 * the structured shape next to the paging recommendation.
 *
 * Closure path for the doctrine bullet "One tool call should answer
 * 'what next?'" + "NextStep handoffs must terminate at a narrowing
 * tool" — paging IS the narrowing call when more inventory exists; the
 * triage call would echo the parameters that just produced a partial
 * response.
 *
 * Skipped on the slim envelope (`files: []`) — that path drops every
 * per-file entry, never sets `nextOffset`, and ships its own SLIM
 * nextStep prose pointing the agent at narrowing tools.
 */

import type { NextStepStructured } from "./next-step.ts";

/**
 * Inspects a fully-assembled scan_project response and, when it
 * carries the truncated-with-resumable-paging shape, returns a new
 * response with paging-augmented `nextStep` prose, paging-shaped
 * `nextStepStructured`, and `nextStepStructuredAlternatives` carrying
 * the prior triage call. When the gate fails, returns the input
 * response unchanged (identity-preserving on the common path).
 *
 * The gate fires only when ALL of:
 *   - `truncated === true` — the response shipped a partial inventory.
 *   - `nextOffset` is a finite non-negative number — paging is
 *     resumable. The slim envelope sets `truncated: true` without
 *     `nextOffset`; this gate filters it out so the slim path keeps
 *     its dedicated SLIM_NEXT_STEP_PROSE.
 *   - `files.length > 0` — the response shipped at least one entry.
 *     A `files: []` shape with `truncated: true` is the slim path's
 *     `filesArrayDropped: true` wire shape; the paging recommendation
 *     would point the agent at a `nextOffset` that still wouldn't fit
 *     under the host envelope on a re-call. Slim already routes to
 *     narrowing tools.
 *   - The original `nextStep` is a string. Defensive — every
 *     scan_project response stamps it, but a future refactor that
 *     removes the field shouldn't crash this overlay.
 *   - `pageClipReason !== "token_density"` — when the density-cap
 *     fired AND the per-rule narrowing reroute engaged, the standard
 *     `nextStep` already points the agent at `explain_rule` on the
 *     dominant rule precisely because the per-file paging loop would
 *     take ~`totalFilesWithFindings` round trips on bulk-template
 *     repros. Adding the paging hint here would override that reroute
 *     and re-recommend the very loop the reroute was designed to
 *     escape. The per-rule reroute is the more-narrow recommendation
 *     in that regime; defer to it.
 *
 * The paging structured call carries `cwd` from the caller's params
 * (so the agent doesn't have to re-discover the scan root) plus
 * `offset: nextOffset`. Other params (`limit`, `standard`, etc.) are
 * NOT echoed — the agent already passed them on the prior call and
 * the doctrine "Don't duplicate capability the agent already has"
 * argues against re-emitting kwargs the caller can copy from their
 * own call site. `cwd` is the exception because it's the load-
 * bearing scope anchor; without it, an agent that lost the prior
 * params context (e.g. a multi-turn handoff) would re-call with no
 * scope and land on whatever the host's default root is.
 */
export function applyPagingHintToNextStep(args: {
  readonly response: Record<string, unknown>;
  readonly params: Record<string, unknown>;
}): Record<string, unknown> {
  const { response, params } = args;
  if (response["truncated"] !== true) return response;
  const nextOffset = response["nextOffset"];
  if (typeof nextOffset !== "number" || !Number.isFinite(nextOffset) || nextOffset < 0) {
    return response;
  }
  const files = response["files"];
  if (!Array.isArray(files) || files.length === 0) return response;
  const baseProse = response["nextStep"];
  if (typeof baseProse !== "string") return response;
  // Defer to the per-rule narrowing reroute on the density-cap path.
  // When the response carries `pageClipReason: "token_density"`, the
  // standard nextStep was already overridden to recommend
  // `explain_rule` on the dominant rule — paging would re-recommend
  // the degenerate ~totalFilesWithFindings loop the reroute escapes.
  if (response["pageClipReason"] === "token_density") return response;
  // Defer to the small-demo-catalog `groupBy: "firstChildDir"`
  // override when it was already in place. The override proposes a
  // fundamentally different call shape (one whole-tree scan with
  // per-sub-project rollup) that returns the entire catalog in one
  // response without paging — strictly more narrowing than the
  // `offset: N` continuation. Demoting it into
  // `nextStepStructuredAlternatives[]` would route the agent at the
  // less-narrow paging call when the catalog-shape lever is the
  // canonical answer for this corpus shape.
  const priorForCatalogCheck = readNextStepStructured(response);
  if (
    priorForCatalogCheck?.tool === "scan_project" &&
    priorForCatalogCheck.args?.["groupBy"] === "firstChildDir"
  ) {
    return response;
  }
  const filesReturned = files.length;
  const totalFilesWithFindings = readTotalFilesWithFindings(response, filesReturned);
  const remaining = Math.max(0, totalFilesWithFindings - filesReturned);
  const remainingPlural = remaining === 1 ? "" : "s";
  // the paging hint prepends — preserves
  // the original triage prose so the agent can still see "and after
  // paging, here's the top finding to start with." Order: paging
  // first (the load-bearing recommendation), triage second.
  const pagingProse =
    `Response truncated — ${totalFilesWithFindings} files-with-findings, ${filesReturned} returned (${remaining} remaining file${remainingPlural}). ` +
    `Call \`scan_project\` with \`offset: ${nextOffset}\` to continue paging, OR triage the top returned finding first via: `;
  const augmentedProse = `${pagingProse}${baseProse}`;
  const pagingStructured = buildPagingStructured({ params, nextOffset });
  // Move the prior structured (if any) into alternatives so an agent
  // that wants the per-finding triage shape still sees the structured
  // form next to the paging primary. Conditional-spread keeps the
  // alternatives field present-when-meaningful — when there was no
  // prior structured, we don't ship an empty array.
  const priorStructured = readNextStepStructured(response);
  return {
    ...response,
    nextStep: augmentedProse,
    nextStepStructured: pagingStructured,
    ...(priorStructured === undefined ? {} : { nextStepStructuredAlternatives: [priorStructured] }),
  };
}

/**
 * Builds the paging-shaped `NextStepStructured`. Echoes `cwd` from the
 * caller's params when present so the agent's copy-paste re-call lands
 * on the same scope; omits when absent rather than fabricating a
 * guessed root (per CLAUDE.md §1 "Ambiguous field shapes are
 * dishonest").
 */
function buildPagingStructured(args: {
  readonly params: Record<string, unknown>;
  readonly nextOffset: number;
}): NextStepStructured {
  const { params, nextOffset } = args;
  const cwd = typeof params["cwd"] === "string" ? (params["cwd"] as string) : undefined;
  const pagingArgs: Record<string, unknown> = { offset: nextOffset };
  if (cwd !== undefined) {
    pagingArgs["cwd"] = cwd;
  }
  return { tool: "scan_project", args: pagingArgs };
}

/**
 * Reads `totalFilesWithFindings` off the response, falling back to
 * `filesReturned` when the field is absent or non-numeric. Defensive
 * narrowing — the field is stamped by every scan_project response on
 * the standard path, but a future refactor or test fixture that omits
 * it shouldn't break the overlay.
 */
function readTotalFilesWithFindings(
  response: Record<string, unknown>,
  filesReturned: number,
): number {
  const value = response["totalFilesWithFindings"];
  if (typeof value === "number" && Number.isFinite(value) && value >= filesReturned) {
    return value;
  }
  return filesReturned;
}

/**
 * Defensive narrowing for the existing `nextStepStructured` field on
 * the response. Returns `undefined` when the field is absent or shaped
 * unexpectedly so the fragment skips the alternatives slot rather than
 * shipping a malformed entry.
 */
function readNextStepStructured(response: Record<string, unknown>): NextStepStructured | undefined {
  const value = response["nextStepStructured"];
  if (value === undefined || value === null || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const tool = obj["tool"];
  const argsField = obj["args"];
  if (typeof tool !== "string") return undefined;
  if (argsField === undefined || argsField === null || typeof argsField !== "object") {
    return undefined;
  }
  return { tool, args: argsField as Record<string, unknown> };
}
