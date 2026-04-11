# `.claude/notes/`

Session-durable learnings. Not a memory system — a place to capture things an agent discovered the hard way so the next agent doesn't repeat the work. Keep each file focused on a single topic.

## What belongs here

- Non-obvious behaviors of the toolchain (Biome, Bun, TypeScript compiler API)
- WCAG interpretation edge cases that surfaced during rule implementation
- Fixes for recurring CI failures
- Performance surprises (what was slow, why, how it was mitigated)
- Decisions that didn't rise to ADR-level but are worth remembering

## What does not belong here

- Things already captured in CLAUDE.md
- Things that belong in `docs/kb/` (those are the long-term retrieval surface)
- Personal notes about individual contributors

## Format

One file per topic, `kebab-case.md`. Optional frontmatter:

```markdown
---
topic: biome-quirks
updated: 2026-04-11
---

# Biome quirks

## The thing that bit us

<what happened>

## Why

<root cause>

## Mitigation

<what we did about it>

## See also

- `docs/kb/gotchas/biome-quirks.md` (reader-facing version)
```

When a note graduates into general knowledge, move it to `docs/kb/gotchas/` and leave a pointer behind.
