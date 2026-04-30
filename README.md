# ra11y

> **AI-first multi-standard accessibility scanner.** MCP-server-first design. Zero runtime dependencies. WCAG 2.2/2.1, Section 508, EN 301 549 out of the box.

[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](./tsconfig.json)

**`ra11y`** (pronounced "rally") is built primarily for an AI coding agent calling its tools — not a human staring at a dashboard. Every response shape, noise-vs-signal decision, and per-finding hint is designed for one-shot agent triage: a scan returns ranked findings with WCAG citations, ready-to-paste suppression comments, primary fix paths, and a `nextStep` pointer so the loop closes in one round-trip.

That doesn't make it agent-only. ra11y ships a CLI with terminal output, multiple report formats, and precommit integration. It covers JSX/TSX, HTML, CSS, and SCSS across WCAG 2.2, WCAG 2.1, Section 508, and EN 301 549 — and a plugin API for adding more.

## Status

**Public beta — `1.0.0-beta.1`, not yet on npm.**

The rule engine, plugin API, multi-standard registry, output formatters, reports (coverage, checklist, VPAT, certification), and MCP server are all in tree and exercised by the test suite. The MCP response shapes are under active hardening against multi-corpus field tests; expect breaking changes to MCP tool response field shapes before `1.0.0`. CLI and rule logic are stable.

Known gaps the maintainers are tracking — none are silent failures, but worth knowing if you're integrating today:

- **`checklist` / `coverage` lack the minimum-honest-envelope fallback that `scan_project` has.** On large or bulk-vendor corpora these two surfaces can exceed the MCP host token cap and surface only a transport error. Workaround: scope down with `paths`, `restrictToPaths`, or call `scan_project` first to triage.
- **`bootstrap` tool's `suggestedConfig.exclude` is over-eager on bulk-template catalogs.** Don't paste the suggested config blindly on corpora ≥1000 files; review the generated `exclude` list first. Fix in flight.
- **`scan_file` `reviewCandidates[].priority` / `.confidence` ship as `null`** while the same candidates on `checklist.items[].candidates[]` populate both. Use `checklist` for the ranked view.

The full backlog of in-flight shape-honesty work lives at [`.claude/backlog.md`](./.claude/backlog.md).

## Design priorities

- **AI-first MCP server.** An agent-native tool surface — scan, checklist, suggest-fix, detect-native-wrappers — with responses shaped for one-shot triage (ranked fix paths, per-finding suppression pragmas, `nextStep` hints, scan-confidence telemetry, structured warnings the agent can act on). The full inventory ships via `tools/list`; current source-of-truth is [`src/mcp/`](./src/mcp/).
- **Zero runtime dependencies.** `dependencies: {}` is empty and enforced in CI via `scripts/check-zero-deps.ts`. Everything in-house — JSX/TSX parsing via the optional TypeScript peer dep, the rest is hand-rolled.
- **Multi-standard by architecture.** Standards → Criteria → Rules. One rule satisfies WCAG 2.2, WCAG 2.1, Section 508, and EN 301 549 simultaneously via cross-standard `equivalentTo` mappings. Adding a new standard never touches rule code.
- **Surface, don't suppress.** Doctrine documented at [`docs/kb/architecture/ai-first-consumer.md`](./docs/kb/architecture/ai-first-consumer.md). False positives are cheap for an agent to dismiss in one read; silent under-emission isn't reversible. The default everywhere is to surface honestly with enough context for the agent to triage, then let the agent suppress at the source via deterministic pragmas.
- **Network isolation.** `src/` never imports `fetch` / `node:http` / `node:net` / `node:dns`. Enforced by `scripts/check-network-isolation.ts`. A compliance tool scanning proprietary source has to be offline by construction.
- **Precommit-speed.** Sub-second on typical commits. Performance budget in [`scripts/bench.ts`](./scripts/bench.ts), enforced in CI; budgets and history at [`docs/performance.md`](./docs/performance.md).

## How it works

