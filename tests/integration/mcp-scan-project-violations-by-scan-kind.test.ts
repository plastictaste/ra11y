/**
 * Integration test for — asserts that
 * `scan_project` surfaces `plan.violationsByScanKind: { source,
 * buildArtifact }` when the scan includes deterministic build-artifact
 * files (compiled CSS, minified bundles, etc.) classified by the
 * `collectBuildArtifacts` pass.
 *
 * The bug this guards: violations summed across categorically different
 * file kinds — authored source (the user can edit) and build
 * artifacts (often un-editable; the productive triage is
 * `propose_config` exclude or source-level disable). On a vendor-heavy
 * template catalog, "187 violations" with 41 sitting in
 * `css/bootstrap.min.css` reads to the agent as 187 fix candidates
 * when the honest budget is 146 source + 41 buildArtifact.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Composite
 * headline counts are dishonest." The structured per-kind tally is
 * the load-bearing surface; consumers that want the flat number sum
 * the two lanes themselves.
 *
 * Per (2026-04-25) the flat
 * `plan.violations` headline was deleted entirely — the test now
 * derives the error+warning total from `plan.fixesByClass` and
 * checks that the per-kind lanes sum to it. The
 * `violationsByScanKind` field itself remains valid because each
 * lane (source, buildArtifact) names exactly one kind of thing.
 *
 * End-to-end through the MCP server (stdio JSON-RPC) so the assertion
 * exercises the full response-assembly path — `runScanAndFormat` +
 * the build-artifact classifier + `withViolationsByScanKind` +
 * `assembleScanProjectResponse` + the MCP envelope.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

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

describe("scan_project: violations split by scan kind", () => {
  it("emits plan.violationsByScanKind when the scan includes a build artifact alongside authored source", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-violations-by-scan-kind-"));
    try {
      // Authored HTML with a real WCAG 1.1.1 violation — `<img>`
      // without `alt`. Lands in the `source` lane.
      writeFileSync(join(root, "page.html"), '<html><body><img src="hero.png"></body></html>\n');
      // Authored CSS with a contrast violation — black on dark grey
      // fails 1.4.3 AA. Lands in the `source` lane.
      writeFileSync(
        join(root, "site.css"),
        ".muted { color: #555555; background-color: #4a4a4a; }\n",
      );
      // Build artifact with the same kind of contrast violation — the
      // `.min.` infix is the canonical pre-minified bundle marker that
      // routes the file into the `buildArtifact` lane.
      writeFileSync(
        join(root, "vendor.min.css"),
        ".faded { color: #444444; background-color: #5a5a5a; }\n",
      );
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;
      expect(plan).toBeDefined();
      // The flat `plan.violations`
      // headline was deleted; the per-kind sibling remains because
      // each lane (`source`, `buildArtifact`) names exactly one kind
      // of thing. Surface-don't-suppress still holds: every finding
      // rides in `files[]` regardless of lane.
      const lanes = plan["fixesByClass"] as
        | { mechanical: number; guidance: number; runtimeOnly: number; verifyInSource: number }
        | undefined;
      const totalViolations = lanes
        ? lanes.mechanical + lanes.guidance + lanes.runtimeOnly + lanes.verifyInSource
        : 0;
      expect(totalViolations).toBeGreaterThan(0);
      // The structured per-kind sibling.
      const split = plan["violationsByScanKind"] as
        | { source: number; buildArtifact: number }
        | undefined;
      expect(split).toBeDefined();
      // The build artifact must contribute at least one finding to the
      // buildArtifact lane (the vendor.min.css contrast violation).
      expect(split?.buildArtifact).toBeGreaterThan(0);
      // The source lane must carry at least one finding (the page.html
      // missing-alt + the site.css contrast violation).
      expect(split?.source).toBeGreaterThan(0);
      // The two per-kind lanes must sum to the flat error+warning
      // count derived from `plan.fixesByClass`. Invariant of the
      // honest split: no finding gets double-counted, no violation
      // is dropped between the per-lane tally and the per-kind
      // sibling. Both surfaces split the same error+warning axis;
      // info-severity notes (`plan.notes`) sit on a different axis
      // and stay out of the per-kind lanes.
      const lanesSum = (split?.source ?? 0) + (split?.buildArtifact ?? 0);
      expect(lanesSum).toBe(totalViolations);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // end-to-end confirmation
  // that scan_project emits the new `scanned_minified_file` warning
  // code (and its paired `warningsDetails.scanned_minified_file:
  // { files: [paths] }` payload) when at least one classified-minified
  // file is in the scan set. Pairs with `scanned_build_artifacts_present`
  // — that label fires for any artifact reason; this finer label names
  // the minified subset specifically so an agent can triage findings on
  // minified bytes without rereading every flagged file. The fixture
  // here uses a `.min.` infix (path-deterministic minified marker) so
  // the assertion locks against the cheaper of the two minified
  // predicate paths in `classifyBuildArtifact`.
  it("emits warnings[scanned_minified_file] + warningsDetails.scanned_minified_file when the scan touches a .min file", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-scanned-minified-warning-"));
    try {
      writeFileSync(join(root, "page.html"), '<html><body><img src="hero.png"></body></html>\n');
      // Build artifact with the canonical `.min.` infix — classifier
      // returns `reason: "minified"`, `signal: { kind: "min-infix", … }`.
      writeFileSync(
        join(root, "vendor.min.css"),
        ".faded { color: #444444; background-color: #5a5a5a; }\n",
      );
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const warnings = body["warnings"] as readonly string[] | undefined;
      expect(warnings).toBeDefined();
      // The new code fires alongside the broader presence label.
      expect(warnings).toContain("scanned_minified_file");
      expect(warnings).toContain("scanned_build_artifacts_present");
      // The paired payload carries the file identity so the agent can
      // act on the per-file decision without descending into
      // `meta.scannedBuildArtifacts`.
      const details = body["warningsDetails"] as
        | { scanned_minified_file?: { files: readonly string[] } }
        | undefined;
      expect(details?.scanned_minified_file).toBeDefined();
      const files = details?.scanned_minified_file?.files ?? [];
      expect(files.length).toBeGreaterThan(0);
      // Path is repo-relative POSIX (the build-artifact pipeline
      // emits the same path shape the rest of the response uses).
      expect(files.some((p) => p.endsWith("vendor.min.css"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The broader `scanned_build_artifacts_present` label fires for any
  // classified artifact (any classification); the narrower
  // `scanned_minified_file` label is gated to the two minified-shaped
  // classifications (`definite-min-infix` for the `.min.` infix path
  // predicate, `likely-minified-by-line-stats` for the corroborated
  // long-line probe). A non-minified artifact must produce the broader
  // label without the narrower one — pin that per-reason narrowing so
  // the warning code doesn't silently fire on every artifact regime.
  it("does NOT emit warnings[scanned_minified_file] when the only artifact is a non-minified path-predicate hit", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-scanned-minified-negative-"));
    try {
      writeFileSync(join(root, "page.html"), '<html><body><img src="hero.png"></body></html>\n');
      // Hand-shaped CSS with a content-hash basename — the classifier
      // emits the path-anchored `likely-hashed-bundle` classification
      // (8+ hex segment between dots). The broader presence code still
      // fires; the narrower minified code must not.
      writeFileSync(
        join(root, "app.a1b2c3d4.css"),
        ".icon { color: #444444; background-color: #5a5a5a; }\n",
      );
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);
      const warnings = body["warnings"] as readonly string[] | undefined;
      // Sanity — the broader presence label fires off the hashed-
      // bundle classification, so the test isn't vacuously true (it
      // would also pass if the artifact pipeline never ran).
      expect(warnings ?? []).toContain("scanned_build_artifacts_present");
      // The narrower minified label must NOT fire — a content-hash
      // segment in the basename is not minification evidence.
      expect(warnings ?? []).not.toContain("scanned_minified_file");
      const details = body["warningsDetails"] as { scanned_minified_file?: unknown } | undefined;
      expect(details?.scanned_minified_file).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits plan.violationsByScanKind on a scan with no build artifacts (present-when-meaningful)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-violations-by-scan-kind-clean-"));
    try {
      // Authored HTML with one violation, no build artifacts in the
      // tree. The classifier produces an empty path set; the helper
      // omits the field per CLAUDE.md §1 "Ambiguous field shapes are
      // dishonest" — emitting `{ source: N, buildArtifact: 0 }` would
      // duplicate the signal already carried by the absence of
      // `meta.scannedBuildArtifacts`.
      writeFileSync(join(root, "page.html"), '<html><body><img src="x.png"></body></html>\n');
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;
      // Sanity check — the scan produced a finding so the test
      // isn't asserting on a vacuously-empty plan. Per
      // the flat `plan.violations`
      // counter is gone; sum the per-lane `fixesByClass` tally for
      // the error+warning total.
      const lanes = plan["fixesByClass"] as
        | { mechanical: number; guidance: number; runtimeOnly: number; verifyInSource: number }
        | undefined;
      const totalViolations = lanes
        ? lanes.mechanical + lanes.guidance + lanes.runtimeOnly + lanes.verifyInSource
        : 0;
      expect(totalViolations).toBeGreaterThan(0);
      // Field is absent on the no-artifacts common case.
      expect(plan["violationsByScanKind"]).toBeUndefined();
      // And the existing absence signal (`meta.scannedBuildArtifacts`)
      // confirms the classifier ran and produced nothing — so the
      // omission is honest, not a wiring miss.
      const meta = body.meta as Record<string, unknown>;
      expect(meta["scannedBuildArtifacts"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
