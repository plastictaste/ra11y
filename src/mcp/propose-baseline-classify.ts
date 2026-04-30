/**
 * Classification helpers for `tool-propose-baseline.ts`. Split out so
 * the main tool module stays under the commit-size cap. The five
 * reason codes and their rationale wording are the agent-visible
 * surface; every shape change here is a wire-shape change.
 */

import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { Violation } from "../types/violation.ts";
import type { compileGlobs } from "../utils/glob.ts";

/**
 * Length of the truncated SHA-256 digest used to key the `rationales`
 * hoist map. Matches the format used elsewhere in the MCP surface
 * (`findingGroupId`, `referenceGuide.fixDescriptions[ruleId][hash]`)
 * so the short-hex token shape is consistent across the response.
 */
const RATIONALE_KEY_LENGTH = 12;

/**
 * The five reason codes the tool emits. Kept as a union literal rather
 * than an enum so the wire shape is plain strings agents can branch on
 * without importing a type.
 */
export type BaselineReason =
  | "wrapper-undetected"
  | "third-party-html"
  | "legacy-route"
  | "design-system-internal"
  | "unclassified";

/**
 * Path substrings that mark a file as third-party HTML/JS/CSS. Each
 * entry is a directory segment check — a file under `/node_modules/`
 * anywhere in its absolute path matches, independent of repo layout.
 */
const THIRD_PARTY_PATH_MARKERS: readonly string[] = ["/node_modules/", "/vendor/", "/.yarn/"];

/**
 * Suffixes that mark a file as a minified third-party asset. Minified
 * files are definitionally not hand-edited; grandfathering violations
 * there is safe.
 */
const THIRD_PARTY_MIN_SUFFIXES: readonly string[] = [".min.html", ".min.js", ".min.css"];

export interface ProposedEntry {
  readonly filePath: string;
  readonly ruleId: string;
  /**
   * Cross-run-stable baseline key (the line-drift-resilient
   * `Violation.findingGroupId`, NOT the per-emission `findingId`).
   * This is what `.ra11y-baseline.json` will store on `baseline mode:
   * "create"` and what subsequent runs will match against. Per AI-
   * first doctrine "Per-finding identifiers must be addressable, not
   * collision-prone," `findingId` is the per-emission address; the
   * baseline is a group-level decision keyed on `findingGroupId`.
   */
  readonly findingGroupId: string;
  readonly reason: BaselineReason;
  /**
   * Short stable key (12-hex SHA-256 truncation) into the top-level
   * `rationales` map. Replaces the inline `rationale` string — a scan of
   * 242 findings with every entry carrying the same 128-char unclassified
   * rationale was shipping 30+ KB of redundant prose on one line (V1-
   * PROPOSE-BASELINE-RATIONALE-DEDUP). Identical rationales across
   * entries now share one key; specific-evidence rationales (which embed
   * matched paths or wrapper names) collapse as well when two entries
   * happen to produce the same text.
   */
  readonly rationaleKey: string;
}

export interface ReasonCounts {
  readonly wrapperUndetected: number;
  readonly thirdPartyHtml: number;
  readonly legacyRoute: number;
  readonly designSystemInternal: number;
  readonly unclassified: number;
}

/**
 * Intermediate classification result before rationale-hoisting. The tool
 * handler converts these to {@link ProposedEntry} + a `rationales` map
 * via {@link hoistRationales} — see the header of this file for the
 * dedup motivation.
 */
interface RawProposedEntry {
  readonly filePath: string;
  readonly ruleId: string;
  readonly findingGroupId: string;
  readonly reason: BaselineReason;
  readonly rationale: string;
}

/**
 * Maps each violation to a raw proposed baseline entry with a reason
 * code + inline rationale. Precedence (first match wins):
 *
 *   1. `legacy-route`          — caller-declared glob
 *   2. `design-system-internal`— caller-declared glob
 *   3. `third-party-html`      — path substring / `.min.*` suffix
 *   4. `wrapper-undetected`    — assumed-wrapper name in message
 *   5. `unclassified`          — default
 *
 * User-declared classifications beat path heuristics; deterministic
 * path signals beat component-name heuristics. No finding is dropped
 * — every violation surfaces with a reason the agent uses to triage.
 *
 * The inline `rationale` on raw entries is hoisted into a top-level
 * `rationales` map by {@link hoistRationales} before the tool emits the
 * response.
 */
