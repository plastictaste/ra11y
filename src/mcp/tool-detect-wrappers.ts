/**
 * The detect_native_wrappers MCP tool. Scans the project for unique
 * PascalCase components with onClick handlers and returns them as
 * candidates for the nativeWrappers config.
 *
 * This closes the onboarding loop: an agent can call this once, eyeball
 * the list, and add the real wrappers to config in one step.
 *
 * We do our own lightweight JSX walk here instead of piggybacking on
 * keyboard/handler-missing. The rule itself trusts PascalCase by
 * default (custom components are assumed keyboard-operable), but this
 * tool wants the inverse view: "which custom components with onClick
 * exist?" — same input, opposite intent.
 */

import { existsSync } from "node:fs";
import { gitRoot } from "../utils/git.ts";
import { buildSuggestedConfigSnippet } from "./config-snippet.ts";
import { collectWrapperCandidates, hasOpaquePascalCaseComponents } from "./detect-wrappers-core.ts";
import { classifyProjectKind, type ProjectKind } from "./detect-wrappers-project-kind.ts";
import { isJsxBearingFile } from "./opaque-tag-filter.ts";
import { scannedProject } from "./scanned-envelope.ts";
import {
  errorResult,
  type McpTool,
  parseFilesWithDiagnostics,
  strParam,
  textResult,
} from "./tools-helpers.ts";

