# Example: custom ra11y rule plugin

This directory shows the smallest possible ra11y rule plugin. One rule (`example/no-title-only-label`), one smoke test that exercises the rule end-to-end through the Registry seam, and this README.

## What the rule checks

The [`title` attribute](https://www.tpgi.com/using-the-html-title-attribute-updated/) is unreliable as an accessible-name source:

- Mobile browsers don't show tooltips at all.
- Keyboard-only users can't trigger the tooltip.
- Screen-reader support is inconsistent.
- Sighted users only see it after a mouse hover delay.

So `<button title="Close"></button>` is technically "named" from a WCAG 4.1.2 perspective, but practically useless. The rule flags the pattern when `title` is the *only* accessible-name source — `<button aria-label="Close" title="…">×</button>` is fine, so is `<button title="…">Close</button>`.

## File layout

```
plugin-rule/
├── package.json         # name, peerDependency on @ra11y/core
├── rule.ts              # defineRule call + afterFile handler
├── test.ts              # shape smoke + end-to-end registry-seam smoke
└── README.md            # this file
```

## Wiring the plugin into a scan

The plugin API helpers (`defineRule`, `defineStandard`, `defineCandidateFinder`) are identity functions at the type level — they're the stable public surface per [ADR 0019](../../docs/adr/0019-v1-api-stability.md). The *internal* wiring that makes a user rule visible to every scan, `list_rules`, `checklist`, etc. lives behind `createRegistry({ rules, standards, finders })` ([ADR 0022](../../docs/adr/0022-registry-aggregate.md)):

```ts
import { defineRule } from "@ra11y/core/plugin";
import { createRegistry } from "@ra11y/core/engine/registry"; // internal seam
import { McpSession } from "@ra11y/core/mcp/session";         // internal seam
import myRule from "./rule.ts";

const registry = createRegistry({ rules: [myRule] });
const session = new McpSession(registry);
// Every MCP tool handler that reads `session.registry` now sees myRule.
```

Or at the CLI bootstrap:

```ts
import { runCli } from "@ra11y/core/cli/run";
import { createRegistry } from "@ra11y/core/engine/registry";
import myRule from "./rule.ts";

await runCli(process.argv.slice(2), createRegistry({ rules: [myRule] }));
```

The `createRegistry`/`McpSession`/`runCli` surfaces are internal (`src/engine/registry/`, `src/mcp/`, `src/cli/`) until a public `ra11y.config.ts` `plugins` loader lands — the seam is here so that future loader has a single constructor param to thread through.

`test.ts` in this directory shows the full pattern: compose the registry, build the session, invoke the `scan` MCP tool handler against a tiny bad fixture, and confirm the plugin's violations appear in `files[].findings`.

## Running the smoke test

```sh
bun examples/plugin-rule/test.ts
```

You should see:

```
✓ example rule plugin loaded with expected shape
✓ example rule fired via Registry seam (1 violation)
```

## Authoring tips

- **Header citation.** The `satisfies` field lists every criterion the rule checks. Add `wcag22:X.Y.Z` and any cross-standard equivalents so the registry fans out coverage when `section508` or `en301549` is enabled.
- **Fix class.** Stamp `fixClass: "mechanical" | "guidance" | "runtime-only" | "verify-in-source"` so findings route into the right downstream lane (see [ADR 0007](../../docs/adr/0007-violation-fix-class-metadata.md)).
- **Context-aware suggestions.** Inspect surrounding AST nodes when building the suggestion text. "Use `aria-label`" is generic; "`<button>×</button>` with `title` is a close button — use `aria-label=\"Close\"`" is specific.
- **AST helpers over hand-walking.** Import from `src/engine/ast-helpers.ts` rather than descending into AST internals.
- **Plugin ID convention.** Namespace your rule IDs (`<scope>/<rule>`) so they never collide with built-ins. `RulesRegistry.register` throws on duplicate IDs — the correct failure mode.
- **Three positive, three negative, one edge.** Every rule ships with ≥3 positive test cases, ≥3 negative, ≥1 boundary. See `tests/unit/rules/media/alt-text-missing.test.ts` for the canonical shape.

## Related

- [`docs/adr/0019-v1-api-stability.md`](../../docs/adr/0019-v1-api-stability.md) — the frozen public plugin surface
- [`docs/adr/0022-registry-aggregate.md`](../../docs/adr/0022-registry-aggregate.md) — the Registry seam this rule rides through
- [`docs/plugins/authoring-a-rule.md`](../../docs/plugins/authoring-a-rule.md) — the longer-form rule authoring guide
- [`src/rules/document/meta-refresh.ts`](../../src/rules/document/meta-refresh.ts) — a full-featured rule template
