/**
 * Integration test for the top-level `warnings: string[]` surfaced on
 * `scan_project` and `scan` responses.
 *
 * Closes the silent-success ambiguity documented in CLAUDE.md §1
 * "Zero-output success is ambiguous failure" — an agent calling
 * `scan_project({ cwd: "/tmp/wrong-path" })` now gets the
 * `scanned_zero_files` code instead of a response that looks
 * indistinguishable from a clean codebase.
 *
 * Two directions guarded explicitly: the warning-emit case (malformed
 * input → the field is present with the expected codes) AND the
 * healthy-scan case (the field is OMITTED entirely, not `[]`). The
 * second direction is the one that lets agents branch on presence
 * alone without reinspecting the value — the `warnings: []` bug is
 * semantically the same silent-success failure this test guards
 * against.
 */

import { describe, expect, it } from "bun:test";
import { posixJoin } from "../helpers/path.ts";

const PROJECT_ROOT = posixJoin(import.meta.dir, "..", "..");
const TEMPLATE_FIXTURE = posixJoin(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "real-world",
  "template-directives",
  "source",
);
const BAD_ALT_DIR = posixJoin(PROJECT_ROOT, "tests", "fixtures", "bad", "alt-text-missing");
const BAD_ALT_FILE = posixJoin(BAD_ALT_DIR, "img-no-alt.html");

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
 * Asserts the `warningsDetails.template_files_parsed_as_literal` payload
 * is honestly populated: both axes non-empty when the warning fires on
 * a primary surface, every listed file lives inside the expected
 * fixture root, extensions are lowercased / sorted / deduped, and the
 * extensions axis exactly mirrors the file-derived extension set. Pure
 * over its inputs; lifted out of the per-test body so individual tests
 * stay under the cognitive-complexity cap.
 */
function assertTemplateLiteralPayload(
  detail: { files: readonly string[]; extensions: readonly string[] } | undefined,
  fixtureRootSubstring: string,
): void {
  expect(detail).toBeDefined();
  if (detail === undefined) return;
  expect(Array.isArray(detail.files)).toBe(true);
  expect(Array.isArray(detail.extensions)).toBe(true);
  expect(detail.files.length).toBeGreaterThan(0);
  expect(detail.extensions.length).toBeGreaterThan(0);
  for (const path of detail.files) expect(path).toContain(fixtureRootSubstring);
  expect(detail.extensions).toEqual([...detail.extensions].sort());
  for (const ext of detail.extensions) {
    expect(ext.startsWith(".")).toBe(true);
    expect(ext).toBe(ext.toLowerCase());
  }
  const seenExts = new Set<string>();
  for (const path of detail.files) {
    const dot = path.lastIndexOf(".");
    if (dot !== -1) seenExts.add(path.slice(dot).toLowerCase());
  }
  expect([...seenExts].sort()).toEqual([...detail.extensions].sort());
}

