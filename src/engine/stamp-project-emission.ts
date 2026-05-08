/**
 * Project-rule emission stamp site.
 *
 * Extracted from `src/engine/scanner.ts` to keep that file under the
 * {@link import("../../scripts/check-limits.ts") limits} budget — the
 * orchestration logic and the stamp sequence have no shared state, so
 * splitting reads cleanly (outer runner sees only a named call; stamp
 * logic stays co-located with its `Ast` + `EmittedViolation` inputs).
 *
 * Mirrors the per-file stamp in `rule-runner.ts` — the two paths share
 * the contract that rules never compute `ruleId`, `criteria`,
 * `findingId`, `groupKey`, `fixClass`, or `patternId` themselves (the
 * engine owns all six).
 */

import type { Ast } from "../types/ast.ts";
import type { EmittedViolation, Rule } from "../types/rule.ts";
import type { Violation } from "../types/violation.ts";
import { maybeCssPatternId } from "../utils/css-pattern-id.ts";
import { computeFindingGroupId, computeFindingId } from "../utils/finding-id.ts";
import { computeGroupKey, UNKNOWN_SHAPE } from "../utils/group-key.ts";
import { maybePatternId } from "../utils/pattern-id.ts";
import { describeNodeShape, findTargetNodeAtLocation } from "./ast-helpers.ts";

/**
 * Builds the final {@link Violation} from a project-rule emission.
 */
export function stampProjectEmission(
  em: EmittedViolation,
  rule: Rule,
  criteria: readonly string[],
  criteriaTitles: readonly string[],
  sourcesByPath: ReadonlyMap<string, string>,
  astsByPath: ReadonlyMap<string, Ast>,
  scanRoot?: string,
): Violation {
  const findingId = computeFindingId({
    ruleId: rule.id,
    filePath: em.location.filePath,
    line: em.location.line,
    column: em.location.column,
    // Conditional spread per exactOptionalPropertyTypes; see rule-runner.ts.
    ...(em.variantKey ? { variantKey: em.variantKey } : {}),
    // Per-emission `findingId` cross-surface invariant — when the
    // caller supplied a scan root, plumb through to the finding-id
    // hash so a `scan_file` (relative path input) and `scan_project`
    // / `checklist` (absolute discovery walk) call produce the same
    // id on the same conceptual emission. Per
    // `docs/kb/architecture/ai-first-consumer.md` "Per-finding
    // identifiers must be addressable, not collision-prone."
    ...(scanRoot === undefined ? {} : { scanRoot }),
  });
  const findingGroupId = computeFindingGroupId({
    ruleId: rule.id,
    filePath: em.location.filePath,
    source: sourcesByPath.get(em.location.filePath) ?? "",
    line: em.location.line,
    ...(em.variantKey ? { variantKey: em.variantKey } : {}),
  });
  const groupKey = computeGroupKey({
    ruleId: rule.id,
    shape: shapeAtEmission(astsByPath, em.location.filePath, em.location.line, em.location.column),
  });
  const patternId = maybePatternId(rule.id, em.snippet);
  // CSS-declaration cross-file fingerprint — sibling of `patternId`
  // for rules whose dedup unit is a CSS selector + property + value
  // triple. See `src/utils/css-pattern-id.ts`.
  const cssPatternId = maybeCssPatternId(rule.id, em.cssFingerprint);
  return {
    ruleId: rule.id,
    fixClass: rule.fixClass,
    criteria,
    criteriaTitles,
    severity: em.severity,
    location: em.location,
    message: em.message,
    findingId,
    findingGroupId,
    groupKey,
    ...(patternId !== undefined && { patternId }),
    ...(cssPatternId !== undefined && { cssPatternId }),
    ...(em.suggestion !== undefined && { suggestion: em.suggestion }),
    ...(em.fix !== undefined && { fix: em.fix }),
    ...(em.fixPaths !== undefined && { fixPaths: em.fixPaths }),
    ...(em.snippet !== undefined && { snippet: em.snippet }),
    ...(em.couldBeWrongBecause?.length ? { couldBeWrongBecause: em.couldBeWrongBecause } : {}),
    // Per-finding scanner-confidence label, project-scope twin of the
    // per-file stamp in `rule-runner.ts`. Cross-file rules with
    // `crossFileCapable: true` whose evidence is bounded on a specific
    // input (one half of the pair scanned, the other not) emit
    // `confidence: "medium"` per docs/kb/architecture/ai-first-consumer.md
    // "Per-finding confidence must reflect per-rule coverage limitations."
    // Conditional spread keeps `confidence: undefined` off the wire per
    // CLAUDE.md §1 "Ambiguous field shapes are dishonest."
    ...(em.confidence !== undefined && { confidence: em.confidence }),
    ...(em.classEvidence ? { classEvidence: em.classEvidence } : {}),
    // Structured discriminating evidence — project-scope emit twin of
    // the per-file stamp in `rule-runner.ts`. No project-scope rule
    // currently populates `evidence`, but keeping the engine's two
    // stamp sites shape-symmetric means a future high-density project
    // rule (e.g. an aggregate landmark check) can opt in without
    // touching the engine. Conditional spread keeps `evidence:
    // undefined` off the wire per CLAUDE.md §1.
    ...(em.evidence !== undefined && { evidence: em.evidence }),
  };
}

/**
 * Resolves the shape string for a project-rule emission. Mirrors the
 * per-file helper in rule-runner.ts but looks up the file's AST from
 * the `astsByPath` map — a project-rule emission can come from any
 * file in the scan. UNKNOWN_SHAPE when the file wasn't in the map
 * (shouldn't happen) or the location doesn't land on any node
 * (synthetic emit with a placeholder location).
 */
function shapeAtEmission(
  astsByPath: ReadonlyMap<string, Ast>,
  filePath: string,
  line: number,
  column: number,
): string {
  const ast = astsByPath.get(filePath);
  const node = ast ? findTargetNodeAtLocation(ast.root, line, column) : null;
  return node ? describeNodeShape(node) : UNKNOWN_SHAPE;
}
