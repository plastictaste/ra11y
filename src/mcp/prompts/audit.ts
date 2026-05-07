/**
 * Prompt: ra11y/audit — guides an end-to-end conformance audit across a
 * standard's criteria, producing a coverage summary and a set of
 * VPAT-ready notes an agent can later feed into `ra11y/vpat-narrative`.
 */
import type { Prompt } from "./types.ts";

const DEFAULT_STANDARD = "wcag22";

export const auditPrompt: Prompt = {
  name: "ra11y/audit",
  description:
    "Run an end-to-end conformance audit for a standard: one-shot `audit` tool call, walk the checklist by criterion, and emit a coverage summary plus VPAT-ready notes.",
  arguments: [
    {
      name: "standard",
      description:
        "Standard ID to audit against (e.g. wcag22, wcag21, section508, en301549). Defaults to wcag22.",
      required: false,
    },
  ],
  render(args) {
    const standard = args["standard"] ?? DEFAULT_STANDARD;
    const text = [
      `You are running a conformance audit against \`${standard}\`. Work in order:`,
      "",
      `1. Call \`sessionConfigure\` with \`{ standard: "${standard}" }\` so all subsequent calls inherit the standard.`,
      "",
      "2. Call `audit` with the project root. This one-shot meta-tool returns `{ scan, coverage, checklist }` — read all three legs end to end. The `checklist.actionableManualItems` array holds grounded manual-review candidates (each with `criterionId`, `location.filePath`, `location.line`, `reason`, `confidence`); `checklist.prompts` holds the per-criterion `reviewPrompt` text you will pass through in step 3.",
      "",
      "   ```json",
      '   { "name": "audit", "arguments": { "cwd": ".", "verboseMeta": true } }',
      "   ```",
      "",
      '3. For every entry in `checklist.actionableManualItems`, call `verdict_candidate` to get a pass/fail/unclear verdict grounded in the candidate\'s file:line. Pass the candidate row through verbatim and pair it with the `reviewPrompt` text from `checklist.prompts[candidate.criterionId]`. If the host does not support sampling the tool returns `status: "cannot_verdict"` with a `verdictPromptForAgent` — run that prompt inline against your own model and record the verdict.',
      "",
      "   ```json",
      "   {",
      '     "name": "verdict_candidate",',
      '     "arguments": {',
      '       "candidate": {',
      '         "criterionId": "wcag22:1.3.1",',
      '         "location": { "filePath": "src/Header.tsx", "line": 42 },',
      '         "reason": "<candidate.reason from audit response>",',
      '         "confidence": "medium"',
      "       },",
      '       "reviewPrompt": "<checklist.prompts[criterionId].text from audit response>"',
      "     }",
      "   }",
      "   ```",
      "",
      "4. Walk the candidate locations yourself too — use `Read` on each `location.filePath` around the line to validate or override the sampled verdict. The sampled verdict is grounding, not a gate. Propose a source-level pragma (`{/* ra11y-disable wcag22:X.Y.Z */}` / `<!-- ra11y-disable wcag22:X.Y.Z -->` / `/* ra11y-disable wcag22:X.Y.Z */`) for anything you `dismiss`.",
      "",
      `5. For each criterion the scan touched — every \`criterionId\` that appears in \`scan\` findings OR in \`checklist.actionableManualItems\` OR in \`checklist.prompts\` — call \`explain_standard\` to retrieve the normative text and level, then classify its status as one of \`supports\`, \`partially-supports\`, \`does-not-support\`, \`not-applicable\` (cite evidence), or \`not-evaluated\` (name the runtime harness). Then call \`draft_vpat_narrative\` to draft the Remarks cell. Build the \`scanSummary\` from the audit response — per-criterion counts from \`coverage\` plus up to five representative findings in \`keyViolationExamples\`.`,
      "",
      "   ```json",
      "   {",
      '     "name": "draft_vpat_narrative",',
      '     "arguments": {',
      '       "criterionId": "wcag22:1.3.1",',
      '       "scanSummary": {',
      '         "totalFindings": 3,',
      '         "violations": 2,',
      '         "notes": 1,',
      '         "actionableManual": 1,',
      '         "untargetedCriteriaForProject": 0,',
      '         "keyViolationExamples": [',
      '           { "ruleId": "semantics/landmark-one-main", "criterionId": "wcag22:1.3.1", "filePath": "src/App.tsx", "line": 12, "message": "<violation message>" }',
      "         ]",
      "       }",
      "     }",
      "   }",
      "   ```",
      "",
      '   On hosts without sampling, `draft_vpat_narrative` returns `{ narrative: "", reason: "sampling_unsupported", promptForAgent }` — run `promptForAgent` inline against your own model and use its output as the Remarks cell. Never emit conformance language the scan did not support.',
      "",
      "Return this shape as your final message:",
      `- \`standard\`: "${standard}" (echo back).`,
      "- `coverage`: `{ automatedCriteriaEvaluated, manualCriteriaReviewed, runtimeOnlyCriteria }` — counts from the `audit` response and from your own `verdict_candidate` traversal.",
      "- `criteria`: array of `{ criterionId, level, status, evidence, verdictSummary }`, one entry per criterion the scan touched. `evidence` cites specific `file:line` locations; `verdictSummary` rolls up the per-candidate `verdict_candidate` results (pass/fail/unclear counts).",
      '- `vpatNotes`: array of `{ criterionId, remark, source }`, one entry per criterion. `remark` is the `narrative` returned by `draft_vpat_narrative` (or the agent-composed fallback when sampling was unsupported). `source` is `"sampled"` or `"agent_inline"` so the consumer can tell which path produced the prose.',
      "Stop once every criterion the scan touched has an entry in both `criteria` and `vpatNotes`. Do NOT emit entries for criteria the scan never saw — those belong to a separate manual audit pass.",
    ].join("\n");
    return [{ role: "user", content: { type: "text", text } }];
  },
};