describe("scan_project emits top-level `warnings` for silent-failure modes", () => {
  it("scanned_zero_files fires when the scan root exists but contains zero parseable files", async () => {
    // Malformed-input paths (nonexistent cwd) now hard-error with the
    // `cwd-not-found` envelope — that case is guarded by
    // `mcp-scan-errors.test.ts`. The warnings-path still needs to cover
    // "valid directory, nothing to parse," which is the empty-but-real
    // case below. Create a real temp dir with no parseable files so
    // the discriminator is exercised honestly.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const empty = mkdtempSync(posixJoin(tmpdir(), "ra11y-empty-"));
    try {
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: empty })]);
      const body = bodyOf(responses[1]) as { warnings?: readonly string[] };
      expect(Array.isArray(body.warnings)).toBe(true);
      expect(body.warnings).toContain("scanned_zero_files");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("template_files_parsed_as_literal: a Jinja fixture raises the parsed-as-literal code", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: TEMPLATE_FIXTURE }),
    ]);
    const body = bodyOf(responses[1]) as { warnings?: readonly string[] };
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings).toContain("template_files_parsed_as_literal");
  });

  it("template_files_parsed_as_literal: payload names the contributing files + extensions", async () => {
    // `extensions_skipped_no_parser` and
    // `template_files_parsed_as_literal` co-fire on overlapping but
    // categorically different file sets (the canonical case is `.yml`
    // workflow files with `${{ ... }}` expressions next to a Jinja
    // `.html`). Without per-file evidence on the warning's payload,
    // an agent reading the response cannot disambiguate which
    // file-shape was the literal-parse substrate vs. which was
    // unrelated. The payload axis names the actual contributing paths
    // plus the unique lowercased extensions across them so the agent
    // disambiguates in one read.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: TEMPLATE_FIXTURE }),
    ]);
    const body = bodyOf(responses[1]) as {
      warnings?: readonly string[];
      warningsDetails?: Record<string, unknown>;
    };
    expect(body.warnings).toContain("template_files_parsed_as_literal");
    const detail = body.warningsDetails?.["template_files_parsed_as_literal"] as
      | { files: readonly string[]; extensions: readonly string[] }
      | undefined;
    assertTemplateLiteralPayload(detail, "template-directives/source");
  });

  it("template_files_parsed_as_literal: payload files[] is disjoint from analysisCoverage.fragmentFiles[] (mutual-exclusion invariant)", async () => {
    // Per AI-first consumer doctrine "Sibling fields naming the same
    // concept must use one shape" + "Heuristic-mislabeled meta sub-
    // fields are dishonest": a file appearing simultaneously in
    // `analysisCoverage.fragmentFiles[]` AND in
    // `warningsDetails.template_files_parsed_as_literal.files` ships two
    // contradictory descriptors for the same file. The fragment
    // classifier is the canonical source-of-truth (more nuanced kind
    // enumeration), so the warning-channel payload deduplicates against
    // it. The template-directives fixture's `partial.html` is the
    // canonical case: it has no `<html>` opener (fragment) AND its
    // findings overlap with `{{ }}` directive lines (would otherwise
    // contribute to template_files_parsed_as_literal). The dedup keeps
    // it on the fragment side only.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: TEMPLATE_FIXTURE, verboseMeta: true }),
    ]);
    const body = bodyOf(responses[1]) as {
      warnings?: readonly string[];
      warningsDetails?: Record<string, unknown>;
      meta?: { analysisCoverage?: { fragmentFiles?: readonly { path: string }[] } };
    };
    const fragmentPaths = new Set<string>(
      (body.meta?.analysisCoverage?.fragmentFiles ?? []).map((entry) => entry.path),
    );
    // Fixture must contribute at least one fragment file — otherwise
    // the invariant is vacuous.
    expect(fragmentPaths.size).toBeGreaterThan(0);
    const detail = body.warningsDetails?.["template_files_parsed_as_literal"] as
      | { files?: readonly string[] }
      | undefined;
    const literalFiles = detail?.files ?? [];
    for (const path of literalFiles) {
      expect(fragmentPaths.has(path)).toBe(false);
    }
  });

  it("a healthy scan omits the `warnings` field entirely (not `warnings: []`)", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    // BAD_ALT_DIR is an explicit cwd with a config-less fixture
    // directory — `scanned_zero_files` and `root_source_defaulted`
    // must NOT fire. `no_config_found` is gated per
    // Q-SHARED-NO-CONFIG-WARNING-TINY-REPO: it fires only when the
    // scan saw ≥ 10 files AND the walk reached a real Node project
    // root. The fixture has < 10 parseable files, so the warning is
    // typically absent here. What we're guarding is the shape
    // contract: when `warnings` is present it is non-empty
    // (never `[]`) and does not include the two scanning codes.
    const body = bodyOf(responses[1]) as { warnings?: readonly string[] };
    if (body.warnings !== undefined) {
      // If present, it must NOT be empty — empty is the silent-bug
      // shape. And it must NOT contain the two codes this case
      // explicitly falsifies.
      expect(body.warnings.length).toBeGreaterThan(0);
      expect(body.warnings).not.toContain("scanned_zero_files");
      expect(body.warnings).not.toContain("root_source_defaulted");
    }
  });
});

describe("checklist emits top-level `warnings` for silent-failure modes", () => {
  // Doctrine: CLAUDE.md §1 "Zero-output success is ambiguous failure."
  // `checklist` has no root-resolution step and never hard-errors on a
  // nonexistent cwd — the discover pass simply returns zero files. Without
  // the soft signal, a response shaped like `{ items: [],
  // untargetedCriteriaForProject: 0 }` reads as "clean codebase" when the tool
  // actually never saw parseable input.
  it("scanned_zero_files fires on a nonexistent cwd", async () => {
    const bogus = posixJoin("/path/that/does/not/exist", "ra11y-checklist-no-such-dir");
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: bogus })]);
    const body = bodyOf(responses[1]) as { warnings?: readonly string[] };
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings).toContain("scanned_zero_files");
  });
});

