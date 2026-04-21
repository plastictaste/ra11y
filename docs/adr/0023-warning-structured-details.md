# ADR 0023 — Structured warning details as a parallel channel

- Status: Accepted
- Date: 2026-04-20
- Supersedes: none
- Superseded by: none
- Related: `src/mcp/warnings.ts`, `src/mcp/scan-assembly.ts`, `docs/kb/architecture/ai-first-consumer.md`, ADR 0021 (scan response size budget)

## Context

MCP scan-family responses carry a top-level `warnings: string[]` channel whose codes are defined in `ScanWarningCode` (`src/mcp/warnings.ts`). The header on that file names the doctrine: "Codes are stable identifiers, not English. Agents branch on the code; the prose of 'why this fired' lives in the same response's `meta` fields which the warning implicitly points at." That split works for codes whose signal is pure presence (`no_config_found`, `scanned_zero_files`, `storybook_preset_active`) — the name of the code *is* the payload.

It breaks for `extensions_skipped_no_parser`. A seventh-pass `scan_project` run against `twbs/bootstrap` HEAD returned 125 parseable files out of 453 source files — 328 dropped at ingestion (110 `.mdx`, 104 `.astro`, 114 `.scss`). The warning code fired, and the ext-count map surfaced in `meta.analysisCoverage.skippedByExtension`:

```jsonc
{
  "warnings": ["extensions_skipped_no_parser"],
  "meta": {
    "analysisCoverage": {
      "skippedByExtension": { ".mdx": 110, ".astro": 104, ".scss": 114 }
    }
  }
}
```

Per the AI-first consumer doctrine, the two channels have different jobs:

- `warnings` is the terse silent-failure channel. Agents triage by branching on codes here.
- `meta` is the verbose scan-confidence channel. Agents read it to calibrate how much weight to put on the headline counts.

The current shape forces agents that branch on `warnings[]` to cross-reference `meta.analysisCoverage` to answer "which extensions were skipped." Either channel should be sufficient on its own per the doctrine entry on one-tool-call-answers-what-next.

Two shapes were on the table:

**(1) Promote every warning to a tagged-object union** — `warnings: Array<string | { code, ...payload }>` or `warnings: Array<{ code: ScanWarningCode, ...payload? }>`. Every consumer reading `warnings[i] === "extensions_skipped_no_parser"` would break; the mixed union is itself the "ambiguous field shapes are dishonest" failure mode in a different place. Existing CHANGELOG `## [Unreleased]` entries already carry five breaking-change notes for v1.0; a sixth on the primary warning channel is cost on every downstream agent and is not motivated by the gap this item closes — the gap is specifically about `extensions_skipped_no_parser`, not about a fundamental shape problem with the warnings channel.

**(2) Add a parallel `warningsDetails: Record<ScanWarningCode, Payload>` sibling** — populated only for codes that carry structured data, conditional-spread on the response. `warnings: string[]` stays exactly as it is today; the bare-code channel remains the canonical "branch on this" surface; the structured-detail channel augments specific codes when useful.

## Decision

Ship option (2). Add a top-level `warningsDetails` object, conditional-spread, keyed by `ScanWarningCode`:

```ts
type ScanWarningDetails = {
  readonly extensions_skipped_no_parser?: {
    readonly extensions: readonly string[];   // sorted by descending count, ties broken alphabetically
    readonly topExtension: string;            // first entry
    readonly topCount: number;                // count for the top extension
    readonly totalSkipped: number;            // sum across the map
  };
};
```

Shape rules:

1. `warningsDetails` is emitted only when at least one code has a structured payload. Zero-payload codes (`no_config_found`, `scanned_zero_files`, `storybook_preset_active`, etc.) leave the object empty and the conditional-spread omits the field entirely — no `warningsDetails: {}` sentinel.
2. A code that fires in `warnings[]` may or may not have a matching entry in `warningsDetails`. Consumers that want the enumeration check the code under `warningsDetails`; consumers that branch only on presence stay on `warnings[]`. The two channels agree on set membership for the codes they both populate; `warningsDetails[code]` without the code in `warnings[]` is never emitted (assembled at the same call site).
3. The payload shape is per-code. Not every code grows a payload; some may never. This ADR only defines `extensions_skipped_no_parser`. Future codes follow the pattern: if enumeration is useful and already sits in `meta`, a small mirror lands under `warningsDetails.<code>` with conditional spread.
4. `warnings: string[]` stays exactly as it is today. The bare-code channel is the stable triage surface; promoting it to tagged objects is rejected (see Alternatives).

