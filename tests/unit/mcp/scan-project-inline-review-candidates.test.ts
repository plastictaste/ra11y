/**
 * Q-SHARED-SCAN-PROJECT-INLINE-REVIEW-CANDIDATES.
 *
 * When `scan_project` produces zero automated findings but grounded
 * manual-review candidates survive, the response must carry an inline
 * `reviewCandidates` array so the agent has a `file:line` pointer
 * without a separate `checklist` round trip. Doctrine: "One tool call
 * should answer 'what next?'".
 *
 * Fixture choice: a single `.html` file with an `<audio controls>`
 * element. `<audio>` without `autoplay` triggers no automated rules
 * (no contrast, no labels, no captions-missing — the captions rule
 * targets `<video>`) but the `review/media-alternatives` finder does
 * surface a `wcag22:1.2.1` candidate at the `<audio>` tag's line.
 * That leaves the scan with exactly the "zero findings, one grounded
 * manual candidate" shape the backlog item reproduces on jekyll
 * `test/source` and website-templates `plugins/`.
 *
 * Tests exercise three arms:
 *   1. Zero findings + grounded manual candidate → `reviewCandidates`
 *      is present with a `file:line` pointer.
 *   2. Zero findings + zero candidates → field is omitted entirely
 *      (present-when-meaningful).
 *   3. Automated findings exist → field is omitted (the agent has
 *      `file:line` pointers already and can choose to call `checklist`
 *      itself — don't duplicate capability the agent already has).
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { scanProjectTool } from "../../../src/mcp/tool-scan-project.ts";

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-inline-rc-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface ScanProjectResponse {
  readonly plan: {
    readonly violations: number;
    readonly notes: number;
    readonly actionableManualItems: number;
  };
  readonly files: ReadonlyArray<{ readonly path: string }>;
  readonly reviewCandidates?: ReadonlyArray<{
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly criteria: readonly string[];
    readonly reason: string;
    readonly confidence: string;
    readonly snippet?: string;
  }>;
}

async function callScanProject(
  params: Record<string, unknown>,
  session: McpSession,
): Promise<ScanProjectResponse> {
  const result = await scanProjectTool.handler(params, session);
  expect(result.isError).toBeUndefined();
  const text = result.content[0]?.text ?? "";
  return JSON.parse(text) as ScanProjectResponse;
}

describe("scan_project inlines reviewCandidates when no automated findings emit", () => {
  it("emits reviewCandidates with file:line when files[] is empty AND actionableManualItems > 0", async () => {
    await withScratch(async (dir) => {
      // <audio controls> produces a media-alternatives review candidate
      // (wcag22:1.2.1) but no automated violation. Doctype + <html lang>
      // + <title> pre-empt the usual html-lang/title rules so the scan
      // returns `files: []`.
      await writeFile(
        join(dir, "page.html"),
        [
          "<!doctype html>",
          '<html lang="en">',
          '  <head><meta charset="utf-8"><title>Test</title></head>',
          "  <body>",
          '    <audio src="talk.mp3" controls></audio>',
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      );
      const session = new McpSession();
      const res = await callScanProject({ cwd: dir }, session);
      expect(res.plan.violations).toBe(0);
      expect(res.files.length).toBe(0);
      expect(res.plan.actionableManualItems).toBeGreaterThan(0);

      // Invariant from the backlog: "When actionableManualItems > 0
      // AND files.length === 0, the field MUST be present."
      expect(res.reviewCandidates).toBeDefined();
      const candidates = res.reviewCandidates ?? [];
      expect(candidates.length).toBeGreaterThan(0);

      // Every candidate carries the shape the agent needs: absolute
      // file path, positive line number, sorted criteria array, reason
      // prose, confidence enum.
      for (const c of candidates) {
        expect(c.file.endsWith("page.html")).toBe(true);
        expect(typeof c.line).toBe("number");
        expect(c.line).toBeGreaterThan(0);
        expect(c.criteria.length).toBeGreaterThanOrEqual(1);
        expect(c.criteria).toEqual([...c.criteria].sort());
        expect(c.reason.length).toBeGreaterThan(0);
        expect(["high", "medium", "low"]).toContain(c.confidence);
      }

      // Cross-standard dedup proof: the media-alternatives finder emits
      // its six `criterionIds` at the <audio>'s (line, column, reason)
      // tuple. The surfaced entry folds them into one row with a
      // sorted `criteria` array containing wcag22:1.2.1 (along with
      // its 2.1/section508/en301549 equivalents if they all target
      // that tag).
      const audioCandidate = candidates.find((c) => c.criteria.includes("wcag22:1.2.1"));
      expect(audioCandidate).toBeDefined();
      if (!audioCandidate) return;
      // The finder declares three WCAG 2.2 criteria (1.2.1 + 1.2.3 +
      // 1.2.5) plus their WCAG 2.1 equivalents, keyed at the same
      // (file, line, column, reason) tuple — dedup collapses them
      // into a single entry with ≥ 2 criteria.
      expect(audioCandidate.criteria.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("omits reviewCandidates when no grounded candidates survive", async () => {
    await withScratch(async (dir) => {
      // Non-root HTML page (filename isn't `index.*` / `layout.*`) with
      // no media elements and enough navigation that the multiple-ways
      // finder doesn't fire. Zero automated findings AND zero grounded
      // review candidates. Field must be omitted entirely (present-
      // when-meaningful; never `[]` on the wire).
      await writeFile(
        join(dir, "about.html"),
        [
          "<!doctype html>",
          '<html lang="en">',
          '  <head><meta charset="utf-8"><title>About</title></head>',
          "  <body>",
          '    <a href="#main">Skip to main content</a>',
          "    <nav>",
          '      <a href="one.html">One</a>',
          '      <a href="two.html">Two</a>',
          '      <a href="three.html">Three</a>',
          "    </nav>",
          '    <main id="main"><p>No media here.</p></main>',
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      );
      const session = new McpSession();
      const res = await callScanProject({ cwd: dir }, session);
      expect(res.files.length).toBe(0);
      expect(res.reviewCandidates).toBeUndefined();
    });
  });

  it("omits reviewCandidates when automated-findings files exist", async () => {
    await withScratch(async (dir) => {
      // <audio controls> produces media-alternatives candidates AND
      // <img> without alt produces an automated violation. Because the
      // agent has `file:line` pointers from the findings, the inline
      // field is omitted — the agent can call `checklist` for the
      // manual half if it wants (doctrine: "Don't duplicate capability
      // the agent already has").
      await writeFile(
        join(dir, "mixed.html"),
        [
          "<!doctype html>",
          '<html lang="en">',
          '  <head><meta charset="utf-8"><title>Mixed</title></head>',
          "  <body>",
          '    <img src="/logo.png">',
          '    <audio src="talk.mp3" controls></audio>',
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      );
      const session = new McpSession();
      const res = await callScanProject({ cwd: dir }, session);
      expect(res.files.length).toBeGreaterThan(0);
      expect(res.plan.actionableManualItems).toBeGreaterThan(0);
      expect(res.reviewCandidates).toBeUndefined();
    });
  });

  it("caps inline reviewCandidates at the caller's limit", async () => {
    await withScratch(async (dir) => {
      // Three HTML files, each with one <audio> — produces three
      // deduped candidates. Call with `limit: 2` and verify the cap
      // holds (the scan's `limit` param bounds both `files` and the
      // inline `reviewCandidates` list).
      for (let i = 0; i < 3; i += 1) {
        await writeFile(
          join(dir, `page-${i}.html`),
          [
            "<!doctype html>",
            '<html lang="en">',
            `  <head><meta charset="utf-8"><title>Page ${i}</title></head>`,
            `  <body><audio src="t${i}.mp3" controls></audio></body>`,
            "</html>",
            "",
          ].join("\n"),
        );
      }
      const session = new McpSession();
      const res = await callScanProject({ cwd: dir, limit: 2 }, session);
      expect(res.files.length).toBe(0);
      expect(res.reviewCandidates).toBeDefined();
      const candidates = res.reviewCandidates ?? [];
      expect(candidates.length).toBeLessThanOrEqual(2);
      expect(candidates.length).toBeGreaterThan(0);
    });
  });
});
