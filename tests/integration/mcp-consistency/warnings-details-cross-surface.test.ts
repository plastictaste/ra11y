/**
 * Cross-surface invariant:
 * warning codes carried across scan_project / scan_file / coverage /
 * checklist must ship the same `warningsDetails[code]` shape on
 * identical inputs, or OMIT the code entirely from surfaces that
 * cannot compute its canonical detail payload.
 *
 * Doctrine:
 *   - `ai-first-consumer.md` §"One tool call should answer 'what next?'":
 *     cross-surface drift (`coverage` surfaces a warning + payload,
 *     `checklist` silently drops both) forces wasted round trips.
 *   - `ai-first-consumer.md` §"Ambiguous field shapes are dishonest":
 *     if a surface emits code `X` without the paired `warningsDetails[X]`
 *     payload its siblings emit, downstream consumers can't tell
 *     "unavailable" from "genuinely empty."
 *   - `ai-first-consumer.md` §"Zero-output success is ambiguous failure":
 *     the response-level analogue of the per-field rule — if `scan_project`
 *     emits `text_source_skipped` + `warningsDetails` but
 *     `checklist` emits `warnings: ["no_config_found"]` alone on the
 *     same scan, the agent has no way to discover the skipped-extension
 *     signal without a second `scan_project` round trip.
 *
 * Surface taxonomy (taught by this test):
 *   - `scan_project`: full discovery + project root → emits the full
 *     warning battery including discovery-dependent codes.
 *   - `coverage`: full discovery → same discovery-dependent codes as
 *     scan_project (`text_source_skipped`, etc.).
 *   - `checklist`: full discovery → MUST match coverage on shared
 *     discovery codes (this is what this test was written to enforce).
 *   - `scan_file`: single-file, no discovery → cannot compute
 *     discovery-only codes like `text_source_skipped`; omits
 *     them entirely per the "present-when-meaningful" rule.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");

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

function body<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

interface ExtensionsSkippedPayload {
  readonly extensions: readonly string[];
  // Per-extension count breakdown of the dotted-extensions slice,
  // present-when-meaningful (omitted when `extensions: []`).
  readonly perExtensionCounts?: Readonly<Record<string, number>>;
  // Present-when-meaningful: omitted when `extensions: []` (e.g. a
  // corpus where only no-extension filenames fired the warning).
  readonly topExtension?: string;
  readonly topCount?: number;
  readonly totalSkipped: number;
}

interface WarningsEnvelope {
  readonly warnings?: readonly string[];
  readonly warningsDetails?: {
    readonly text_source_skipped?: ExtensionsSkippedPayload;
    readonly sourcemap_files_excluded?: {
      readonly count: number;
      readonly topPaths: readonly string[];
    };
    readonly content_files_skipped?: { readonly count: number };
    readonly source_language_unsupported?: { readonly language: string };
    readonly vendor_css_dominates_findings?: { readonly vendorFindingsCount: number };
    readonly response_token_budget_truncated?: { readonly requestedLimit: number };
    readonly erb_islands_unrendered?: {
      readonly fileCount: number;
      readonly fileList: readonly string[];
      readonly reason: string;
    };
    readonly astro_islands_unrendered?: {
      readonly fileCount: number;
      readonly fileList: readonly string[];
      readonly reason: string;
    };
  };
}

/**
 * Makes a fixture that drops at least one `.vue` file into the scan
 * root so discovery records an `text_source_skipped` signal.
 * We also seed one real HTML file so the scan has findings to report —
 * otherwise the response is dominated by `scanned_zero_files` and the
 * payload-bearing codes never fire. `.vue` is chosen over `.scss` /
 * `.md` because both of those were added to `PARSEABLE_EXTENSIONS` —
 * `.vue` remains a canonical non-parseable Web-framework extension so
 * the skip counter fires deterministically regardless of future
 * parser additions.
 */
async function makeSkippedExtensionFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-xsurface-warn-"));
  // Real parseable file — ensures the scan finishes with findings and
  // the response is the "at least one file parsed" shape.
  await writeFile(
    join(dir, "page.html"),
    `<html><body><img src="a.png"><p>hello</p></body></html>`,
  );
  // Unparseable-by-scanner file — drives the skip signal.
  await writeFile(join(dir, "component.vue"), `<template><div>hi</div></template>`);
  return dir;
}

