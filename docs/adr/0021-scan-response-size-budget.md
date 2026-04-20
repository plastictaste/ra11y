# ADR 0021 — scan_project response size budget

- Status: Accepted
- Date: 2026-04-20
- Supersedes: none
- Superseded by: none
- Related: P1-OVF (current files-with-findings pagination), V1-SIZE-LABEL-ECHO-CAP (per-finding echo cap)

## Context

`scan_project` against Bootstrap returned 147 KB and tripped the MCP host token ceiling on the first call even with `limit: 50`. The current default `DEFAULT_PAGE_LIMIT = 200` was sized against a rough worst-case inventory — "cap the list so a monorepo with thousands of files doesn't flood the response" — without a budget for the wire shape. After V1-SIZE-LABEL-ECHO-CAP capped the per-finding echo at 200 chars the per-finding ceiling is now bounded, but the file count × findings-per-file × meta telemetry product is still the dominant response-size driver and the 200 default leaves it unbounded in practice.

Measurement — in-process `scan_project` handler against real-world and synthetic fixtures on branch `worktree-agent-a8eb4fd3`:

| fixture | files in response | findings | response bytes |
|---|---:|---:|---:|
| forms-validation | 2 | 6 | 15,987 |
| data-tables | 1 | 1 | 11,665 |
| nav-landmarks | 1 | 3 | 10,934 |
| tailwind-coverage | 7 | 9 | 19,656 |
| live-region-status | 2 | 5 | 15,200 |
| synthetic-10-files (label-heavy) | 10 | 80 | 70,427 |
| synthetic-15-files | 15 | 120 | 101,229 |
| synthetic-20-files | 20 | 160 | 132,025 |
| synthetic-25-files | 25 | 200 | 162,820 |
| synthetic-50-files | 50 | 400 | 317,111 |
| synthetic-100-files | 100 | 800 | 625,146 |
| synthetic-200-files | 200 | 1,600 | 1,241,554 |

Bytes-per-file is remarkably stable on a given profile — ~6.2 KB/file for the label-heavy synthetic (eight findings per file with long visible labels), ~2.8 KB/file for realistic sparse findings (tailwind-coverage), ~2.9 KB/file amortized for the reported Bootstrap case (147 KB at 50 files). File count, not per-finding bytes, is the cheap lever.

The host-imposed token ceiling is ~25K tokens ≈ 100 KB for typical MCP hosts. A default that ships 1.24 MB responses cannot be reconciled with that ceiling without a round-trip.

## Decision

Lower `DEFAULT_PAGE_LIMIT` from 200 to **25**. Pagination semantics — `truncated: true`, `nextOffset`, `totalFilesWithFindings` — are unchanged. The caller-supplied `limit` range stays at [1, 2000]; only the default moves.

Rationale for option (a) over a token-aware budget (option b):

- Bytes-per-file is stable on a given profile; a file-count cap is the honest lever.
- `limit`/`offset` is a contract agents already understand. Introducing a token-aware budget replaces that contract with a new mental model ("the cap unit is estimated tokens, not files") and requires re-learning it across every consumer.
- The measurements show a clean inflection: at 15 files the label-heavy synthetic is right at 100 KB; at 25 files the Bootstrap-class amortized profile (2.9 KB/file) is ~72 KB; at 25 files the label-heavy synthetic is ~163 KB — well above 100 KB but below the ~200 KB danger zone where most hosts actually reject.

25 files is the calibration point where:

- The Bootstrap 147 KB-at-50-files profile maps to ~72 KB at the new default — comfortably under the ceiling.
- Typical real-world corpora (2–4 KB/file amortized) stay well under 100 KB at the default.
- The label-heavy synthetic (pathological: every form element missing a label, long visible text) lands at ~163 KB — honest `truncated: true` + `nextOffset` signals paginate the rest. Not "under ceiling," but the host no longer rejects the first call.

The `limit` description in the tool schema is updated to reflect the new default. Nothing else on the response shape changes; the token-budget variant can still land later if real-world data shows bytes-per-file drifts enough to re-open the question.

## Consequences

