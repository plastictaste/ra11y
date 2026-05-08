/**
 * Unit tests for the cross-file same-reason candidate collapse helper.
 *
 * Sibling test file to `tests/unit/mcp/checklist-vendor-collapse.test.ts`
 * which pins the line-keyed pass — this file pins the line-AGNOSTIC
 * pass that catches templated reason fan-outs across distinct files
 * at varying lines (canonical case: 528 sub-site `index.html` files
 * all firing `wcag22:2.4.5` with byte-identical reason text but at
 * different lines per file).
 *
 * Doctrine references (docs/kb/architecture/ai-first-consumer.md):
 *   - "Composite headline counts are dishonest" extended to per-row
 *     volume — predicate-boundary tests guard against the threshold
 *     drifting and silently re-introducing the dishonest-quantity
 *     regression at the cross-line cohort surface.
 *   - "Surface, don't suppress" — the threshold protects small
 *     cohorts (≤ 20) from collapse so the agent reads the full
 *     evidence when redundancy is low.
 *   - "Labeled buckets are suppression too" — the predicate ("same
 *     reason fires on N>20 distinct files") is deterministic; the
 *     unit tests pin that the helper does not collapse on weaker
 *     evidence.
 *   - "Ambiguous field shapes are dishonest" — the helper omits
 *     `occurrences` / `samplePaths` on non-collapsed entries (never
 *     emits sentinel `0` / `[]`).
 */

import { describe, expect, it } from "bun:test";
import {
  collapseAcrossFilesByReason,
  MIN_OCCURRENCES_TO_COLLAPSE,
  SAMPLE_PATHS_CAP,
} from "../../../src/mcp/checklist-cross-file-reason-collapse.ts";

interface MinimalCandidate {
  readonly path: string;
  readonly line: number;
  readonly reason: string;
  readonly occurrences?: number;
  readonly samplePaths?: readonly string[];
}

function makeRow(
  path: string,
  line: number,
  reason = "Likely root layout has no search/sitemap/breadcrumb",
): MinimalCandidate {
  return { path, line, reason };
}

