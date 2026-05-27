---
name: ra11y
description: Use when the user wants to run ra11y, audit a web codebase for accessibility, fix ra11y findings, review WCAG or Section 508 or EN 301 549 issues, onboard native wrappers, or draft VPAT or conformance outputs. Prefer the ra11y MCP tools and prompts; if they are unavailable, read references/install.md first and only fall back to the CLI for one-off scans.
---

# ra11y

ra11y is MCP-first. Prefer its structured tools and prompts over ad hoc accessibility advice.

## Preflight

1. Check whether the ra11y MCP server is connected and exposes tools such as `scan_project`, `checklist`, `suggest_fix`, `coverage`, `review_candidates`, `draft_vpat_narrative`, or prompts such as `ra11y/triage`, `ra11y/fix`, `ra11y/audit`, and `ra11y/vpat-narrative`.
2. If the server is missing, read [references/install.md](references/install.md) and help the user connect it.
3. Only use the CLI fallback from [references/install.md](references/install.md) when the user wants a one-off scan or cannot enable MCP.

## Workflow

1. For full-project triage, prefer the MCP prompt `ra11y/triage` when the host surfaces MCP prompts. Otherwise follow [references/workflow.md](references/workflow.md).
2. Start scans with `scan_project` using `autoDetectWrappers: true` and `verboseMeta: true`. Keep `minSeverity: "info"` unless the user explicitly narrows it.
3. Before calling a scan clean, inspect `warnings`, `filesScanned`, `configSource`, `activeNativeWrappers`, `rulesEvaluated`, and `filesByExtension`. A zero-file scan or warning-heavy scan is not a clean result.
4. For fixes, use `suggest_fix`. Apply only deterministic edits automatically, then verify with `scan_file` on the touched file.
5. For manual-review criteria, use `checklist`, `review_candidates`, and `verdict_candidate`. Read the cited source before dismissing anything.
6. For onboarding false positives, use `detect_native_wrappers`, `wrapper_introspect`, and `propose_config` rather than guessing wrapper lists.
7. For procurement and compliance outputs, use `coverage`, `draft_vpat_narrative`, `vpat`, `attest`, and `conformance_statement` as needed.

## Rules

- Surface `warnings` and scan-confidence telemetry in your summary.
- Never claim "clean" when `filesScanned` is `0` or when setup warnings indicate the scan lacked teeth.
- Do not collapse `fixesByClass.mechanical`, `guidance`, `runtimeOnly`, and `verifyInSource` into one headline number.
- If you dismiss a finding, prefer a durable source-level suppression with a real reason.
- Use `explain_rule` and `explain_standard` when the spec context affects the fix.

## References

- [references/install.md](references/install.md) for Codex and Claude installation plus MCP setup.
- [references/workflow.md](references/workflow.md) for the deterministic scan, fix, manual-review, and VPAT loop.
