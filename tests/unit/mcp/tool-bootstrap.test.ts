/**
 * Unit tests for the `bootstrap` MCP meta-tool.
 *
 * Covers:
 *   - Happy path: composition surfaces wrappers, suggestedConfig,
 *     scan subset, ciSnippet, and nextStep on a real fixture tree
 *     with writeBaseline defaulting to false (no file written).
 *   - writeBaseline opt-in: `.ra11y-baseline.json` lands on disk at
 *     the scan root; the response's `baseline` field reports the
 *     path + entriesWritten.
 *   - Partial failure: when a sub-handler rejects (monkey-patched),
 *     the tool still returns the other legs and emits a
 *     `bootstrap_<leg>_failed` warning code.
 *   - Empty project: zero parseable files propagate the scan's
 *     `scanned_zero_files` warning through the bootstrap response.
 *   - cwd-not-found hard-errors before any sub-handler runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { McpSession } from "../../../src/mcp/session.ts";
import { bootstrapTool } from "../../../src/mcp/tool-bootstrap.ts";
import { detectNativeWrappersTool } from "../../../src/mcp/tool-detect-wrappers.ts";
import { proposeConfigTool } from "../../../src/mcp/tool-propose-config.ts";
import { posixJoin } from "../../helpers/path.ts";

interface BootstrapResponse {
  readonly wrappers: { readonly candidates: readonly unknown[] };
  readonly suggestedConfig?: string;
  readonly scan: {
    readonly filesScanned: number;
    readonly violationsCount: number;
    readonly notesCount: number;
    readonly scanMode?: string;
    readonly fixesByClass?: {
      readonly mechanical: { readonly source: number; readonly buildArtifact: number };
      readonly guidance: { readonly source: number; readonly buildArtifact: number };
      readonly runtimeOnly: { readonly source: number; readonly buildArtifact: number };
      readonly verifyInSource: { readonly source: number; readonly buildArtifact: number };
      readonly suppressRecommended: { readonly source: number; readonly buildArtifact: number };
    };
    readonly limitations?: readonly string[];
  };
  readonly baseline?: { readonly written: boolean; readonly path: string };
  readonly ciSnippet: string;
  readonly nextStep: string;
  readonly nextStepStructured: { readonly tool: string; readonly args: Record<string, unknown> };
  readonly meta: {
    readonly scanned: { readonly mode: "project"; readonly root: string };
    readonly writeBaseline: boolean;
  };
  readonly warnings?: readonly string[];
  readonly warningsDetails?: Record<string, unknown>;
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-bootstrap-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function callBootstrap(
  params: Record<string, unknown>,
): Promise<{ response: BootstrapResponse; isError: boolean | undefined }> {
  const session = new McpSession();
  const result = await bootstrapTool.handler(params, session);
  return {
    isError: result.isError,
    response: JSON.parse(result.content[0]?.text ?? "") as BootstrapResponse,
  };
}

describe("bootstrap: happy path (writeBaseline default false)", () => {
  // Composition invariant: every top-level key the spec promises
  // must land, even on a clean codebase. Dry-run writes nothing — the
  // baseline file must NOT appear on disk when the flag is omitted.
  it("returns wrappers, suggestedConfig, scan, baseline:null, ciSnippet on a clean codebase", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Hello</title></head><body><p>content</p></body></html>\n',
      );
      const { response, isError } = await callBootstrap({ cwd: dir });
      expect(isError).toBeUndefined();
      expect(response.wrappers).toBeTruthy();
      expect(Array.isArray(response.wrappers.candidates)).toBe(true);
      // Canonical key is `suggestedConfig` — matches
      // `propose_config.suggestedConfig` and
      // `detect_native_wrappers.suggestedConfigSnippet`.
      expect(typeof response.suggestedConfig).toBe("string");
      expect(response.suggestedConfig).toContain('import { defineConfig } from "@ra11y/core";');
      // The former `proposedConfig` transition alias was dropped per
      // CLAUDE.md §1 "Sibling fields naming the same concept must use
      // one shape" — it duplicated the canonical ~10KB string verbatim
      // on every call.
      expect((response as unknown as Record<string, unknown>)["proposedConfig"]).toBeUndefined();
      expect(response.scan.filesScanned).toBeGreaterThan(0);
      expect(response.scan.violationsCount).toBe(0);
      expect(response.scan.notesCount).toBe(0);
      // Clean scan should not emit the per-lane fixesByClass tally —
      // upstream scan-assembly only sets it when violations > 0 and
      // the subset forwards that shape verbatim. The former
      // `safeEditsAvailable` composite was dropped upstream per
      // Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT; guard that it
      // never reappears on the subset either.
      expect(response.scan.fixesByClass).toBeUndefined();
      expect((response.scan as Record<string, unknown>)["safeEditsAvailable"]).toBeUndefined();
      // Dry-run: `baseline` is omitted from the response (not `null`)
      // and `baseline_dry_run` lands under `warnings` so dry-run is
      // distinguishable from baseline-creation-failed by reading the
      // shape alone (
      // CLAUDE.md §1 "Ambiguous field shapes are dishonest").
      expect(response.baseline).toBeUndefined();
      expect(response.warnings).toBeDefined();
      expect(response.warnings).toContain("baseline_dry_run");
      expect(response.ciSnippet).toContain("ra11y");
      expect(response.ciSnippet).toContain("baseline check");
      expect(response.meta.scanned).toEqual({ mode: "project", root: dir });
      expect(response.meta.writeBaseline).toBe(false);
      expect(existsSync(posixJoin(dir, ".ra11y-baseline.json"))).toBe(false);
    });
  });

  // Envelope honesty: the upstream scan emits `plan.limitations`
  // prose telling readers static analysis can prove failure but not
  // conformance and that runtime-only checks are out of scope. The
  // bootstrap composer must forward that prose onto `scan.limitations`
  // so CI readers pasting the `ciSnippet` don't treat the scan as
  // authoritative..
  it("forwards plan.limitations prose from scan_project onto scan.limitations", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><p>x</p></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      expect(response.scan.limitations).toBeDefined();
      expect(Array.isArray(response.scan.limitations)).toBe(true);
      expect((response.scan.limitations ?? []).length).toBeGreaterThan(0);
      const joined = (response.scan.limitations ?? []).join(" ");
      // Prose cites the static-analysis / runtime-check caveat —
      // agents and CI readers need the substantive warning, not just
      // the field's presence.
      expect(joined.toLowerCase()).toContain("static analysis");
      expect(joined.toLowerCase()).toContain("runtime");
    });
  });

  // The nextStepStructured contract routes agents at the right *forward*
  // follow-up call. The former self-loop routed back at
  // `bootstrap({ writeBaseline: true })` — same tool, different arg —
  // which failed the "One tool call should answer 'what next?'" rule:
  // the baseline-toggle is an input arg on the same tool, not a
  // forward step. On a dirty dry-run with no wrapper candidates the
  // forward move is `scan_project` (to iterate on findings after the
  // agent fixes them). The grandfather-via-baseline option still
  // appears in the prose `nextStep` as the grandfather-alternative.
  it("routes forward to scan_project on dirty dry-run (not a self-loop into bootstrap)", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "a.html"),
        '<!DOCTYPE html><html><head></head><body><img src="/a.png"></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      expect(response.scan.violationsCount).toBeGreaterThan(0);
      expect(response.baseline).toBeUndefined();
      expect(response.warnings).toContain("baseline_dry_run");
      // Self-loop is gone: structured hint never points at bootstrap.
      expect(response.nextStepStructured.tool).not.toBe("bootstrap");
      // No wrapper candidates in this fixture (raw HTML, no
      // PascalCase+onClick), so the forward hop is `scan_project`.
      expect(response.nextStepStructured.tool).toBe("scan_project");
      // Grandfather-alternative stays in prose — legitimate English
      // guidance, not a recursive structured hint.
      expect(response.nextStep).toContain("writeBaseline: true");
    });
  });

  // Edge case — wrappers unconfirmed: when the detect leg surfaces
  // PascalCase+onClick candidates AND the dry-run scan has
  // violations, the more actionable forward move is
  // `detect_native_wrappers` before another `scan_project`.
  // Confirming wrappers changes which findings the engine treats as
  // real, so iterating on `scan_project` first risks chasing false
  // positives. Fixture: a TSX call site that uses a PascalCase
  // component with `onClick` (the detector keys on *usage*, not
  // declaration) plus an HTML page with the alt-text violation so
  // `scan_project` still reports dirty.
  it("routes to detect_native_wrappers on dirty dry-run when wrapper candidates exist", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "app.tsx"),
        [
          "export function App() {",
          "  return (",
          "    <>",
          "      <ActionButton onClick={a} />",
          "      <Card onClick={b} />",
          "    </>",
          "  );",
          "}",
        ].join("\n"),
      );
      await writeFile(
        posixJoin(dir, "a.html"),
        '<!DOCTYPE html><html><head></head><body><img src="/a.png"></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      expect(response.scan.violationsCount).toBeGreaterThan(0);
      expect(response.wrappers.candidates.length).toBeGreaterThan(0);
      expect(response.baseline).toBeUndefined();
      expect(response.warnings).toContain("baseline_dry_run");
      expect(response.nextStepStructured.tool).toBe("detect_native_wrappers");
      expect(response.nextStepStructured.args.cwd).toBe(dir);
    });
  });

  // Upstream `scan_project` intentionally splits violations from
  // notes on `plan` (scan-assembly.ts) and emits per-lane
  // counters (`safeEditsAvailable`, `fixesByClass`) separately
  // so agents budget per-kind rather than against a sum. The
  // bootstrap subset must forward those split counters verbatim —
  // re-summing them into a `totalFindings` composite is the
  // dishonest-headline anti-pattern CLAUDE.md §1 warns against.
  it("preserves the upstream violations/notes/fixesByClass split instead of re-summing", async () => {
    await withScratch(async (dir) => {
      // `img` without `alt` is a violation — at least one mechanical
      // remediation lane should be populated.
      await writeFile(
        posixJoin(dir, "a.html"),
        '<!DOCTYPE html><html><head></head><body><img src="/a.png"></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      // Split shape: violations and notes live under separate keys;
      // no `totalFindings` re-sum is present on the subset.
      expect(response.scan.violationsCount).toBeGreaterThan(0);
      expect(response.scan.notesCount).toBeGreaterThanOrEqual(0);
      expect((response.scan as Record<string, unknown>)["totalFindings"]).toBeUndefined();
      // `fixesByClass` is present when the upstream plan emits it
      // (violations > 0 gate in scan-assembly.ts). Each lane counts
      // one kind of thing per CLAUDE.md §1.
      expect(response.scan.fixesByClass).toBeDefined();
      const zeroLane = { source: 0, buildArtifact: 0 };
      const lanes = response.scan.fixesByClass ?? {
        mechanical: zeroLane,
        guidance: zeroLane,
        runtimeOnly: zeroLane,
        verifyInSource: zeroLane,
        suppressRecommended: zeroLane,
      };
      // Each lane is a per-scan-kind sub-tally — `source` (authored)
      // + `buildArtifact` (vendor / generated). The bootstrap subset
      // forwards the upstream shape verbatim. The sum spans all five
      // lanes the upstream `plan.fixesByClass` enumerates including
      // `suppressRecommended` per "Bootstrap-class lanes must equal
      // project-rooted lanes."
      const laneSum = (l: { source: number; buildArtifact: number }): number =>
        l.source + l.buildArtifact;
      const total =
        laneSum(lanes.mechanical) +
        laneSum(lanes.guidance) +
        laneSum(lanes.runtimeOnly) +
        laneSum(lanes.verifyInSource) +
        laneSum(lanes.suppressRecommended);
      // Per-lane tally sums to the total violation count — honest
      // invariant that fails the day the subset drops one lane.
      expect(total).toBe(response.scan.violationsCount);
      // The nextStep prose reads violations separately from notes —
      // the former "N findings" sum is gone.
      expect(response.nextStep).toContain(
        `${response.scan.violationsCount} violation${response.scan.violationsCount === 1 ? "" : "s"}`,
      );
      expect(response.nextStep).not.toMatch(/\d+ findings from scan_project/);
    });
  });
});

describe("bootstrap: writeBaseline opt-in", () => {
  // The on-disk artifact is the contract here: `.ra11y-baseline.json`
  // must exist at the scan root after a writeBaseline:true call. The
  // response must report the path + written:true so an agent can
  // commit the file without re-probing disk.
  it("writes .ra11y-baseline.json at the scan root and reports the path", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "a.html"),
        '<!DOCTYPE html><html><head></head><body><img src="/a.png"></body></html>\n',
      );
      const { response, isError } = await callBootstrap({ cwd: dir, writeBaseline: true });
      expect(isError).toBeUndefined();
      expect(response.baseline).toBeDefined();
      expect(response.baseline?.written).toBe(true);
      expect(response.baseline?.path).toContain(".ra11y-baseline.json");
      expect(existsSync(posixJoin(dir, ".ra11y-baseline.json"))).toBe(true);
      expect(response.meta.writeBaseline).toBe(true);
      // writeBaseline:true must NOT emit `baseline_dry_run` — that
      // code is the dry-run discriminator only.
      expect(response.warnings ?? []).not.toContain("baseline_dry_run");
      // After a successful baseline write, the next-step routes to
      // `baseline check` — the canonical verify-in-CI move.
      expect(response.nextStepStructured.tool).toBe("baseline");
      expect(response.nextStepStructured.args.mode).toBe("check");
    });
  });
});

describe("bootstrap: ciSnippet honesty gates on baseline-existence", () => {
  //. `buildCiSnippet` used to emit
  // `npx @ra11y/core --baseline check` verbatim regardless of whether
  // `.ra11y-baseline.json` existed on disk — a caller pasting the
  // dry-run response's snippet into CI before committing the baseline
  // file hit a first-run failure. Each branch below pins the snippet
  // content that matches the actual state so a copy-paste-into-CI path
  // is always correct.

  // Dry-run, no baseline on disk: snippet must prepend a `baseline
  // create` step (with the `# create ... first` comment) so first-run
  // CI bootstraps itself before `baseline check` executes.
  it("emits a create-first prelude when dry-run and no baseline on disk", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "a.html"),
        '<!DOCTYPE html><html><head></head><body><img src="/a.png"></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      expect(response.baseline).toBeUndefined();
      expect(existsSync(posixJoin(dir, ".ra11y-baseline.json"))).toBe(false);
      // Create step precedes check step — ordering is the contract.
      // Match the yaml `- run:` lines, not just the substring, so the
      // comment line (which names both commands) doesn't confuse the
      // ordering assertion.
      const snippet = response.ciSnippet;
      const createRunIdx = snippet.indexOf("- run: npx @ra11y/core --baseline create");
      const checkRunIdx = snippet.indexOf("- run: npx @ra11y/core --baseline check");
      expect(createRunIdx).toBeGreaterThan(-1);
      expect(checkRunIdx).toBeGreaterThan(-1);
      expect(createRunIdx).toBeLessThan(checkRunIdx);
      expect(snippet).toContain(".ra11y-baseline.json");
      // Comment frames the reason a human CI-editor needs to see.
      expect(snippet).toContain("create");
    });
  });

  // Baseline absent going in, this call wrote it: snippet runs only
  // `baseline check` but reminds the caller to commit the new file
  // before pushing (otherwise CI still hits "baseline missing").
  it("emits a commit-first reminder when this call just wrote the baseline", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "a.html"),
        '<!DOCTYPE html><html><head></head><body><img src="/a.png"></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir, writeBaseline: true });
      expect(response.baseline?.written).toBe(true);
      expect(existsSync(posixJoin(dir, ".ra11y-baseline.json"))).toBe(true);
      const snippet = response.ciSnippet;
      // `baseline check` is the only baseline step — no create prelude
      // needed because this call just wrote the file.
      expect(snippet).toContain("--baseline check");
      expect(snippet).not.toContain("--baseline create");
      // Commit reminder names the file so the caller knows what to
      // stage before pushing.
      expect(snippet).toContain(".ra11y-baseline.json");
      expect(snippet.toLowerCase()).toContain("commit");
    });
  });

  // Baseline already on disk from a prior run: snippet is the plain
  // `baseline check` incantation — no prelude, no reminder. This is the
  // steady-state CI shape.
  it("emits a plain baseline-check snippet when baseline already exists on disk", async () => {
    await withScratch(async (dir) => {
      // Pre-seed the baseline file so the tool sees it on entry.
      await writeFile(
        posixJoin(dir, ".ra11y-baseline.json"),
        JSON.stringify({ version: 1, violations: [] }),
      );
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><p>ok</p></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      expect(existsSync(posixJoin(dir, ".ra11y-baseline.json"))).toBe(true);
      const snippet = response.ciSnippet;
      expect(snippet).toContain("--baseline check");
      expect(snippet).not.toContain("--baseline create");
      // No commit-first comment either — the file is already on disk
      // and (by virtue of being present) presumed committed.
      expect(snippet.toLowerCase()).not.toContain("commit");
    });
  });
});

describe("bootstrap: ciSnippet clarifies node-setup is ra11y-only for foreign ecosystems", () => {
  //. The ra11y job body is identical
  // across ecosystems — `@ra11y/core` is a Node-based CLI regardless of
  // the consumer's primary language, so `actions/setup-node@v4` stays
  // in the snippet for Ruby / Python / Go / Rust roots too. Stripping
  // the node-setup step would produce a snippet that silently fails
  // when CI runs ("Surface, don't suppress"). What changes is the
  // header preface: for a foreign-ecosystem root we emit a clarifying
  // comment that the job is additive and the node-setup is ra11y-only,
  // so a reader pasting the snippet into a Rails / Django / Go repo
  // doesn't mistake it for an instruction to replace their existing
  // setup actions.

  it("emits the foreign-ecosystem preface for a Ruby root (Gemfile present, no package.json)", async () => {
    await withScratch(async (dir) => {
      await writeFile(posixJoin(dir, "Gemfile"), "source 'https://rubygems.org'\n");
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><p>ok</p></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      const snippet = response.ciSnippet;
      // Preface names the ecosystem inline so the reader sees which
      // detection fired.
      expect(snippet).toContain("ruby");
      // "Add this job to your existing CI" frames the job as additive
      // — pasteable alongside whatever Ruby CI is already on disk.
      expect(snippet.toLowerCase()).toContain("existing ci");
      // Explicit callout that the node-setup step is ra11y-only (not
      // a replacement for the Ruby setup).
      expect(snippet.toLowerCase()).toContain("node-based tool");
      // The `actions/setup-node@v4` step STAYS in the body — the
      // preface is prose; the job itself is unchanged. Stripping the
      // step would silently break the CI run ("Surface, don't
      // suppress").
      expect(snippet).toContain("actions/setup-node@v4");
      expect(snippet).toContain("actions/checkout@v4");
    });
  });

  it("emits the foreign-ecosystem preface for a Python root (pyproject.toml present, no package.json)", async () => {
    await withScratch(async (dir) => {
      await writeFile(posixJoin(dir, "pyproject.toml"), '[project]\nname = "x"\nversion = "0"\n');
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><p>ok</p></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      const snippet = response.ciSnippet;
      expect(snippet).toContain("python");
      expect(snippet).toContain("actions/setup-node@v4");
    });
  });

  it("omits the foreign-ecosystem preface for a Node root (package.json present alongside Gemfile)", async () => {
    await withScratch(async (dir) => {
      // Mixed stack: Node toolchain short-circuits the foreign-ecosystem
      // predicate even with Gemfile present (matches
      // `detectForeignEcosystem`'s `package.json` short-circuit).
      await writeFile(posixJoin(dir, "package.json"), '{ "name": "x" }\n');
      await writeFile(posixJoin(dir, "Gemfile"), "source 'https://rubygems.org'\n");
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><p>ok</p></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      const snippet = response.ciSnippet;
      // No ecosystem name in the preface — pure Node-path snippet.
      expect(snippet).not.toContain("ruby");
      expect(snippet).not.toContain("python");
      expect(snippet).not.toContain("go-based");
      // The "add this job to your existing CI" framing is
      // foreign-ecosystem-only; a Node repo's snippet stays in the
      // original (pre-Q4) shape.
      expect(snippet.toLowerCase()).not.toContain("existing ci");
      expect(snippet).toContain("actions/setup-node@v4");
    });
  });

  it("emits the foreign-ecosystem preface on a Go root when writeBaseline lands the file", async () => {
    await withScratch(async (dir) => {
      await writeFile(posixJoin(dir, "go.mod"), "module x\n\ngo 1.22\n");
      await writeFile(
        posixJoin(dir, "a.html"),
        '<!DOCTYPE html><html><head></head><body><img src="/a.png"></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir, writeBaseline: true });
      expect(response.baseline?.written).toBe(true);
      const snippet = response.ciSnippet;
      expect(snippet).toContain("go");
      // Post-write: baseline check step stays; create-prelude does not.
      expect(snippet).toContain("--baseline check");
      expect(snippet).not.toContain("--baseline create");
      // Preface is orthogonal to the baseline branching — foreign
      // preface applies regardless of which baseline-branch ran.
      expect(snippet.toLowerCase()).toContain("node-based tool");
    });
  });
});

describe("bootstrap: partial failure (sub-handler rejects)", () => {
  // Monkey-patch one sub-handler to throw so we can assert the
  // allSettled contract: the OTHER legs still compose, and the
  // response carries a `bootstrap_<leg>_failed` warning code naming
  // the failed step. Mirrors the audit meta-tool's partial-failure
  // pattern (commit 048dfcc).
  const originalDetect = detectNativeWrappersTool.handler;

  beforeEach(() => {
    (detectNativeWrappersTool as { handler: unknown }).handler = () => {
      throw new Error("forced-detect-failure");
    };
  });

  afterEach(() => {
    (detectNativeWrappersTool as { handler: unknown }).handler = originalDetect;
  });

  it("returns scan + suggestedConfig and emits bootstrap_detect_failed warning when detect rejects", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body></body></html>\n',
      );
      const { response, isError } = await callBootstrap({ cwd: dir });
      expect(isError).toBeUndefined();
      expect(response.wrappers.candidates).toEqual([]);
      expect(typeof response.suggestedConfig).toBe("string");
      expect((response as unknown as Record<string, unknown>)["proposedConfig"]).toBeUndefined();
      expect(response.scan.filesScanned).toBeGreaterThan(0);
      expect(response.warnings).toBeDefined();
      expect(response.warnings).toContain("bootstrap_detect_failed");
      expect(response.nextStep).toContain("Degraded legs");
    });
  });
});

describe("bootstrap: suggestedConfig null-case", () => {
  // When the `propose_config` leg degrades (handler rejects →
  // extractProposedConfig returns null), `suggestedConfig` is omitted
  // from the response (conditional spread per CLAUDE.md §1
  // "Ambiguous field shapes are dishonest") and the partial-failure
  // pipeline emits `bootstrap_propose_config_failed` so the agent can
  // tell "leg degraded" from "no config available."
  const originalPropose = proposeConfigTool.handler;

  beforeEach(() => {
    (proposeConfigTool as { handler: unknown }).handler = () => {
      throw new Error("forced-propose-failure");
    };
  });

  afterEach(() => {
    (proposeConfigTool as { handler: unknown }).handler = originalPropose;
  });

  it("omits suggestedConfig when propose_config leg rejects", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body></body></html>\n',
      );
      const { response, isError } = await callBootstrap({ cwd: dir });
      expect(isError).toBeUndefined();
      expect(response.suggestedConfig).toBeUndefined();
      // The former `proposedConfig` transition alias was dropped per
      // CLAUDE.md §1 "Sibling fields naming the same concept must use
      // one shape"; guard that it never resurfaces alongside the
      // canonical absence either.
      expect((response as unknown as Record<string, unknown>)["proposedConfig"]).toBeUndefined();
      expect(response.warnings).toBeDefined();
      expect(response.warnings).toContain("bootstrap_propose_config_failed");
    });
  });
});

describe("bootstrap: empty project edge case", () => {
  // Zero parseable files is the canonical ambiguity-risk CLAUDE.md §1
  // warns against. The scan leg emits `scanned_zero_files`; the
  // bootstrap response must propagate that code verbatim so an agent
  // reading the warnings can't mistake "tool never ran" for "clean
  // codebase."
  it("propagates scanned_zero_files when the scan parses nothing", async () => {
    await withScratch(async (dir) => {
      // Scratch directory with no parseable files. `.md` is parseable
      // under ADR 0025 (markdown Option B), so use `.txt` — a truly
      // unsupported extension — to ensure the scan finds no input.
      await writeFile(posixJoin(dir, "NOTES.txt"), "nothing to scan\n");
      const { response, isError } = await callBootstrap({ cwd: dir });
      expect(isError).toBeUndefined();
      expect(response.scan.filesScanned).toBe(0);
      expect(response.warnings).toBeDefined();
      expect(response.warnings).toContain("scanned_zero_files");
      // Dry-run code joins the scan-leg code in `warnings` —
      // applies regardless of
      // whether the scan parsed any files.
      expect(response.warnings).toContain("baseline_dry_run");
      expect(response.baseline).toBeUndefined();
      expect(response.nextStep.toLowerCase()).toContain("zero files");
    });
  });
});

describe("bootstrap: cwd-not-found hard-errors", () => {
  // Matches the propose_config + scan_project cwd-not-found envelope
  // — nonexistent cwd must be a structured error, not a silent
  // zero-output success. Same guard the other tools install at entry.
  it("returns structured error with code cwd-not-found when cwd is missing", async () => {
    const session = new McpSession();
    const result = await bootstrapTool.handler(
      { cwd: "/nonexistent/path/that/does/not/exist-xyz789" },
      session,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? "{}") as { code?: string };
    expect(body.code).toBe("cwd-not-found");
  });
});

describe("bootstrap: registered on tools/list", () => {
  // Canonical tools/list inventory is the spec contract for agents
  // discovering available MCP tools — a handler that isn't registered
  // is unreachable regardless of implementation. Guards against
  // silently forgetting to wire the new tool.
  it("appears in the MCP_TOOLS export", async () => {
    const { MCP_TOOLS } = await import("../../../src/mcp/tools.ts");
    const names = MCP_TOOLS.map((t) => t.def.name);
    expect(names).toContain("bootstrap");
  });
});

/**
 * Pins the membership-vs-payload invariant at the bootstrap surface:
 * every code in `warnings[]` MUST resolve to a `warningsDetails.<code>`
 * entry, and `warningsDetails` is omitted entirely when no codes
 * fired.
 *
 * Closes the strictly-worse variant of the empty-`{}` regression
 * documented in CLAUDE.md §1 "Empty `warningsDetails.<code>: {}` is
 * dishonest" — bootstrap was shipping a populated `warnings[]` (e.g.
 * 15 codes including `no_config_found`, `partial_parse_files_present`,
 * `baseline_dry_run`) without any top-level `warningsDetails` object,
 * leaving the agent with the warning name and zero way to triage what
 * fired.
 *
 * The cross-surface count invariant applies at warning-channel
 * granularity: bootstrap composes scan_project's response and must
 * forward its `warningsDetails` payloads verbatim. Bootstrap-local
 * codes (`baseline_dry_run`, `bootstrap_<leg>_failed`) are binary-
 * presence — `fallThroughDetailEntry` stamps `{}` markers per the
 * "presence is the signal" pattern documented on the helper.
 */
