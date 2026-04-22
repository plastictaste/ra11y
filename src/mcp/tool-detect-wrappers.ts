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

import { gitRoot } from "../utils/git.ts";
import { buildSuggestedConfigSnippet } from "./config-snippet.ts";
import {
  collectWrapperCandidates,
  hasOpaquePascalCaseComponents,
} from "./detect-wrappers-core.ts";
import { scannedProject } from "./scanned-envelope.ts";
import { type McpTool, parseFiles, strParam, textResult } from "./tools-helpers.ts";

export const detectNativeWrappersTool: McpTool = {
  def: {
    name: "detect_native_wrappers",
    description:
      'Scan the project and list unique PascalCase components with onClick — onboarding aid for `nativeWrappers` in ra11y.config.ts. Each candidate carries a `definitionFile` pointer (absolute path resolved by one-hop basename match, or `null` when the source lives outside the scanned set) so you can open the wrapper directly to verify it wraps a native <button>/<a>/<input>. When `candidates` is empty the response carries a structured `emptyReason` discriminator (`"no-parseable-files"`, `"no-pascalcase-onclick-components"`, or `"no-jsx-onclick-candidates-found-but-opaque-components-present"` when PascalCase components exist but none carry the detector\'s required `onClick` / controlled-input props — common in Astro/MDX where wrappers rarely ship inline handlers) so agents can branch without string-matching the prose `nextStep`; the field is omitted when candidates are non-empty. The tool does not modify files.',
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
    const spawnCwd = process.cwd();
    const root = explicitCwd ?? gitRoot(spawnCwd) ?? spawnCwd;

    const projectConfig = await session.loadProjectConfig(root);
    const files = await parseFiles([root], session, root);
    if (files.length === 0) {
      return textResult({
        scanned: scannedProject(root),
        candidates: [],
        emptyReason: "no-parseable-files",
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
    // `nextStep`. Two sub-cases distinguish how the empty set arose:
    //
    //   - `"no-jsx-onclick-candidates-found-but-opaque-components-present"`:
    //     the scanned JSX/TSX contains PascalCase elements, but none
    //     carry an `onClick` prop (nor the controlled-input prop
    //     shape). This is the Astro/MDX case — wrappers typically
    //     render as children with no inline handlers, so the detector's
    //     lower-bound premise (an `onClick` signal) fails even when
    //     wrapper candidates genuinely exist in the codebase. Per the
    //     AI-first doctrine ("Zero-output success is ambiguous
    //     failure"), the bare `candidates: []` would read as "nothing
    //     to wrap here" — the structured reason closes the ambiguity
    //     and lets the agent branch into opening the opaque components
    //     (surfaced in `opaqueCustomComponentNames` on the scan
    //     surfaces) directly to classify them itself.
    //
    //   - `"no-pascalcase-onclick-components"`: the parseable JSX/TSX
    //     set genuinely has no PascalCase elements at all. Nothing
    //     for the detector to investigate, and nothing for the agent
    //     to follow up on — an honest empty result.
    //
    // Omitted when `candidates` is populated (present-when-meaningful).
    const opaquePresent = candidates.length === 0 && hasOpaquePascalCaseComponents(files);
    const emptyReasonField =
      candidates.length === 0
        ? {
            emptyReason: opaquePresent
              ? "no-jsx-onclick-candidates-found-but-opaque-components-present"
              : "no-pascalcase-onclick-components",
          }
        : {};

    return textResult({
      scanned: scannedProject(root),
      candidates,
      ...emptyReasonField,
      ...(absent.length > 0 ? { absentDeclaredWrappers: absent } : {}),
      ...snippetField,
      nextStep: buildNextStep(candidates, absent, opaquePresent),
    });
  },
};

function buildNextStep(
  candidates: readonly { component: string }[],
  absent: readonly string[],
  opaquePresent: boolean,
): string {
  const parts: string[] = [];
  if (candidates.length === 0) {
    if (opaquePresent) {
      // The Astro/MDX branch: PascalCase wrappers are present in the
      // scanned JSX/TSX but none carry an inline `onClick` — the
      // detector's lower-bound premise. Point the agent at the opaque-
      // components inventory on the scan surfaces so they can open
      // those files directly and decide whether each component wraps
      // a native interactive element.
      parts.push(
        "No PascalCase onClick components detected, but PascalCase components are present in the scanned JSX/TSX. The detector requires an `onClick` (or `onChange` + `value`/`defaultValue`/`checked`) prop to propose a wrapper candidate; components that render as children without inline handlers — common in Astro/MDX — are invisible to it. Open the opaque components listed under `analysisCoverage.opaqueCustomComponentNames` on a `scan_project` response and inspect each one: if it wraps a native `<button>` / `<a>` / `<input>`, add it manually to `nativeWrappers` in ra11y.config.ts.",
      );
    } else {
      parts.push("No PascalCase onClick components detected — nothing to register.");
    }
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