- **Default responses fit the common host ceiling.** A fresh `scan_project` call on a medium repo returns under ~100 KB on typical profiles and under ~200 KB on pathological (label-heavy) profiles. Both are first-call-safe on the hosts that today reject responses above 25K tokens.
- **Truncation is the common case on medium-plus repos.** A repo with ≥25 files-with-findings now always sees `truncated: true` + `nextOffset` on the first call. Pagination was previously rare; this default makes it routine. The existing test (`tests/unit/mcp/paginate-files.test.ts`) already covers page-1 and mid-paging shapes; no new contract, only more traffic on the existing one.
- **Consumers who were relying on the 200 default get a soft behavior change.** Callers that want the old behavior set `limit: 200` explicitly; the MAX_PAGE_LIMIT of 2000 is unchanged. This is called out in the changelog under Changed rather than Breaking — the `limit` parameter has always existed and pagination has always been honest when triggered. Agents using `nextOffset` to page continue to work without modification.
- **No new wire fields.** Response shape, meta telemetry, and `warnings` codes are unchanged. The cap is the only delta.
- **The token-aware alternative remains on the table.** If a future measurement shows per-file bytes drift substantially (e.g., a new meta field that grows with finding count), the file-count cap gets inaccurate. At that point option (b) is the correct follow-up, likely gated on a new `V1-SIZE-RESPONSE-BUDGET-V2` backlog item. The present ADR does not foreclose it.

## Alternatives considered

**Option (b) — token-aware greedy budget.** Walk files in the existing order, serialize each, and include files until the estimated response bytes would cross a threshold (~100 KB). Mark `truncated: true` + `nextOffset` at the stopping point. Rejected as over-engineered for the data: bytes-per-file stability means a fixed file cap captures the same effect with less moving parts, and the new cap-unit (estimated bytes) is harder for agents to reason about than a file count. Worth revisiting when `bytesPerFile` varies materially across real-world corpora.

**Token-aware plus lower file default.** Deferred for the same reason — it solves a problem we don't yet have and adds a contract consumers would need to learn alongside a change they already have to absorb.

**Lower to 15 (the synthetic 100 KB breakpoint).** Too aggressive. The label-heavy synthetic is pathological — a realistic label-heavy repo averages 3–5 findings per file, not 8. Picking 15 optimizes against a fixture we constructed, not the Bootstrap data point from the field report.

## Amendment (2026-04-20): token-density secondary budget

The file-count cap calibrated above holds on codebases where bytes-per-file is bounded — but not on *density-heavy* codebases where findings cluster in few label-dense files. Re-measurement on `twbs/bootstrap` (second-pass, via the `V1-SIZE-RESPONSE-BUDGET-DENSITY` `fix.description` hoist, 075b64c + 2a26c25):

| metric | value |
|---|---|
| parseable files scanned | 125 |
| findings total | 131 |
| files-with-findings | **18** |
| response size after hoist | ≈ 107 KB (~26.7k tokens) |

With 18 < 25, the file-count cap never engages — `truncated` / `nextOffset` don't fire — and the response ships 1.07× the ~25k token MCP host ceiling. The original ADR projected worst-case ~163 KB "with honest `truncated` + `nextOffset` signals," but that projection assumed the file count would exceed the cap and trigger pagination. Bootstrap shows the signals can fail to engage when per-file density, not file count, is the bloat axis. Root cause: `semantics/label-in-name` emits a 1,970-char `fix.description` that repeats verbatim 6× (~12 KB of the response); `forms/autocomplete-missing` repeats a 150-char description 31× (~4.5 KB). The Q2-PROSE-style `fix.description` hoist (`V1-SIZE-RESPONSE-BUDGET-DENSITY` option (b), shipped at 075b64c) recovered 14.1% (~17.6 KB), but the remaining per-finding `message` (~22 KB), `fix` (~13 KB), `suppressWith` (~7.6 KB), and `criteriaTitles` (~3.8 KB) are not dedupable at that layer.

**Decision.** Add a byte-based secondary budget on top of the existing file-count cap. After the `fix.description` hoist runs in the response-assembly path (`tool-scan-project.ts`, `tools.ts`, `tool-scan-diff.ts`), the helper `applyTokenBudget` (in `src/mcp/tools-helpers.ts`) measures `JSON.stringify(response).length`; if over budget, drops trailing file entries one at a time until the serialized shape fits, then flips `truncated: true`, records `nextOffset = offset + keptFileCount`, and surfaces a `response_token_budget_truncated` warning code so the caller can distinguish density truncation from the existing file-count truncation. The `limit` / `offset` contract is unchanged — the density cap is a *secondary* guard that fires only when per-file density would push the response past the threshold even after `limit` has been applied. Either cap firing is honest truncation; `truncated: true` is set in both cases, and the two causes are disambiguated by the presence or absence of the new warning code.