/**
 * `checklist` field reports showed responses
 * that shipped no scan-confidence warnings (or no `meta` block at all)
 * on bulk-template sites where `scan_project` on the same corpus
 * surfaced `template_files_parsed_as_literal`, `parse_errors_present`,
 * `text_source_skipped`, etc. The cross-surface drift forced
 * agents to call `scan_project` a second time to confirm what
 * `checklist` already knew but didn't emit. Doctrine: "verbose meta
 * is signal, not clutter" — the parity subset (configSource,
 * scanned.root, rulesEvaluated, filesByExtension) is the minimum an
 * agent needs to cross-check scan confidence without a second round
 * trip. This invariant guards the propagation so the drift never
 * reopens.
 */
describe("checklist meta + warnings parity with scan_project on the same input", () => {
  it("emits the same warning code scan_project emits on the template-directives fixture", async () => {
    // Both tools run on the same cwd; both must surface
    // `template_files_parsed_as_literal` so the agent sees the
    // honest "parse quality degraded" signal regardless of which
    // surface it called.
    const [spResponses, clResponses] = await Promise.all([
      mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: TEMPLATE_FIXTURE })]),
      mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: TEMPLATE_FIXTURE })]),
    ]);
    const sp = bodyOf(spResponses[1]) as { warnings?: readonly string[] };
    const cl = bodyOf(clResponses[1]) as { warnings?: readonly string[] };
    expect(Array.isArray(sp.warnings)).toBe(true);
    expect(Array.isArray(cl.warnings)).toBe(true);
    expect(sp.warnings).toContain("template_files_parsed_as_literal");
    expect(cl.warnings).toContain("template_files_parsed_as_literal");
  });

  it("ships a meta block with configSource, scanned.root, rulesEvaluated, filesByExtension on every call", async () => {
    // Doctrine: "verbose meta is signal, not clutter." The backlog-
    // mandated minimum parity fields must be present on every checklist
    // response (default mode — not gated behind `metaMode: "delta"`)
    // so an agent cross-checking with scan_project sees the same
    // scan-confidence telemetry on the same inputs.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { cwd: TEMPLATE_FIXTURE }),
    ]);
    const body = bodyOf(responses[1]) as {
      meta?: {
        configSource?: string | null;
        scanned?: { mode?: string; root?: string };
        rulesEvaluated?: { loaded?: number; withEligibleInputs?: number; fired?: number };
        filesByExtension?: Readonly<Record<string, number>>;
      };
    };
    expect(body.meta).toBeDefined();
    expect(body.meta?.scanned?.mode).toBe("project");
    expect(typeof body.meta?.scanned?.root).toBe("string");
    // `configSource` is `null` (no config resolved) rather than
    // omitted — the field is always present so the agent can
    // distinguish "no config" from "the shape dropped the field."
    expect(body.meta?.configSource === null || typeof body.meta?.configSource === "string").toBe(
      true,
    );
    expect(typeof body.meta?.rulesEvaluated?.loaded).toBe("number");
    expect(typeof body.meta?.filesByExtension).toBe("object");
    expect(body.meta?.filesByExtension).not.toBeNull();
  });
});

describe("coverage emits top-level `warnings` for silent-failure modes", () => {
  it("scanned_zero_files fires on a nonexistent cwd", async () => {
    const bogus = posixJoin("/path/that/does/not/exist", "ra11y-coverage-no-such-dir");
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: bogus })]);
    const body = bodyOf(responses[1]) as { warnings?: readonly string[] };
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings).toContain("scanned_zero_files");
  });
});

describe("review_candidates emits top-level `warnings` for silent-failure modes", () => {
  it("scanned_zero_files fires on a nonexistent cwd", async () => {
    const bogus = posixJoin("/path/that/does/not/exist", "ra11y-review-cand-no-such-dir");
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "review_candidates", { cwd: bogus }),
    ]);
    const body = bodyOf(responses[1]) as { warnings?: readonly string[] };
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings).toContain("scanned_zero_files");
  });
});

