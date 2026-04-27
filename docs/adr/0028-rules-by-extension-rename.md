# 0028 — Rename `analysisCoverage.rulesByExtension` to `rulesFiredByExtension`

Status: accepted
Date: 2026-04-24

## Context

`meta.analysisCoverage.rulesByExtension` and `meta.perRuleCoverage` carry
incompatible "what ran?" signals under look-alike labels.

`rulesByExtension[ext]` lists every active rule whose `appliesTo.fileExtensions`
gate matches `ext` (via `extensionMatches`, so aliases expand). Rules without
any extension gate are unconditionally included. The field has nothing to say
about whether a rule produced findings — only that it was eligible to evaluate
files of that extension.

`perRuleCoverage[].filesEvaluated` is a per-rule count of files the rule's
`check()` actually ran against — coupled to the rule-runner's evaluation
tracker, not the static extension gate.

Field reports keep landing because the names are ambiguous. On a
`scan_file` of `accessibility.mdx`, `rulesByExtension[".mdx"]` returns ~2
entries (the rules whose gates literally include `.mdx` or the alias-mapped
`.tsx`/`.jsx`), while `perRuleCoverage` shows ~53 rule rows from the broader
scan loop (every rule the runner attempted to dispatch). Both numbers
plausibly answer "how many rules ran?" — the disagreement is silent and
forces the agent to pick one source of truth.

This is the canonical "ambiguous field shapes are dishonest" doctrine
applied at the field-name level: when two surfaces carry the same name
shape (`rules*` + extension axis) but different semantics, the agent's
downstream triage propagates whichever interpretation it picked first.

## Decision

Rename `analysisCoverage.rulesByExtension` to
`analysisCoverage.rulesFiredByExtension`.

The new name reads as "rules eligible to fire on files of this extension"
— still distinct from `perRuleCoverage`'s post-runner tally, but no longer
sharing the same shape-name with categorically different semantics. Agents
join `perRuleCoverage` by `ruleId` for the per-rule tally and read
`rulesFiredByExtension[ext]` for the per-extension eligibility view; the two
field names no longer compete for the same role.

For one minor release, the deprecated name `rulesByExtension` ships
alongside `rulesFiredByExtension` carrying the identical value. Whenever
the alias rides, the response emits the structured warning
`deprecated_field_rules_by_extension_renamed_rules_fired_by_extension`
on the top-level `warnings` channel so callers can self-migrate without
a hidden break. The alias is removed in the next minor release; the
`### Deprecated` CHANGELOG entry tracks the removal window.

This pattern was first considered in 2026-04-23 for Q7-CRITERION-ID-FIELD-NAME-
DRIFT (`coverage` entries' `id` → `criterionId` rename). The Q7 dual-emission
shape was later dropped before any release tagged the alias because the two
identical-value fields on every entry triggered the AI-first consumer model
"Ambiguous field shapes are dishonest" rule (Q9-DUPLICATE-ID-AND-CRITERIONID-
AFTER-RENAME). The same risk exists here — if `rulesByExtension` and
`rulesFiredByExtension` both ride identical payloads on every coverage
response, the same rule fires.

## Alternatives considered

- **Merge into `perRuleCoverage` with an explicit `evaluated`/`fired`
  split.** Restructures the existing per-rule entries into a wider record
  and changes the shape of a stable surface. Higher blast radius for the
  same disambiguation gain; deferred until evidence shows the per-extension
  view has no independent value.

- **Drop `rulesByExtension` outright.** The per-extension view is a useful
  scan-confidence signal (an agent can answer "did any contrast rule run on
  this `.scss` file?" from one map lookup, not by walking every
  `perRuleCoverage` row). Dropping it forces the agent to reconstruct the
  view per call.

## Consequences

- New field `rulesFiredByExtension` carries the canonical per-extension
  eligibility view.
- Deprecated field `rulesByExtension` ships unchanged for one minor
  release; agents reading the legacy name keep working.
- New warning code
  `deprecated_field_rules_by_extension_renamed_rules_fired_by_extension`
  fires whenever the alias rides — agents can branch on the warnings
  channel and rewrite their reads in one round trip.
- Tool descriptions in `scan`, `scan_file`, `scan_project`, `scan_diff`,
  and `audit` mention the new name; the legacy name disappears from
  tool-list payloads on the next minor.
- The CHANGELOG `### Deprecated` section gets an entry pointing at this
  ADR and the removal window.
