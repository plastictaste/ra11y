# Changelog

All notable changes to ra11y are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — see `CLAUDE.md` section 14 for the ra11y-specific semver policy.

## [Unreleased]

### Added

- Phase 0 autonomous Claude Code infrastructure (`.claude/` hooks, agents, skills, backlog, notes)
- Root-level config: `package.json`, `tsconfig.json`, `biome.json`, `.editorconfig`, `.gitignore`, `LICENSE`
- `CLAUDE.md` spec (three-layer architecture, invariants, verification, rule/standard workflow)
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `ACCESSIBILITY.md`, `CODE_OF_CONDUCT.md`
- Full directory skeleton for `src/`, `tests/`, `docs/`, `examples/`, `scripts/`

### Target for v0.1.0

- Four built-in standards: WCAG 2.2, WCAG 2.1, Section 508 (2017), EN 301 549 v3.2.1
- ~30 automated rules covering every "auto" and "partial" criterion under WCAG 2.1 A+AA and WCAG 2.2 A+AA additions
- Six output formatters: terminal, json, sarif, junit, html, markdown
- CLI with full flag surface including `--standard`, `--level`, `--changed`, `--coverage`, `--vpat`, `--certification`, `--checklist`, `--fix`, `--baseline`
- In-house parsers for TSX/JSX, HTML, CSS, and Tailwind class extraction
- Plugin API: `defineRule`, `defineStandard`, `defineFormatter`, `defineConfig`
- VPAT mapping and certification readiness scorecard
- Manual review checklist generator for non-automatable criteria
- Inline disable comments (`// ra11y-disable-next-line <rule>`)
- Baseline mode for adopting on existing codebases
- Monorepo / workspace support via `projects: []` in config