export const detectNativeWrappersTool: McpTool = {
  def: {
    name: "detect_native_wrappers",
    description:
      'Scan the project and list unique PascalCase components with onClick — onboarding aid for `nativeWrappers` in ra11y.config.ts. Each candidate carries a `definitionFile` pointer (absolute path resolved by one-hop basename match, or `null` when the source lives outside the scanned set) so you can open the wrapper directly to verify it wraps a native <button>/<a>/<input>. Every response (success or empty) also carries a `projectKind` discriminator (`"jsx"` when any `.tsx`/`.jsx`/`.mdx`/`.astro` was parsed; `"ruby"`/`"python"`/`"go"` when the discovery walker rejected `.rb`/`.py`/`.go` files as non-parseable and that language dominates; `"static-site"` when only `.html`/`.htm` was parsed; `"unknown"` otherwise) so agents can short-circuit speculative re-calls on non-JSX repos — empty candidates on a Rails site are the tool not applying, not a coverage miss. When `candidates` is empty the response carries a structured `emptyReason` discriminator (`"no-parseable-files"` for an empty cwd; `"no-parseable-jsx-files"` when parseable HTML/CSS exists but the scan saw no JSX-bearing source — `.tsx`/`.jsx`/`.mdx`/`.astro` — so the detector has no surface to inspect; `"no-pascalcase-onclick-components"` when JSX-bearing files exist but contain no PascalCase tags; or `"no-jsx-onclick-candidates-found-but-opaque-components-present"` when PascalCase components exist but none carry the detector\'s required `onClick` / controlled-input props — common in Astro/MDX where wrappers rarely ship inline handlers) so agents can branch without string-matching the prose `nextStep`; the field is omitted when candidates are non-empty. The tool does not modify files.',
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description:
            "Project root. Defaults to the git root of the MCP server's spawn directory, then process.cwd().",
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    const explicitCwd = strParam(params, "cwd");
    // Hard-error envelope when the caller passed a `cwd` that doesn't
    // exist on disk. Without this, `parseFiles` silently returns 0 and
    // the response shape reads as "no parseable files here" — the
    // canonical silent-success failure mode AI-first doctrine warns
    // against. Mirrors `scan_project` and `wrapper_introspect`, so
    // agents can rely on the same code across onboarding tools.
    if (explicitCwd !== undefined && !existsSync(explicitCwd)) {
      return errorResult({
        code: "cwd-not-found",
        message: `Requested cwd does not exist on disk: ${explicitCwd}`,
        details: { cwd: explicitCwd },
        remediation:
          "Pass `cwd` as a path to an existing directory. Relative paths resolve against the MCP server's spawn directory.",
      });
    }
    const spawnCwd = process.cwd();
    const root = explicitCwd ?? gitRoot(spawnCwd) ?? spawnCwd;

    const projectConfig = await session.loadProjectConfig(root);
    // Switched from `parseFiles` to the with-diagnostics variant so
    // `projectKind` can read the `skippedByExtension` map — without it
    // the tool can't distinguish "no parseable files in a Rails repo"
    // (where `.rb` files were the dominant input the walker rejected)
    // from "no parseable files in an empty cwd."
    const { files, diagnostics } = await parseFilesWithDiagnostics([root], session, root);
    const projectKind = classifyProjectKind(files, diagnostics.skippedByExtension);
    if (files.length === 0) {
      return textResult({
        scanned: scannedProject(root),
        candidates: [],
        emptyReason: "no-parseable-files",
        projectKind,
        note: "No parseable files found.",
      });
    }

    const candidates = collectWrapperCandidates(files);
    const detectedNames = new Set(candidates.map((c) => c.component));
    const declared = [
      ...new Set([...projectConfig.nativeWrappers, ...session.config.nativeWrappers]),
    ];
    const absent = declared.filter((name) => !detectedNames.has(name));

    // Structured twin of the English nudge in `nextStep`: agents can
    // paste this directly into ra11y.config.ts instead of parsing the
    // prose. Conditional-spread per CLAUDE.md §1 "Ambiguous field
    // shapes are dishonest" — omit entirely when there are no
    // candidates to seed a snippet from, rather than ship `""`.
    const snippet = buildSuggestedConfigSnippet(
      candidates.map((c) => ({ component: c.component })),
    );
    const snippetField = snippet.length > 0 ? { suggestedConfigSnippet: snippet } : {};

    // Structured discriminator so agents can branch on the
    // "empty result" case without string-matching the prose
    // `nextStep`. Three sub-cases distinguish how the empty set arose,
    // computed deterministically from the parsed-file extension set
    // (per "Heuristic-mislabeled meta sub-fields are dishonest" in
    // ai-first-consumer.md — the JSX-bearing count is provable from
    // the input, not a heuristic):
    //
    //   - `"no-parseable-jsx-files"`: parseable HTML/CSS/MD files
    //     exist but the scan saw zero JSX-bearing source files
    //     (`.tsx`/`.jsx`/`.mdx`/`.astro`). The detector has no JSX
    //     walk surface — there is no place where a wrapper component
    //     would be defined with the prop shapes we look for.
    //     Q7-DETECT-NATIVE-WRAPPERS-EMPTY-REASON-DISCRIMINATOR was
    //     filed when a docs-only HTML site that happened to carry one
    //     `.mdx` file emitted the opaque-components branch and routed
    //     the agent to a `analysisCoverage.opaqueCustomComponentNames`
    //     list that didn't exist for that codebase — gating on the
    //     extension count first stops that misroute.
    //
    //   - `"no-jsx-onclick-candidates-found-but-opaque-components-present"`:
    //     JSX-bearing files exist and contain PascalCase elements,
    //     but none carry an `onClick` prop (nor the controlled-input
    //     prop shape). This is the Astro/MDX case — wrappers
    //     typically render as children with no inline handlers, so
    //     the detector's lower-bound premise (an `onClick` signal)
    //     fails even when wrapper candidates genuinely exist in the
    //     codebase. The structured reason closes the ambiguity and
    //     lets the agent branch into opening the opaque components
    //     (surfaced in `opaqueCustomComponentNames` on the scan
    //     surfaces) directly to classify them itself.
    //
    //   - `"no-pascalcase-onclick-components"`: JSX-bearing files
    //     exist but contain no PascalCase elements at all. Nothing
    //     for the detector to investigate, and nothing for the agent
    //     to follow up on — an honest empty result.
    //
    // Omitted when `candidates` is populated (present-when-meaningful).
    const noJsxBearingFiles = !files.some((f) => isJsxBearingFile(f.filePath));
    const opaquePresent =
      candidates.length === 0 && !noJsxBearingFiles && hasOpaquePascalCaseComponents(files);
    const emptyKind: EmptyKind | null = pickEmptyKind(
      candidates.length,
      noJsxBearingFiles,
      opaquePresent,
    );
    const emptyReasonField = emptyKind === null ? {} : { emptyReason: emptyKind };

    return textResult({
      scanned: scannedProject(root),
      candidates,
      ...emptyReasonField,
      projectKind,
      ...(absent.length > 0 ? { absentDeclaredWrappers: absent } : {}),
      ...snippetField,
      nextStep: buildNextStep(candidates, absent, emptyKind, projectKind),
    });
  },
};