export function buildProposedEntries(args: {
  readonly violations: readonly Violation[];
  readonly root: string;
  readonly assumedWrappers: ReadonlySet<string>;
  readonly legacyMatcher: ReturnType<typeof compileGlobs>;
  readonly designMatcher: ReturnType<typeof compileGlobs>;
}): readonly RawProposedEntry[] {
  const { violations, root, assumedWrappers, legacyMatcher, designMatcher } = args;
  const out: RawProposedEntry[] = [];
  for (const v of violations) {
    const filePath = v.location.filePath;
    const relPath = toRelPath(filePath, root);
    const reason = classifyViolation({
      filePath,
      relPath,
      message: v.message,
      assumedWrappers,
      legacyMatcher,
      designMatcher,
    });
    out.push({
      filePath,
      ruleId: v.ruleId,
      findingGroupId: v.findingGroupId,
      reason: reason.code,
      rationale: reason.rationale,
    });
  }
  return out;
}

/**
 * Coalesces inline rationale strings into a response-level `rationales`
 * map keyed by short SHA-256 truncation. Entries drop the inline
 * `rationale` field in favour of a `rationaleKey` pointer.
 *
 * Why dedup: on a 242-finding scan, every entry shipped the same
 * 128-char `unclassified` rationale — identical prose inflated the
 * response past 70 KB on one line. Specific-evidence rationales
 * (`legacy-route`, `third-party-html`, `wrapper-undetected`) vary by
 * path or wrapper name but still collapse when two entries happen to
 * land on the same text (two findings under the same matched path,
 * multiple findings flagging the same wrapper).
 *
 * The shape mirrors `referenceGuide.fixDescriptions[ruleId][hash]` and
 * `findingGroupId`: 12-hex-char truncated SHA-256 keys, so agents
 * recognize the short-hex-token format across the MCP surface.
 *
 * Insertion order into `rationales` follows first-seen across entries —
 * stable across scans with the same inputs, so snapshots stay clean.
 *
 * Single-entry scans are deduped too: the map carries one key, the
 * entry carries one `rationaleKey`. Consistent shape per CLAUDE.md §14
 * ("same shape across findings") — agents don't have to branch on
 * "inline vs. hoisted" depending on size.
 */
export function hoistRationales(raw: readonly RawProposedEntry[]): {
  readonly entries: readonly ProposedEntry[];
  readonly rationales: Readonly<Record<string, string>>;
} {
  const rationales: Record<string, string> = {};
  const entries: ProposedEntry[] = [];
  for (const r of raw) {
    const key = rationaleKey(r.rationale);
    if (!(key in rationales)) {
      rationales[key] = r.rationale;
    }
    entries.push({
      filePath: r.filePath,
      ruleId: r.ruleId,
      findingGroupId: r.findingGroupId,
      reason: r.reason,
      rationaleKey: key,
    });
  }
  return { entries, rationales };
}

/**
 * Computes the truncated SHA-256 key for a rationale string. Exported
 * so tests can reconstruct the key from a known rationale without
 * reaching into internals.
 */
export function rationaleKey(rationale: string): string {
  return createHash("sha256").update(rationale).digest("hex").slice(0, RATIONALE_KEY_LENGTH);
}

interface Classification {
  readonly code: BaselineReason;
  readonly rationale: string;
}

/**
 * Returns the first matching reason code for a single violation, with
 * a one-line rationale explaining why the code was assigned. The
 * rationale is the agent's cue for whether to accept the category at
 * a glance — it names the specific evidence the scanner saw, not a
 * generic label.
 */
