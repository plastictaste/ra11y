---
title: ra11y project layout
description: Directory tree for the ra11y repository, with one-line role descriptions for each top-level path under src/.
slug: architecture/project-layout
---

# ra11y project layout

```
ra11y/
├── .claude/                 # Autonomous infrastructure
│   ├── settings.json        # Hook wiring
│   ├── backlog.md           # Persistent to-do list — /continue reads this
│   ├── agents/              # Subagent definitions
│   ├── skills/              # Skills (folders with SKILL.md + supporting files)
│   ├── rules/               # Path-scoped rules loaded on demand
│   └── hooks/               # TypeScript hook scripts run by bun
├── src/
│   ├── index.ts             # Public programmatic API entry (re-exports from src/api/)
│   ├── cli.ts               # Binary entry (thin wrapper over src/cli/)
│   ├── types/               # Single source of truth for shared types
│   ├── engine/              # Scanner machinery (scanner, rule-runner, registries)
│   ├── standards/           # WCAG 2.2, 2.1, Section 508, EN 301 549
│   ├── rules/               # Rules organized by domain
│   ├── input/               # Parsers (tsx, html, css, tailwind) + file discovery
│   ├── output/              # Formatters (terminal, json, sarif, junit, html, markdown, agent) + theme
│   │   └── agent-response/  # Shared AI-first response builder — consumed by MCP + CLI --format agent
│   ├── reports/             # Structured reports (coverage, vpat, certification, checklist)
│   ├── mcp/                 # MCP server (JSON-RPC over stdio) + tool handlers
│   │   ├── prompts/         # Built-in prompt templates (audit, fix, triage)
│   │   └── resources/       # ra11y-kb:// resource index + readers
│   ├── review/              # Review candidate ranking
│   │   └── finders/         # Per-criterion manual-review candidate generators
│   ├── config/              # Config loading + validation (ra11y.config.ts, pragmas)
│   ├── api/                 # Public API (defineRule, defineStandard, defineConfig, defineFormatter)
│   ├── cli/                 # CLI internals
│   │   └── commands/        # Per-command handlers (scan, coverage, vpat, checklist, …)
│   └── utils/               # Zero-dep primitives (ansi, args, glob, contrast, string-width, logger)
├── tests/                   # Mirrors src/; plus integration, snapshot, cli, fuzz, golden, fixtures
├── docs/                    # User docs + architecture + ADRs + indexed KB (docs/kb/)
├── examples/                # Precommit, CI, plugin examples
└── scripts/                 # All .ts, run with bun (guards, generators, bench)
```