type EmptyKind =
  | "no-parseable-jsx-files"
  | "no-jsx-onclick-candidates-found-but-opaque-components-present"
  | "no-pascalcase-onclick-components";

/**
 * Resolve the `emptyReason` discriminator from three deterministic
 * input signals — the candidate count, whether the scanned set
 * contained any JSX-bearing files, and whether at least one PascalCase
 * tag was sighted in the JSX walker. Extracted from the handler so the
 * branching reads as a single decision rather than nested ternaries
 * (also keeps Biome's `noNestedTernary` happy without cluttering the
 * call site with `if`/`return` scaffolding).
 */
function pickEmptyKind(
  candidateCount: number,
  noJsxBearingFiles: boolean,
  opaquePresent: boolean,
): EmptyKind | null {
  if (candidateCount > 0) return null;
  if (noJsxBearingFiles) return "no-parseable-jsx-files";
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
 * Branches the prose `nextStep` on the structured `emptyKind` so the
 * two surfaces stay in lockstep — the wording each agent reads matches
 * the discriminator each agent codes against. Routing the
 * `no-parseable-jsx-files` case to a JSX-surface message rather than
 * the opaque-components nudge is the silent-misroute fix at the heart
 * of Q7-DETECT-NATIVE-WRAPPERS-EMPTY-REASON-DISCRIMINATOR.
 *
 * When `projectKind` is a named backend language (`"ruby"` / `"python"`
 * / `"go"`), the prose explicitly tells the agent that
 * `nativeWrappers` is a JSX-only concept and the empty result is
 * "tool doesn't apply," not a coverage miss — closes
 * V1-DETECT-NATIVE-WRAPPERS-PROJECTKIND-HINT's silent-misroute on
 * non-JSX repos.
 */
function emptyNextStep(emptyKind: EmptyKind | null, projectKind: ProjectKind): string {
  if (projectKind === "ruby" || projectKind === "python" || projectKind === "go") {
    const langLabel = projectKind === "ruby" ? "Ruby" : projectKind === "python" ? "Python" : "Go";
    return `Project signature reads as ${langLabel} (the discovery walker saw \`${BACKEND_EXT_LABEL[projectKind]}\` files alongside the scanned set). \`nativeWrappers\` is a JSX-only concept — no React/JSX components means nothing to register here, and this empty result is "tool doesn't apply," not a coverage miss. Skip \`detect_native_wrappers\` on this project; if a sibling JSX/TSX subtree exists, re-run with a \`cwd\` rooted in that subtree.`;
  }
  if (emptyKind === "no-parseable-jsx-files") {
    return "No JSX-bearing source files in the scanned set — the detector saw only HTML/CSS/MD files (and possibly plain `.ts` / `.js` modules, which cannot legally carry JSX). There is no surface where a `nativeWrappers` candidate would be defined. If the project genuinely has no React/JSX components, no `nativeWrappers` config is needed. If you expected JSX (e.g. an `app/` folder with `.tsx`), re-run with a `cwd` that includes those files, or pass them via `additionalPaths` on `scan_project`.";
  }
  if (emptyKind === "no-jsx-onclick-candidates-found-but-opaque-components-present") {
    // The Astro/MDX branch: PascalCase wrappers are present in the
    // scanned JSX/TSX but none carry an inline `onClick` — the
    // detector's lower-bound premise. Point the agent at the opaque-
    // components inventory on the scan surfaces so they can open
    // those files directly and decide whether each component wraps
    // a native interactive element.
    return "No PascalCase onClick components detected, but PascalCase components are present in the scanned JSX/TSX. The detector requires an `onClick` (or `onChange` + `value`/`defaultValue`/`checked`) prop to propose a wrapper candidate; components that render as children without inline handlers — common in Astro/MDX — are invisible to it. Open the opaque components listed under `analysisCoverage.opaqueCustomComponentNames` on a `scan_project` response and inspect each one: if it wraps a native `<button>` / `<a>` / `<input>`, add it manually to `nativeWrappers` in ra11y.config.ts.";
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