/**
 * Fixture seeding `text_source_skipped` with multiple distinct
 * unparseable text-source extensions so the per-extension breakdown
 * has data to enforce. The `.coffee` and `.rmd` substrates are both
 * parser-routable text-island extensions but NOT yet routed; the
 * `.xml` substrate is data-only. Without `perExtensionCounts` an
 * agent reading the warning would see `topExtension: ".xml"` and
 * have no signal for the `.coffee` and `.rmd` actionable subsets.
 */
async function makeMultiExtensionSkippedFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-xsurface-multiext-"));
  await writeFile(
    join(dir, "page.html"),
    `<html><body><img src="a.png" alt="alt"><p>hello</p></body></html>`,
  );
  // Multiple distinct text-source extensions, none parseable by ra11y.
  await writeFile(join(dir, "report.rmd"), `# R Markdown\n\nbody\n`);
  await writeFile(join(dir, "module.coffee"), `console.log "hi"\n`);
  await writeFile(join(dir, "feed.xml"), `<?xml version="1.0"?><feed/>\n`);
  return dir;
}

/**
 * Fixture seeding `sourcemap_files_excluded` — drops two `.map`
 * sourcemap files alongside one parseable HTML file. The discovery
 * walker routes the `.map` files into the dedicated
 * `analysisCoverage.sourcemapFiles` bucket so the warning declares
 * the conventional sourcemap exclusion explicitly. Mirrors the
 * canonical CSS-framework corpus shape (sibling `.css.map` /
 * `.js.map` to authored output) at the smallest size that fires the
 * predicate on every project-rooted tool.
 */
async function makeSourcemapFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-xsurface-srcmap-"));
  await writeFile(
    join(dir, "page.html"),
    `<html><body><img src="a.png" alt="alt"><p>hi</p></body></html>`,
  );
  await writeFile(join(dir, "app.css.map"), `{"version":3,"sources":[]}`);
  await writeFile(join(dir, "vendor.js.map"), `{"version":3,"sources":[]}`);
  return dir;
}

/**
 * Fixture seeding `erb_islands_unrendered` — drops two `.erb`
 * Rails-style view templates carrying `<%= … %>` and `<% … %>`
 * islands. The HTML parser's `stripTemplateDirectives` pass blanks
 * the islands so any aria/role/label attribute the islands would
 * have injected at render time is invisible to the static scan;
 * the per-file evidence accumulator records both files and the
 * warning channel surfaces the routing-decision telemetry. Mirrors
 * `makeSourcemapFixture` shape — also seeds one parseable HTML page
 * so the response carries the "real scan" framing.
 */
async function makeErbIslandsFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-xsurface-erb-"));
  await writeFile(
    join(dir, "page.html"),
    `<html><body><img src="a.png" alt="alt"><p>hi</p></body></html>`,
  );
  await writeFile(join(dir, "show.erb"), `<div <%= aria_attrs %>>\n  <p>Welcome</p>\n</div>\n`);
  await writeFile(
    join(dir, "edit.erb"),
    `<% if logged_in? %>\n  <button <%= "aria-expanded=#{expanded}" %>>Edit</button>\n<% end %>\n`,
  );
  return dir;
}

/**
 * Fixture seeding `astro_islands_unrendered` — drops two `.astro`
 * Astro page files carrying frontmatter fences AND capitalized
 * component-tag openers (`<Layout>`). The Astro adapter blanks the
 * frontmatter and the HTML parser leaves imported components
 * unrendered, so any aria/role/label attribute or visible text the
 * components would have produced at render time is invisible to the
 * static scan; the per-file evidence accumulator records both files
 * and the warning channel surfaces the routing-decision telemetry.
 * Mirrors `makeErbIslandsFixture` shape — also seeds one parseable
 * HTML page so the response carries the "real scan" framing.
 */