**Characters-per-token proxy.** We use `Math.ceil(bytes / 4)` as the standard rough estimate for English-heavy structured JSON across mainstream BPE tokenizers. A real tokenizer would violate the zero-dependency invariant in CLAUDE.md §3. The proxy is exposed as `CHARS_PER_TOKEN_PROXY = 4` so tests and reviewers can see the choice without reading the helper's code. Ratio drift is bounded: even if a future tokenizer shifted the ratio by ±25% on our content, the amendment's 3k-token headroom below the 25k ceiling absorbs it. If a host ceiling tightens or the response shape diversifies so the proxy mis-estimates by more than the headroom, re-calibrate `DEFAULT_TOKEN_BUDGET_CHARS` against measured bytes against that host.

**Default ceiling.** `DEFAULT_TOKEN_BUDGET_CHARS = 88000` (≈ 22000 tokens via the 4-chars-per-token proxy). The 22k/25k split leaves ~3k tokens of headroom so the JSON.stringify measurement overhead, the MCP envelope wrap (`content[0].text` as a JSON string-encoded payload), and host-side framing don't push the response past the ceiling.

**Progress guarantee.** The helper keeps at least one file entry even when the single surviving file still exceeds the budget. The alternative — empty `files` with `truncated: true` — produces a response the caller cannot paginate past (no resumable state), silently converting a density-truncation signal into a regression gap. With ≥1 file preserved, the caller always has something to read and `nextOffset` advances into the dropped tail.

**Composition with file-count cap.** Both caps share the same `truncated: true` flag; the density cap's warning code (`response_token_budget_truncated`) is the disambiguator. `totalFilesWithFindings` always reflects the full pre-truncation file count so callers see the inventory size regardless of which cap fired. `nextOffset` on density-truncated scan_project responses points past the dropped files so the next call resumes correctly.

**Scope.** Wired through `scan`, `scan_project`, and `scan_diff` (both baseline and hunks modes). `scan_file` is a single-file shape — the density cap's drop dimension (trailing file entries) does not exist there, so the helper is not called on that path. The coverage matches `V1-SIZE-RESPONSE-BUDGET-DENSITY` (b) — `suggest_fix` / `apply_fix` / `baseline` are skipped for the same reason: their response bodies don't carry a multi-file array the density cap can trim. `scan` has no `limit`/`offset` contract, so when the cap fires there it emits `truncated: true` + `totalFilesWithFindings` + the warning, but omits `nextOffset` — the remediation surfaced via the warning is "narrow `paths` or use `scan_project` which does paginate."

**Measurement after amendment.** Verified post-merge against `/tmp/bootstrap` (twbs/bootstrap) via in-process handler call:

| metric | pre-amendment (post-hoist) | post-amendment |
|---|---:|---:|
| response body bytes | 107,036 | 78,167 |
| approx tokens | ~26,759 | ~19,542 |
| envelope bytes | — | 86,098 |
| envelope approx tokens | — | ~21,525 |
| files in response | 18 | 8 |
| totalFilesWithFindings | 18 | 18 |
| truncated | false | **true** |
| nextOffset | — | 8 |
| warnings | `no_config_found`, `extensions_skipped_no_parser` | `no_config_found`, `extensions_skipped_no_parser`, **`response_token_budget_truncated`** |

The 25k MCP ceiling is respected with ~3.5k tokens of envelope headroom. The second call against `nextOffset: 8` covers the remaining 10 files with findings. CI guardrail: a 50-file label-dense HTML fixture with `limit: 50` produces a truncated response ≈ 82 KB (previously unbounded-by-file-count), with `response_token_budget_truncated` emitted — see `tests/unit/mcp/token-budget-scan-project.test.ts`.

**Non-reversal of prior decision.** The original decision (lower `DEFAULT_PAGE_LIMIT` from 200 to 25) still holds. File-count is still the primary guard — cheap to reason about, matches an existing contract. The token-density cap is a secondary guardrail for the case the original ADR flagged as the natural follow-up: "If a future measurement shows per-file bytes drift substantially (e.g., a new meta field that grows with finding count), the file-count cap gets inaccurate. At that point option (b) is the correct follow-up…" The present amendment lands that follow-up. Option (c) — shifting full `fix.description` prose off scan responses onto `suggest_fix` — remains on the table as a larger shape change if future measurements show the density cap can't hold typical codebases under 25k tokens.
