# bootstrap-role-tab-wrapper

Guards the `semantics/nested-interactive` rule against firing on `<div role="tab">` wrappers that contain a native `<button>` but carry no click/key handler, no `tabindex`, and are not a native interactive tag.

## What this fixture guards

Commit guarded: the `isMateriallyInteractiveHtml` predicate in `src/rules/semantics/nested-interactive.ts` — specifically that an ARIA role alone does NOT qualify an outer element as "materially interactive" for the nested-control ancestry walk.

Failure mode: if `isMateriallyInteractiveHtml` regresses and starts treating `role="tab"` alone as sufficient evidence of an interactive outer element, all three `<div role="tab"><button>` pairs in `source/tab-wrapper.html` will produce `semantics/nested-interactive` violations (false positives). The `no-violation` assertion locks this in.

## Which assertion locks it in

`{ kind: "no-violation", ruleId: "semantics/nested-interactive" }` — any false positive on the role-only wrapper fails immediately with a message naming both the fixture and the offending predicate.

## Sanitization decisions

Bootstrap-specific `data-bs-toggle="tab"` attributes were removed from the `<button>` elements. Their presence triggered a separate `aria/expanded-on-disclosure` rule (disclosure-trigger shape detection), which obscured the regression target and introduced noise unrelated to the nested-interactive invariant. Structure, `role="tab"`, and the `<button>` nesting are preserved faithfully.

## Divergence from backlog description

The backlog item (Q3-RULE-NESTED-INTERACTIVE-ROLE-REGRESSION) described the bug as "still fires" at specific Bootstrap visual-test line numbers. Live probe against current `main` shows zero `semantics/nested-interactive` findings — the existing `isMateriallyInteractiveHtml` fix covers the `<button>`-inner case as well as the `<a href>` case captured by `bootstrap-nested-interactive-role-only`. This fixture is therefore a **forward regression guard** (green on current `main`) rather than a bug-capture (red). The backlog description was stale relative to the landed fix.