async function makeAstroIslandsFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-xsurface-astro-"));
  await writeFile(
    join(dir, "page.html"),
    `<html><body><img src="a.png" alt="alt"><p>hi</p></body></html>`,
  );
  await writeFile(
    join(dir, "index.astro"),
    `---\nconst title = "Welcome";\n---\n<Layout title={title}>\n  <h1>{title}</h1>\n</Layout>\n`,
  );
  await writeFile(
    join(dir, "about.astro"),
    `---\nimport Header from "../components/Header.astro";\n---\n<Header />\n<main>\n  <h1>About</h1>\n</main>\n`,
  );
  return dir;
}

/**
 * Projects a surface's response body down to the shared warnings
 * envelope. Every surface in scope must satisfy this shape; fields are
 * optional because "omit when no code fires" is the correct honest
 * behavior (present-when-meaningful rule).
 */
function warningsEnvelope(raw: Record<string, unknown>): WarningsEnvelope {
  const warnings = Array.isArray(raw["warnings"])
    ? (raw["warnings"] as readonly string[])
    : undefined;
  const details = raw["warningsDetails"] as WarningsEnvelope["warningsDetails"] | undefined;
  return {
    ...(warnings === undefined ? {} : { warnings }),
    ...(details === undefined ? {} : { warningsDetails: details }),
  };
}

/**
 * Codes whose emission is tied to full discovery (a project walk that
 * classifies files by extension). `scan_file` takes a single file and
 * never runs discovery — it MUST omit these codes entirely per the
 * task doctrine.
 */
const DISCOVERY_DEPENDENT_CODES: readonly string[] = [
  "text_source_skipped",
  "binary_assets_skipped",
  "sourcemap_files_excluded",
  "content_files_skipped",
  "source_language_unsupported",
  "tailwind_detected_css_undercounted",
  "template_files_parsed_as_literal",
] as const;

