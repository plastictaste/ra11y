/**
 * Unit tests for the `bootstrap` MCP meta-tool.
 *
 * Covers:
 *   - Happy path: composition surfaces wrappers, suggestedConfig (with
 *     the `proposedConfig` transition alias carrying the identical
 *     value), scan subset, ciSnippet, and nextStep on a real fixture
 *     tree with writeBaseline defaulting to false (no file written).
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
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { bootstrapTool } from "../../../src/mcp/tool-bootstrap.ts";
import { detectNativeWrappersTool } from "../../../src/mcp/tool-detect-wrappers.ts";
import { proposeConfigTool } from "../../../src/mcp/tool-propose-config.ts";

interface BootstrapResponse {
  readonly wrappers: { readonly candidates: readonly unknown[] };
  readonly suggestedConfig?: string;
  readonly proposedConfig?: string;
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
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-bootstrap-"));
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
  it("returns wrappers, suggestedConfig (and proposedConfig alias), scan, baseline:null, ciSnippet on a clean codebase", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Hello</title></head><body><p>content</p></body></html>\n',
      );
      const { response, isError } = await callBootstrap({ cwd: dir });
      expect(isError).toBeUndefined();
      expect(response.wrappers).toBeTruthy();
      expect(Array.isArray(response.wrappers.candidates)).toBe(true);
      // Canonical key is `suggestedConfig` (-
      // DRIFT); `proposedConfig` is emitted alongside for one release
      // as a transition alias so agents that learned the old name keep
      // working. Both must carry the identical value.
      expect(typeof response.suggestedConfig).toBe("string");
      expect(response.suggestedConfig).toContain('import { defineConfig } from "@ra11y/core";');
      expect(typeof response.proposedConfig).toBe("string");
      expect(response.proposedConfig).toContain('import { defineConfig } from "@ra11y/core";');
      expect(response.proposedConfig).toBe(response.suggestedConfig);
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
      expect(existsSync(join(dir, ".ra11y-baseline.json"))).toBe(false);
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
        join(dir, "index.html"),
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
        join(dir, "a.html"),
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
        join(dir, "app.tsx"),
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
        join(dir, "a.html"),
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
        join(dir, "a.html"),
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
      };
      // Each lane is a per-scan-kind sub-tally — `source` (authored)
      // + `buildArtifact` (vendor / generated). The bootstrap subset
      // forwards the upstream shape verbatim.
      const laneSum = (l: { source: number; buildArtifact: number }): number =>
        l.source + l.buildArtifact;
      const total =
        laneSum(lanes.mechanical) +
        laneSum(lanes.guidance) +
        laneSum(lanes.runtimeOnly) +
        laneSum(lanes.verifyInSource);
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
        join(dir, "a.html"),
        '<!DOCTYPE html><html><head></head><body><img src="/a.png"></body></html>\n',
      );
      const { response, isError } = await callBootstrap({ cwd: dir, writeBaseline: true });
      expect(isError).toBeUndefined();
      expect(response.baseline).toBeDefined();
      expect(response.baseline?.written).toBe(true);
      expect(response.baseline?.path).toContain(".ra11y-baseline.json");
      expect(existsSync(join(dir, ".ra11y-baseline.json"))).toBe(true);
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
        join(dir, "a.html"),
        '<!DOCTYPE html><html><head></head><body><img src="/a.png"></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      expect(response.baseline).toBeUndefined();
      expect(existsSync(join(dir, ".ra11y-baseline.json"))).toBe(false);
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
        join(dir, "a.html"),
        '<!DOCTYPE html><html><head></head><body><img src="/a.png"></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir, writeBaseline: true });
      expect(response.baseline?.written).toBe(true);
      expect(existsSync(join(dir, ".ra11y-baseline.json"))).toBe(true);
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
        join(dir, ".ra11y-baseline.json"),
        JSON.stringify({ version: 1, violations: [] }),
      );
      await writeFile(
        join(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><p>ok</p></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      expect(existsSync(join(dir, ".ra11y-baseline.json"))).toBe(true);
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
      await writeFile(join(dir, "Gemfile"), "source 'https://rubygems.org'\n");
      await writeFile(
        join(dir, "index.html"),
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
      await writeFile(join(dir, "pyproject.toml"), '[project]\nname = "x"\nversion = "0"\n');
      await writeFile(
        join(dir, "index.html"),
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
      await writeFile(join(dir, "package.json"), '{ "name": "x" }\n');
      await writeFile(join(dir, "Gemfile"), "source 'https://rubygems.org'\n");
      await writeFile(
        join(dir, "index.html"),
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
      await writeFile(join(dir, "go.mod"), "module x\n\ngo 1.22\n");
      await writeFile(
        join(dir, "a.html"),
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

  it("returns scan + suggestedConfig (plus proposedConfig alias) and emits bootstrap_detect_failed warning when detect rejects", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body></body></html>\n',
      );
      const { response, isError } = await callBootstrap({ cwd: dir });
      expect(isError).toBeUndefined();
      expect(response.wrappers.candidates).toEqual([]);
      expect(typeof response.suggestedConfig).toBe("string");
      expect(typeof response.proposedConfig).toBe("string");
      expect(response.proposedConfig).toBe(response.suggestedConfig);
      expect(response.scan.filesScanned).toBeGreaterThan(0);
      expect(response.warnings).toBeDefined();
      expect(response.warnings).toContain("bootstrap_detect_failed");
      expect(response.nextStep).toContain("Degraded legs");
    });
  });
});

describe("bootstrap: suggestedConfig/proposedConfig null-case parity", () => {
  //. When the `propose_config` leg
  // degrades (handler rejects → extractProposedConfig returns null),
  // neither the canonical `suggestedConfig` key nor the
  // `proposedConfig` transition alias may appear on the response —
  // conditional-spread for both under one gate. Asserting on both
  // absence simultaneously prevents the alias from being emitted when
  // the canonical key is omitted (half-populated shape ambiguity).
  const originalPropose = proposeConfigTool.handler;

  beforeEach(() => {
    (proposeConfigTool as { handler: unknown }).handler = () => {
      throw new Error("forced-propose-failure");
    };
  });

  afterEach(() => {
    (proposeConfigTool as { handler: unknown }).handler = originalPropose;
  });

  it("omits both suggestedConfig and proposedConfig when propose_config leg rejects", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body></body></html>\n',
      );
      const { response, isError } = await callBootstrap({ cwd: dir });
      expect(isError).toBeUndefined();
      expect(response.suggestedConfig).toBeUndefined();
      expect(response.proposedConfig).toBeUndefined();
      expect(response.warnings).toBeDefined();
      expect(response.warnings).toContain("bootstrap_propose_config_failed");
    });
  });
});

describe("bootstrap: proposedConfig deprecation warning", () => {
  //. `bootstrap` ships the
  // canonical `suggestedConfig` and a transition-alias `proposedConfig`
  // with identical contents for one release. Without a structured
  // warning, agents have no signal that the alias is going away and
  // pay the double-payload cost on every call. The dedicated code
  // fires whenever `proposedConfig` is in the response so agents drop
  // their alias reads on the next tool call. Removed in lockstep with
  // the alias itself in the next minor release.
  it("fires proposed_config_deprecated_use_suggested_config alongside the alias", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><p>x</p></body></html>\n',
      );
      const { response } = await callBootstrap({ cwd: dir });
      // Sanity: the alias is on the response.
      expect(typeof response.proposedConfig).toBe("string");
      expect(response.proposedConfig).toBe(response.suggestedConfig);
      // Deprecation code rides alongside.
      expect(response.warnings).toBeDefined();
      expect(response.warnings).toContain("proposed_config_deprecated_use_suggested_config");
    });
  });

  // Pair: when the propose_config leg fails and the alias is omitted,
  // the deprecation code MUST also drop. Emitting the warning without
  // the alias would direct agents at a non-existent migration —
  // ambiguous-shape territory.
  it("omits the deprecation code when proposedConfig is not emitted", async () => {
    const originalPropose = proposeConfigTool.handler;
    (proposeConfigTool as { handler: unknown }).handler = () => {
      throw new Error("forced-propose-failure");
    };
    try {
      await withScratch(async (dir) => {
        await writeFile(
          join(dir, "index.html"),
          '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body></body></html>\n',
        );
        const { response } = await callBootstrap({ cwd: dir });
        expect(response.suggestedConfig).toBeUndefined();
        expect(response.proposedConfig).toBeUndefined();
        expect(response.warnings ?? []).not.toContain(
          "proposed_config_deprecated_use_suggested_config",
        );
      });
    } finally {
      (proposeConfigTool as { handler: unknown }).handler = originalPropose;
    }
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
      await writeFile(join(dir, "NOTES.txt"), "nothing to scan\n");
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
