---
title: "Set up the ra11y MCP server"
audience: users (teams using ra11y via an agent host)
---

# Set up the ra11y MCP server

ra11y ships a Model Context Protocol server out of the box. Any MCP host — Claude Code, Cursor, Zed, Continue — can connect to it over stdio and get 34 accessibility-specific tools in the agent's toolbox.

This page is the 60-second setup. For the tool reference, see [`tool-reference.md`](./tool-reference.md). For architecture, see [`docs/kb/architecture/mcp-server.md`](../kb/architecture/mcp-server.md).

## Claude Code

Add ra11y to your project's `.mcp.json` at the repo root:

```jsonc
{
  "mcpServers": {
    "ra11y": {
      "command": "npx",
      "args": ["-y", "--package=@ra11y/core", "ra11y", "--mcp"]
    }
  }
}
```

The explicit `--package=@ra11y/core ra11y` form is required because the package name (`@ra11y/core`) does not match the bin name (`ra11y`).

Or if you've installed ra11y globally / at the workspace level:

```jsonc
{
  "mcpServers": {
    "ra11y": {
      "command": "ra11y",
      "args": ["--mcp"]
    }
  }
}
```

Restart Claude Code. The ra11y tools appear in the agent's tool list.

## Cursor

Cursor uses the same `.mcp.json` format. Drop it at the workspace root or configure through Cursor's settings UI. Full instructions: https://docs.cursor.com/context/model-context-protocol.

## Zed

Zed reads MCP servers from `settings.json`:

```jsonc
{
  "context_servers": {
    "ra11y": {
      "command": {
        "path": "npx",
        "args": ["-y", "--package=@ra11y/core", "ra11y", "--mcp"]
      }
    }
  }
}
```

## Verifying the connection

From any connected host, ask the agent to:

> List the ra11y tools available to you.

You should see 34 tools: `scan`, `scan_project`, `scan_file`, `scan_diff`, `scan_process`, `detect_native_wrappers`, `wrapper_introspect`, `explain_rule`, `explain_standard`, `suggest_fix`, `apply_fix`, `get_finding`, `findings_by_rule`, `coverage`, `checklist`, `conformance_statement`, `review_candidates`, `verdict_candidate`, `draft_vpat_narrative`, `audit`, `audit_rule_coverage`, `baseline`, `bootstrap`, `list_rules`, `list_finders`, `list_suppressions`, `suppress`, `attest`, `list_attestations`, `vpat`, `propose_config`, `propose_baseline`, `sessionConfigure`, `session_inspect`.

If the list is missing, check your host's MCP logs. The ra11y server exits cleanly with a diagnostic on stderr if invoked incorrectly.

## Typical first session

1. Ask the agent: "Run `scan_project` on this repo with `minSeverity: 'info'`."
2. The agent returns findings. Triage the `info` findings by source reading — that's where the agent adds value static analysis can't.
3. Ask: "Run `detect_native_wrappers` so I can populate `nativeWrappers` in my ra11y.config.ts." This quiets false positives from design-system PascalCase wrappers.
4. Ask: "Run `coverage` to see what WCAG criteria still need manual review."
5. Iterate with `scan_file` on the files you've edited.

## Configuration

Session-level config lives inside each MCP connection — use the `sessionConfigure` tool:

> Call `sessionConfigure` with `{ standard: "wcag22", level: "AA", nativeWrappers: ["Button", "Link"] }`.

Project-level config lives in `ra11y.config.ts` at the repo root. The server reads it fresh on every tool call, so edits take effect without reconnecting. Generate a starter with `ra11y --init`.

## See also

- [`tool-reference.md`](./tool-reference.md) — every tool, its inputs, its outputs.
- [`docs/kb/architecture/mcp-server.md`](../kb/architecture/mcp-server.md) — how the server is built internally.
- [`docs/kb/patterns/using-mcp-from-agents.md`](../kb/patterns/using-mcp-from-agents.md) — recommended workflows for agents.