describe("warnings + warningsDetails coherence across scan_project / scan_file / coverage / checklist", () => {
  it("scan_project, coverage, and checklist emit the same sourcemap_files_excluded payload on the same scan root", async () => {
    const dir = await makeSourcemapFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const scanProj = warningsEnvelope(body<Record<string, unknown>>(responses[1]));
    const coverage = warningsEnvelope(body<Record<string, unknown>>(responses[2]));
    const checklist = warningsEnvelope(body<Record<string, unknown>>(responses[3]));

    // Sanity: predicate fires on scan_project, otherwise the cross-
    // surface invariant below is vacuously true.
    expect(scanProj.warnings ?? []).toContain("sourcemap_files_excluded");

    const scanProjPayload = scanProj.warningsDetails?.sourcemap_files_excluded;
    const coveragePayload = coverage.warningsDetails?.sourcemap_files_excluded;
    const checklistPayload = checklist.warningsDetails?.sourcemap_files_excluded;

    expect(scanProjPayload).toBeDefined();
    expect(coveragePayload).toBeDefined();
    expect(checklistPayload).toBeDefined();

    // Same fixture → identical payload across all three surfaces.
    // Cross-surface drift (one tool counts 2 sourcemaps while another
    // counts 1) would silently mislead an agent budgeting against the
    // first tool's headline before calling the second.
    expect(coveragePayload).toEqual(scanProjPayload);
    expect(checklistPayload).toEqual(scanProjPayload);

    // Payload shape sanity — count is 2 (.css.map + .js.map),
    // topPaths are sorted ascending.
    expect(scanProjPayload?.count).toBe(2);
    expect(scanProjPayload?.topPaths.length).toBe(2);
    expect(scanProjPayload?.topPaths[0]).toMatch(/app\.css\.map$/);
    expect(scanProjPayload?.topPaths[1]).toMatch(/vendor\.js\.map$/);
  });

  it("scan_project, coverage, and checklist emit the same text_source_skipped payload on the same scan root", async () => {
    const dir = await makeSkippedExtensionFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const scanProj = warningsEnvelope(body<Record<string, unknown>>(responses[1]));
    const coverage = warningsEnvelope(body<Record<string, unknown>>(responses[2]));
    const checklist = warningsEnvelope(body<Record<string, unknown>>(responses[3]));

    // Sanity: the fixture does trigger the code on scan_project —
    // otherwise the invariant below is vacuously true.
    expect(scanProj.warnings ?? []).toContain("text_source_skipped");

    // Cross-surface rule: any surface that runs full discovery and
    // emits `text_source_skipped` must carry the same
    // structured payload. Deep-equal the payload so field shape drift
    // (e.g., a surface dropping `topCount` while another keeps it) is
    // caught.
    const scanProjPayload = scanProj.warningsDetails?.text_source_skipped;
    const coveragePayload = coverage.warningsDetails?.text_source_skipped;
    const checklistPayload = checklist.warningsDetails?.text_source_skipped;

    expect(scanProjPayload).toBeDefined();
    expect(coveragePayload).toBeDefined();
    expect(checklistPayload).toBeDefined();

    // All three surfaces see the same `.scss` file → identical payload.
    expect(coveragePayload).toEqual(scanProjPayload);
    expect(checklistPayload).toEqual(scanProjPayload);
  });

  it("scan_project, coverage, and checklist agree on the per-extension breakdown of text_source_skipped (one-level-deeper cross-surface invariant)", async () => {
    // The deep-equal already exists for the canonical text-source
    // payload; this test pins the per-extension breakdown specifically
    // so a future regression that drops `perExtensionCounts` from one
    // surface (or computes it differently) is caught at the field
    // level. Per AI-first doctrine "Cross-surface count invariant":
    // every conceptual counter shipping from multiple project-rooted
    // tools must agree on the same input.
    const dir = await makeMultiExtensionSkippedFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const scanProj = warningsEnvelope(body<Record<string, unknown>>(responses[1]));
    const coverage = warningsEnvelope(body<Record<string, unknown>>(responses[2]));
    const checklist = warningsEnvelope(body<Record<string, unknown>>(responses[3]));

    expect(scanProj.warnings ?? []).toContain("text_source_skipped");

    const scanProjPayload = scanProj.warningsDetails?.text_source_skipped;
    const coveragePayload = coverage.warningsDetails?.text_source_skipped;
    const checklistPayload = checklist.warningsDetails?.text_source_skipped;

    expect(scanProjPayload?.perExtensionCounts).toBeDefined();
    expect(coveragePayload?.perExtensionCounts).toBeDefined();
    expect(checklistPayload?.perExtensionCounts).toBeDefined();

    // All three surfaces walked the same fixture — per-extension
    // counts must match.
    expect(coveragePayload?.perExtensionCounts).toEqual(scanProjPayload?.perExtensionCounts);
    expect(checklistPayload?.perExtensionCounts).toEqual(scanProjPayload?.perExtensionCounts);

    // Sanity: the breakdown enumerates every actionable extension with
    // its true file count — one each for `.rmd`, `.coffee`, `.xml`.
    expect(scanProjPayload?.perExtensionCounts).toEqual({
      ".coffee": 1,
      ".rmd": 1,
      ".xml": 1,
    });
    // The headline scalar still derives from the dominant entry —
    // ties in this fixture break alphabetically, so `.coffee` wins.
    expect(scanProjPayload?.topExtension).toBe(".coffee");
    expect(scanProjPayload?.topCount).toBe(1);
  });

  it("every surface emitting `warnings: [code]` with a payload-bearing code also emits `warningsDetails[code]` (present-when-meaningful)", async () => {
    const dir = await makeSkippedExtensionFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const envelopes = [
      { name: "scan_project", env: warningsEnvelope(body<Record<string, unknown>>(responses[1])) },
      { name: "coverage", env: warningsEnvelope(body<Record<string, unknown>>(responses[2])) },
      { name: "checklist", env: warningsEnvelope(body<Record<string, unknown>>(responses[3])) },
    ];

    // warnings-details schema discipline: every fired code MUST
    // have a corresponding key on `warningsDetails`, regardless of
    // whether the code is payload-bearing or presence-only. The
    // membership invariant is the load-bearing contract: an agent
    // reading the wire can always look up `warningsDetails[code]`
    // and get a definite answer (rich payload OR `{}` marker)
    // without prior knowledge of the per-code classification.
    for (const { name, env } of envelopes) {
      for (const code of env.warnings ?? []) {
        const detailKey = code as keyof NonNullable<typeof env.warningsDetails>;
        const detail = env.warningsDetails?.[detailKey];
        expect(
          detail,
          `${name} emitted warnings[${code}] but warningsDetails.${code} is missing — schema-discipline invariant broken`,
        ).toBeDefined();
      }
      // Mirror direction: every key on `warningsDetails` must
      // correspond to a fired code in `warnings[]`. No stray keys.
      const detailKeys = Object.keys(env.warningsDetails ?? {});
      const warningCodes = new Set(env.warnings ?? []);
      for (const key of detailKeys) {
        expect(
          warningCodes.has(key),
          `${name} shipped warningsDetails.${key} without a matching code in warnings[] — membership invariant broken`,
        ).toBe(true);
      }
    }
  });

  it("every surface that emits codes ships `warningsDetails` keyed by every fired code (warnings-details schema discipline)", async () => {
    // Clean fixture: one well-formed HTML file, no discovery-skip
    // triggers. Per warnings-details schema discipline, every
    // fired code (rich-payload OR presence-only) must have a key on
    // `warningsDetails`. Surfaces that fire no codes at all omit
    // both fields entirely; surfaces that fire any code ship the
    // matched-keys map. The `{}` marker is the deterministic "no
    // further detail by design" signal — never the empty-sentinel
    // anti-pattern (`warningsDetails: {}` with zero keys).
    const dir = await mkdtemp(join(tmpdir(), "ra11y-xsurface-clean-"));
    await writeFile(
      join(dir, "page.html"),
      `<html><body><img src="a.png" alt="alt"><p>hello</p></body></html>`,
    );
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
      toolCall(5, "scan_file", { filePath: join(dir, "page.html") }),
    ]);
    const envelopes = [
      { name: "scan_project", env: warningsEnvelope(body<Record<string, unknown>>(responses[1])) },
      { name: "coverage", env: warningsEnvelope(body<Record<string, unknown>>(responses[2])) },
      { name: "checklist", env: warningsEnvelope(body<Record<string, unknown>>(responses[3])) },
      { name: "scan_file", env: warningsEnvelope(body<Record<string, unknown>>(responses[4])) },
    ];
    for (const { name, env } of envelopes) {
      const codes = env.warnings ?? [];
      if (codes.length === 0) {
        // Zero codes fired → `warningsDetails` must be absent
        // entirely (no empty-`{}` sentinel).
        expect(
          env.warningsDetails,
          `${name} shipped warningsDetails alongside warnings:[] — empty sentinel is forbidden`,
        ).toBeUndefined();
      } else {
        // At least one code fired → `warningsDetails` is present
        // with one entry per fired code.
        expect(
          env.warningsDetails,
          `${name} fired warnings but omitted warningsDetails — schema-discipline invariant broken`,
        ).toBeDefined();
        const detailKeys = Object.keys(env.warningsDetails ?? {}).sort();
        expect(detailKeys).toEqual([...codes].sort());
      }
    }
  });

  it("scan_file omits discovery-dependent warning codes entirely (single-file surface has no discovery phase)", async () => {
    // Doctrine (task notes): "If a surface can emit a warning code
    // but CANNOT compute the details that another surface provides
    // (e.g. scan_file is single-file so `text_source_skipped`
    // doesn't apply), OMIT the code entirely from that surface."
    //
    // Dropped `.scss` alongside the HTML file. `scan_project` /
    // `coverage` / `checklist` surface `text_source_skipped`
    // because they walk the directory; `scan_file` takes a single file
    // path and must not surface the discovery-only codes at all —
    // doing so without the paired payload would be the "bare code
    // without details" anti-pattern the task explicitly forbids.
    const dir = await makeSkippedExtensionFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { filePath: join(dir, "page.html") }),
    ]);
    const env = warningsEnvelope(body<Record<string, unknown>>(responses[1]));
    for (const code of DISCOVERY_DEPENDENT_CODES) {
      expect(
        env.warnings ?? [],
        `scan_file must not emit the discovery-only code ${code}`,
      ).not.toContain(code);
    }
  });

  it("scan_project, coverage, and checklist emit the same erb_islands_unrendered payload on the same scan root", async () => {
    // Cross-surface invariant for `erb_islands_unrendered`: the
    // routing-decision warning fires off a deterministic per-file
    // predicate (extension is `.erb` AND source carries an island
    // opener), so every project-rooted tool that walks the same cwd
    // must surface the same `{fileCount, fileList, reason}` payload.
    // Mirrors the `sourcemap_files_excluded` / `text_source_skipped`
    // cross-surface assertions above; without it, an agent calling
    // `checklist` first on an ERB-heavy Rails corpus would see no
    // signal that 14 view templates carried unscanned ERB-injected
    // attributes — the silent-miss failure mode the AI-first doctrine
    // calls out.
    const dir = await makeErbIslandsFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
      toolCall(5, "scan_file", { path: join(dir, "show.erb") }),
    ]);
    const scanProj = warningsEnvelope(body<Record<string, unknown>>(responses[1]));
    const coverage = warningsEnvelope(body<Record<string, unknown>>(responses[2]));
    const checklist = warningsEnvelope(body<Record<string, unknown>>(responses[3]));
    const scanFile = warningsEnvelope(body<Record<string, unknown>>(responses[4]));

    // Sanity: predicate fires on scan_project, otherwise the cross-
    // surface invariant below is vacuously true.
    expect(scanProj.warnings ?? []).toContain("erb_islands_unrendered");

    const scanProjPayload = scanProj.warningsDetails?.erb_islands_unrendered;
    const coveragePayload = coverage.warningsDetails?.erb_islands_unrendered;
    const checklistPayload = checklist.warningsDetails?.erb_islands_unrendered;

    expect(scanProjPayload).toBeDefined();
    expect(coveragePayload).toBeDefined();
    expect(checklistPayload).toBeDefined();

    // Same fixture → identical payload across all three project-rooted
    // surfaces. Cross-surface drift would silently mislead an agent
    // budgeting against the first tool's headline before calling the
    // second.
    expect(coveragePayload).toEqual(scanProjPayload);
    expect(checklistPayload).toEqual(scanProjPayload);

    // Payload shape sanity — count is 2 (show.erb + edit.erb) and
    // fileList is sorted ascending so the agent can scope follow-ups
    // deterministically. The `reason` text names the routing-decision
    // predicate so the agent has the load-bearing pivot in one read.
    expect(scanProjPayload?.fileCount).toBe(2);
    expect(scanProjPayload?.fileList.length).toBe(2);
    expect(scanProjPayload?.fileList[0]).toMatch(/edit\.erb$/);
    expect(scanProjPayload?.fileList[1]).toMatch(/show\.erb$/);
    expect(scanProjPayload?.reason).toMatch(/ERB tags not extracted/);

    // scan_file scopes to one .erb file — the predicate is per-file
    // (the file's own source carries an opener) so the warning still
    // fires on the single-file surface, with a count of 1 and a
    // fileList carrying just the scanned path. Cross-surface payload
    // shape is identical (same `{fileCount, fileList, reason}` keys),
    // only the per-file evidence is scoped to the requested path.
    expect(scanFile.warnings ?? []).toContain("erb_islands_unrendered");
    const scanFilePayload = scanFile.warningsDetails?.erb_islands_unrendered;
    expect(scanFilePayload).toBeDefined();
    expect(scanFilePayload?.fileCount).toBe(1);
    expect(scanFilePayload?.fileList[0]).toMatch(/show\.erb$/);
    expect(scanFilePayload?.reason).toBe(scanProjPayload?.reason);
  });

  it("scan_project, coverage, and checklist emit the same astro_islands_unrendered payload on the same scan root", async () => {
    // Cross-surface invariant for `astro_islands_unrendered`: the
    // routing-decision warning fires off a deterministic per-file
    // predicate (extension is `.astro` AND source carries
    // frontmatter / capitalized component tag / `{expr}` brace), so
    // every project-rooted tool that walks the same cwd must surface
    // the same `{fileCount, fileList, reason}` payload. Mirrors the
    // `erb_islands_unrendered` cross-surface assertion above; without
    // it, an agent calling `checklist` first on an Astro-heavy site
    // would see no signal that N pages carried unrendered components.
    const dir = await makeAstroIslandsFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
      toolCall(5, "scan_file", { path: join(dir, "index.astro") }),
    ]);
    const scanProj = warningsEnvelope(body<Record<string, unknown>>(responses[1]));
    const coverage = warningsEnvelope(body<Record<string, unknown>>(responses[2]));
    const checklist = warningsEnvelope(body<Record<string, unknown>>(responses[3]));
    const scanFile = warningsEnvelope(body<Record<string, unknown>>(responses[4]));

    // Sanity: predicate fires on scan_project, otherwise the cross-
    // surface invariant below is vacuously true.
    expect(scanProj.warnings ?? []).toContain("astro_islands_unrendered");

    const scanProjPayload = scanProj.warningsDetails?.astro_islands_unrendered;
    const coveragePayload = coverage.warningsDetails?.astro_islands_unrendered;
    const checklistPayload = checklist.warningsDetails?.astro_islands_unrendered;

    expect(scanProjPayload).toBeDefined();
    expect(coveragePayload).toBeDefined();
    expect(checklistPayload).toBeDefined();

    // Same fixture → identical payload across all three project-rooted
    // surfaces. Cross-surface drift would silently mislead an agent
    // budgeting against the first tool's headline before calling the
    // second.
    expect(coveragePayload).toEqual(scanProjPayload);
    expect(checklistPayload).toEqual(scanProjPayload);

    // Payload shape sanity — count is 2 (about.astro + index.astro)
    // and fileList is sorted ascending so the agent can scope follow-
    // ups deterministically. The `reason` text names the routing-
    // decision predicate so the agent has the load-bearing pivot in
    // one read.
    expect(scanProjPayload?.fileCount).toBe(2);
    expect(scanProjPayload?.fileList.length).toBe(2);
    expect(scanProjPayload?.fileList[0]).toMatch(/about\.astro$/);
    expect(scanProjPayload?.fileList[1]).toMatch(/index\.astro$/);
    expect(scanProjPayload?.reason).toMatch(/Astro frontmatter and components not extracted/);

    // scan_file scopes to one .astro file — the predicate is per-file
    // so the warning still fires on the single-file surface, with a
    // count of 1 and a fileList carrying just the scanned path.
    // Cross-surface payload shape is identical (same `{fileCount,
    // fileList, reason}` keys), only the per-file evidence is scoped
    // to the requested path.
    expect(scanFile.warnings ?? []).toContain("astro_islands_unrendered");
    const scanFileAstroPayload = scanFile.warningsDetails?.astro_islands_unrendered;
    expect(scanFileAstroPayload).toBeDefined();
    expect(scanFileAstroPayload?.fileCount).toBe(1);
    expect(scanFileAstroPayload?.fileList[0]).toMatch(/index\.astro$/);
    expect(scanFileAstroPayload?.reason).toBe(scanProjPayload?.reason);
  });

  it("payload-bearing codes never ship a bare `{}` detail entry — fall-through stamps the truncation sentinel instead", async () => {
    // The fix: when a payload-bearing
    // code's summarizer returns `undefined` (input not threaded to
    // this surface, or dropped under truncation), the dispatch falls
    // through to a `{ truncated: true, reason: "..." }` sentinel —
    // never the bare `{}` marker — so an agent reading the wire can
    // distinguish "the payload-bearing slot exists and the input
    // wasn't here" from "this code is binary by design (`{}` is the
    // entire signal)."
    //
    // Repro shape: scan a project root that fires multiple codes in
    // one response. Walk every emitted code; for each, classify as
    // payload-bearing (typed slot accepts more than `{}` on
    // `ScanWarningDetails`) vs binary (typed as `BinaryPresenceMarker`).
    // Payload-bearing entries must be EITHER the rich payload OR the
    // truncation sentinel — never bare `{}`. Binary entries must be
    // bare `{}` (the wire is the entire signal).
    //
    // Cross-surface coverage: scan_project / coverage / checklist all
    // share the same warnings pipeline; assert on each.
    const dir = await makeSkippedExtensionFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const envelopes = [
      { name: "scan_project", env: warningsEnvelope(body<Record<string, unknown>>(responses[1])) },
      { name: "coverage", env: warningsEnvelope(body<Record<string, unknown>>(responses[2])) },
      { name: "checklist", env: warningsEnvelope(body<Record<string, unknown>>(responses[3])) },
    ];
    for (const { name, env } of envelopes) {
      assertSentinelOrRichPayloadInvariant(name, env);
    }
  });
});

