# sensory-callout-prose

Guards `review/sensory-characteristics` (wcag22:1.3.3 / wcag21:1.3.3) callout-container reason-text enrichment added for the.3.3-LOCATIVE-CALLOUT-PROSE backlog item.

## Failure mode guarded

Component-library documentation pages routinely include `<div class="note">` / `<aside class="tip">` blocks describing UI elements to developers using sensory phrasing ("click the red button below", "icon on the right side"). The 1.3.3 finder fires on this prose — correct, because static analysis cannot distinguish developer-facing from user-facing copy. Without enrichment, an agent reading the candidate reason has no immediate signal that the prose is documentation prose rather than a live UI instruction, requiring a file read to dismiss.

## What the assertions lock in

1. **Surface, don't suppress** — `candidate-present` for both `wcag22:1.3.3` and `wcag21:1.3.3` ensures a regression that silently drops callout-wrapped candidates is caught.

2. **Callout enrichment** — `candidate-present { reasonIncludes: "callout block" }` and `reasonIncludes: "developer-facing documentation"` ensure the enrichment note is present in the reason string, making the agent's dismiss mechanical.

3. **Line-mapping honesty** — `candidate-at-line { line: 27 }` guards the `precisePositionForOffset` line-mapping fix through the ancestor-stack refactor: the fix from commit `81cc8ee2` (ssg-pagination-sensory-line-drift) must survive.

## Sanitization

Brand names, component names, and product copy replaced with generic equivalents. The structural pattern — callout `<div class="note">` wrapping a `<p>` with sensory phrasing — is preserved intact because that pattern is the reproduction.
