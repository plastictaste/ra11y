# Install ra11y as a skill

This skill is portable. Copy the `ra11y` skill folder into the host-specific skill directory or upload the folder in products that support skill uploads.

Use one of these source paths:

- Inside the ra11y repository: `skills/ra11y`
- From an installed npm package: `node_modules/@ra11y/core/skills/ra11y`

The skill is most useful with the ra11y MCP server connected. Without MCP, you can still run the CLI for one-off scans, but you lose the structured tool flow (`suggest_fix`, `checklist`, `verdict_candidate`, MCP prompts, and related artifacts).

## MCP prerequisite

Use the explicit `npx` form below:

```sh
npx -y --package=@ra11y/core ra11y --mcp
```

Do not use `npx @ra11y/core --mcp`. The package name (`@ra11y/core`) and bin name (`ra11y`) differ, and the shorter form is documented in this repo as intermittently failing.

## Claude Code

Install the skill:

```sh
RA11Y_SKILL_SRC="node_modules/@ra11y/core/skills/ra11y"   # or skills/ra11y inside this repo
mkdir -p .claude/skills
cp -R "$RA11Y_SKILL_SRC" .claude/skills/ra11y
```

Or install it for every project:

```sh
RA11Y_SKILL_SRC="node_modules/@ra11y/core/skills/ra11y"   # or skills/ra11y inside this repo
mkdir -p ~/.claude/skills
cp -R "$RA11Y_SKILL_SRC" ~/.claude/skills/ra11y
```

Connect the MCP server at project scope:

```sh
claude mcp add --scope project --transport stdio ra11y -- \
  npx -y --package=@ra11y/core ra11y --mcp
```

Project-scoped JSON config also works:

```json
{
  "mcpServers": {
    "ra11y": {
      "command": "npx",
      "args": ["-y", "--package=@ra11y/core", "ra11y", "--mcp"],
      "type": "stdio"
    }
  }
}
```

Verify:

1. Run `/mcp` and confirm the `ra11y` server is connected.
2. Ask Claude to list the available `ra11y` tools.
3. If MCP prompts are enabled, you can invoke `/mcp__ra11y__ra11y/triage`, `/mcp__ra11y__ra11y/fix`, `/mcp__ra11y__ra11y/audit`, and `/mcp__ra11y__ra11y/vpat-narrative`.

## Codex

Install the skill into the directory Codex actually scans:

```sh
RA11Y_SKILL_SRC="node_modules/@ra11y/core/skills/ra11y"   # or skills/ra11y inside this repo
CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$CODEX_SKILLS_DIR"
cp -R "$RA11Y_SKILL_SRC" "$CODEX_SKILLS_DIR/ra11y"
```

Codex does not use `.agents/skills` or `~/.agents/skills` for skill discovery.

Connect the MCP server:

```sh
codex mcp add ra11y -- npx -y --package=@ra11y/core ra11y --mcp
```

Equivalent `~/.codex/config.toml` entry:

```toml
[mcp_servers.ra11y]
command = "npx"
args = ["-y", "--package=@ra11y/core", "ra11y", "--mcp"]
```

Verify:

1. Run `/mcp` in the Codex TUI and confirm the `ra11y` server is active.
2. Ask Codex to list the available `ra11y` tools.
3. Invoke the skill explicitly with `$ra11y` or let Codex load it implicitly from its description.

## CLI fallback

When MCP is unavailable, use the CLI only for simpler scans:

```sh
npx -y --package=@ra11y/core ra11y . --format json
```

Common variants:

```sh
npx -y --package=@ra11y/core ra11y --changed
npx -y --package=@ra11y/core ra11y . --checklist
npx -y --package=@ra11y/core ra11y . --coverage
```

Treat this as reduced capability mode. The CLI is useful for scanning, but the richer agent workflow lives in MCP.