describe("collapseAcrossFilesByReason", () => {
  it("returns input verbatim on the empty list", () => {
    expect(collapseAcrossFilesByReason([])).toEqual([]);
  });

  it("does not collapse cohorts ≤ MIN_OCCURRENCES_TO_COLLAPSE distinct paths", () => {
    // 20 distinct paths, all sharing the same reason — the helper
    // requires the cohort to STRICTLY exceed the threshold, so 20
    // stays expanded. Each candidate uses a different line so the
    // line-keyed sibling pass would also miss; this isolates the
    // line-agnostic predicate.
    expect(MIN_OCCURRENCES_TO_COLLAPSE).toBe(20);
    const rows = Array.from({ length: 20 }, (_, i) => makeRow(`/site-${i}/index.html`, i + 1));
    const out = collapseAcrossFilesByReason(rows);
    expect(out.length).toBe(20);
    for (const r of out) {
      expect(r.occurrences).toBeUndefined();
      expect(r.samplePaths).toBeUndefined();
    }
  });

  it("collapses cohorts strictly greater than the threshold across varying lines", () => {
    // 21 distinct paths, identical reason, every candidate on a
    // DIFFERENT line — the canonical regression: 528 sub-sites with
    // their own layouts, same prose reason, different lines per file.
    const rows = Array.from({ length: 21 }, (_, i) => makeRow(`/site-${i}/index.html`, i + 1));
    const out = collapseAcrossFilesByReason(rows);
    expect(out.length).toBe(1);
    expect(out[0]?.occurrences).toBe(21);
    expect((out[0]?.samplePaths ?? []).length).toBe(SAMPLE_PATHS_CAP);
    expect(out[0]?.samplePaths?.[0]).toBe(out[0]?.path);
  });

  it("caps samplePaths at SAMPLE_PATHS_CAP regardless of cohort size", () => {
    expect(SAMPLE_PATHS_CAP).toBe(5);
    const rows = Array.from({ length: 528 }, (_, i) =>
      makeRow(`/site-${String(i).padStart(3, "0")}/index.html`, (i % 50) + 1),
    );
    const out = collapseAcrossFilesByReason(rows);
    expect(out.length).toBe(1);
    expect(out[0]?.occurrences).toBe(528);
    expect((out[0]?.samplePaths ?? []).length).toBe(SAMPLE_PATHS_CAP);
  });

  it("does not collapse when all rows are on the same path (one file emitting many)", () => {
    // 21 rows, all on one file at distinct lines — the count gate
    // would fire but the distinct-paths gate must not. This is the
    // per-file aggregation problem; not the helper's concern.
    const rows = Array.from({ length: 21 }, (_, i) => makeRow("/sole/page.html", i + 1));
    const out = collapseAcrossFilesByReason(rows);
    expect(out.length).toBe(21);
    for (const r of out) {
      expect(r.occurrences).toBeUndefined();
      expect(r.samplePaths).toBeUndefined();
    }
  });

  it("partitions cohorts by reason — distinct reasons stay distinct rows", () => {
    // 21 paths × 2 reasons = 42 candidates. Each reason cohort is 21
    // distinct paths and qualifies; the output should carry two
    // collapsed entries (one per reason) — order preserved via the
    // first-seen index.
    const reasons = [
      "Likely root layout has no search/sitemap/breadcrumb",
      "Possible heading hierarchy issue at root",
    ];
    const rows: MinimalCandidate[] = [];
    for (let i = 0; i < 21; i += 1) {
      for (const reason of reasons) {
        rows.push(makeRow(`/site-${i}/index.html`, i + 1, reason));
      }
    }
    const out = collapseAcrossFilesByReason(rows);
    expect(out.length).toBe(2);
    const seenReasons = new Set(out.map((r) => r.reason));
    expect(seenReasons.size).toBe(2);
    for (const r of out) {
      expect(r.occurrences).toBe(21);
    }
  });

  it("preserves non-cohort rows alongside collapsed cohorts", () => {
    // A 21-path same-reason cohort + a singleton row with a different
    // reason. Both must appear in the output (the singleton verbatim,
    // the cohort collapsed).
    const cohort = Array.from({ length: 21 }, (_, i) =>
      makeRow(`/site-${i}/index.html`, i + 1, "shared reason"),
    );
    const singleton = makeRow("/lone/page.tsx", 17, "different reason");
    const out = collapseAcrossFilesByReason([...cohort, singleton]);
    expect(out.length).toBe(2);
    const collapsed = out.find((r) => r.occurrences !== undefined);
    expect(collapsed?.occurrences).toBe(21);
    const passthru = out.find((r) => r.occurrences === undefined);
    expect(passthru?.path).toBe("/lone/page.tsx");
    expect(passthru?.reason).toBe("different reason");
  });

  it("dedupes paths in the distinct-paths gate (one file emitting twice does not satisfy ≥2 paths alone)", () => {
    // 21 identical-reason rows but on only ONE distinct path — the
    // count gate would fire but the distinct-paths gate must not.
    const rows = Array.from({ length: 21 }, (_, i) => makeRow("/sole/page.html", i + 1));
    const out = collapseAcrossFilesByReason(rows);
    expect(out.length).toBe(21);
    for (const r of out) {
      expect(r.occurrences).toBeUndefined();
    }
  });

  it("passes through pre-collapsed rows (occurrences already set) verbatim", () => {
    // Pre-collapsed input — the line-keyed sibling pass already
    // folded a 6-path cohort. The reason-keyed pass must not refold
    // (would lose the line precision the earlier pass earned).
    const preCollapsed: MinimalCandidate = {
      path: "/site-00/vendor.js",
      line: 4,
      reason: "vendor library iframe",
      occurrences: 6,
      samplePaths: ["/site-00/vendor.js", "/site-01/vendor.js"],
    };
    const out = collapseAcrossFilesByReason([preCollapsed]);
    expect(out.length).toBe(1);
    expect(out[0]?.occurrences).toBe(6);
    expect(out[0]?.samplePaths).toEqual(["/site-00/vendor.js", "/site-01/vendor.js"]);
  });

  it("does not refold cohorts that are entirely pre-collapsed even when reasons match", () => {
    // 21 pre-collapsed rows sharing one reason — they were already
    // each folded by the line-keyed pass. The reason-keyed pass
    // skips them all; output equals input.
    const rows = Array.from({ length: 21 }, (_, i) => ({
      path: `/site-${i}/vendor.js`,
      line: 4,
      reason: "vendor library iframe",
      occurrences: 6,
      samplePaths: [`/site-${i}/vendor.js`],
    }));
    const out = collapseAcrossFilesByReason(rows);
    expect(out.length).toBe(21);
    for (const r of out) {
      expect(r.occurrences).toBe(6);
    }
  });

  it("collapses cross-line cohorts even when one row carries the same line as another", () => {
    // Real corpora have line collisions — site-A's index.html and
    // site-B's both happen to put the breadcrumb at line 10. The
    // line-keyed pass would catch the (10, reason) duplicates if N>5
    // shared a line; this pass catches the broader cohort regardless.
    const rows: MinimalCandidate[] = [];
    for (let i = 0; i < 21; i += 1) {
      rows.push(makeRow(`/site-${i}/index.html`, (i % 3) + 1));
    }
    const out = collapseAcrossFilesByReason(rows);
    expect(out.length).toBe(1);
    expect(out[0]?.occurrences).toBe(21);
  });

  it("samplePaths are listed in encounter order with the canonical first", () => {
    const rows = Array.from({ length: 21 }, (_, i) =>
      makeRow(`/site-${String(i).padStart(2, "0")}/index.html`, i + 1),
    );
    const out = collapseAcrossFilesByReason(rows);
    expect(out.length).toBe(1);
    const samples = out[0]?.samplePaths ?? [];
    expect(samples.length).toBe(SAMPLE_PATHS_CAP);
    // Encounter order: first 5 distinct paths in input order.
    expect(samples[0]).toBe("/site-00/index.html");
    expect(samples[1]).toBe("/site-01/index.html");
    expect(samples[2]).toBe("/site-02/index.html");
    expect(samples[3]).toBe("/site-03/index.html");
    expect(samples[4]).toBe("/site-04/index.html");
  });

  it("input is not mutated", () => {
    const rows = Array.from({ length: 21 }, (_, i) => makeRow(`/site-${i}/index.html`, i + 1));
    const before = rows.map((r) => ({ ...r }));
    collapseAcrossFilesByReason(rows);
    for (let i = 0; i < rows.length; i += 1) {
      expect(rows[i]).toEqual(before[i] ?? rows[i]);
    }
  });
});
