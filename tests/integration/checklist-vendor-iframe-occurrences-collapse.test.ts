/**
 * Cross-file repeated-candidate collapse on the `checklist` surface.
 *
 * Closes V1-CHECKLIST-VENDOR-IFRAME-OCCURRENCES-COLLAPSE.
 *
 * Doctrine references (docs/kb/architecture/ai-first-consumer.md):
 *   - "Composite headline counts are dishonest" extended to per-row
 *     volume — N copies of one underlying line across N sibling vendor
 *     files must collapse to ONE row carrying the cohort total.
 *   - "Surface, don't suppress" — the row remains visible (no bucket-
 *     filter); only the redundant per-path duplicates fold away. The
 *     full count surfaces on `occurrences`, sample paths on
 *     `samplePaths`.
 *   - "Labeled buckets are suppression too" — the closure preserves the
 *     `likelyIrrelevant` bucket label honesty (deterministic "no
 *     `<video>`/`<audio>` parsed") while fixing the dishonest *quantity*
 *     the bucket carried pre-fix.
 *
 * Canonical regression: a website-templates corpus with 74 sub-sites
 * each shipping `fancybox.pack.js` produced 74 byte-identical candidate
 * rows per criterion under `likelyIrrelevant` — every row pointed at an
 * `<iframe id="fancybox-frame{rnd}"…>` template literal at the same
 * `(line, column)` of identical-content vendor files. The fixture below
 * mints 20 byte-identical copies of one vendor file (over the
 * `MIN_OCCURRENCES_TO_COLLAPSE = 5` threshold and well above the
 * `SAMPLE_PATHS_CAP = 5`) and asserts the response collapses them.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../src/mcp/tools.ts";

function findTool(name: string) {
  const tool = MCP_TOOLS.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

interface ChecklistCandidate {
  readonly path?: string;
  readonly line?: number;
  readonly reason?: string;
  readonly occurrences?: number;
  readonly samplePaths?: readonly string[];
}

interface ChecklistItem {
  readonly criteria?: readonly string[];
  readonly candidates?: readonly ChecklistCandidate[];
  readonly likelyRelevant?: false;
}

interface ChecklistEnvelope {
  readonly items?: readonly ChecklistItem[];
  readonly likelyIrrelevant?: readonly ChecklistItem[];
}

function parseEnvelope(text: string): ChecklistEnvelope {
  return JSON.parse(text) as ChecklistEnvelope;
}

/**
 * Templated page content that fans out across the bulk-corpus copies.
 * The same `<video>` / `<audio>` / `<form>` tokens land at the same
 * source line in each of N copies — the engine's media-review finders
 * (1.2.1 prerecorded audio-only / video-only, 1.2.3 audio description,
 * 1.2.4 captions live, 1.2.5 audio description, 2.4.6 headings/labels)
 * each emit one candidate per copy. Pre-fix the response shipped N
 * separate rows per criterion; post-fix the cohort folds to one row.
 *
 * Models the website-templates regression: many sub-sites copy the
 * same template page verbatim, so every per-criterion candidate fan
 * collapses into N copies of one line — the volume the closure
 * targets.
 */
const TEMPLATE_PAGE_CONTENT = [
  "<!doctype html>",
  "<html><head><title>Templated Page</title></head>",
  "<body><h1>Sample Page</h1>",
  '<video controls src="movie.mp4"></video>',
  '<audio controls src="track.mp3"></audio>',
  "<form><input type=\"text\" name=\"q\" /></form>",
  "</body></html>",
].join("\n");

