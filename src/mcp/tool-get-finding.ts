/**
 * The `get_finding` MCP tool — back-resolves a `findingId` to the
 * canonical violation or review candidate so an agent that captured
 * the id earlier (from `scan_project` / `scan_file` / `checklist` /
 * `review_candidates`) can recover the per-call address shape
 * (`ruleId, file, line, column, criteria, severity, fix, ...`) that
 * the downstream chain (`suggest_fix`, source-level disable pragma)
 * needs.
 *
 * Closure for: agents threading a `findingId` between tool calls had no
 * affordance to recover the underlying `(ruleId, file, line)` triple
 * without re-running `scan_project` and walking the full response.
 * `suggest_fix` requires `(ruleId, file, line)`; without this tool the
 * findingId on the wire was an opaque token the agent had to discard
 * and re-derive. `get_finding(findingId)` makes the id round-trip:
 * `scan_project → findingId → get_finding → (ruleId, file, line) →
 * suggest_fix`.
 *
 * Lookup logic (`lookupViolationById`, `lookupCandidateById`,
 * `buildIdNotFoundResult`, `buildZeroFilesResult`,
 * `FINDING_LOOKUP_CANDIDATE_LIMIT`) lives in
 * `./tool-get-finding-internals.ts` so this file stays under the
 * per-MCP-tool effective-line budget. The handler here is the wire
 * shape: param-validation, cwd resolution, scan dispatch, and the
 * helper-call chain.
 *
 * The lookup intentionally re-runs the scan rather than persisting
 * state across tool calls — `findingId` is computed deterministically
 * from `(ruleId, relativeFilePath, line, column, variantKey?)` so a
 * re-scan produces the same id when the file hasn't changed. Per AI-
 * first doctrine "Don't duplicate capability the agent already has,"
 * agent-side state is not the tool's concern.
 */

import { existsSync } from "node:fs";
import { gitRoot } from "../utils/git.ts";
import { buildScanProjectReviewCandidates } from "./scan-project-review-candidates.ts";
import {
  buildIdNotFoundResult,
  buildZeroFilesResult,
  FINDING_LOOKUP_CANDIDATE_LIMIT,
  lookupCandidateById,
  lookupViolationById,
} from "./tool-get-finding-internals.ts";
import {
  collectManualCriteria,
  errorResult,
  type McpTool,
  parseFilesWithDiagnostics,
  resolveStandards,
  runScanAndFormat,
  strParam,
} from "./tools-helpers.ts";

const GET_FINDING_DESCRIPTION =
  'Resolve a `findingId` returned by an earlier scan call back to the canonical violation or review candidate so the agent can chain into `suggest_fix(ruleId, file, line)` or apply a source-level disable pragma without re-walking the full scan response.\n\nWorkflow: `scan_project` → capture `findingId` → `get_finding({findingId})` → use the returned `ruleId`, `file`, `line` (and `column`) on `suggest_fix`. The id is deterministic per `(ruleId, relativeFilePath, line, column)` (per `src/utils/finding-id.ts`), so a re-scan produces the same id when the file hasn\'t changed.\n\nOn match: returns `{ found: true, kind: "violation" | "reviewCandidate", finding: {...canonical fields...}, filesScanned, scanned: { root } }`. The `finding` shape mirrors what `scan_project` would have surfaced for that emission.\n\nOn miss: returns `{ found: false, reason: "finding_id_not_found" | "scanned_zero_files", filesScanned, scanned: { root }, warnings? }`. Per AI-first doctrine "Zero-output success is ambiguous failure" the response distinguishes "scan ran and the id doesn\'t address any current emission" (the file may have been edited; the agent should re-scan and capture a fresh id) from "scan never ran on a useful corpus" (the cwd was empty / wrong). Read `filesScanned` and the warning code to triage which.';

const GET_FINDING_FINDING_ID_DESCRIPTION =
  'Per-emission opaque token returned by a prior scan call (e.g. `scan_project.files[].findings[].findingId`, `scan_file.reviewCandidates[].findingId`, `checklist.items[].candidates[].findingId`). 12 hex chars, deterministic per `(ruleId, relativeFilePath, line, column, variantKey?)` for violations and per `(sortedCriteria.join(","), filePath, line, column)` for review candidates.';

const GET_FINDING_CWD_DESCRIPTION =
  "Project root to scan. Defaults to the git root of the MCP server's spawn directory, then `process.cwd()`. Pass the same `cwd` you used on the originating scan so the path-relativization the id was hashed against matches.";

export const getFindingTool: McpTool = {
  def: {
    name: "get_finding",
    description: GET_FINDING_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        findingId: { type: "string", description: GET_FINDING_FINDING_ID_DESCRIPTION },
        cwd: { type: "string", description: GET_FINDING_CWD_DESCRIPTION },
      },
      required: ["findingId"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    const findingId = strParam(params, "findingId");
    if (findingId === undefined || findingId.length === 0) {
      return errorResult({
        code: "missing-required-param",
        message: "findingId is required.",
        details: { missing: ["findingId"] },
      });
    }
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
    const hostRoot = explicitCwd === undefined ? session.firstRootPath() : null;
    const root = explicitCwd ?? hostRoot ?? gitRoot(spawnCwd) ?? spawnCwd;
    const projectConfig = await session.loadProjectConfig(root);
    const { files } = await parseFilesWithDiagnostics(
      [root],
      session,
      root,
      projectConfig.preset === "storybook" ? { includeStoryFiles: true } : {},
    );
    if (files.length === 0) {
      return buildZeroFilesResult({ findingId, root });
    }
    const standards = resolveStandards(undefined, session);
    const scanRunResult = await runScanAndFormat(
      files,
      session,
      standards,
      undefined, // no minSeverity filter — id lookup must see every emission
      session.effectiveRules(projectConfig),
      undefined,
      root,
    );
    const violationHit = lookupViolationById({
      findingId,
      formatted: scanRunResult.formatted,
      filesScanned: files.length,
      root,
    });
    if (violationHit !== null) return violationHit;
    const manualIds = collectManualCriteria(standards, session, session.config.level, files);
    const candidates = buildScanProjectReviewCandidates({
      candidates: scanRunResult.reviewCandidates,
      manualIds,
      limit: FINDING_LOOKUP_CANDIDATE_LIMIT,
    });
    const candidateHit = lookupCandidateById({
      findingId,
      candidates,
      filesScanned: files.length,
      root,
    });
    if (candidateHit !== null) return candidateHit;
    return buildIdNotFoundResult({ findingId, filesScanned: files.length, root });
  },
};
