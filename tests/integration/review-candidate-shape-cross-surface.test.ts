/**
 * Pins the AI-first doctrine bullet
 * "Per-tool review-candidate shape must agree across surfaces"
 * (`docs/kb/architecture/ai-first-consumer.md`).
 *
 * The contract every project- / file-rooted MCP surface that ships
 * review candidates must satisfy on a single response set:
 *
 *   For each conceptual candidate that surfaces under the same
 *   `findingId` on multiple tools:
 *     (a) `findingId` is byte-equal across all surfaces (per the
 *         shared `computeCandidateFindingId` hash function);
 *     (b) field-presence parity for `priority` and `confidence` —
 *         a candidate that ships `priority: "high"` on one surface
 *         must not ship the same field as `null` / absent on a
 *         sibling surface for the same conceptual candidate;
 *     (c) value parity for `confidence` — the finder's evidence
 *         strength is a per-emission attribute, so the value on
 *         every surface that surfaces the candidate must agree.
 *
 *   The doctrine framing: a candidate identifier (`findingId`) must
 *   be a stable address an agent can use across `scan_file`,
 *   `checklist`, and `coverage` without re-deriving from
 *   `(path, line, reason)`; the per-candidate shape (priority,
 *   confidence) must agree on all three so the agent reading any
 *   one surface gets the same attention-budget signal as it would
 *   reading any other.
 *
 * Pre-closure regressions this pin guards:
 *   - `scan_file.reviewCandidates[]` shipped `priority: null` /
 *     `confidence: null` while `checklist.items[].candidates[]`
 *     populated both — the `DedupedReviewCandidate` shape lacked
 *     the resolved attention-budget signal entirely.
 *   - `coverage.manualWithCandidates[]` stripped `candidates: []`
 *     entirely — the per-candidate evidence the scan already had
 *     in hand was discarded, forcing a `checklist` round trip.
 *   - Candidate `findingId`s drifted across surfaces (one surface
 *     hashing absolute paths, another hashing `cwd`-relative).
 *
 * The fixture: a `<video>` element grounds candidate finders for
 * the prerecorded-media criteria pile (1.2.1, 1.2.2, 1.2.3, 1.2.4,
 * 1.2.5, 1.2.6, 1.2.7, 1.2.8) — well above the ≥3 manual-review
 * criteria threshold the dispatch prompt names. The page also
 * embeds a `<form>` with a `<input type="password">` so the
 * `review/password-inputs` finder grounds a sibling 3.3.8 candidate
 * the cross-surface assertion can pivot through if the media pile
 * collapses.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: { readonly content?: readonly { readonly text: string }[] };
}

async function mcpSession(
  messages: readonly Record<string, unknown>[],
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });
  proc.stdin.write(`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`);
  proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
}

const initMsg = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
});

const toolCall = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

function bodyOf<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

/**
 * `scan_file.reviewCandidates[]` per-entry shape — the
 * `DedupedReviewCandidate` projection. The `priority` and
 * `confidence` fields are required (per the dedup module's TSDoc:
 * "Required — agents budget against this signal and a missing or
 * `null` value is the dishonest shape").
 */
interface ScanFileCandidate {
  readonly findingId: string;
  readonly criteria: readonly string[];
  readonly line: number;
  readonly column: number;
  readonly priority?: string | null;
  readonly confidence?: string | null;
}

interface ScanFileBody {
  readonly reviewCandidates?: readonly ScanFileCandidate[];
}

/**
 * `checklist.items[].candidates[]` per-entry shape — the
 * `ChecklistCandidateOut` projection. `priority` is inherited
 * from the parent item per the closure of the earlier shape pin
 * (`tests/integration/mcp-consistency/scan-file-checklist-candidate-shape.test.ts`).
 */
interface ChecklistCandidate {
  readonly findingId: string;
  readonly path: string;
  readonly line: number;
  readonly priority?: string | null;
  readonly confidence?: string | null;
  readonly criteria?: readonly string[];
}

interface ChecklistItem {
  readonly criteria: readonly string[];
  readonly priority: string;
  readonly confidence: string;
  readonly candidates: readonly ChecklistCandidate[];
}

interface ChecklistBody {
  readonly items: readonly ChecklistItem[];
}

/**
 * `coverage.manualWithCandidates[].candidates[]` per-entry shape —
 * the `ScanProjectReviewCandidate` projection. Surfaced under each
 * coverage entry so an agent walking `coverage` does not have to
 * round-trip to `checklist` to recover the per-criterion file:line
 * evidence.
 */
