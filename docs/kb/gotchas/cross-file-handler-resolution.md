---
title: "Cross-file handler resolution"
topic: gotcha
audience: rule authors, MCP integrators
---

# Cross-file handler resolution is an explicit non-goal

ra11y does not resolve click handlers, change handlers, or any other event binding across file boundaries. When a vanilla-JS tree wires `<div class="btn">` with `document.querySelector('.btn').addEventListener('click', …)` from a separate `.js` module — or when a JSX element references a handler imported from a sibling file — the rule that fires (`keyboard/handler-missing`, `aria/role-from-class-only`, etc.) sees only the local AST and flags the element as if no handler exists.

This is by design, not a missing feature.

## Why we don't resolve

The doctrine "[don't duplicate capability the agent already has](../architecture/ai-first-consumer.md)" applies at full strength here. The consuming agent (an LLM with Read + Grep) opens the sibling file in one tool call and verifies the handler shape; the result is exact, accounts for shadowed bindings / dynamic dispatch / event delegation, and costs less than the in-tool resolver would. An in-tool cross-file resolver, by contrast, would:

- Walk the import graph (or worse, regex for identifier matches across the tree).
- Mis-resolve shadowed identifiers and computed selectors (`addEventListener('click', handlers[key])`).
- Miss handlers attached via event delegation on an ancestor.
- Add complexity to the engine that has no compensating signal value.

The ecosystem's reigning a11y linter [`eslint-plugin-jsx-a11y`](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y) takes the same position — its `click-events-have-key-events` rule is explicitly scoped to JSX-local static evaluation, and the project README says the linter "does a static evaluation of the JSX" and "is meant to be used in combination with other tools."

## What we do instead

- **Surface the limitation structurally.** When a finder needs cross-file evidence to resolve confidently, it adds an entry to the response-level `limitations[]` field with the machine-readable code `external_handler_resolution_unavailable`. Agents reading the response can budget against the limitation rather than treat the scan as authoritative.
- **Enrich the candidate's `reason` text.** Rules that fire on elements where the absent-handler signal could be answered by an external script include a reason-text pointer ("no inline handler found; if this element is wired from an external script, verify in the file that imports/dispatches the binding"). The agent reads the pointer in-line.

## What rule authors should not do

- Do not add a "follow the import" pass to your rule. Rules are pure functions over the local AST.
- Do not encode "looks like the handler is in another file" as a confidence-downgrade — the doctrine is to surface, not to suppress.
- Do not gate emission on cross-file evidence at all. If the local AST is enough to fire confidently, fire; if it isn't, the rule probably belongs in `src/review/finders/` (manual-review candidate) rather than `src/rules/`.