ra11y separates *what to check* (rules) from *why it matters* (criteria) from *which framework cares* (standards):

```
Standards (WCAG 2.2, 2.1, Section 508, EN 301 549)
  └─ declares
     Criteria (e.g. wcag22:1.4.3, section508:1194.22.c)
       └─ satisfied by
          Rules (e.g. contrast/minimum, alt-text/missing)
```

A scan with `--standard section508` activates the same `contrast/minimum` rule and cites the Section 508 criterion ID in output — no rule changes needed. Adding a new standard is one file with criterion records + `equivalentTo` pointers into the existing standards.

Architecture deep-dive: [`docs/architecture.md`](./docs/architecture.md). Rule authoring: [`docs/kb/patterns/writing-a-rule.md`](./docs/kb/patterns/writing-a-rule.md). Three-layer model: [`docs/kb/architecture/three-layer-model.md`](./docs/kb/architecture/three-layer-model.md).

## Install (from source)

Until the npm package publishes, install from the cloned repo:

```sh
git clone https://github.com/<owner>/ra11y.git
cd ra11y
bun install
bun run build
```

Then either invoke the CLI directly:

```sh
bun run src/cli.ts src/
```

…or wire the MCP server into your agent (see below). Once `@ra11y/core` is on npm, `npx @ra11y/core` will work the same way.

## CLI

```sh
ra11y src/                          # Scan a directory
ra11y --changed                     # Scan only git-staged files (precommit)
ra11y --since main                  # Scan files changed since a git ref
ra11y --standard wcag22,section508  # Run multiple standards at once
ra11y --level AA                    # Enforce conformance level
ra11y --format sarif                # GitHub code scanning output
ra11y --format json                 # Structured JSON for pipelines
ra11y --baseline=create             # Freeze existing violations
ra11y --baseline=check              # Only new violations fail the scan
ra11y --coverage                    # Per-standard coverage summary
ra11y --vpat                        # Generate VPAT-ready report
ra11y --certification               # Generate readiness scorecard
ra11y --checklist                   # Manual review checklist
ra11y --explain contrast/minimum    # Rule detail, spec quote, examples
ra11y --list-rules                  # All built-in rules
ra11y --list-standards              # All built-in standards
```

Full reference: [`docs/cli.md`](./docs/cli.md).

## MCP server (AI agent integration)