/**
 * Codes typed as `BinaryPresenceMarker` on `ScanWarningDetails` —
 * their `{}` entry IS honest because the schema declares "no
 * payload by design." Keep in sync with `BINARY_PRESENCE_CODES`
 * in `src/mcp/warnings.ts`.
 */
const BINARY_PRESENCE_CODES_FOR_INVARIANT: ReadonlySet<string> = new Set([
  "scanned_zero_files",
  "root_source_defaulted",
  "tailwind_detected_css_undercounted",
  // `template_files_parsed_as_literal` is now payload-bearing on the
  // canonical surfaces (`scan_project`, `coverage`, `checklist`,
  // `scan_file`) — they thread the per-file evidence list through the
  // warnings aggregator. Derivative surfaces that don't materialize
  // the file list still fall back to the bare `{}` marker, but the
  // typed schema declares the code as `{ files, extensions } |
  // BinaryPresenceMarker` so it no longer belongs in the
  // exclusively-binary set this invariant walks.
  "no_hunks_in_comparison",
  "storybook_preset_active",
  "session_wrappers_configured_for_different_cwd",
  // `redundant_additional_paths` is now payload-bearing on the canonical
  // scan_project surface (it threads `redundantAdditionalPathsList`
  // through the warnings aggregator). Derivative surfaces that don't
  // materialize the per-input subset still fall back to the
  // `{ truncated: true, reason: "summarizer_inputs_unavailable" }`
  // sentinel via the schema-discipline contract, but the typed schema
  // declares the code as `{ redundantPaths, reason }` so it no longer
  // belongs in the exclusively-binary set this invariant walks.
  "restrict_to_paths_no_matches",
  "baseline_dry_run",
  "partial_parse_files_present",
  // `parser_bailed_zero_findings` is now payload-bearing on the canonical
  // surfaces — the warnings aggregator threads `analysisCoverage` through
  // and the summarizer materializes `{ parseErrorFileCount, topFiles?, reason }`
  // when the predicate fires. The typed schema removed the
  // `BinaryPresenceMarker` slot so the code no longer belongs in this
  // exclusively-binary set; derivative surfaces that don't materialize
  // the coverage block still fall back to the truncation sentinel via
  // the schema-discipline contract.
  "dist_only_scan_detected",
]);

