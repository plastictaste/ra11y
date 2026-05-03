/**
 * Per-finding `couldBeWrongBecause` propagation for findings emitted
 * inside MDX code-demo prop bodies.
 *
 * Sibling of {@link import("./per-finding-build-artifact-confidence.ts")}
 * and {@link import("./per-finding-confidence-parity.ts")} — same
 * write-through shape, different evidence axis. Where the build-
 * artifact pass keys on per-FILE classification (the file is generated
 * bytes), and the per-rule-limitations pass keys on per-RULE coverage
 * degradation, this pass keys on per-LOCATION evidence: a specific
 * `(filePath, line)` falls inside an MDX docs-component code-demo
 * prop's template-literal body the parser descended into.
 *
 * Doctrine source: docs/kb/architecture/ai-first-consumer.md
 *   "Per-finding confidence must reflect per-rule coverage limitations."
 *   — extended one axis over: per-finding `couldBeWrongBecause` must
 *   reflect per-LOCATION substrate when the response also surfaces
 *   the per-corpus warning code on a sibling field
 *   (`jsx_code_demo_prop_parsed_as_live_dom` is the corpus-level
 *   companion of this per-finding propagation). Without the
 *   propagation, the agent reads the corpus-level warning ("descents
 *   happened on this corpus") but cannot tell which findings fired
 *   inside one — silent disagreement between the warning channel and
 *   the per-finding channel.
 *
 * Predicate strength: deterministic. The MDX adapter has already
 * descended (synthesized JSX elements pinned to MDX-source positions);
 * the `(bodyStartLine, bodyEndLine)` range is a proven fact about
 * THIS scan, not a heuristic guess. Per AI-first doctrine "Surface,
 * don't suppress" the rule still emits at its full severity — the
 * markup IS structurally what the rule names; the propagation only
 * adds triage context so the agent recognizes rhetorical-preview
 * substrate at the per-finding granularity. No `confidence` downgrade
 * (the rule's evidence horizon is honest at the synthesized markup;
 * what's at issue is whether the user paid attention to the substrate,
 * not whether the rule's predicate observed full evidence).
 */

import { CODE_DEMO_PROP_REASON_CODE } from "../input/parsers/mdx-example-extractor.ts";
import type { AgentFinding } from "../output/agent-response/types.ts";
import type { FindingBucket } from "./per-finding-confidence-parity.ts";
import type { WarningInputs } from "./warnings.ts";

/**
 * Walks per-file findings and appends
 * {@link CODE_DEMO_PROP_REASON_CODE} to `couldBeWrongBecause` for any
 * finding whose `(filePath, line)` falls inside one of the recorded
 * code-demo prop body line ranges. Returns the input array reference
 * unchanged when the matches map is empty (no-op fast path) — the
 * common case on non-MDX repos pays no walk.
 *
 * Per CLAUDE.md §1 "Ambiguous field shapes are dishonest": when a
 * finding already carries the propagated code, the finding is returned
 * unchanged — the agent's `couldBeWrongBecause` array stays
 * dedup-stable across multiple enrichment passes.
 *
 * Returns a fresh top-level array when any finding was rewritten;
 * unchanged buckets ride the original reference. Same shape contract
 * as {@link import("./per-finding-build-artifact-confidence.ts").enrichFindingsWithBuildArtifactPath}
 * so the response-assembler seam can chain enrichment passes.
 */
export function enrichFindingsWithCodeDemoPropMatch<T extends FindingBucket>(
  fileEntries: readonly T[],
  matches: WarningInputs["codeDemoPropMatches"],
): readonly T[] {
  if (matches === undefined || matches.size === 0) return fileEntries;
  let mutatedAny = false;
  const out = fileEntries.map((file) => {
    const perFile = matches.get(file.path);
    if (perFile === undefined || perFile.length === 0) return file;
    let bucketMutated = false;
    const findings = file.findings.map((finding) => {
      if (!findingFallsInsideAnyMatch(finding.line, perFile)) return finding;
      const existing = finding.couldBeWrongBecause;
      if (existing?.includes(CODE_DEMO_PROP_REASON_CODE) === true) return finding;
      bucketMutated = true;
      const next: AgentFinding = {
        ...finding,
        couldBeWrongBecause:
          existing === undefined || existing.length === 0
            ? [CODE_DEMO_PROP_REASON_CODE]
            : [...existing, CODE_DEMO_PROP_REASON_CODE],
      };
      return next;
    });
    if (!bucketMutated) return file;
    mutatedAny = true;
    return { ...file, findings };
  });
  return mutatedAny ? out : fileEntries;
}

/**
 * True when `line` falls inside the inclusive `[bodyStartLine,
 * bodyEndLine]` range of any recorded match. Linear scan over the
 * per-file matches; `perFile.length` is bounded by the number of
 * `<Example|Demo|Playground>` elements in the file (typically <10 on
 * real-world docs), so the cost is acceptable per finding.
 */
function findingFallsInsideAnyMatch(
  line: number,
  perFile: readonly {
    readonly bodyStartLine: number;
    readonly bodyEndLine: number;
  }[],
): boolean {
  for (const match of perFile) {
    if (line >= match.bodyStartLine && line <= match.bodyEndLine) return true;
  }
  return false;
}
