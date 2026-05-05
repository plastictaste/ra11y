/**
 * Unit tests for the cross-file repeated-candidate collapse helper.
 *
 * Closes V1-CHECKLIST-VENDOR-IFRAME-OCCURRENCES-COLLAPSE alongside the
 * integration test in `tests/integration/checklist-vendor-iframe-
 * occurrences-collapse.test.ts`. The integration test pins the
 * end-to-end shape on real corpus inputs; this file pins the helper's
 * predicate boundaries (threshold, distinct-paths gate, fingerprint
 * axes) on synthetic inputs that exercise each branch without a full
 * MCP round-trip.
 *
 * Doctrine references (docs/kb/architecture/ai-first-consumer.md):
 *   - "Composite headline counts are dishonest" extended to per-row
 *     volume — predicate-boundary tests guard against the threshold
 *     drifting and silently re-introducing the dishonest-quantity
 *     regression.
 *   - "Surface, don't suppress" — the threshold protects small
 *     cohorts (≤ 5) from collapse so the agent reads the full evidence
 *     when redundancy is low.
 *   - "Ambiguous field shapes are dishonest" — the helper omits
 *     `occurrences` / `samplePaths` on non-collapsed entries (never
 *     emits sentinel `0` / `[]`).
 */

import { describe, expect, it } from "bun:test";
import {
  collapseRepeatedAcrossFiles,
  MIN_OCCURRENCES_TO_COLLAPSE,
  SAMPLE_PATHS_CAP,
} from "../../../src/mcp/checklist-vendor-collapse.ts";

interface MinimalCandidate {
  readonly path: string;
  readonly line: number;
  readonly reason: string;
  readonly snippet?: string;
}

function makeRow(path: string, line = 4, reason = "iframe template", snippet?: string): MinimalCandidate {
  const base = { path, line, reason } as const;
  return snippet === undefined ? base : { ...base, snippet };
}

