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
 *
 * Response-shape helpers (per-branch assembly, prose `nextStep`
 * builder, per-extension census) live in
 * `./detect-wrappers-tool-helpers.ts` so this file stays under the
 * per-MCP-tool effective-line cap.
 */

import { existsSync } from "node:fs";
import { gitRoot } from "../utils/git.ts";
import { classifyProjectKind } from "./detect-wrappers-project-kind.ts";
import { assembleSuccessResult, inapplicableNoJsxResult } from "./detect-wrappers-tool-helpers.ts";
import { isJsxBearingFile } from "./opaque-tag-filter.ts";
import { errorResult, type McpTool, parseFilesWithDiagnostics, strParam } from "./tools-helpers.ts";

export const detectNativeWrappersTool: McpTool = {
  def: {
    name: "detect_native_wrappers",
    description:
      'Scan the project and list unique PascalCase components with onClick — onboarding aid for `nativeWrappers` in ra11y.config.ts. Each candidate carries a `definitionFile` pointer (absolute path resolved by one-hop basename match, or `null` when the source lives outside the scanned set) so you can open the wrapper directly to verify it wraps a native <button>/<a>/<input>. Every response (success or empty) also carries a `projectKind` discriminator (`"jsx"` when any `.tsx`/`.jsx`/`.mdx`/`.astro` was parsed; `"ruby"`/`"python"`/`"go"` when the discovery walker rejected `.rb`/`.py`/`.go` files as non-parseable and that language dominates; `"static-site"` when only `.html`/`.htm` was parsed; `"unknown"` otherwise) so agents can short-circuit speculative re-calls on non-JSX repos — empty candidates on a Rails site are the tool not applying, not a coverage miss. When the scan tree contains zero JSX-bearing files (`.tsx`/`.jsx`/`.mdx`/`.astro`), the response carries a top-level `inapplicable: { reason: "no_jsx_in_tree", filesByExtension }` block instead of an `emptyReason` — the detector has no surface to inspect, so the result is structurally "tool doesn\'t apply" rather than "tool ran clean," and the per-extension census shows what files were in the tree. When candidates are empty but JSX-bearing files exist, the response carries a structured `emptyReason` discriminator (`"no-pascalcase-onclick-components"` when JSX-bearing files exist but contain no PascalCase tags; `"no-jsx-onclick-candidates-found-but-opaque-components-present"` when PascalCase components exist but none carry the detector\'s required `onClick` / controlled-input props — common in Astro/MDX where wrappers rarely ship inline handlers; on this branch the response also inlines the `opaqueCustomComponentNames` array so the agent can open each component directly without a follow-up `scan_project` call). The tool does not modify files.',
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
    const { files, diagnostics } = await parseFilesWithDiagnostics([root], session, root);
    const projectKind = classifyProjectKind(files, diagnostics.skippedByExtension);

    // "Tool inapplicable" branch: no JSX-bearing source files exist in
    // the scanned tree, so the detector's evidence model never had a
    // surface to inspect. Per AI-first doctrine "Zero-output success
    // is ambiguous failure" + "One tool call should answer 'what
    // next?'", this is structurally distinct from "tool ran clean
    // (some JSX scanned, no wrappers detected)" — surface the
    // distinction with a top-level `inapplicable` block.
    if (!files.some((f) => isJsxBearingFile(f.filePath))) {
      return inapplicableNoJsxResult(root, files, diagnostics.skippedByExtension, projectKind);
    }

    return assembleSuccessResult(root, files, projectKind, projectConfig, session);
  },
};