/**
 * Walks every fired code on one envelope and asserts the
 * disambiguation invariant — payload-bearing codes ship the rich
 * payload OR the truncation sentinel, NEVER bare `{}`.
 */
function assertSentinelOrRichPayloadInvariant(name: string, env: WarningsEnvelope): void {
  const details = env.warningsDetails ?? {};
  for (const code of env.warnings ?? []) {
    const entry = (details as Record<string, unknown>)[code];
    expect(entry, `${name}: warningsDetails.${code} missing`).toBeDefined();
    if (BINARY_PRESENCE_CODES_FOR_INVARIANT.has(code)) {
      expect(entry, `${name}: binary code ${code} should ship {}`).toEqual({});
    } else {
      assertPayloadBearingEntry(name, code, entry);
    }
  }
}

/**
 * Per-payload-bearing-code assertion: entry must be either a rich
 * payload (any keys) or the truncation sentinel
 * (`{ truncated: true, reason: <string> }`). Bare `{}` would collide
 * with the binary-presence wire shape and is the anti-pattern.
 */
function assertPayloadBearingEntry(name: string, code: string, entry: unknown): void {
  const obj = entry as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    throw new Error(
      `${name}: payload-bearing code ${code} shipped bare {} — payload-vs-binary disambiguation invariant broken (must be rich payload or { truncated: true, reason: "..." } sentinel)`,
    );
  }
  if ("truncated" in obj) {
    expect(obj.truncated).toBe(true);
    expect(typeof obj.reason).toBe("string");
  }
}
