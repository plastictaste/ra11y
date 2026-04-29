/**
 * Unit tests for scan_project's pagination — the response-size
 * guard that caps files-with-findings lists so large monorepo scans
 * don't overflow MCP token limits. The scan itself still runs over
 * everything; the cap bounds only the emitted `files` array.
 *
 * Exercises the internal pagination helpers via scan_project's public
 * MCP surface so the contract the agent sees (truncated + nextOffset
 * + totalFilesWithFindings) stays guarded against drift.
 *
 * `truncated` and
 * `totalFilesWithFindings` ALWAYS ride on every scan_project response —
 * the negative answer ("not truncated, this IS the full inventory") is
 * load-bearing. Conditional-spread is wrong for these two fields:
 * present-when-meaningful applies only when absence carries no signal,
 * but here the false/full-inventory case IS the signal. The other
 * pagination fields (`nextOffset`, `requestedLimit`, `effectiveLimit`,
 * `pageClipReason`) stay present-when-meaningful because pagination
 * may not have been active.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");

type JsonRpcResponse = Record<string, unknown>;

async function mcpSession(
  messages: readonly Record<string, unknown>[],
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });
  const payload = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
  proc.stdin.write(payload);
  proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  proc.kill();
  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as JsonRpcResponse);
}

function initMsg(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-agent", version: "1.0" },
    },
  };
}

function toolCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function bodyOf(response: JsonRpcResponse): Record<string, unknown> {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

/**
 * Builds a tempdir with N simple HTML files, each containing an
 * `<img>` without alt text so each file produces at least one
 * finding. Keeps per-file findings small so the file count drives
 * pagination.
 */
function buildFixture(fileCount: number): string {
  const root = mkdtempSync(join(tmpdir(), "ra11y-paginate-"));
  const src = join(root, "src");
  mkdirSync(src);
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(
      join(src, `page-${i}.html`),
      `<html><body><img src="/p${i}.png"></body></html>\n`,
    );
  }
  return root;
}