interface CoverageCandidate {
  readonly findingId: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly criteria: readonly string[];
  readonly priority?: string | null;
  readonly confidence?: string | null;
}

interface CoverageManualEntry {
  readonly criterionId: string;
  readonly candidates: readonly CoverageCandidate[];
}

interface CoverageEntry {
  readonly standardId: string;
  readonly manualWithCandidates?: readonly CoverageManualEntry[];
}

interface CoverageBody {
  readonly entries?: readonly CoverageEntry[];
  // Single-standard scans flatten (no `entries[]` wrapper).
  readonly standardId?: string;
  readonly manualWithCandidates?: readonly CoverageManualEntry[];
}

/**
 * Sanitized fixture exercising both the prerecorded-media criteria
 * pile (1.2.x family from a `<video>` element) and the password-input
 * finder (3.3.8 from `review/password-inputs`). The two finders fire
 * at distinct byte positions inside one document so the cross-surface
 * assertions have ≥3 conceptual candidates the surfaces can each
 * surface independently.
 */
async function makeMultiCandidateFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-review-candidate-shape-"));
  const page = join(dir, "watch-and-login.html");
  await writeFile(
    page,
    `<!doctype html>
<html lang="en">
<head><title>Watch and login</title></head>
<body>
<main>
<h1>Latest stream</h1>
<video src="latest.mp4" controls></video>
<form>
<label for="u">Username</label>
<input type="text" id="u" name="user">
<label for="p">Password</label>
<input type="password" id="p" name="pw">
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>
`,
  );
  return { dir, page };
}

/**
 * Indexes coverage's `manualWithCandidates[]` entries by
 * `findingId` per criterion. Coverage surfaces flatten — a
 * single-standard scan ships entries at the top level; a
 * multi-standard scan wraps under `entries[].`. This helper
 * normalizes both shapes.
 */
function coverageCandidatesByFindingId(
  coverage: CoverageBody,
): ReadonlyMap<string, CoverageCandidate> {
  const out = new Map<string, CoverageCandidate>();
  const top = coverage.manualWithCandidates ?? [];
  const wrapped = (coverage.entries ?? []).flatMap((e) => e.manualWithCandidates ?? []);
  for (const entry of [...top, ...wrapped]) {
    for (const c of entry.candidates) out.set(c.findingId, c);
  }
  return out;
}

/**
 * Indexes checklist candidates by `findingId` across all items —
 * a candidate that satisfies multiple criteria appears under each
 * owning item, but every per-item instance carries the same id by
 * construction (per `annotateSharedCandidates`).
 */
function checklistCandidatesByFindingId(
  checklist: ChecklistBody,
): ReadonlyMap<string, { candidate: ChecklistCandidate; itemPriority: string }> {
  const out = new Map<string, { candidate: ChecklistCandidate; itemPriority: string }>();
  for (const item of checklist.items) {
    for (const c of item.candidates) {
      // First-seen wins — same id repeats across sibling items by
      // construction; the candidate body is byte-equal across the
      // duplicates.
      if (!out.has(c.findingId)) out.set(c.findingId, { candidate: c, itemPriority: item.priority });
    }
  }
  return out;
}

