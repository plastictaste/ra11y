# ra11y workflow

Use the MCP surface when available. The built-in prompts are the fastest path:

- `ra11y/triage` for full scan-to-verdict triage
- `ra11y/fix` for a single deterministic fix loop
- `ra11y/audit` for broader conformance work
- `ra11y/vpat-narrative` for a single criterion's remarks text

When prompts are not surfaced by the host, follow the tool workflow below.

## 1. Preflight scan

Start with a project scan:

```json
{
  "cwd": ".",
  "autoDetectWrappers": true,
  "verboseMeta": true
}
```

Check these fields before summarizing anything:

- `warnings`
- `filesScanned`
- `configSource`
- `activeNativeWrappers`
- `rulesEvaluated`
- `filesByExtension`

If `warnings` contains `scanned_zero_files`, `no_config_found`, `tailwind_detected_css_undercounted`, or `template_files_parsed_as_literal`, fix setup first. Do not present that scan as authoritative.

Keep `minSeverity: "info"` unless the user explicitly narrows the scope. Info findings are often where the agent can add value by reading source.

## 2. Triage automated findings

For each actionable finding:

1. Read the cited source in context.
2. Use `suggest_fix`.
3. If the response is deterministic, apply the edit.
4. Re-run `scan_file` on the edited file.
5. Confirm the original rule no longer fires at that location.

Use `scan`, `scan_file`, or `scan_diff` for incremental verification rather than re-running the whole project scan after every small edit.

## 3. Triage manual-review criteria

Use `checklist` after the first scan. It gives grounded manual-review items and untargeted criteria.

If a criterion needs a flatter candidate list or better ranking, call `review_candidates`.

For each candidate:

1. Read the cited `file:line`.
2. Decide `fail`, `dismiss`, or `investigate`.
3. Use `verdict_candidate` when you need a structured verdict record.
4. If you dismiss something, prefer a durable suppression with a real reason.

Do not filter findings by hunch. Read the code and make a source-grounded call.

## 4. Clean up wrapper and config noise

When wrapper false positives show up:

1. Call `detect_native_wrappers`.
2. Validate suspicious entries with `wrapper_introspect`.
3. Use `propose_config` to shape a durable `ra11y.config.ts` update.

This is better than silently teaching the agent to ignore wrapper-driven findings.

## 5. Produce audit and compliance artifacts

Use:

- `coverage` for automated vs manual criteria status
- `vpat` for the structured VPAT artifact
- `draft_vpat_narrative` for a single remarks cell
- `attest` and `list_attestations` for durable manual-review evidence
- `conformance_statement` for an explicit conformance artifact

When summarizing, keep the remediation lanes separate. Do not merge `mechanical`, `guidance`, `runtimeOnly`, and `verifyInSource` into one number.