ra11y ships a built-in [MCP](https://modelcontextprotocol.io) server so AI coding agents (Claude Code, Cursor, Zed, Continue) can scan, explain, and fix accessibility issues interactively.

**Setup** — add this to your project's `.mcp.json` (once `@ra11y/core` is on npm; for now point at your local clone):

```jsonc
{
  "mcpServers": {
    "ra11y": {
      "command": "npx",
      "args": ["@ra11y/core", "--mcp"]
    }
  }
}
```

Or start the server directly from a clone: `bun run src/cli.ts --mcp`

**What the server exposes** — a couple dozen tools spanning scan (`scan_project`, `scan_file`, `scan_diff`, `scan`), triage (`checklist`, `coverage`, `review_candidates`, `suggest_fix`, `apply_fix`, `explain_rule`, `explain_standard`), onboarding (`bootstrap`, `detect_native_wrappers`, `propose_config`, `propose_baseline`), conformance (`vpat`, `attest`, `verdict_candidate`, `conformance_statement`, `draft_vpat_narrative`, `list_attestations`, `audit`), and lifecycle (`list_rules`, `list_suppressions`, `suppress`, `baseline`, `sessionConfigure`). Canonical inventory: call `tools/list` on the server, or read [`src/mcp/`](./src/mcp/).

**Typical agent workflow:**

```
scan_project  →  read findings + nextStep
       ↓
suggest_fix   →  apply deterministic edits
       ↓
scan_file     →  verify (cached AST, fast)
       ↓
checklist     →  manual-review candidates
       ↓
coverage      →  conformance scorecard
```

Full setup guide: [`docs/mcp/server-setup.md`](./docs/mcp/server-setup.md). Architecture: [`docs/kb/architecture/mcp-server.md`](./docs/kb/architecture/mcp-server.md).

**First-run flags** (for an agent meeting a new codebase):

```jsonc
// scan_project args
{
  "cwd": "/abs/path/to/project",
  "autoDetectWrappers": true,          // auto-register PascalCase-with-onClick
                                       // as nativeWrappers for this scan —
                                       // closes the "47 opaque components"
                                       // gap in one call.
  "additionalPaths": ["dist/assets"],  // bypass .gitignore + default build-dir
                                       // skips to scan post-compile output.
  "verboseMeta": true                  // expand analysisCoverage so agents can
                                       // audit which rules ran on which files.
}
```

## Configure

`ra11y.config.ts`:

```ts
import { defineConfig } from "@ra11y/core";

export default defineConfig({
  standards: ["wcag22", "section508"],
  level: "AA",
  exclude: ["node_modules", "dist", "**/*.test.tsx"],
  overrides: [
    {
      files: ["src/legacy/**/*.tsx"],
      rules: { "contrast/minimum": "warn" },
    },
  ],
});
```

Full reference: [`docs/configuration.md`](./docs/configuration.md).

## Precommit integration

Scan only files staged in git, fail the commit on any error:

```sh
ra11y --changed --fail-on error
```

With [lefthook](https://github.com/evilmartians/lefthook):

```yaml
# lefthook.yml
pre-commit:
  commands:
    ra11y:
      run: bunx ra11y --changed --fail-on error
```

Or use baseline mode to adopt on an existing codebase without fixing everything up front:

```sh
ra11y --baseline=create    # freeze existing violations
ra11y --baseline=check     # only new violations fail the scan
```

Examples for CI and precommit tools: [`examples/`](./examples).

## Plugin API

Standards and rules are both pluggable. Adding a new accessibility framework is one file:

```ts
import { defineStandard } from "@ra11y/core/plugin";

export default defineStandard({
  id: "coga",
  name: "Cognitive Accessibility Guidelines",
  version: "1.0",
  publisher: "W3C WAI",
  url: "https://www.w3.org/TR/coga-usable/",
  levels: ["base"],
  criteria: [
    /* … */
  ],
});
```

Rules declare coverage across every loaded standard:

```ts
import { defineRule } from "@ra11y/core/plugin";

export default defineRule({
  id: "custom/no-placeholder-as-label",
  satisfies: ["wcag22:3.3.2", "coga:clear-instructions"],
  severity: "error",
  // …
});
```

Authoring guides: [`docs/plugins/authoring-a-rule.md`](./docs/plugins/authoring-a-rule.md), [`docs/plugins/authoring-a-standard.md`](./docs/plugins/authoring-a-standard.md), [`docs/plugins/authoring-a-formatter.md`](./docs/plugins/authoring-a-formatter.md). End-to-end templates: [`examples/plugin-rule/`](./examples/plugin-rule/), [`examples/plugin-standard/`](./examples/plugin-standard/), [`examples/plugin-formatter/`](./examples/plugin-formatter/). Worked agent integrations: [`examples/ra11y-in-claude-code/`](./examples/ra11y-in-claude-code/), [`examples/ra11y-in-cursor/`](./examples/ra11y-in-cursor/).

## Feedback

Bug reports + reproductions welcome via GitHub issues. The maintainers aren't accepting external pull requests during the beta — the response-shape doctrine ([`docs/kb/architecture/ai-first-consumer.md`](./docs/kb/architecture/ai-first-consumer.md)) is still hardening and merging external work would slow that loop. Once `1.0.0` ships, contribution norms will land in `CONTRIBUTING.md`.

If you're using ra11y on a real codebase and the MCP responses surface something dishonest (counts that don't reconcile across surfaces, ambiguous-empty fields, oversize without an envelope, fix descriptions that contradict the rule's severity), open an issue with the response payload — those reports drive the doctrine work directly.

## License

Apache-2.0 © ra11y contributors
