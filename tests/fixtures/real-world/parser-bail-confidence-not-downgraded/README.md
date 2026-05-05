# parser-bail-confidence-not-downgraded

Guards the invariant introduced by the Q15 parser-bail-route coverage fix:
when a plain-JS file is routed through the TSX parser and produces zero
findings (silent bail), every `perRuleCoverage` row must report non-`"high"`
confidence.

## Failure mode

`applyParserBailRouteAdjustment` exists in `src/mcp/per-rule-coverage-shared.ts`
but was not wired into the `runScanAndFormat` cascade in
`src/mcp/tools-helpers.ts`. The warning channel emits
`scan_file_parser_bail_no_findings` (correctly identifying the routing
ambiguity), but every `perRuleCoverage` row still ships at
`coverageConfidence: "high"` — the per-rule layer contradicts the warning
channel.

## Assertions that lock it in

- `meta.warnings` contains `scan_file_parser_bail_no_findings`
- every `perRuleCoverage` row (ruleId: `"*"`) has `coverageConfidence: "low"`
  with `coverageConfidenceReason` containing `"parse-bailed-non-jsx-in-tsx-route"`

## Sanitization notes

Source is a synthetic minimal plain-JS module. No upstream project content.
The structural shapes (relational member-access comparisons that trigger the
TSX parser bail) are sanitized generic forms.

## Status

`todo: true` — intentionally RED until `runScanAndFormat` wires in
`applyParserBailRouteAdjustment`. Remove `todo` once the fix lands.