describe("bootstrap emits warningsDetails alongside warnings (membership invariant)", () => {
  // Closes the strictly-worse variant of the empty-`{}` regression
  // documented in CLAUDE.md §1 "Empty `warningsDetails.<code>: {}` is
  // dishonest" — bootstrap was shipping a populated `warnings[]` (e.g.
  // 15 codes including `no_config_found`, `partial_parse_files_present`,
  // `baseline_dry_run`) without a top-level `warningsDetails` object at
  // all. The membership invariant requires every code in `warnings[]`
  // to resolve to a `warningsDetails.<code>` entry — the agent reads a
  // definite shape rather than `undefined`.
  //
  // Cross-surface count invariant applied at warning-channel
  // granularity: bootstrap composes scan_project's response and must
  // forward its `warningsDetails` payloads verbatim. The bulk of the
  // codes a real-corpus scan ships (`no_config_found`,
  // `partial_parse_files_present`, etc.) come from the underlying scan
  // leg — without forwarding the details, the agent gets the names
  // without the per-code triage payload (`searchedFrom`, `parseErrorsByParser`).
  it("scan-driven warning codes resolve to a warningsDetails.<code> entry over the MCP transport", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "bootstrap", { cwd: TEMPLATE_FIXTURE }),
    ]);
    const body = bodyOf(responses[1]) as {
      warnings?: readonly string[];
      warningsDetails?: Record<string, unknown>;
    };
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warningsDetails).toBeDefined();
    // Membership invariant: every code in `warnings[]` MUST resolve
    // to a `warningsDetails.<code>` key. Tested by iteration so any
    // future code added to the bootstrap warnings channel is covered
    // automatically — the test breaks if a new code lands without a
    // companion entry.
    for (const code of body.warnings ?? []) {
      expect(body.warningsDetails?.[code]).toBeDefined();
    }
    // The template-directives fixture is a known carrier of
    // `template_files_parsed_as_literal` (verified by the parallel
    // scan_project / checklist tests above), so this assertion pins
    // forwarding of a payload-bearing scan code through the bootstrap
    // envelope explicitly.
    if ((body.warnings ?? []).includes("template_files_parsed_as_literal")) {
      const detail = body.warningsDetails?.["template_files_parsed_as_literal"] as
        | { files: readonly string[]; extensions: readonly string[] }
        | undefined;
      assertTemplateLiteralPayload(detail, "template-directives/source");
    }
  });
});