function classifyViolation(args: {
  readonly filePath: string;
  readonly relPath: string;
  readonly message: string;
  readonly assumedWrappers: ReadonlySet<string>;
  readonly legacyMatcher: ReturnType<typeof compileGlobs>;
  readonly designMatcher: ReturnType<typeof compileGlobs>;
}): Classification {
  const { filePath, relPath, message, assumedWrappers, legacyMatcher, designMatcher } = args;

  if (legacyMatcher.matches(relPath)) {
    return {
      code: "legacy-route",
      rationale: `Path \`${relPath}\` matches a caller-declared \`legacyRoutes\` glob.`,
    };
  }
  if (designMatcher.matches(relPath)) {
    return {
      code: "design-system-internal",
      rationale: `Path \`${relPath}\` matches a caller-declared \`designSystemPaths\` glob.`,
    };
  }
  const thirdPartyMarker = matchThirdPartyMarker(filePath);
  if (thirdPartyMarker !== null) {
    return {
      code: "third-party-html",
      rationale: `Path contains \`${thirdPartyMarker}\` — canonical third-party / minified asset location.`,
    };
  }
  const wrapperName = matchAssumedWrapperName(message, assumedWrappers);
  if (wrapperName !== null) {
    return {
      code: "wrapper-undetected",
      rationale: `Fires on \`<${wrapperName}>\` — PascalCase component the auto-detect probe considered but could not confirm as a native-element wrapper. Read the component source to decide whether to register in \`nativeWrappers\` or grandfather the finding.`,
    };
  }
  return {
    code: "unclassified",
    rationale:
      'No heuristic matched. Read the finding and decide whether to grandfather or fix before running `baseline` with mode: "create".',
  };
}

function matchThirdPartyMarker(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  for (const marker of THIRD_PARTY_PATH_MARKERS) {
    if (lower.includes(marker)) return marker;
  }
  for (const suffix of THIRD_PARTY_MIN_SUFFIXES) {
    if (lower.endsWith(suffix)) return `*${suffix}`;
  }
  return null;
}

function matchAssumedWrapperName(
  message: string,
  assumedWrappers: ReadonlySet<string>,
): string | null {
  if (assumedWrappers.size === 0) return null;
  const match = /^<([A-Z][A-Za-z0-9]*)(?=[\s>])/.exec(message);
  const name = match?.[1];
  if (name === undefined) return null;
  return assumedWrappers.has(name) ? name : null;
}

function toRelPath(filePath: string, root: string): string {
  const rel = relative(root, filePath);
  if (rel === "" || rel.startsWith("..")) return filePath;
  return rel.split("\\").join("/");
}

export function tallyReasons(
  entries: readonly { readonly reason: BaselineReason }[],
): ReasonCounts {
  let wrapperUndetected = 0;
  let thirdPartyHtml = 0;
  let legacyRoute = 0;
  let designSystemInternal = 0;
  let unclassified = 0;
  for (const e of entries) {
    switch (e.reason) {
      case "wrapper-undetected":
        wrapperUndetected += 1;
        break;
      case "third-party-html":
        thirdPartyHtml += 1;
        break;
      case "legacy-route":
        legacyRoute += 1;
        break;
      case "design-system-internal":
        designSystemInternal += 1;
        break;
      case "unclassified":
        unclassified += 1;
        break;
    }
  }
  return { wrapperUndetected, thirdPartyHtml, legacyRoute, designSystemInternal, unclassified };
}

export function buildProposedNextStep(total: number, counts: ReasonCounts): string {
  if (total === 0) {
    return "Scan is clean — no baseline needed. Re-run `propose_baseline` after the next regression to grandfather new findings.";
  }
  const parts: string[] = [];
  if (counts.wrapperUndetected > 0) parts.push(`${counts.wrapperUndetected} wrapper-undetected`);
  if (counts.thirdPartyHtml > 0) parts.push(`${counts.thirdPartyHtml} third-party-html`);
  if (counts.legacyRoute > 0) parts.push(`${counts.legacyRoute} legacy-route`);
  if (counts.designSystemInternal > 0) {
    parts.push(`${counts.designSystemInternal} design-system-internal`);
  }
  if (counts.unclassified > 0) parts.push(`${counts.unclassified} unclassified`);
  const breakdown = parts.join(", ");
  return `Proposed ${total} baseline ${total === 1 ? "entry" : "entries"}: ${breakdown}. Review by category, then call \`baseline\` with mode: "create" to persist. Read unclassified entries first — the heuristic reasons (wrapper-undetected, third-party-html) are safer to batch.`;
}