For `extensions_skipped_no_parser`, the payload is constructed from `discoveryDiagnostics.skippedByExtension` at the emission site (`src/mcp/scan-assembly.ts`). The existing `meta.analysisCoverage.skippedByExtension` map is preserved verbatim — the `warningsDetails` payload is an additional dense summary shaped for fast branching (top extension, total), not a replacement. An agent that wants the full per-ext distribution still reads `meta.analysisCoverage.skippedByExtension`; an agent that only wants "how bad is the skip" reads the top-level `warningsDetails.extensions_skipped_no_parser.totalSkipped` without cross-referencing `meta`.

Migration: purely additive. No existing field changes type or cardinality. Every existing consumer that reads `warnings: string[]` continues to work. CHANGELOG lands under `## [Unreleased] ### Added` — not Breaking.

## Consequences

- **Backward-compatible.** Every consumer that branches on `response.warnings[i] === "extensions_skipped_no_parser"` stays green. Tests that read `warnings.includes(...)` stay green. External agents using the published MCP shape stay green. This preserves the five existing `## [Unreleased]` breaking-change entries as the full v1.0 breaking-change bill — we do not add a sixth unnecessarily.
- **One tool call answers "what next?" for this code.** An agent branching on `warnings` can now stop at the structured `warningsDetails` sibling without descending into `meta` — the top three skipped extensions and total skip count are directly readable. The `meta.analysisCoverage.skippedByExtension` full-distribution map stays for agents that do want the long tail.
- **Precedent for future structured payloads.** Codes where a small enumeration would save a round-trip to `meta` (potential future candidates: `parse_errors_present` carrying the top parse-error file path, `tailwind_detected_css_undercounted` carrying the CSS vs JSX ratio) land their payloads under `warningsDetails.<code>` without re-litigating the channel shape. The split (terse `warnings[]` + conditional `warningsDetails`) scales without a schema break per code.
- **Scope of this ADR is exactly one code.** Only `extensions_skipped_no_parser` gets a `warningsDetails` entry in this change. Other codes keep their existing presence-only shape. Adding a new payload later is a per-code increment, not a shape migration — the container already exists.
- **Zero runtime-dependency invariant preserved.** Purely additive in-tree change; no parser, formatter, rule, or scanner contract changes. No new imports beyond the existing `analysisCoverage` + `discoveryDiagnostics` plumbing.
- **Tests asserting the shape migrate in one file.** `tests/unit/mcp/warnings.test.ts` gains new coverage for the builder function; `tests/unit/mcp/tool-coverage.test.ts` and `tests/unit/mcp/scan-assembly*.test.ts` inherit the payload at the call-site integration level. No test asserting `warnings[]` shape breaks.

## Alternatives considered

**Option (1) — tagged-object warnings.** Replace `warnings: string[]` with `warnings: Array<{ code, ...payload }>` or the mixed union `Array<string | { code, ...payload }>`. Rejected:

- The mixed union is itself the "ambiguous field shapes are dishonest" failure mode — a consumer has to type-discriminate before branching.
- The uniform object shape forces every presence-only code into a wrapper object (`{ code: "no_config_found" }`) whose only content is the code; the indirection buys no signal for >90% of the codes but costs every existing consumer a migration.
- A breaking change to the primary warnings channel is disproportionate to the gap. The item named one code where the cross-reference hurt; a channel-wide reshape is scope creep.

**Nest `warningsDetails` under `meta`.** The structured payload is scan-confidence signal and `meta` is the existing home for scan-confidence signal — tempting to put it there. Rejected: the doctrine entry this item points at says "Either path should be sufficient on its own." Putting the enumeration back under `meta` keeps the cross-reference burden; `warningsDetails` has to live at the top level alongside `warnings` for an agent branching on codes to find it without descending.

**Emit the full `skippedByExtension` map under `warningsDetails.extensions_skipped_no_parser`.** Considered — would let agents skip `meta.analysisCoverage` entirely for this code. Rejected: on pathological mixed-language repos the map can carry dozens of long-tail extensions (`.pyc`, `.d.ts`, `.map`, `.lock`, editor swap files). The verbose distribution is legitimate scan-confidence telemetry but also bloat on the terse warnings channel, where the signal an agent wants is "how bad and in what kind of code." Dense summary (`topExtension`, `topCount`, `totalSkipped`, list of top N) on the warnings side; full distribution stays in `meta`. The two channels retain their roles.

**Wait until v1.0 releases and add the new channel then.** Rejected: CHANGELOG `## [Unreleased]` entries are already accumulating for v1.0 and this item names the gap explicitly against the seventh-pass bootstrap scan. Shipping the additive channel now lets the v1.0 changelog describe the full warnings surface; deferring to v1.1 would ship v1.0 with a known cross-reference gap called out in the backlog.
