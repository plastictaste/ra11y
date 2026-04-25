---
title: "MCP tool reference"
audience: users, agents
---

# MCP tool reference

Every tool the ra11y MCP server exposes, with inputs, outputs, and when to reach for it.

For setup: [`server-setup.md`](./server-setup.md). For architecture: [`docs/kb/architecture/mcp-server.md`](../kb/architecture/mcp-server.md).

## Discovery

### `list_rules`

Returns the full rule catalog with metadata.

**Use when:** the agent needs to know what ra11y can check for, or the user asks "what rules does ra11y ship?"

### `explain_rule`

Takes a `ruleId`. Returns the rule's full metadata: WCAG normative quote, rationale, good/bad examples, references.

**Use when:** resolving a violation and the agent needs the spec context to write a good fix.

### `explain_standard`

Takes a `standardId` (e.g. `wcag22`) and optional `level`. Returns the standard's metadata and criterion list, filtered to that level.

**Use when:** drafting a VPAT, comparing coverage across standards, or picking criteria for a manual-review pass.

## Scanning

### `scan`

Scans explicit paths. Required: `paths: string[]`. Optional: `standard`, `level`, `minSeverity`, `cwd`.

**Use when:** the agent has a specific set of files to check (e.g. the ones it just edited).

**Mixed files and directories:** each entry in `paths` can be a file path or a directory path, and a single call can mix both. The scanner resolves directories recursively and merges them with any explicit file entries before scanning.

```jsonc
// Mix a changed file with a directory in one call:
{ "paths": ["src/components/Button.tsx", "src/forms/"] }
```

**Default `minSeverity`:** `info` — keep it. Info findings are exactly where the agent adds value by reading source code; filtering to `warning` ships false negatives.

### `scan_project`

Scans the whole project. `paths` optional — omit and the server auto-promotes to the git root. `changedOnly: true` or `since: "<git-ref>"` scope to diffs for CI-on-diff workflows.

**Use when:** first-pass triage of a new repo, or a CI check on a PR.

### `scan_file`

Single-file re-scan using the cached AST. Fast — skips parsing when mtime is unchanged.

**Use when:** the fix-verify loop after editing one file.

## Triage

### `detect_native_wrappers`

Heuristic tool for onboarding. Scans the codebase for PascalCase React components frequently paired with `onClick` — the candidates for `nativeWrappers` in `ra11y.config.ts`. Each candidate comes with a confidence score and example locations.

**Use when:** first-time setup on a React codebase. Populates the config knob that quiets false positives from `keyboard/handler-missing` on design-system wrappers.

### `suggest_fix`

Takes a finding; returns a structured fix where one exists. Confidence is `"high"` when the rule has a deterministic fix (e.g. adding a missing `alt=""` on a decorative image) and `"low"` when the fix is prose guidance (the agent has to tailor it).

**Use when:** about to edit a file to resolve a violation.

## Coverage & review

### `coverage`

Per-standard summary: automated, total, passing, failing, manual-review count. Level-filterable.

**Use when:** producing a status readout or deciding where to focus the next manual-review session.

### `checklist`

Manual-review criteria grouped by section, with review prompts and candidate locations. Items flagged `likelyRelevant: false` when the supporting elements don't exist in the codebase (e.g. media criteria on a repo with no `<video>`).

**Use when:** driving a human- or LLM-led manual review pass.

### `review_candidates`

The programmatic counterpart to `checklist`. Returns tier-1 candidates as a flat list with source snippets and the finder's exact `reviewPrompt`.

**Use when:** the agent wants to iterate candidates one-by-one, reading source + answering pass/fail per item.

### `vpat`

Produces a VPAT 2.5 Rev conformance report (VPAT 2.5 Rev INT when EN 301 549 is in scope) from a fresh scan plus any durable attestations. MCP companion to `ra11y --vpat`.

Required inputs: `productName`, `productVersion`. Optional: `contactEmail`, `contactOrganization`, `evaluationMethods`, `notesOnEvaluation`, `cwd`, `additionalPaths`, `standards`, `level`, `format` (`"markdown"` or `"json"`).

Response carries structured entries per criterion (`standards[].entries[]`) with conformance verdicts (`Supports`, `Partially Supports`, `Does Not Support`, `Not Applicable`, `Not Evaluated`), procurement-grade remarks, and a `nextStep` + `nextStepStructured` pair routing to the canonical follow-up tool (`scan_project` when failures are present, `attest` when manual criteria remain, `conformance_statement` otherwise).

