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

The canonical-field rename stands. The originally-planned dual-emission
transition window — shipping `rulesByExtension` alongside
`rulesFiredByExtension` for one minor release with a structured
`deprecated_field_rules_by_extension_renamed_rules_fired_by_extension`
warning — was dropped before any tagged release; see the postscript
below.

## Postscript — dual-emission shape dropped before release

The originally-planned transition shipped `rulesByExtension` alongside
`rulesFiredByExtension` carrying the identical value, with the warning
code firing whenever the alias rode. Field-test sweeps observed the
shape recurring across multiple corpora as the canonical "Ambiguous
field shapes are dishonest" failure mode in
`docs/kb/architecture/ai-first-consumer.md` — two byte-identical
fields on every coverage response forced the agent to disambiguate
which name to read while inflating bulk-corpus payloads (~6–10 KB on
verbose `meta` responses). This is the same shape Q9-DUPLICATE-ID-
AND-CRITERIONID-AFTER-RENAME closed for the parallel `id` →
`criterionId` rename on `coverage` entries.

Per the doctrine, the durable closure is to drop the duplicate
field, the narrating warning code, and its `warningsDetails` marker
before any release tagged the alias — no shipped consumer ever read
`rulesByExtension`, so dropping it is non-breaking. The canonical
field `rulesFiredByExtension` rides alone. The `### Deprecated`
CHANGELOG entry that announced the alias is amended to record the
drop. Closes Q9-RULESBYEXTENSION-DUP-PAYLOAD.

The pattern was first considered in 2026-04-23 for Q7-CRITERION-ID-FIELD-NAME-
DRIFT (`coverage` entries' `id` → `criterionId` rename) and closed
the same way under Q9-DUPLICATE-ID-AND-CRITERIONID-AFTER-RENAME on
2026-04-27. Renames behind a transition alias are still a valid
shape — what fails the doctrine is the dual-emission window where
both names carry identical values on every entry of every response.

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

- The canonical field `rulesFiredByExtension` carries the per-extension
  eligibility view; it rides alone under `verboseMeta`.
- The previously-planned `rulesByExtension` alias is not emitted at any
  verbosity. The `deprecated_field_rules_by_extension_renamed_rules_fired_by_extension`
  warning code and its `warningsDetails` marker are removed (no shipped
  consumer ever read either).
- Tool descriptions in `scan`, `scan_file`, `scan_project`, `scan_diff`,
  and `audit` mention only the canonical name.
- The CHANGELOG `### Deprecated` entry that announced the alias is
  amended to record the drop before any tagged release.
- A unit test pins the canonical-field-rides-alone invariant so the
  dual-emission shape can't silently re-land
  (`tests/unit/mcp/analysis-coverage.test.ts`).