describe("collapseRepeatedAcrossFiles", () => {
  it("returns input verbatim on the empty list", () => {
    expect(collapseRepeatedAcrossFiles([])).toEqual([]);
  });

  it("does not collapse cohorts ≤ MIN_OCCURRENCES_TO_COLLAPSE distinct paths", () => {
    // Five distinct paths, all sharing the same fingerprint — the
    // helper requires the cohort to STRICTLY exceed the threshold, so
    // five stays expanded.
    expect(MIN_OCCURRENCES_TO_COLLAPSE).toBe(5);
    const rows = Array.from({ length: 5 }, (_, i) => makeRow(`/s${i}/v.js`));
    const out = collapseRepeatedAcrossFiles(rows);
    expect(out.length).toBe(5);
    for (const r of out) {
      expect(r.occurrences).toBeUndefined();
      expect(r.samplePaths).toBeUndefined();
    }
  });

  it("collapses cohorts strictly greater than the threshold", () => {
    // Six distinct paths, identical fingerprint — strictly above the
    // threshold; collapse fires.
    const rows = Array.from({ length: 6 }, (_, i) => makeRow(`/s${i}/v.js`));
    const out = collapseRepeatedAcrossFiles(rows);
    expect(out.length).toBe(1);
    expect(out[0]?.occurrences).toBe(6);
    expect((out[0]?.samplePaths ?? []).length).toBe(SAMPLE_PATHS_CAP);
    // First sample is the canonical path (encounter order).
    expect(out[0]?.samplePaths?.[0]).toBe(out[0]?.path);
  });

  it("caps samplePaths at SAMPLE_PATHS_CAP regardless of cohort size", () => {
    expect(SAMPLE_PATHS_CAP).toBe(5);
    const rows = Array.from({ length: 50 }, (_, i) => makeRow(`/s${String(i).padStart(2, "0")}/v.js`));
    const out = collapseRepeatedAcrossFiles(rows);
    expect(out.length).toBe(1);
    expect(out[0]?.occurrences).toBe(50);
    expect((out[0]?.samplePaths ?? []).length).toBe(SAMPLE_PATHS_CAP);
  });

  it("does not collapse when all rows are on the same path (one file emitting many)", () => {
    // Twenty rows, all on the same file — the cohort exceeds the
    // count threshold but fails the distinct-paths gate (≥ 2). This
    // is the per-file aggregation problem; not the helper's concern.
    const rows = Array.from({ length: 20 }, () => makeRow("/single/v.js"));
    const out = collapseRepeatedAcrossFiles(rows);
    expect(out.length).toBe(20);
    for (const r of out) {
      expect(r.occurrences).toBeUndefined();
      expect(r.samplePaths).toBeUndefined();
    }
  });

  it("partitions cohorts by reason — distinct reasons stay distinct rows", () => {
    // Six paths × 2 reasons. Each reason cohort is six paths and
    // qualifies; the output should carry two collapsed entries (one
    // per reason).
    const reasons = ["iframe template literal", "audio element template literal"];
    const rows: MinimalCandidate[] = [];
    for (let i = 0; i < 6; i += 1) {
      for (const reason of reasons) {
        rows.push(makeRow(`/s${i}/v.js`, 4, reason));
      }
    }
    const out = collapseRepeatedAcrossFiles(rows);
    expect(out.length).toBe(2);
    const seenReasons = new Set(out.map((r) => r.reason));
    expect(seenReasons.size).toBe(2);
    for (const r of out) {
      expect(r.occurrences).toBe(6);
    }
  });

  it("partitions cohorts by line — distinct lines stay distinct rows", () => {
    const rows: MinimalCandidate[] = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push(makeRow(`/s${i}/v.js`, 4));
      rows.push(makeRow(`/s${i}/v.js`, 12));
    }
    const out = collapseRepeatedAcrossFiles(rows);
    // One candidate per line per file is fine; two collapsed rows
    // (one per line) is expected because each line cohort has 6
    // distinct paths.
    expect(out.length).toBe(2);
    const lines = new Set(out.map((r) => r.line));
    expect(lines.has(4)).toBe(true);
    expect(lines.has(12)).toBe(true);
  });

  it("partitions cohorts by snippet when populated", () => {
    // Same line + reason but different snippets → distinct cohorts.
    const rows: MinimalCandidate[] = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push(makeRow(`/s${i}/v.js`, 4, "shared reason", "snippet A"));
      rows.push(makeRow(`/t${i}/v.js`, 4, "shared reason", "snippet B"));
    }
    const out = collapseRepeatedAcrossFiles(rows);
    expect(out.length).toBe(2);
    const snippets = new Set(out.map((r) => r.snippet));
    expect(snippets.has("snippet A")).toBe(true);
    expect(snippets.has("snippet B")).toBe(true);
  });

  it("preserves non-cohort rows alongside collapsed cohorts", () => {
    // A six-path cohort + a singleton non-collapse row that doesn't
    // share the fingerprint. Both must appear in the output (the
    // singleton uncollapsed, the cohort canonical-collapsed).
    const cohort = Array.from({ length: 6 }, (_, i) => makeRow(`/s${i}/v.js`, 4, "shared reason"));
    const singleton = makeRow("/lone/page.tsx", 17, "different reason");
    const out = collapseRepeatedAcrossFiles([...cohort, singleton]);
    expect(out.length).toBe(2);
    const collapsed = out.find((r) => r.occurrences !== undefined);
    expect(collapsed?.occurrences).toBe(6);
    const passthru = out.find((r) => r.occurrences === undefined);
    expect(passthru?.path).toBe("/lone/page.tsx");
    expect(passthru?.line).toBe(17);
  });

  it("dedupes paths in the distinct-paths gate (one file emitting twice does not satisfy ≥2 paths alone)", () => {
    // Six identical-fingerprint rows but on only ONE distinct path —
    // the count gate would fire but the distinct-paths gate must not.
    const rows = Array.from({ length: 6 }, () => makeRow("/sole/v.js"));
    const out = collapseRepeatedAcrossFiles(rows);
    expect(out.length).toBe(6);
    for (const r of out) {
      expect(r.occurrences).toBeUndefined();
    }
  });

  it("treats absent snippet equivalently to absent snippet (both fold into one cohort)", () => {
    // Six rows, none with a snippet — they should fold (the absent
    // sentinel is "" internally and pairs with itself).
    const rows = Array.from({ length: 6 }, (_, i) => makeRow(`/s${i}/v.js`));
    const out = collapseRepeatedAcrossFiles(rows);
    expect(out.length).toBe(1);
    expect(out[0]?.occurrences).toBe(6);
  });
});
