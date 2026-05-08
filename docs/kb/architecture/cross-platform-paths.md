---
title: "Cross-platform paths: POSIX everywhere external"
topic: architecture
audience: agents, contributors
---

# Cross-platform paths

ra11y's externally visible paths are POSIX (forward slash) on every host OS. The invariant is one-line: a Windows host scanning a Windows tree must produce the same path strings as a macOS or Linux host scanning the same source — `src/app/page.tsx`, never `src\\app\\page.tsx`. This file documents the rule, the boundary call sites that own it, and the enforcement script that ratchets it in.

## Invariant

Every path in an externally visible position is POSIX (forward slash) regardless of host OS. Internal `node:fs` operations can use either form (Node accepts both on Windows). The only place native separators are honest is the brief moment between OS-syscall return and the boundary helper — `readdirSync` results are joined with `node:path`, then handed straight to a normalizer before any other code observes them.

## Why

Three failure modes all collapse onto the same root cause — native separators leaking into externally observable strings:

1. **Cross-platform agents and consumers.** An MCP host on macOS calling a ra11y server scanning a Windows checkout would see `src\\app\\page.tsx` while the same scan on the same host's macOS clone returns `src/app/page.tsx`. Identifiers an agent treats as cross-surface stable (file paths in `files[]`, `findingId` hashes, `groupKey` references) drift silently per OS — the canonical "ambiguous field shapes" failure mode at the path layer.
2. **Deterministic JSON.** Baseline files (`ra11y.baseline.json`), suppression artifacts, and persisted attestations are JSON checked into version control. Backslash strings on a Windows checkin diff against forward-slash strings on a macOS rebase — the file thrashes per author OS rather than per-content change. Same applies to any JSON canonicalization the agent does on a tool response.
3. **String-equality safety.** Suppression pragma resolution (`<!-- ra11y-disable wcag22:1.4.5 -->` mapped against a finding's path), `groupKey` lookup, and "did this finding already exist in the baseline" checks all bottom out in JS string equality. A Windows-emitted `src\\foo.ts` never `===` a baseline-stored `src/foo.ts`. The miss is silent: the suppression doesn't fire, the baseline reports the finding as new, the agent has no signal that the comparison failed.

The cross-platform-paths invariant is the path-layer mirror of the AI-first consumer model's "Cross-surface count invariant" — same identity must serialize the same way across every surface that ships it.

## Boundary call sites

Externally visible positions — every path on these surfaces must be POSIX-shaped:

- **Scanner output.** `meta.scanned.root`, `meta.scanned.file`, `analysisCoverage.parseErrorFiles[].path`, `analysisCoverage.partialParseFiles[].path`, `analysisCoverage.fragmentFiles[].path`, `meta.scannedBuildArtifacts[].path`, `meta.filesByExtension` keys (extensions only — but the per-file file lists they reference must be POSIX).
- **MCP tool responses.** Every `files[]` entry on `scan_project` / `scan_file` / `checklist` / `coverage` / `bootstrap` / `propose_config` / `suggest_*`, every `path` field on per-finding `Violation` / `AgentFinding` records, every `nextStepStructured.params.cwd` / `params.additionalPaths[]` / `params.restrictToPaths[]`, every `sourceContext.file`.
- **Baseline JSON.** `ra11y.baseline.json` keys and `path` fields. The file is committed to user repos; native separators on Windows would re-thrash the file every macOS rebase.
- **Suppression pragmas.** Pragma resolution maps a `path` field on a finding against the file the pragma was found in — both sides are paths, both must be POSIX, or the comparison silently misses.
- **Formatter output.** Terminal, JSON, SARIF, JUnit, HTML, Markdown, plain — every path string in a formatter's render output. The CLI writes formatter output to stdout for downstream tools (CI, agents, IDE plugins) to consume; mixed separators per host are the same external-shape regression.
- **Manual-review checklists.** `checklist.items[].candidates[].file`, `coverage.manualWithCandidates[].candidates[].file` — same surface as MCP responses, same invariant.
- **Per-violation telemetry.** `Violation.path`, `Violation.sourceContext.file`, `AgentFinding.path`, `AgentFinding.fix.targetPath` — every path-shaped field on the type definitions in `src/types/violation.ts`.

If you're adding a field whose type is "a path" and its value reaches any of the above, normalize at the assembly site.

## The pattern

The helper takes native input and normalizes once at return:

```ts
import { posixJoin, posixResolve, posixRelative, posixDirname } from "../utils/path.ts";

// Before — leaks native separators on Windows:
const file = join(scanRoot, relativePath);

// After — POSIX on every host:
const file = posixJoin(scanRoot, relativePath);
```

The four POSIX helpers (`posixJoin`, `posixResolve`, `posixRelative`, `posixDirname`) are drop-in replacements for `node:path`'s `join` / `resolve` / `relative` / `dirname`. They keep the underlying `node:path` semantics (same root resolution, same `..` collapse, same drive-letter handling on Windows) and apply the POSIX normalization at return so the consumer never sees a backslash.

The bare `toPosix(p)` helper is for paths that already exist (read from a file, returned by an external API, joined through native `node:path` deeper in the call stack); it's idempotent so wrapping a POSIX-already path is a no-op.

## Internal escape hatch

Some `node:path` usages are provably internal — the result never crosses an externally visible surface. The directory walker in `src/input/discover.ts` joins `readdirSync` results with `join` to produce native paths it then feeds to `statSync`; until those paths reach the discoverFiles return statement, native is the right shape (Node `fs` accepts both, but the syscall layer is OS-native). Same applies to the `node:path` calls inside the parser dispatchers in `src/input/parsers/**` — the joined paths are consumed locally, never returned.

For these provably-internal call sites, the file declares an opt-out at the top:

```ts
// path-normalization-allow: internal walker — joined paths feed
// statSync only and are POSIX-normalized at the discoverFiles return.
```

The opt-out comment must (a) name the reason in one phrase and (b) hold across the whole file. If a single function in the file leaks a native path to an external surface, the file isn't a valid opt-out — split the internal-only joins into a sibling helper that owns the comment, or normalize at the leaking return.

## Enforcement

`scripts/check-paths.ts` runs in `verify` (between `network-isolation` and `builtins-scope`). It greps every `src/**/*.ts` file for `node:path` `join` / `resolve` / `relative` / `dirname` calls, flags them on files in externally-shipping directories (`src/output/**`, `src/mcp/**`, `src/reports/**`, `src/api/**`, `src/engine/baseline.ts`, `src/engine/scanner.ts`), and exits non-zero on violations. Files with a top-of-file `// path-normalization-allow:` comment are skipped.

For tests, the script catches `expect(...).toBe(join(...))` shapes within ~10 lines of each other — these are the canonical "build expected path with native `path.join`, compare against POSIX scanner output" regressions that surfaced 38 windows-shard failures before the source-side normalization landed (commits `8891f3de`, `4395f1cf`). The fix at the test side is `posixJoin` from `tests/helpers/path.ts`.

The script's allowlist is a migration map: each entry names a file whose existing `node:path` usage hasn't been migrated yet, tagged with the area it covers. The allowlist shrinks as the migration agent walks each entry; when the allowlist is empty, the invariant is fully ratcheted in.

If you're adding new code to a boundary call site and the check flags you, the fix is to import the POSIX helper. If the check flags an existing usage that's provably internal, document it with a `// path-normalization-allow:` opt-out and explain why the joined path never reaches a consumer.