describe("scan_project pagination (overflow)", () => {
  it("emits truncated:false + totalFilesWithFindings when every files-with-findings entry fits under the cap", async () => {
    const root = buildFixture(3);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 200 }),
      ]);
      const body = bodyOf(responses[1]) as {
        files: unknown[];
        truncated?: unknown;
        nextOffset?: unknown;
        totalFilesWithFindings?: unknown;
      };
      // load-bearing negative —
      // `truncated: false` is the explicit "this IS the full inventory"
      // signal. Omitting it would force the agent to disambiguate
      // "not truncated" from "field never emitted on this scan
      // shape." `totalFilesWithFindings` rides alongside so the
      // caller can confirm `files.length === totalFilesWithFindings`
      // on the un-truncated path. Other pagination fields
      // (`nextOffset`, `requestedLimit`, `effectiveLimit`,
      // `pageClipReason`) stay absent because pagination wasn't
      // active.
      expect(body.files.length).toBe(3);
      expect(body.truncated).toBe(false);
      expect(body.totalFilesWithFindings).toBe(3);
      expect(body.nextOffset).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits truncated + nextOffset + totalFilesWithFindings when the cap truncates", async () => {
    const root = buildFixture(6);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 2 }),
      ]);
      const body = bodyOf(responses[1]) as {
        files: unknown[];
        truncated?: boolean;
        nextOffset?: number;
        totalFilesWithFindings?: number;
      };
      // Page 1: first 2 files, more available.
      expect(body.files.length).toBe(2);
      expect(body.truncated).toBe(true);
      expect(body.nextOffset).toBe(2);
      expect(body.totalFilesWithFindings).toBe(6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("paging with offset returns the remaining slice and drops truncated on the last page", async () => {
    const root = buildFixture(5);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 3, offset: 3 }),
      ]);
      const body = bodyOf(responses[1]) as {
        files: unknown[];
        truncated?: boolean;
        nextOffset?: number;
        totalFilesWithFindings?: number;
        requestedLimit?: number;
        effectiveLimit?: number;
        pageClipReason?: string;
      };
      // Page 2 of 2: the remaining 2 files (5 total - offset 3).
      // `truncated: false` rides
      // on the last page so the caller knows no more pages remain;
      // `nextOffset` stays absent because there's nothing to resume.
      // `totalFilesWithFindings` carries the full inventory size.
      // The last-page clip (`limit: 3` requested, 2 returned because
      // the tail ran out) surfaces as `pageClipReason: "end_of_results"`
      // + the limit/effective settlement so the caller can distinguish
      // "ran out of data" from the density-cap regime without a re-page.
      expect(body.files.length).toBe(2);
      expect(body.truncated).toBe(false);
      expect(body.nextOffset).toBeUndefined();
      expect(body.totalFilesWithFindings).toBe(5);
      expect(body.requestedLimit).toBe(3);
      expect(body.effectiveLimit).toBe(2);
      expect(body.pageClipReason).toBe("end_of_results");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries requestedLimit + effectiveLimit on every page where pagination is active, and no pageClipReason when the full limit returned", async () => {
    // Page 1 of a limit:2 / 6-file scan returns exactly 2 files — the
    // page is "full." `truncated: true` fires because more pages
    // remain, so pagination is active; `requestedLimit` and
    // `effectiveLimit` are both 2 (no clip at this layer), and the
    // honest shape omits `pageClipReason` because nothing clipped
    // below the requested size. Any future clip cause (density,
    // end_of_results, per_criterion_cap) must surface as a reason
    // code — emitting `effectiveLimit: 2` alongside `requestedLimit: 2`
    // without a reason is the invariant: the caller can tell from a
    // single read whether the page was clipped, and by what.
    const root = buildFixture(6);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 2 }),
      ]);
      const body = bodyOf(responses[1]) as {
        files: unknown[];
        truncated?: boolean;
        requestedLimit?: number;
        effectiveLimit?: number;
        pageClipReason?: string;
      };
      expect(body.files.length).toBe(2);
      expect(body.truncated).toBe(true);
      expect(body.requestedLimit).toBe(2);
      expect(body.effectiveLimit).toBe(2);
      expect(body.pageClipReason).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cross-surface invariant: every paginated response with files.length < requestedLimit carries exactly one pageClipReason", async () => {
    // Walk three scenarios that all trigger a clipped-page shape:
    // (a) last page with a short tail (end_of_results),
    // (b) last page on a single-page call with a smaller tail than
    //     the default limit — but only when pagination is active.
    // The invariant: whenever `requestedLimit` is present on the wire
    // and `effectiveLimit < requestedLimit`, `pageClipReason` MUST be
    // set to exactly one of the documented codes. Cross-surface drift
    // here (one page honest, one page silent) is the exact regime the
    // backlog's Q5 field report named.
    const root = buildFixture(5);
    try {
      const responses = await mcpSession([
        initMsg(1),
        // Last page: offset 3, limit 10 → 2 files, end_of_results.
        toolCall(2, "scan_project", { cwd: root, limit: 10, offset: 3 }),
        // Mid page: offset 0, limit 10 → 5 files, and the default-no-
        // pagination branch kicks in because offset === 0 && !hasMore.
        toolCall(3, "scan_project", { cwd: root, limit: 10, offset: 0 }),
      ]);
      const lastPage = bodyOf(responses[1]) as {
        files: unknown[];
        requestedLimit?: number;
        effectiveLimit?: number;
        pageClipReason?: string;
      };
      expect(lastPage.files.length).toBe(2);
      expect(lastPage.requestedLimit).toBe(10);
      expect(lastPage.effectiveLimit).toBe(2);
      expect(lastPage.pageClipReason).toBe("end_of_results");
      // Non-paginated single-page response (offset === 0, whole thing
      // fit): — `truncated: false`
      // and `totalFilesWithFindings` always ride; the rest of the
      // pagination fields stay omitted because pagination wasn't
      // active (no clip to disambiguate).
      const onePage = bodyOf(responses[2]) as {
        files: unknown[];
        requestedLimit?: number;
        effectiveLimit?: number;
        pageClipReason?: string;
        truncated?: unknown;
        totalFilesWithFindings?: unknown;
      };
      expect(onePage.files.length).toBe(5);
      expect(onePage.truncated).toBe(false);
      expect(onePage.totalFilesWithFindings).toBe(5);
      expect(onePage.requestedLimit).toBeUndefined();
      expect(onePage.effectiveLimit).toBeUndefined();
      expect(onePage.pageClipReason).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plan split counters report the full pre-truncation tally so page 1 doesn't mislead", async () => {
    const root = buildFixture(6);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 2 }),
      ]);
      type Lane = { source: number; buildArtifact: number };
      const body = bodyOf(responses[1]) as {
        plan: {
          notes: number;
          fixesByClass?: {
            mechanical: Lane;
            guidance: Lane;
            runtimeOnly: Lane;
            verifyInSource: Lane;
          };
        };
      };
      // Each fixture file has one <img> without alt; the alt-text
      // rule fires under multiple criteria (WCAG 2.2, 2.1, etc.), so
      // the total finding count is >= file count. What matters for
      // is that the plan reports the PRE-TRUNCATION tally —
      // limit:2 must not cut the per-lane counters down to the page-1
      // subset, otherwise the agent reads "found 2" when there's more
      // work. Per the flat
      // `plan.violations` headline is gone; sum the four
      // `fixesByClass` lanes (each a per-scan-kind pair) for the
      // error+warning total.
      const lanes = body.plan.fixesByClass;
      const laneSum = (l: Lane): number => l.source + l.buildArtifact;
      const errorWarning = lanes
        ? laneSum(lanes.mechanical) +
          laneSum(lanes.guidance) +
          laneSum(lanes.runtimeOnly) +
          laneSum(lanes.verifyInSource)
        : 0;
      const total = errorWarning + body.plan.notes;
      expect(total).toBeGreaterThanOrEqual(6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies the default files-with-findings cap (ADR 0021) when no limit is passed", async () => {
    // Build 30 files so the default of 25 triggers truncation on a
    // call with no explicit `limit`. The value guarded here is the
    // ADR-0021 calibration — changing the default without updating
    // this test (and the ADR) rewrites response-size contract for
    // every consumer that accepted the default.
    const root = buildFixture(30);
    try {
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const body = bodyOf(responses[1]) as {
        files: unknown[];
        truncated?: boolean;
        nextOffset?: number;
        totalFilesWithFindings?: number;
      };
      expect(body.files.length).toBe(25);
      expect(body.truncated).toBe(true);
      expect(body.nextOffset).toBe(25);
      expect(body.totalFilesWithFindings).toBe(30);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits truncated + totalFilesWithFindings on every shape (small / paginated-mid / paginated-last / capped)", async () => {
    // The four scan_project shapes a caller might encounter — every
    // one must carry both fields so an agent reading `truncated` can
    // distinguish "this IS the full inventory" (false) from "more
    // pages remain" (true) WITHOUT having to detect "is this the
    // small-scan shape that omits the fields entirely." The
    // load-bearing negative ("not truncated") is the signal here;
    // omitting it on the small-scan path is the dishonest shape that
    // forces silent disambiguation.
    const small = buildFixture(3);
    const six = buildFixture(6);
    const five = buildFixture(5);
    const huge = buildFixture(30);
    try {
      const responses = await mcpSession([
        initMsg(1),
        // (a) Small: whole result fits (offset 0, hasMore false).
        toolCall(2, "scan_project", { cwd: small, limit: 200 }),
        // (b) Paginated mid: more pages remain (truncated true).
        toolCall(3, "scan_project", { cwd: six, limit: 2 }),
        // (c) Paginated last: offset > 0, hasMore false.
        toolCall(4, "scan_project", { cwd: five, limit: 3, offset: 3 }),
        // (d) Default cap: ADR 0021 25-file default trims a 30-file scan.
        toolCall(5, "scan_project", { cwd: huge }),
      ]);
      type Shape = { files: unknown[]; truncated?: unknown; totalFilesWithFindings?: unknown };
      const a = bodyOf(responses[1]) as Shape;
      const b = bodyOf(responses[2]) as Shape;
      const c = bodyOf(responses[3]) as Shape;
      const d = bodyOf(responses[4]) as Shape;
      // Every shape carries both fields with the right kind. Type
      // checks here are belt-and-suspenders: a regression that
      // re-omitted on one path would fail `typeof === "boolean"`
      // and `typeof === "number"` rather than slipping past a
      // truthy/falsy assertion.
      for (const shape of [a, b, c, d]) {
        expect(typeof shape.truncated).toBe("boolean");
        expect(typeof shape.totalFilesWithFindings).toBe("number");
      }
      expect(a.truncated).toBe(false);
      expect(a.totalFilesWithFindings).toBe(3);
      expect(b.truncated).toBe(true);
      expect(b.totalFilesWithFindings).toBe(6);
      expect(c.truncated).toBe(false);
      expect(c.totalFilesWithFindings).toBe(5);
      expect(d.truncated).toBe(true);
      expect(d.totalFilesWithFindings).toBe(30);
    } finally {
      rmSync(small, { recursive: true, force: true });
      rmSync(six, { recursive: true, force: true });
      rmSync(five, { recursive: true, force: true });
      rmSync(huge, { recursive: true, force: true });
    }
  });
});