describe("bootstrap: warningsDetails membership invariant", () => {
  // Dry-run on a clean codebase fires `baseline_dry_run` only — the
  // minimum case where bootstrap must ship `warningsDetails`. Without
  // the fix, the dry-run code lived alone in `warnings[]` with no
  // payload-channel companion at all.
  it("ships warningsDetails with baseline_dry_run carrying { didWrite: false, wouldHaveAdded } on a clean dry-run", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Hello</title></head><body><p>content</p></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      expect(response.warnings).toContain("baseline_dry_run");
      expect(response.warningsDetails).toBeDefined();
      // Structured payload — graduated from BinaryPresenceMarker per
      // the AI-first doctrine "Empty `warningsDetails.<code>: {}` is
      // dishonest." `didWrite: false` is the predicate's "fired"
      // branch; `wouldHaveAdded` is the count of violations the
      // create leg would have written had `writeBaseline: true` been
      // passed (sourced from the scan subset's `violationsCount`
      // lane). On a clean dry-run the count is 0 — the agent reads
      // the payload and decides "no baseline needed" rather than
      // budgeting for a follow-up `bootstrap({ writeBaseline: true })`
      // call against an unknown count.
      const payload = response.warningsDetails?.["baseline_dry_run"] as
        | { didWrite: false; wouldHaveAdded: number }
        | undefined;
      expect(payload?.didWrite).toBe(false);
      expect(typeof payload?.wouldHaveAdded).toBe("number");
      expect(payload?.wouldHaveAdded).toBe(0);
    });
  });

  // Membership-vs-payload invariant: every code in `warnings[]` must
  // have a corresponding `warningsDetails.<code>` key. Drives the
  // contract `every code in warnings[] resolves to a non-empty
  // warningsDetails.<code>` from the AI-first doctrine bullet.
  it("every code in warnings[] resolves to a warningsDetails.<code> entry", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "a.html"),
        '<!DOCTYPE html><html><head></head><body><img src="/a.png"></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      expect(response.warnings).toBeDefined();
      expect(response.warningsDetails).toBeDefined();
      const details = response.warningsDetails ?? {};
      for (const code of response.warnings ?? []) {
        // The agent must read a definite shape, not `undefined` —
        // membership invariant per CLAUDE.md §1.
        expect(details[code]).toBeDefined();
      }
    });
  });

  // Cross-surface forwarding: the upstream scan_project response
  // carries the `no_config_found` warning with the present-when-
  // meaningful empty-record payload on identical `cwd`. Bootstrap
  // must forward that payload verbatim — the per-tool warning-set
  // classification rule requires the same warning-payload set to
  // reach every consumer of the corpus.
  //
  // Per `docs/kb/architecture/ai-first-consumer.md` "Verbose meta is
  // signal, not clutter — `configSearchedFrom` is present-when-
  // meaningful, omitted when it would just echo the caller's `cwd` or
  // a `scanned.root` already in the response," the
  // `warningsDetails.no_config_found.searchedFrom` payload drops to
  // the empty record when the loader's walk-up base equals
  // `meta.scanned.root` (the common case for bootstrap, since
  // `cwd === scanned.root === searchedFrom`). The bare warning code
  // is the canonical signal; the agent reads `meta.scanned.root` for
  // the search base.
  it("forwards the no_config_found warning detail from the upstream scan_project leg verbatim (empty-record payload when search base echoes cwd)", async () => {
    await withScratch(async (dir) => {
      // No ra11y.config.ts at this scratch root → scan_project may
      // emit `no_config_found`. The clean index.html keeps
      // `filesScanned > 0` so `scanned_zero_files` doesn't fire
      // (which would shadow the case under test).
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><p>x</p></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      // The `no_config_found` code may not fire on this tiny scratch
      // tree (per the tiny-repo gate documented in
      // `shouldEmitNoConfigFound`), so this assertion is conditional:
      // when the code is present in `warnings[]`, its forwarded
      // payload must be the present-when-meaningful empty record (the
      // search base equals `cwd === scanned.root` and would just
      // echo a value the agent already has).
      if ((response.warnings ?? []).includes("no_config_found")) {
        const detail = response.warningsDetails?.["no_config_found"] as
          | { searchedFrom?: string }
          | undefined;
        expect(detail).toBeDefined();
        // The `searchedFrom` field is dropped because it would echo
        // `cwd` / `scanned.root` already on the response. The
        // remaining shape is the empty record.
        expect(detail).toEqual({});
      }
    });
  });

  // Zero-output-success companion: a scan parsing nothing emits
  // `scanned_zero_files` (binary-presence). Forwarded onto the
  // bootstrap envelope so the membership invariant holds even when
  // the upstream scan was empty.
  it("forwards scanned_zero_files onto warningsDetails when the scan parses nothing", async () => {
    await withScratch(async (dir) => {
      await writeFile(posixJoin(dir, "NOTES.txt"), "nothing to scan\n");
      const { response } = await callBootstrap({ cwd: dir });
      expect(response.warnings).toContain("scanned_zero_files");
      expect(response.warningsDetails?.["scanned_zero_files"]).toBeDefined();
      // `scanned_zero_files` is a binary-presence code — empty-object
      // marker is the honest wire shape.
      expect(response.warningsDetails?.["scanned_zero_files"]).toEqual({});
      // `baseline_dry_run` joins the scan-leg code on the same
      // response and resolves to its structured payload (graduated
      // from the empty-object marker per the AI-first doctrine
      // "Empty `warningsDetails.<code>: {}` is dishonest"). Both
      // halves of the membership invariant exercised in one case.
      expect(response.warnings).toContain("baseline_dry_run");
      const dryRunPayload = response.warningsDetails?.["baseline_dry_run"] as
        | { didWrite: false; wouldHaveAdded: number }
        | undefined;
      expect(dryRunPayload?.didWrite).toBe(false);
      expect(typeof dryRunPayload?.wouldHaveAdded).toBe("number");
    });
  });

  // Bootstrap-local failure code: when a sub-leg rejects, the
  // `bootstrap_<leg>_failed` code joins `warnings[]`. These codes are
  // outside the canonical `ScanWarningCode` union — `fallThroughDetailEntry`
  // treats them as binary-presence by default. The invariant must
  // still hold: a key on `warningsDetails`, even if the wire shape
  // is `{}`.
  it("stamps warningsDetails.bootstrap_detect_failed = {} when the detect leg rejects", async () => {
    const originalDetect = detectNativeWrappersTool.handler;
    (detectNativeWrappersTool as { handler: unknown }).handler = () => {
      throw new Error("forced-detect-failure");
    };
    try {
      await withScratch(async (dir) => {
        await writeFile(
          posixJoin(dir, "index.html"),
          '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body></body></html>\n',
        );
        const { response } = await callBootstrap({ cwd: dir });
        expect(response.warnings).toContain("bootstrap_detect_failed");
        expect(response.warningsDetails?.["bootstrap_detect_failed"]).toBeDefined();
        expect(response.warningsDetails?.["bootstrap_detect_failed"]).toEqual({});
      });
    } finally {
      (detectNativeWrappersTool as { handler: unknown }).handler = originalDetect;
    }
  });
});