`format: "markdown"` additionally attaches `markdownRendering` — a ready-to-paste VPAT table. `format: "json"` (default) omits it; the structured entries are already the machine shape.

Empty-string product metadata carries through `<Product Name>` / `<Product Version>` placeholders AND raises `warnings: ["product_metadata_placeholders_in_use"]` so the agent knows to prompt the user before distributing the VPAT. Additional warnings: `scanned_zero_files` (tool ran against an empty tree) and `no_config_found` (no `ra11y.config.*` resolved at a real Node project root — the warning is gated on the scan seeing ≥ 10 files AND a `package.json` reachable in the config walk-up, so demo-size scans don't rebroadcast the `meta.configSource: null` signal).

```jsonc
// Minimal VPAT generation against the current project:
{
  "productName": "Acme App",
  "productVersion": "1.2.3",
  "contactOrganization": "Acme Inc.",
  "format": "markdown"
}
```

**Use when:** drafting the procurement artifact — VPAT for a RFP response, compliance review, or release audit.

### `suppress`

Writes a source-level `ra11y-disable-next-line` pragma above a target line so a specific finding stops firing on subsequent scans. Required inputs: `file`, `line` (1-based), `ruleId` (rule ID like `keyboard/handler-missing` or criterion ID like `wcag22:2.4.5`), `reason` (non-empty justification).

Like `apply_fix`, this is a mutating tool — the session must have `allowWrite: true` (set via `sessionConfigure`) or the call rejects with `allow-write-disabled`. Reason text is REQUIRED; a missing or whitespace-only reason rejects with `reason-required` rather than silently writing a bare pragma.

Comment shape per extension:

- `.tsx` / `.jsx` → `{/* ra11y-disable-next-line <id>: <reason> */}`
- `.ts` / `.js` → `// ra11y-disable-next-line <id>: <reason>`
- `.html` / `.htm` → `<!-- ra11y-disable-next-line <id>: <reason> -->`
- `.css` → `/* ra11y-disable-next-line <id>: <reason> */`

The pragma is inserted on its own line directly above the target, with indentation matching the target line so the comment stays visually grouped with the code it suppresses. Error envelopes: `file-not-found`, `line-out-of-range`, `file-unsupported`, `path-escapes-cwd`, `allow-write-disabled`, `reason-required`.

**Use when:** an agent has read the finding, determined it's a false positive or intentional exception, and wants a durable source-level dismissal (so the next scan passes without the agent re-justifying it).

## Session

### `sessionConfigure`

Sets session-level config: `standard`, `level`, `exclude`, `rules` (per-rule severity overrides), `nativeWrappers`, `cwd`, `allowWrite`.

**Use when:** the user adjusts scope mid-session ("also run Section 508", "downgrade `contrast/enhanced` to info").

Pass `cwd` alongside `nativeWrappers` to anchor the session wrappers to a specific project root. Session state is connection-wide, so later `scan_project` / `list_suppressions` calls against a different `cwd` will still see the wrappers — but the response will carry a `session_wrappers_configured_for_different_cwd` warning so an agent that switches targets sees the cross-cwd drift. Re-call `sessionConfigure` with the new project's `cwd` to re-anchor.

## Reading the output

Every tool returns `{ content: [{ type: "text", text: "<json>" }] }` where the JSON is the structured payload. Parse and inspect. For the `scan` family the top-level shape is:

```jsonc
{
  // No top-level pass boolean — see plan.summary and plan.totalFindings.
  "plan": { "totalFindings": number, "summary": string },
  "files": [
    {
      "filePath": string,
      "findings": [
        { "ruleId", "severity", "line", "column", "message", "suggestion", "criteria": [...] }
      ]
    }
  ],
  "meta": { "filesScanned", "configSource", "scanned": { "mode": "project", "root": "..." }, ... }
}
```

## groupKey semantics

Every finding carries two stable identity tokens: `findingId` and `groupKey`. They answer opposite questions.

- `findingId` — "is this the same finding across re-runs of the same scan?" Includes the file path and the normalized text of the flagged line. Two identical `<img>` elements in two files get different `findingId`s.
- `groupKey` — "is this the same kind of problem?" Excludes the file path and any identifier-specific data. Two identical `<img alt>` elements in 40 different files share one `groupKey`. Write one fix, apply it everywhere.

### What the hash covers

```
groupKey = sha256(ruleId + NUL + normalizedShape).slice(0, 12)
```

`normalizedShape` is produced by `describeNodeShape` in `src/engine/ast-helpers.ts`. It encodes the node's structural kind and preserves which attribute/property names are present, but strips values and position. Specifically:

| What is preserved | What is stripped |
|---|---|
| Element or selector kind (`html:img`, `jsx:a`, `css:rule`) | Attribute values (`alt="…"`, `href="…"`) |
| Attribute/property name set (`[attrs=:alt:src]`) | Unique identifiers (`id="…"`, `class="…"`) |
| Missingness of key attributes (`[missing=no-alt]`) | File path, line, column |
| CSS declaration property names (`[decl=color,outline]`) | CSS declaration values |
| CSS pseudo-class and pseudo-element markers (`:focus-visible`) | CSS selector class/id values |
| JSX spread presence (`[spread]`) | JSX expression content |
| Coarse children shape (`[children=text\|expr\|element\|mixed\|empty]`) | Literal text content |

The `ruleId` prefix ensures that two different rules firing on the same node always produce different `groupKey`s.

### What groupKey equality means in practice

**Same rule, AST-equivalent nodes, any number of files → same `groupKey`.**

```jsonc
// navigation/href-javascript-void fires on <a href="javascript:void(0)">
// in login.html AND checkout.tsx — both findings share one groupKey.
// Fix once, grep groupKey to find every site.
{ "groupKey": "a3f1b2c4d5e6" }
```

**Same rule, structurally distinct nodes → different `groupKey`.**

```jsonc
// media/alt-text-missing on <img> with no alt at all vs. <img alt="">
// (decorative, already exempted): different missingness → different groupKey.
// <img src="…">          → [missing=no-alt] → groupKey A
// <img src="…" alt="x"> → [attrs=:alt:src]  → groupKey B
```

**Different rules on the same node → always different `groupKey`s.**

### Per-rule-family behavior

The normalization rules above are universal. The practical effect differs by rule family:

**`navigation/link-descriptive-text` and `navigation/href-javascript-void`**

These fire on `<a>` elements. The `href` *value* is stripped by normalization; only whether the `href` attribute is present feeds the shape. Two `<a href="javascript:void(0)">` elements in two separate files share a `groupKey` — the rule is keyed on the presence of `href`, not the specific placeholder string used. Cross-file aggregation is the intended use case.

**`media/alt-text-missing`**

Fires on `<img>`, `<input type="image">`, `<canvas>`, `<svg image>`, and `role="img"` elements. The `src` value is stripped. What separates groups is the combination of: (a) which labeling attributes are present by name, and (b) whether `alt` is absent (`[missing=no-alt]`). An `<img>` with no attributes at all and an `<img src="photo.jpg">` share a `groupKey`; an `<img alt="x">` does not (the presence of `alt` is part of the shape, and the rule would not fire on it anyway).

**CSS rules (`contrast/minimum`, `focus/visible`, etc.)**

The CSS selector's class/id tokens are stripped but the selector's structural kind and pseudo-class markers survive. `.login-btn:focus-visible` and `.submit-button:focus-visible` canonicalize to the same shape (`class-selector:focus-visible`) and share a `groupKey`. Declaration property names survive but not values — two rules that both lack `outline` on `:focus-visible` selectors will share a `groupKey` regardless of what other declarations they carry.

### Fallback groupKey

When the emitting rule is project-scoped (no individual node target), or when a rule crashes and emits a synthetic `internal/rule-crash` record, `normalizedShape` is set to `"unknown-shape"`. All un-groupable findings for a given rule share one `groupKey`. This is an honest "these don't share a targetable node" bucket, not a suppression.

### How to use groupKey

```jsonc
// Collect all findings that share a groupKey and apply one fix:
const targets = findings.filter(f => f.groupKey === "a3f1b2c4d5e6");
// Every entry in targets has the same ruleId, the same structural
// pattern, and can accept the same edit.

// Use scan_project output: findings already carry groupKey.
// Use suggest_fix on one representative finding to get the edit;
// apply it at every location in targets.
```

Cross-file `groupKey` grouping is the primary affordance for bulk remediation. `findingId` is for tracking one finding's lifecycle. Both appear on every finding in the `scan` family responses.

For the full design rationale: [`docs/adr/0008-violation-group-key.md`](../adr/0008-violation-group-key.md).

## See also

- [`server-setup.md`](./server-setup.md) — how to wire this into your agent host.
- [`docs/kb/architecture/mcp-server.md`](../kb/architecture/mcp-server.md) — internal architecture.
- [`.claude/notes/mcp-iteration.md`](../../.claude/notes/mcp-iteration.md) — the decisions that produced this specific toolset.
