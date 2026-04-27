/**
 * Integration test: every emitted finding's `(ruleId, file, line)` triple
 * must resolve via `suggest_fix` in the same response.
 *
 * Doctrine: docs/kb/architecture/ai-first-consumer.md "Cross-surface
 * count invariant" applied at the per-finding level — when the same
 * predicate ships from `scan_project` (or any other scan-family
 * surface) and from `suggest_fix`, the answer to "does this finding
 * exist at this (ruleId, file, line) triple?" must agree across both
 * surfaces. Drift is silent: the agent reads the scan response, picks
 * a finding, calls `suggest_fix({ruleId, file, line})`, and gets back
 * `kind: "none"` — same response, same predicate, contradictory
 * answers. The agent then doubts the original scan tally and wastes a
 * triage round-trip.
 *
 * Test strategy: build a multi-file synthetic input mixing
 *   (a) per-element rule-fires (the rule emits at the element line),
 *   (b) wrapper-inheritance call-site emissions (synthesized by the
 *       inherited-findings post-pass at call-site lines in OTHER
 *       files), and
 *   (c) external-JS afterFile emissions (the rule emits at offset-
 *       derived line numbers from a `.js` file scan).
 *
 * Then for every emitted violation, we drive `buildSuggestFixPayload`
 * the same way `tool-suggest-fix.ts` does — re-scan the cited file in
 * single-file mode and assert the lookup either matches the violation
 * OR routes the agent honestly via `nearestFinding` / `didYouMean[]`
 * breadcrumbs (a `kind: "none"` with no breadcrumb is the dead-end
 * shape this test forbids).
 */

import { describe, expect, it } from "bun:test";

import { runScan } from "../../src/engine/scanner.ts";
import { parseHtml } from "../../src/input/parsers/html.ts";
import { parseTsx } from "../../src/input/parsers/index.ts";
import {
  collectWrapperNames,
  detectWrapperElementAtLine,
} from "../../src/mcp/suggest-fix-inherited-hint.ts";
import { buildSuggestFixPayload } from "../../src/mcp/tool-suggest-fix-internals.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";
import type { Ast } from "../../src/types/ast.ts";
import type { Violation } from "../../src/types/violation.ts";

type Lang = "tsx" | "jsx" | "ts" | "js" | "html";

interface FileSpec {
  readonly filePath: string;
  readonly source: string;
  readonly lang: Lang;
}

function parseFor(spec: FileSpec): { source: string; ast: Ast } {
  if (spec.lang === "html") {
    const p = parseHtml(spec.source);
    return { source: spec.source, ast: { language: "html", root: p.root, errors: p.errors } };
  }
  const p = parseTsx(spec.source);
  return { source: spec.source, ast: { language: spec.lang, root: p.root, errors: p.errors } };
}

interface OffenderRecord {
  ruleId: string;
  file: string;
  line: number;
  payloadKind: unknown;
  hasBreadcrumb: boolean;
  sourceOfFinding?: string;
}

/**
 * Mirrors what the suggest_fix handler does for one (ruleId, file,
 * line) triple: rescan the cited file alone, look up the match,
 * compose the inherited-from-wrapper hint when the rescan misses, and
 * build the payload through the same `buildSuggestFixPayload` the
 * handler calls. Returns an offender record when the payload is a
 * dead-end `kind: "none"` (no match, no breadcrumb), otherwise null.
 */
function probeSuggestFixForViolation(args: {
  readonly violation: Violation;
  readonly fileSpec: FileSpec;
  readonly wrapperNames: ReadonlySet<string>;
}): OffenderRecord | null {
  const { violation: v, fileSpec, wrapperNames } = args;
  const ast = parseFor(fileSpec);
  const { result: singleFile } = runScan({
    standards: BUILTIN_STANDARDS,
    rules: BUILTIN_RULES,
    enabled: ["wcag22"],
    files: [{ filePath: fileSpec.filePath, source: fileSpec.source, ast: ast.ast }],
  });
  const match = singleFile.violations.find(
    (vv) => vv.ruleId === v.ruleId && vv.location.line === v.location.line,
  );
  const inheritedHint =
    match === undefined ? detectWrapperElementAtLine(ast.ast, v.location.line, wrapperNames) : null;
  const payload = buildSuggestFixPayload({
    ruleId: v.ruleId,
    line: v.location.line,
    match: match as Violation | undefined,
    sourceContext: fileSpec.source,
    source: fileSpec.source,
    filePath: fileSpec.filePath,
    sameFileFindings: singleFile.violations,
    ...(inheritedHint === null ? {} : { inheritedFromWrapper: inheritedHint }),
  });
  const kind = payload["kind"];
  if (kind !== "none") return null;
  const hasBreadcrumb =
    "nearestFinding" in payload || "didYouMean" in payload || "inheritedFromWrapper" in payload;
  if (hasBreadcrumb) return null;
  const offender: OffenderRecord = {
    ruleId: v.ruleId,
    file: fileSpec.filePath,
    line: v.location.line,
    payloadKind: kind,
    hasBreadcrumb,
  };
  if (v.sourceOfFinding !== undefined) {
    offender.sourceOfFinding = `${v.sourceOfFinding.filePath}:${v.sourceOfFinding.line}`;
  }
  return offender;
}