describe("checklist tool: cross-file repeated-candidate collapse", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ra11y-vendor-iframe-collapse-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("collapses ≥20 byte-identical templated page copies into one candidate row carrying occurrences + samplePaths", async () => {
    // Mint 20 sibling sub-directories each carrying an identical copy
    // of the templated page. Per-criterion finders (1.2.1, 1.2.3,
    // 1.2.4, 1.2.5, 2.4.6) emit at the same source line in every
    // copy; pre-fix the response shipped 20 separate rows per
    // criterion.
    const COPIES = 20;
    for (let i = 0; i < COPIES; i += 1) {
      const sub = join(dir, `site-${String(i).padStart(2, "0")}`);
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "index.html"), TEMPLATE_PAGE_CONTENT);
    }
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0]?.text ?? "{}");

    // Walk every checklist row across `items` AND `likelyIrrelevant`
    // — the regression observed appeared on `likelyIrrelevant` rows
    // when the deterministic "no <video>/<audio> parsed" predicate
    // didn't fire, but the collapse must apply uniformly on any
    // surface that carries per-criterion candidate fans.
    const allItems: readonly ChecklistItem[] = [
      ...(data.items ?? []),
      ...(data.likelyIrrelevant ?? []),
    ];
    expect(allItems.length).toBeGreaterThan(0);

    // Find at least one candidate row that landed on the templated
    // page and carries the collapse signal.
    let foundCollapsed = false;
    for (const item of allItems) {
      for (const c of item.candidates ?? []) {
        if (c.path?.endsWith("index.html") && typeof c.occurrences === "number") {
          foundCollapsed = true;
          expect(c.occurrences).toBeGreaterThan(5);
          expect(c.occurrences).toBeLessThanOrEqual(COPIES);
          expect(c.samplePaths).toBeDefined();
          expect((c.samplePaths ?? []).length).toBeLessThanOrEqual(5);
          expect((c.samplePaths ?? []).length).toBeGreaterThanOrEqual(2);
          // Every sample path must point at a copy of the templated
          // page, and the canonical `path` must equal the FIRST
          // sample (encounter order = sort order).
          for (const p of c.samplePaths ?? []) {
            expect(p.endsWith("index.html")).toBe(true);
          }
          expect(c.samplePaths?.[0]).toBe(c.path);
        }
      }
    }
    expect(foundCollapsed).toBe(true);

    // Anti-volume invariant: per criterion, the candidate row count
    // for the templated page is now 1 (collapsed), NOT 20 (one per
    // copy). We assert this on every criterion that carries a
    // candidate — a single criterion shipping 20 rows would fail.
    for (const item of allItems) {
      // Group candidates on the templated page by `(line, reason)` so
      // a criterion that grounded on TWO genuinely different lines
      // (e.g. `<video>` at one line + `<audio>` at another) still
      // satisfies the invariant per cohort. Each cohort must collapse
      // to ONE row.
      const cohortKey = (c: ChecklistCandidate) => `${c.line}\x00${c.reason}`;
      const cohorts = new Map<string, number>();
      for (const c of item.candidates ?? []) {
        if (!c.path?.endsWith("index.html")) continue;
        cohorts.set(cohortKey(c), (cohorts.get(cohortKey(c)) ?? 0) + 1);
      }
      for (const count of cohorts.values()) {
        expect(count).toBe(1);
      }
    }
  });

  it("does NOT collapse cohorts of fewer than the threshold (preserves full evidence on small fan-outs)", async () => {
    // Three sibling copies of the templated page — below the
    // `MIN_OCCURRENCES_TO_COLLAPSE = 5` threshold. The agent should
    // see each row separately so the per-file evidence stays visible.
    const COPIES = 3;
    for (let i = 0; i < COPIES; i += 1) {
      const sub = join(dir, `site-${i}`);
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "index.html"), TEMPLATE_PAGE_CONTENT);
    }
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0]?.text ?? "{}");
    const allItems: readonly ChecklistItem[] = [
      ...(data.items ?? []),
      ...(data.likelyIrrelevant ?? []),
    ];
    // No candidate should carry the `occurrences` field — the small
    // cohort stays expanded.
    for (const item of allItems) {
      for (const c of item.candidates ?? []) {
        expect(c.occurrences).toBeUndefined();
        expect(c.samplePaths).toBeUndefined();
      }
    }
  });
});