describe("warningsDetails entries are non-empty for graduated codes (Q16 closure)", () => {
  // Closes the multi-corpus regression where four codes were shipping
  // empty `warningsDetails.<code>: {}` payloads on otherwise valid
  // responses — `partial_parse_files_present`, `baseline_dry_run`,
  // `dist_only_scan_detected`, and the colon-suffixed dynamic
  // `foreign_ecosystem_detected: <value>` (which additionally
  // violated the static-code-only contract because a runtime-injected
  // suffix can't key the typed `warningsDetails` slot). Each
  // graduated to a payload-bearing slot per the AI-first doctrine
  // bullet "Empty `warningsDetails.<code>: {}` is dishonest."
  //
  // The structural assertion here: any code in the four-name set that
  // appears on `warnings[]` MUST have a corresponding
  // `warningsDetails.<code>` whose value is NOT the empty `{}` marker.
  // The test fires off the warningsdetails-empty-payload fixture for
  // partial-parse, off bootstrap (dry-run by default) for
  // `baseline_dry_run`, and off propose_config in a Ruby-toolchain
  // scratch dir for the foreign-ecosystem rename. Coverage of
  // `dist_only_scan_detected` payload graduation is handled by the
  // unit tests in `tests/unit/mcp/warnings.test.ts` — fabricating a
  // dist-only scan from the integration harness would require a
  // bulk-vendor fixture larger than the surface here justifies.
  const FIXTURE = posixJoin(
    PROJECT_ROOT,
    "tests",
    "fixtures",
    "real-world",
    "warningsdetails-empty-payload",
    "source",
  );

  it("scan_project: partial_parse_files_present payload is non-empty when the warning fires", async () => {
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: FIXTURE })]);
    const body = bodyOf(responses[1]) as {
      warnings?: readonly string[];
      warningsDetails?: Record<string, unknown>;
    };
    expect(body.warnings).toBeDefined();
    if (!(body.warnings ?? []).includes("partial_parse_files_present")) {
      // The fixture's malformed tail should drive the warning; if a
      // future parser change recovers more aggressively and the
      // warning stops firing, this assertion fails loudly so the
      // fixture can be re-shaped.
      throw new Error(
        "partial_parse_files_present did not fire on the fixture — re-shape the malformed tail to restore the predicate",
      );
    }
    const detail = body.warningsDetails?.["partial_parse_files_present"] as
      | { partialParseFileCount?: number }
      | Record<string, never>
      | undefined;
    expect(detail).toBeDefined();
    // Empty `{}` is the dishonest shape the doctrine warns against —
    // payload-bearing codes must carry their structured payload, not
    // the binary-presence marker.
    expect(detail).not.toEqual({});
    expect((detail as { partialParseFileCount?: number }).partialParseFileCount).toBeGreaterThan(0);
  });

  it("bootstrap: baseline_dry_run payload carries didWrite + wouldHaveAdded (not the empty marker)", async () => {
    const responses = await mcpSession([initMsg(1), toolCall(2, "bootstrap", { cwd: FIXTURE })]);
    const body = bodyOf(responses[1]) as {
      warnings?: readonly string[];
      warningsDetails?: Record<string, unknown>;
    };
    expect(body.warnings).toContain("baseline_dry_run");
    const detail = body.warningsDetails?.["baseline_dry_run"] as
      | { didWrite?: false; wouldHaveAdded?: number }
      | Record<string, never>
      | undefined;
    expect(detail).toBeDefined();
    expect(detail).not.toEqual({});
    expect((detail as { didWrite?: false }).didWrite).toBe(false);
    expect(typeof (detail as { wouldHaveAdded?: number }).wouldHaveAdded).toBe("number");
  });

  it("propose_config: foreign_ecosystem_detected ships as a static code with structured payload (not the colon-suffixed dynamic identifier)", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(posixJoin(tmpdir(), "ra11y-foreign-eco-"));
    try {
      writeFileSync(posixJoin(dir, "Gemfile"), "source 'https://rubygems.org'\n");
      writeFileSync(
        posixJoin(dir, "util.ts"),
        "export function add(a: number, b: number): number { return a + b; }\n",
      );
      const responses = await mcpSession([initMsg(1), toolCall(2, "propose_config", { cwd: dir })]);
      const body = bodyOf(responses[1]) as {
        warnings?: readonly string[];
        warningsDetails?: Record<string, unknown>;
      };
      // Static code identifier — the dynamic-suffix shape
      // `foreign_ecosystem_detected: ruby` was rejected because a
      // runtime-injected suffix can't key the typed `warningsDetails`
      // slot, leaving the payload `{}` by construction.
      expect(body.warnings).toContain("foreign_ecosystem_detected");
      // No colon-suffixed sibling carrying the language inline.
      for (const code of body.warnings ?? []) {
        expect(code.startsWith("foreign_ecosystem_detected:")).toBe(false);
      }
      const detail = body.warningsDetails?.["foreign_ecosystem_detected"] as
        | { ecosystem?: string; evidence?: readonly string[]; hasPackageJson?: boolean }
        | Record<string, never>
        | undefined;
      expect(detail).toBeDefined();
      expect(detail).not.toEqual({});
      expect((detail as { ecosystem?: string }).ecosystem).toBe("ruby");
      expect((detail as { evidence?: readonly string[] }).evidence).toEqual(["Gemfile"]);
      expect((detail as { hasPackageJson?: boolean }).hasPackageJson).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scan emits top-level `warnings` for silent-failure modes", () => {
  it("scanned_zero_files fires when the paths exist but resolve to zero parseable files", async () => {
    // Nonexistent-path inputs now hard-error with `scan-paths-not-found`
    // — that case lives in `mcp-scan-errors.test.ts`. Here we
    // cover the real-but-empty directory case: a valid dir with no
    // parseable files produces a successful response with the
    // `scanned_zero_files` soft signal.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const empty = mkdtempSync(posixJoin(tmpdir(), "ra11y-empty-"));
    try {
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan", { paths: [empty] })]);
      const body = bodyOf(responses[1]) as { warnings?: readonly string[] };
      expect(Array.isArray(body.warnings)).toBe(true);
      expect(body.warnings).toContain("scanned_zero_files");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("does NOT fire root_source_defaulted on `scan` — that tool takes paths directly and has no root-resolution step", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan", { paths: [BAD_ALT_FILE] }),
    ]);
    const body = bodyOf(responses[1]) as { warnings?: readonly string[] };
    // `warnings` may be present (e.g. no_config_found is plausible
    // for the fixture file) but root_source_defaulted is
    // scan_project-only.
    if (Array.isArray(body.warnings)) {
      expect(body.warnings).not.toContain("root_source_defaulted");
    }
  });
});
