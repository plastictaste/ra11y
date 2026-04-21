---
title: "VPAT conformance mapping"
audience: certification leads, compliance engineers
---

# VPAT conformance mapping

The Voluntary Product Accessibility Template (VPAT) is a federal-procurement artifact. Agencies use it to evaluate whether a product meets their a11y requirements before purchasing. ra11y's `vpat` report produces one deterministically from scan state.

This page documents how ra11y maps its internal data (violations, coverage, rule metadata) to VPAT verdicts.

## The five VPAT verdicts

Every criterion in the target standard is assigned exactly one of:

| Verdict | When it's emitted |
|---------|-------------------|
| **Supports** | The criterion is fully automatable, NOT in the runtime-evidence allowlist, AND no rule satisfying it has produced a violation. |
| **Partially Supports** | The criterion is partially automatable, NOT in the runtime-evidence allowlist, AND the automated half has no violations. Remarks cell notes which aspects need manual review. |
| **Does Not Support** | At least one rule satisfying the criterion has produced an active violation. Applies to runtime-evidence-required criteria too — a proven static failure is honest negative evidence even when full evaluation would need runtime. |
| **Not Applicable** | Element-presence detection says the codebase doesn't use the feature (e.g. no `<video>` elements → media criteria not applicable). |
| **Not Evaluated** | No rule satisfies this criterion (manual-only), OR the criterion is in the runtime-evidence allowlist (keyboard, focus, rendered contrast, heading adequacy, pointer interaction, authentication flow) AND no fresh attestation (verdict `pass` / `fail` / `n/a`) has been supplied. Absence of a static finding on a runtime-dependent SC is not evidence of conformance. |

### Runtime-evidence-required criteria

Some WCAG criteria fundamentally require runtime observation — the normative requirement is about keyboard traversal, focus management, rendered color contrast, heading/label adequacy, or pointer interaction that a source-level AST cannot observe. The canonical list lives at `src/reports/runtime-evidence-criteria.ts` as `RUNTIME_EVIDENCE_REQUIRED_CRITERIA`. On a clean bootstrap scan (zero violations, no attestations), these route to `"Not Evaluated"` rather than `"Partially Supports"` — the honest framing is "the static layer cannot answer this question."

To move a runtime-only criterion out of `"Not Evaluated"`, supply an attestation via the `attest` MCP tool (or `.ra11y/attestations.jsonl` directly) once a runtime harness or manual-review pass produces a verdict. The VPAT builder reads attestations with verdict `"pass"`, `"fail"`, or `"n/a"`; `"pending"` verdicts (bare pragmas without a reason) do not count as evidence.

## Mapping in detail

### The `automatable` metadata

Every criterion in ra11y's standard modules declares `automatable: "full" | "partial" | "manual"`:

- **full** — the rule engine can catch every conformance failure mechanically. Example: WCAG 1.1.1 for `<img>` alt text.
- **partial** — the engine catches a meaningful subset; the rest requires manual audit. Example: WCAG 1.4.3 contrast — the engine catches in-file CSS pairs but can't resolve Tailwind utility classes or inherited styles.
- **manual** — no static check is possible. Example: WCAG 1.2.2 — "captions are provided for prerecorded audio content."

### Conformance derivation

```
criterion automatable = "full"
  - no violations → Supports
  - any violation → Does Not Support

criterion automatable = "partial"
  - no violations → Partially Supports (remarks: "Automated checks pass; manual audit required for <specific aspects>")
  - any violation → Does Not Support

criterion automatable = "manual"
  - always → Not Evaluated (remarks: "requires manual review — this criterion cannot be fully determined by static source analysis")

Runtime-evidence-required override:
  - any criterion in RUNTIME_EVIDENCE_REQUIRED_CRITERIA, with zero violations AND no fresh attestation → Not Evaluated
  - (a proven static failure still routes to Does Not Support; an attestation with verdict pass/fail/n/a releases the criterion back to its automatable default)

Element-presence override:
  - any criterion that depends on element X, where X is absent from the codebase → Not Applicable
```

Precedence: violations win over element-presence, which wins over runtime-evidence-required, which wins over automatable metadata. A proven failure is always surfaced; a runtime-only SC with a runtime-attested verdict is evaluated; a runtime-only SC with neither is honestly "Not Evaluated."

### Element-presence detection

`src/mcp/manual-applicability.ts` runs an element-presence scan alongside the rule scan. Results feed both `checklist` (to mark `likelyRelevant: false`) and `vpat` (to emit `Not Applicable`).

Presence checks currently cover:

- `<video>`, `<audio>` — media criteria (WCAG 1.2.1, 1.2.2, 1.2.3, 1.2.4, 1.2.5, 1.2.6, 1.2.7, 1.2.8, 1.2.9, 1.4.2, plus WCAG 2.1 equivalents)

Additional presence checks (forms, tables, iframes, landmarks) are tracked on the v1 backlog and land with the finders that consume them. Until then, criteria outside the media set fall through to `Not Evaluated` on clean automated scans.

## Running the report

```sh
ra11y --vpat src/ --standard wcag22 --level AA > vpat.md
```

Or from MCP:

```
Call the `coverage` tool with level AA, then iterate criteria.
```

The future `draft_vpat_narrative` tool (Phase 20) takes this a step further — for each criterion, samples the host for a remarks cell that references the specific rules that passed and any partial-automation caveats.

## See also

- [`docs/kb/architecture/reports.md`](../kb/architecture/reports.md) — all four report kinds.
- [`docs/certification/readiness-scoring.md`](./readiness-scoring.md) — the readiness-scorecard report (sibling).
- [`docs/certification/wcag-certification-guide.md`](./wcag-certification-guide.md) — end-to-end guide to using ra11y to prepare for a certification audit.
