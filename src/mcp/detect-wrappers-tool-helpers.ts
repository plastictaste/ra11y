/**
 * Helpers for the {@link import("./tool-detect-wrappers.ts").detectNativeWrappersTool}
 * MCP handler — extracted so the handler file stays under the per-MCP-tool
 * effective-line cap (`scripts/check-limits.ts`). Each function in here
 * is a pure transformer over the handler's inputs (parsed files,
 * project kind, declared wrappers) and returns the slice of the
 * response body the handler concatenates back together.
 *
 * Two response branches live here:
 *   - {@link inapplicableNoJsxResult} — the "tool inapplicable" branch
 *     (no JSX-bearing files in the scanned tree) carrying a
 *     structured `inapplicable: { reason, filesByExtension }` block.
 *   - {@link assembleSuccessResult} — the "JSX surface present" branch
 *     covering the candidate list, opaque-name inlining, declared-
 *     but-absent diff, config-snippet emission, and the structured
 *     `emptyReason` discriminator.
 *
 * The prose `nextStep` builder ({@link buildNextStep} +
 * {@link emptyNextStep}) lives here too so the handler can stay a
 * thin orchestrator. See `docs/kb/architecture/ai-first-consumer.md`
 * for the doctrine the response shapes uphold.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import { extension } from "../utils/path.ts";
import { buildSuggestedConfigSnippet } from "./config-snippet.ts";
import {
  collectOpaquePascalCaseComponentNames,
  collectWrapperCandidates,
} from "./detect-wrappers-core.ts";
import type { ProjectKind } from "./detect-wrappers-project-kind.ts";
import { scannedProject } from "./scanned-envelope.ts";
import { textResult } from "./tools-helpers.ts";

/**
 * Structured `emptyReason` discriminator for the success branch — the
 * response carries one of these tokens whenever the detector ran on
 * real JSX input but came up empty. The "no JSX in tree" branch is
 * surfaced separately via the top-level `inapplicable` block (see
 * {@link inapplicableNoJsxResult}).
 */
export type EmptyKind =
  | "no-jsx-onclick-candidates-found-but-opaque-components-present"
  | "no-pascalcase-onclick-components";

/**
 * Branch tag used by {@link emptyNextStep} to render the prose
 * `nextStep` for the "tool inapplicable" branch. Distinct from
 * {@link EmptyKind} because the response carries an `inapplicable`
 * block on this branch rather than an `emptyReason` discriminator —
 * the prose surface stays unified, the structured surface stays
 * honest about the underlying distinction ("tool didn't apply" vs
 * "tool ran clean").
 */
type NextStepBranch = EmptyKind | "no-jsx-in-tree";

/**
 * Build the response body for the "tool inapplicable" branch — no
 * JSX-bearing source files exist in the scanned tree, so the
 * detector's evidence model never had a surface to inspect. The
 * structured `inapplicable: { reason, filesByExtension }` block lets
 * an agent route in one read (the per-extension census shows what
 * was in the tree); the prose `nextStep` mirrors the structured
 * signal so consumers reading either surface land on the same
 * follow-up.
 */
export function inapplicableNoJsxResult(
  root: string,
  files: readonly ParsedFile[],
  skippedByExtension: Readonly<Record<string, number>>,
  projectKind: ProjectKind,
): ReturnType<typeof textResult> {
  const filesByExtension = buildFilesByExtension(files, skippedByExtension);
  return textResult({
    scanned: scannedProject(root),
    candidates: [],
    inapplicable: { reason: "no_jsx_in_tree", filesByExtension },
    projectKind,
    nextStep: emptyNextStep("no-jsx-in-tree", projectKind),
  });
}

/**
 * Build the response body for the success branch — JSX-bearing files
 * exist, so the detector ran on real input. Wraps the candidate
 * collection, opaque-name inlining (when `emptyReason` names the
 * opaque-components branch), declared-but-absent diff, and config-
 * snippet emission.
 */
export function assembleSuccessResult(
  root: string,
  files: readonly ParsedFile[],
  projectKind: ProjectKind,
  projectConfig: { readonly nativeWrappers: readonly string[] },
  session: { readonly config: { readonly nativeWrappers: readonly string[] } },
): ReturnType<typeof textResult> {
  const candidates = collectWrapperCandidates(files);
  const detectedNames = new Set(candidates.map((c) => c.component));
  const declared = [
    ...new Set([...projectConfig.nativeWrappers, ...session.config.nativeWrappers]),
  ];
  const absent = declared.filter((name) => !detectedNames.has(name));

  const snippet = buildSuggestedConfigSnippet(candidates.map((c) => ({ component: c.component })));
  const snippetField = snippet.length > 0 ? { suggestedConfigSnippet: snippet } : {};

  // Inline the opaque-component inventory only on the branch whose
  // `emptyReason` references opaque components — per "One tool call
  // should answer 'what next?'" the agent doesn't need a follow-up
  // `scan_project` call to read the same names.
  const opaqueNames = candidates.length === 0 ? collectOpaquePascalCaseComponentNames(files) : [];
  const emptyKind: EmptyKind | null = pickEmptyKind(candidates.length, opaqueNames.length > 0);
  const emptyReasonField = emptyKind === null ? {} : { emptyReason: emptyKind };
  const opaqueNamesField =
    emptyKind === "no-jsx-onclick-candidates-found-but-opaque-components-present"
      ? { opaqueCustomComponentNames: opaqueNames }
      : {};

  return textResult({
    scanned: scannedProject(root),
    candidates,
    ...emptyReasonField,
    ...opaqueNamesField,
    projectKind,
    ...(absent.length > 0 ? { absentDeclaredWrappers: absent } : {}),
    ...snippetField,
    nextStep: buildNextStep(candidates, absent, emptyKind, projectKind),
  });
}