describe("suggest_fix lookup must agree with rule emission", () => {
  it("every emitted finding resolves to a suggest_fix match (or honest breadcrumb) in the same response", () => {
    // Mix of per-element fires, wrapper-inherited call sites, and
    // external-JS afterFile emissions — all three are real shapes that
    // the keyboard/handler-missing rule produces in the wild.
    const files: readonly FileSpec[] = [
      // (a) Wrapper definition: the rule fires at the bare <div onClick>
      //     inside the wrapper component's body.
      {
        filePath: "/components/Tile.tsx",
        lang: "tsx",
        source: `export const Tile = ({onClick, label}) => <div onClick={onClick}>{label}</div>;
`,
      },
      // (b) Call site: every <Tile> render in this file becomes an
      //     inherited finding via the synthesizeInheritedFindings
      //     post-pass — emitted at the call-site line, NOT at the
      //     wrapper-definition line.
      {
        filePath: "/page.tsx",
        lang: "tsx",
        source: `import { Tile } from "./components/Tile";
export const Page = () => (
  <main>
    <Tile onClick={() => 1} label="One" />
    <Tile onClick={() => 2} label="Two" />
  </main>
);
`,
      },
      // (c) Per-element HTML fire — bare <div onclick> on its own line.
      {
        filePath: "/page.html",
        lang: "html",
        source: `<!doctype html><html><body>
<div onclick="run()">Click me</div>
</body></html>
`,
      },
      // (d) External-JS afterFile emission — addEventListener('click', …)
      //     with no sibling keyboard listener.
      {
        filePath: "/app.js",
        lang: "js",
        source: `const btn = document.querySelector('#save');
btn.addEventListener('click', () => save());
`,
      },
    ];

    const built = files.map((f) => ({ filePath: f.filePath, ...parseFor(f) }));

    const wrapperConfig: Readonly<Record<string, string>> = { Tile: "div" };
    const wrapperNames = collectWrapperNames(wrapperConfig, undefined);
    // Project-wide scan with wrapper inheritance enabled — mirrors what
    // scan_project does on a real codebase.
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: built,
      nativeWrapperElements: wrapperConfig,
    });

    const handlerMissing = result.violations.filter((v) => v.ruleId === "keyboard/handler-missing");
    // Sanity: the corpus must produce findings of every shape (a)–(d)
    // for the test to actually exercise the invariant.
    expect(handlerMissing.length).toBeGreaterThan(0);
    const inheritedCount = handlerMissing.filter((v) => v.sourceOfFinding !== undefined).length;
    expect(inheritedCount).toBeGreaterThan(0);

    const offenders: OffenderRecord[] = [];
    for (const v of handlerMissing) {
      const fileSpec = files.find((f) => f.filePath === v.location.filePath);
      if (!fileSpec) throw new Error(`missing source for ${v.location.filePath}`);
      const offender = probeSuggestFixForViolation({ violation: v, fileSpec, wrapperNames });
      if (offender !== null) offenders.push(offender);
    }
    // Empty offender list = invariant holds. When this fires, the
    // listed (ruleId, file, line) triples were emitted by the rule
    // engine but suggest_fix's lookup couldn't find them — the per-call
    // surface is dead-ending the agent on a finding the response just
    // advertised. The fix is to align suggest_fix's lookup predicate
    // with the rule's emission predicate (or to surface an honest
    // breadcrumb when single-file rescan can't reproduce a multi-file
    // fire like inherited-findings synthesis).
    expect(offenders).toEqual([]);
  });

  it("kind: none on an inherited-finding call site carries inheritedFromWrapper", () => {
    // Direct positive shape assertion — a wrapper-call lookup should
    // route the agent to the wrapper definition via the structured
    // hint, not just emit "no violation" prose.
    const wrapperDef: FileSpec = {
      filePath: "/components/Tile.tsx",
      lang: "tsx",
      source: `export const Tile = ({onClick}) => <div onClick={onClick}>x</div>;\n`,
    };
    const callSite: FileSpec = {
      filePath: "/page.tsx",
      lang: "tsx",
      source: `import { Tile } from "./components/Tile";\nexport const P = () => <Tile onClick={() => 1} />;\n`,
    };
    const built = [wrapperDef, callSite].map((f) => ({ filePath: f.filePath, ...parseFor(f) }));
    const wrapperConfig: Readonly<Record<string, string>> = { Tile: "div" };
    const wrapperNames = collectWrapperNames(wrapperConfig, undefined);

    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: built,
      nativeWrapperElements: wrapperConfig,
    });
    const inherited = result.violations.find(
      (v) =>
        v.ruleId === "keyboard/handler-missing" &&
        v.sourceOfFinding !== undefined &&
        v.location.filePath === "/page.tsx",
    );
    expect(inherited).toBeDefined();
    if (!inherited) return;

    // Re-scan call-site file alone — mirrors suggest_fix's single-file
    // rescan. The lookup will miss; the inherited-hint detection
    // populates the structured field.
    const callAst = parseFor(callSite);
    const { result: singleFile } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [{ filePath: callSite.filePath, source: callSite.source, ast: callAst.ast }],
    });
    const match = singleFile.violations.find(
      (vv) => vv.ruleId === inherited.ruleId && vv.location.line === inherited.location.line,
    );
    expect(match).toBeUndefined();
    const hint = detectWrapperElementAtLine(callAst.ast, inherited.location.line, wrapperNames);
    expect(hint).toEqual({ wrapperName: "Tile" });

    const payload = buildSuggestFixPayload({
      ruleId: inherited.ruleId,
      line: inherited.location.line,
      match: undefined,
      sourceContext: callSite.source,
      source: callSite.source,
      filePath: callSite.filePath,
      sameFileFindings: singleFile.violations,
      inheritedFromWrapper: hint as { wrapperName: string },
    });
    expect(payload["kind"]).toBe("none");
    expect(payload["inheritedFromWrapper"]).toEqual({ wrapperName: "Tile" });
    // The explanation prose should name the wrapper so the agent can
    // route to the wrapper definition without a second call.
    expect(payload["explanation"]).toContain("Tile");
  });
});