describe("review candidate shape cross-surface — scan_file, checklist, coverage agree on findingId + priority/confidence presence", () => {
  it("the fixture grounds at least three distinct manual-review candidates across the three surfaces", async () => {
    const { dir, page } = await makeMultiCandidateFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: page }),
      toolCall(3, "checklist", { cwd: dir }),
      toolCall(4, "coverage", { cwd: dir }),
    ]);
    const scanFile = bodyOf<ScanFileBody>(responses[1]);
    const checklist = bodyOf<ChecklistBody>(responses[2]);
    const coverage = bodyOf<CoverageBody>(responses[3]);

    // Sanity floor — the dispatch prompt requires ≥3 manual-review
    // criteria firing for the cross-surface invariant to be a
    // non-vacuous pin. The video + password-input fixture exceeds
    // this; if the floor breaks, the fixture has rotted.
    const scanCandidates = scanFile.reviewCandidates ?? [];
    expect(scanCandidates.length).toBeGreaterThanOrEqual(3);
    expect(checklist.items.length).toBeGreaterThanOrEqual(3);
    const coverageById = coverageCandidatesByFindingId(coverage);
    expect(coverageById.size).toBeGreaterThanOrEqual(3);
  });

  it("findingId is byte-equal across scan_file.reviewCandidates[], checklist.items[].candidates[], and coverage.manualWithCandidates[].candidates[] for every conceptual candidate that surfaces on all three", async () => {
    const { dir, page } = await makeMultiCandidateFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: page }),
      toolCall(3, "checklist", { cwd: dir }),
      toolCall(4, "coverage", { cwd: dir }),
    ]);
    const scanFile = bodyOf<ScanFileBody>(responses[1]);
    const checklist = bodyOf<ChecklistBody>(responses[2]);
    const coverage = bodyOf<CoverageBody>(responses[3]);

    const checklistById = checklistCandidatesByFindingId(checklist);
    const coverageById = coverageCandidatesByFindingId(coverage);

    // For every candidate scan_file surfaces, the same id MUST appear
    // on at least one sibling surface — the doctrine bullet "Per-tool
    // review-candidate shape must agree across surfaces" makes the
    // identifier the cross-surface address, so a scan_file id absent
    // from both sibling surfaces would be the silent-miss the pin
    // guards against. ≥1 sibling surface is the floor (some
    // candidates filter to specific surfaces — e.g. discovery-only
    // codes — but a candidate the scanner emits on ANY project-rooted
    // surface must also reach the file-rooted surface that owns the
    // file).
    let crossSurfaceMatches = 0;
    for (const c of scanFile.reviewCandidates ?? []) {
      const onChecklist = checklistById.has(c.findingId);
      const onCoverage = coverageById.has(c.findingId);
      if (onChecklist || onCoverage) crossSurfaceMatches++;
    }
    // The fixture grounds enough finders that the ≥3 floor names
    // distinct candidates that surface on all three. If the
    // findingId hash drifts (the canonical regression — relative-vs-
    // absolute path normalization, criteria-union ordering, etc.),
    // this count drops to zero across the deduped surface.
    expect(crossSurfaceMatches).toBeGreaterThanOrEqual(3);
  });

  it("priority is present (non-null) on scan_file.reviewCandidates[] for every entry — DedupedReviewCandidate.priority is required per the type", async () => {
    const { page } = await makeMultiCandidateFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const scanFile = bodyOf<ScanFileBody>(responses[1]);
    const candidates = scanFile.reviewCandidates ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      // The pre-closure regression the doctrine bullet names
      // explicitly: scan_file shipped `priority: null` /
      // `confidence: null` while checklist populated both. The
      // shared `resolvePriorityForCandidate` helper now threads the
      // value through the dedup path; a `null` or absent field on
      // any entry here would re-introduce the silent-miss.
      expect(c.priority).toBeDefined();
      expect(c.priority).not.toBeNull();
      expect(c.confidence).toBeDefined();
      expect(c.confidence).not.toBeNull();
    }
  });

  it("priority and confidence are present (non-null) on checklist.items[].candidates[] for every entry — ChecklistCandidateOut.priority/confidence are required per the type", async () => {
    const { dir } = await makeMultiCandidateFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklist = bodyOf<ChecklistBody>(responses[1]);
    expect(checklist.items.length).toBeGreaterThan(0);
    for (const item of checklist.items) {
      for (const c of item.candidates) {
        // Per the checklist candidate shape's TSDoc: "Required —
        // agents budget against this signal and a missing or `null`
        // value is the dishonest shape per `Ambiguous field shapes
        // are dishonest`."
        expect(c.priority).toBeDefined();
        expect(c.priority).not.toBeNull();
        expect(c.confidence).toBeDefined();
        expect(c.confidence).not.toBeNull();
      }
    }
  });

  it("confidence value agrees across scan_file and checklist for the same conceptual candidate (findingId-keyed)", async () => {
    const { dir, page } = await makeMultiCandidateFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: page }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const scanFile = bodyOf<ScanFileBody>(responses[1]);
    const checklist = bodyOf<ChecklistBody>(responses[2]);
    const checklistById = checklistCandidatesByFindingId(checklist);

    // The per-emission `confidence` is a finder-supplied evidence-
    // strength label — the dedup helpers thread it through unchanged
    // on both surfaces, so the same `findingId` must read the same
    // value. Drift here is the silent-miss case the doctrine bullet
    // names: an agent reading checklist sees one confidence; reading
    // scan_file sees another for the same evidence; the budget call
    // the agent makes depends on which surface it queried first.
    let comparedPairs = 0;
    for (const c of scanFile.reviewCandidates ?? []) {
      const checklistEntry = checklistById.get(c.findingId);
      if (checklistEntry === undefined) continue;
      expect(c.confidence).toBe(checklistEntry.candidate.confidence);
      comparedPairs++;
    }
    // The fixture lands at least one cross-surface match; if the
    // hash drifts the prior test catches it, but the value-equality
    // assertion here only fires on the matched subset. The floor
    // ensures this test is non-vacuous.
    expect(comparedPairs).toBeGreaterThan(0);
  });

  it("priority value agrees across scan_file and checklist for the same conceptual candidate (findingId-keyed)", async () => {
    const { dir, page } = await makeMultiCandidateFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: page }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const scanFile = bodyOf<ScanFileBody>(responses[1]);
    const checklist = bodyOf<ChecklistBody>(responses[2]);
    const checklistById = checklistCandidatesByFindingId(checklist);

    // Per the dedup module's TSDoc on `priority`: "downgraded to
    // `medium` when the candidate's own static evidence concedes
    // the predicate (hedging reason, vendor-path-shape
    // `vendorContext`, or logotype-pattern `predicateConceded`)."
    // The same logic resolves on both surfaces from
    // `resolvePriorityForCandidate` — value parity is the
    // observable test.
    let comparedPairs = 0;
    for (const c of scanFile.reviewCandidates ?? []) {
      const checklistEntry = checklistById.get(c.findingId);
      if (checklistEntry === undefined) continue;
      expect(c.priority).toBe(checklistEntry.candidate.priority);
      comparedPairs++;
    }
    expect(comparedPairs).toBeGreaterThan(0);
  });

  it("coverage.manualWithCandidates[].candidates[] entries carry the same findingId and confidence as the matching scan_file / checklist candidate", async () => {
    const { dir, page } = await makeMultiCandidateFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: page }),
      toolCall(3, "checklist", { cwd: dir }),
      toolCall(4, "coverage", { cwd: dir }),
    ]);
    const scanFile = bodyOf<ScanFileBody>(responses[1]);
    const checklist = bodyOf<ChecklistBody>(responses[2]);
    const coverage = bodyOf<CoverageBody>(responses[3]);

    const checklistById = checklistCandidatesByFindingId(checklist);
    const coverageById = coverageCandidatesByFindingId(coverage);

    let comparedPairs = 0;
    for (const c of scanFile.reviewCandidates ?? []) {
      const coverageCandidate = coverageById.get(c.findingId);
      if (coverageCandidate === undefined) continue;
      // findingId hashing is the cross-surface address — the byte-
      // equal check is implicit in the map lookup, but the
      // confidence-value assertion catches the case where the id
      // matches but the per-emission evidence-strength label drifted
      // (e.g. one surface used the dedup union's max while another
      // passed the first-seen finder value through unchanged).
      expect(coverageCandidate.confidence).toBe(c.confidence);
      // Cross-check coverage ↔ checklist on the same id — covers the
      // scan_file-absent case where coverage and checklist surface a
      // candidate the file-rooted scan_file wouldn't see (e.g. when
      // the checklist surface walks a sibling file).
      const checklistEntry = checklistById.get(c.findingId);
      if (checklistEntry !== undefined) {
        expect(coverageCandidate.confidence).toBe(checklistEntry.candidate.confidence);
      }
      comparedPairs++;
    }
    // The fixture's video element grounds 1.2.x criteria that all
    // three surfaces ship; the matched subset is non-empty.
    expect(comparedPairs).toBeGreaterThan(0);
  });

  it("the cross-surface candidate hash function (computeCandidateFindingId) is shared — every candidate id is the canonical 12-hex-char shape on all three surfaces", async () => {
    // Doctrine bullet: "the candidate identifier hash function is
    // shared." The shape contract (sha256-truncated to 12 hex
    // chars per `src/utils/finding-id.ts`) is observable on the
    // wire — drift to a different hash function would change the
    // length or the alphabet. A single shared helper is the only
    // way the cross-surface byte-equality invariant above can hold,
    // and the wire-level hex-shape is the cheapest way to detect a
    // helper-fork regression.
    const { dir, page } = await makeMultiCandidateFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: page }),
      toolCall(3, "checklist", { cwd: dir }),
      toolCall(4, "coverage", { cwd: dir }),
    ]);
    const scanFile = bodyOf<ScanFileBody>(responses[1]);
    const checklist = bodyOf<ChecklistBody>(responses[2]);
    const coverage = bodyOf<CoverageBody>(responses[3]);
    const HEX12 = /^[0-9a-f]{12}$/;
    for (const c of scanFile.reviewCandidates ?? []) expect(c.findingId).toMatch(HEX12);
    for (const item of checklist.items) {
      for (const c of item.candidates) expect(c.findingId).toMatch(HEX12);
    }
    const coverageById = coverageCandidatesByFindingId(coverage);
    for (const id of coverageById.keys()) expect(id).toMatch(HEX12);
  });
});