/**
 * Aggregates a per-extension census of every file the discovery
 * walker considered for the scan — both the parsed files (`files[]`
 * entries) and the parser-rejected extensions surfaced via the
 * walker's `skippedByExtension` map (e.g. `.rb` / `.py` / `.go` on a
 * backend-framework repo). One map so the agent reading
 * `inapplicable.filesByExtension` sees a unified census rather than
 * having to merge two surfaces. Empty-extension entries (no `.`)
 * bucket under `""`.
 */
function buildFilesByExtension(
  files: readonly ParsedFile[],
  skippedByExtension: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const ext = extension(file.filePath);
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  for (const [ext, count] of Object.entries(skippedByExtension)) {
    counts.set(ext, (counts.get(ext) ?? 0) + count);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Resolve the `emptyReason` discriminator from two deterministic
 * inputs — the candidate count and whether at least one opaque
 * PascalCase tag was sighted in the JSX walker. The "no JSX in tree"
 * branch is split out earlier in the handler into a top-level
 * `inapplicable` block (per "Zero-output success is ambiguous
 * failure" — the absence of a JSX surface is structurally distinct
 * from a clean scan and gets its own discriminator).
 */
function pickEmptyKind(candidateCount: number, opaquePresent: boolean): EmptyKind | null {
  if (candidateCount > 0) return null;
  if (opaquePresent) return "no-jsx-onclick-candidates-found-but-opaque-components-present";
  return "no-pascalcase-onclick-components";
}

function buildNextStep(
  candidates: readonly { component: string }[],
  absent: readonly string[],
  emptyKind: EmptyKind | null,
  projectKind: ProjectKind,
): string {
  const parts: string[] = [];
  if (candidates.length === 0) {
    parts.push(emptyNextStep(emptyKind, projectKind));
  } else {
    const names = candidates.map((c) => `"${c.component}"`).join(", ");
    parts.push(
      `Found ${candidates.length} unique candidate${candidates.length === 1 ? "" : "s"}. Add the ones that truly wrap a native interactive element to \`nativeWrappers\` in ra11y.config.ts:\n\nexport default {\n  nativeWrappers: [${names}],\n};\n\nRemove any from the list that render a <div> or <span> internally — those are real bugs to fix.`,
    );
  }
  if (absent.length > 0) {
    parts.push(
      `\n\nDeclared but absent from JSX: [${absent.map((n) => `"${n}"`).join(", ")}]. These wrappers appear in your config but no component by that name was found in this scan — consider removing them from \`nativeWrappers\` unless you're about to add a usage.`,
    );
  }
  return parts.join("");
}

/**
 * Branches the prose `nextStep` on the structured branch tag so the
 * two surfaces stay in lockstep. The "no JSX in tree" branch maps to
 * the structured `inapplicable: { reason: "no_jsx_in_tree" }` block
 * on the response; the prose surface remains unified.
 *
 * When `projectKind` is a named backend language (`"ruby"` /
 * `"python"` / `"go"`), the prose explicitly tells the agent that
 * `nativeWrappers` is a JSX-only concept and the empty result is
 * "tool doesn't apply," not a coverage miss.
 */
function emptyNextStep(branch: NextStepBranch | null, projectKind: ProjectKind): string {
  if (projectKind === "ruby" || projectKind === "python" || projectKind === "go") {
    const langLabel = projectKind === "ruby" ? "Ruby" : projectKind === "python" ? "Python" : "Go";
    return `Project signature reads as ${langLabel} (the discovery walker saw \`${BACKEND_EXT_LABEL[projectKind]}\` files alongside the scanned set). \`nativeWrappers\` is a JSX-only concept — no React/JSX components means nothing to register here, and this empty result is "tool doesn't apply," not a coverage miss. Skip \`detect_native_wrappers\` on this project; if a sibling JSX/TSX subtree exists, re-run with a \`cwd\` rooted in that subtree.`;
  }
  if (branch === "no-jsx-in-tree") {
    return 'No JSX-bearing source files in the scanned tree — the detector saw only HTML/CSS/MD files (and possibly plain `.ts` / `.js` modules, which cannot legally carry JSX). The response carries an `inapplicable: { reason: "no_jsx_in_tree", filesByExtension }` block so you can branch on the structured signal directly. If the project genuinely has no React/JSX components, no `nativeWrappers` config is needed. If you expected JSX (e.g. an `app/` folder with `.tsx`), re-run with a `cwd` that includes those files, or pass them via `additionalPaths` on `scan_project`.';
  }
  if (branch === "no-jsx-onclick-candidates-found-but-opaque-components-present") {
    return "No PascalCase onClick components detected, but PascalCase components are present in the scanned JSX/TSX. The detector requires an `onClick` (or `onChange` + `value`/`defaultValue`/`checked`) prop to propose a wrapper candidate; components that render as children without inline handlers — common in Astro/MDX — are invisible to it. Open each component listed in `opaqueCustomComponentNames` on this response and inspect it: if it wraps a native `<button>` / `<a>` / `<input>`, add it manually to `nativeWrappers` in ra11y.config.ts.";
  }
  return "No PascalCase onClick components detected — nothing to register.";
}

/**
 * Human-readable extension labels for the named backend languages,
 * used when the `projectKind` branch in {@link emptyNextStep} cites
 * the deterministic signature evidence in the prose.
 */
const BACKEND_EXT_LABEL: Readonly<Record<"ruby" | "python" | "go", string>> = {
  ruby: ".rb",
  python: ".py",
  go: ".go",
};
