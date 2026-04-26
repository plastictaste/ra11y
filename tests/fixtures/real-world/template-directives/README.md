# template-directives

**Guards:** commit `a554d27` (feat(mcp): actionable hints and explicit template-directive handling).

## What this fixture guards

When the HTML parser encounters control-block tokens (`{% extends %}`, `{% block %}`, `{% if %}`, `{% for %}`) or bare double-brace interpolation (`{{ value }}`), it treats them as literal text — it does not render or execute the tokens. The scanner's static analysis therefore runs against the template source, not any rendered output.

The handling note surfaces this behavior explicitly via `meta.analysisCoverage.templateDirectiveHandling` alongside the `templateInterpolationFound` token list. Agents use the prose to calibrate scan confidence: if it ever silently disappears or changes wording to imply rendered analysis, the fixture fails.

## What this fixture guards

The `meta.analysisCoverage.templateDirectiveHandling` field so agents
know a template-rendered file was parsed as literal source (not the
rendered DOM). If the field ever silently disappears or changes
wording to imply rendered analysis, the fixture fails.

## Source files

- `base.jinja.html` — control-block tokens (`{% extends %}`, `{% block %}`, `{% if %}`, `{% for %}`) plus bare `{{ }}` interpolation. Surfaces `{%x%}` and `{{x}}` tokens.
- `partial.html` — bare `{{ }}` interpolation only, no control blocks. Surfaces the `{{x}}` token alone.

## Sanitization

Generic placeholder content throughout. No brand names, product copy, or real usernames.
