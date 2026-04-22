# Using ra11y inside Claude Code

This is a drop-in section you can paste into your own project's `CLAUDE.md` once the `.mcp.json` next to this file is in place. It teaches Claude Code the deterministic v1 workflow for accessibility work — no host-sampling required, every step grounded in a real file:line or a concrete fix proposal.

## Tool inventory (deterministic surface)

These are the ra11y MCP tools Claude Code will pick up from `.mcp.json`. The full list is discoverable via `tools/list` on the server; the ones below are the canonical v1 flow and are guaranteed to work on any MCP host that implements Tools (sampling not required).

| Tool | What it does | When to call |
|---|---|---|
| `scan_project` | Full-project scan. Returns grouped findings, `plan.*` counters, scan-confidence telemetry (`activeNativeWrappers`, `rulesEvaluated`, `filesByExtension`, `configSource`), and a `warnings` array for silent-failure modes. | First call on a new codebase, and after any round of fixes. |
| `checklist` | Manual-review half of the audit. Grounded candidates with `criterionId`, `location.filePath`, `location.line`, `snippet`, and a short `reason` framing the question. Also emits per-criterion `reviewPrompt` text for criteria the scanner can't target. | After an automated scan comes back clean or near-clean. |
| `suggest_fix` | For a specific finding, returns either a mechanical edit (`kind: "edit"` with a widened unique-anchor `oldText` / `newText` pair) or prose guidance (`kind: "guidance"` with an optional `editCandidate`). | One call per violation you plan to act on. |
| `verdict_candidate` | For a single checklist candidate, returns a pass/fail/unclear verdict grounded in the cited file:line. If the host does not support sampling (Claude Code currently declines), the tool returns `status: "cannot_verdict"` plus a `verdictPromptForAgent` string — Claude Code runs that prompt against its own model and records the result. Either way, the output is deterministic from the agent's perspective. | For each candidate in `checklist.actionableManualItems` you are reviewing. |
| `draft_vpat_narrative` | Drafts the VPAT "Remarks and Explanations" cell for one criterion. Takes a `scanSummary` you build from the `scan_project` + `checklist` responses. On hosts without sampling, returns `{ narrative: "", reason: "sampling_unsupported", promptForAgent }` — Claude Code runs the prompt inline. | Once per criterion that touched the scan, when producing a VPAT draft. |

Other useful tools you'll reach for less often: `scan_file` (fast single-file re-scan), `detect_native_wrappers` (one-shot opaque-component probe), `explain_rule` and `explain_standard` (authoritative rule + criterion metadata), `suppress` / `list_suppressions` (pragma bookkeeping), `coverage`, `review_candidates`. Canonical list is `tools/list`.

## The deterministic v1 workflow

The five steps below are the inner loop. Claude Code should walk them in order for any "audit this codebase" or "fix the a11y issues in this file" request.

1. **Scan.** Call `scan_project` with the project root. Pass `autoDetectWrappers: true` on the first call — this registers PascalCase design-system wrappers as native-element stand-ins for the scan, silencing the opaque-component false-positive tail without mutating session state. If the response's `warnings` array contains `scanned_zero_files`, `no_config_found`, `tailwind_detected_css_undercounted`, or `template_files_parsed_as_literal`, stop and read the message — the scan did not have teeth. Otherwise, the response gives you a rule-grouped summary plus `plan.mechanicalEditsAvailable`, `plan.guidanceFixesAvailable`, `plan.actionableManualItems`, `plan.untargetedCriteria`, each a split honest counter.

   ```json
   {
     "name": "scan_project",
     "arguments": {
       "cwd": ".",
       "autoDetectWrappers": true,
       "verboseMeta": true
     }
   }
   ```

2. **Triage the manual half.** Call `checklist`. The response's `actionableManualItems` array holds grounded candidates with `location.filePath` + `location.line` + `snippet`; `untargetedCriteria` holds bare criterion prompts where the scanner has no locator. Walk the actionable items first — each already ships with the question text in `reason`.

   ```json
   { "name": "checklist", "arguments": { "cwd": "." } }
   ```

3. **Propose fixes.** For every violation you plan to act on, call `suggest_fix` with the violation's `findingId`. Two response kinds:

   - `kind: "edit"` — mechanical fix. `oldText` is a unique anchor window (up to 200 chars) that matches the source verbatim; `newText` is the replacement. `apply_fix` can consume this pair directly, or you can use the `Edit` tool with the same two strings.
   - `kind: "guidance"` — the fix needs authorial judgment (e.g. alt text content). The response may include `editCandidate` — a speculative edit to verify in source before applying. Never apply `editCandidate` blind.

   ```json
   { "name": "suggest_fix", "arguments": { "findingId": "<12-char hex from scan response>" } }
   ```

4. **Verdict the candidates.** For each entry in `checklist.actionableManualItems`, call `verdict_candidate`. Pass the candidate row through verbatim and pair it with the criterion's `reviewPrompt` text from the checklist response. If the host does not support MCP sampling (Claude Code currently declines), the tool returns `status: "cannot_verdict"` with a `verdictPromptForAgent` — run that prompt inline and record the verdict yourself. Walk each `location.filePath` with `Read` at the cited line either way: the sampled verdict is grounding, not a gate.

   ```json
   {
     "name": "verdict_candidate",
     "arguments": {
       "candidate": {
         "criterionId": "wcag22:1.3.1",
         "location": { "filePath": "src/Header.tsx", "line": 42 },
         "reason": "<candidate.reason from checklist response>",
         "confidence": "medium"
       },
       "reviewPrompt": "<checklist.prompts[criterionId].text>"
     }
   }
   ```

   Propose a source-level pragma (`{/* ra11y-disable wcag22:X.Y.Z */}` for JSX, `<!-- ra11y-disable wcag22:X.Y.Z -->` for HTML, `/* ra11y-disable wcag22:X.Y.Z */` for CSS) for anything you dismiss. Pragmas make the dismissal durable; hidden heuristics do not.

5. **Draft the VPAT narrative.** For each criterion the scan touched — every `criterionId` in `scan_project` findings OR in `checklist.actionableManualItems` OR in `checklist.prompts` — call `explain_standard` to retrieve the normative text, then `draft_vpat_narrative` with a `scanSummary` you assemble from the prior responses. On sampling-less hosts the tool returns `{ narrative: "", reason: "sampling_unsupported", promptForAgent }` — run `promptForAgent` inline and use its output as the Remarks cell. Never emit conformance language the scan did not support.

   ```json
   {
     "name": "draft_vpat_narrative",
     "arguments": {
       "criterionId": "wcag22:1.3.1",
       "scanSummary": {
         "totalFindings": 3,
         "violations": 2,
         "notes": 1,
         "actionableManual": 1,
         "untargetedCriteria": 0,
         "keyViolationExamples": [
           { "ruleId": "semantics/landmark-one-main", "criterionId": "wcag22:1.3.1", "filePath": "src/App.tsx", "line": 12, "message": "<violation message>" }
         ]
       }
     }
   }
   ```

## Rules of the road

- **Surface every finding; never post-hoc filter in your own output.** ra11y already prunes by `likelyIrrelevant` + `uniquePerCriterion`. If a candidate looks wrong, read the file at the cited line and dismiss it with a pragma, not by omission.
- **Pass the verbose meta through when you summarize.** `configSource`, `configSearchedFrom`, `activeNativeWrappers`, `rulesEvaluated`, `filesByExtension` are scan-confidence telemetry. They tell the user whether the scan had teeth. Don't trim them because the response feels long.
- **Check `warnings` before claiming "clean."** A response with `filesScanned: 0` is not a clean scan; it is a scan that never reached the codebase. The `warnings` array exists because zero-output success is otherwise indistinguishable from silent failure.
- **Respect the split counters.** `plan.mechanicalEditsAvailable` and `plan.guidanceFixesAvailable` are separate on purpose — they describe categorically different work. Never sum them into a headline "fixes available" number; the agent's budget should reflect which lane the work actually falls in.
- **Use `nextStep` / `nextStepStructured` to chain calls.** Each response tells you the canonical next call. If the response says call `checklist` next, that is the honest next step; the tool already picked the right hop.

## Configuration (optional)

Project defaults live in `ra11y.config.ts` at the repo root. The server re-reads it on every tool call — edits take effect without reconnecting. Generate a starter with `npx @ra11y/core --init`.

Per-session overrides (without editing the config file) go through `sessionConfigure`:

```json
{
  "name": "sessionConfigure",
  "arguments": {
    "standard": "wcag22",
    "level": "AA",
    "nativeWrappers": ["Button", "Link", "TextField"]
  }
}
```

Session state applies to subsequent tool calls in the same MCP connection and is discarded when the connection closes.
