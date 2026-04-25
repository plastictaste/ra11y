/**
 * Rule: semantics/form-landmark-name-missing
 * Satisfies: wcag22:1.3.1, wcag22:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *       https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are
 * > available in text.
 *
 * > For all user interface components … name and role can be
 * > programmatically determined …
 *
 * Per the ARIA-in-HTML mapping (`html-aria` § 3 `<form>`), a `<form>`
 * is exposed as the `form` landmark role ONLY when it has an
 * accessible name. Without one, browsers strip the implicit landmark
 * role and the element is announced as a generic group — it does not
 * appear in the screen-reader landmark list, and a user cursoring
 * landmarks (NVDA `D`, JAWS `R`, VoiceOver `VO+U`) cannot reach it
 * directly.
 *
 * The author who wrote a `<form>` clearly meant to author a form
 * region. The missing accessible name silently downgrades that intent
 * into an unrecognized chunk of the page.
 *
 * Detection gate (single-form scope only):
 *
 * - Fire only when the file contains exactly one `<form>`. The
 *   multi-form case (`<form>` count >= 2) is owned by
 *   `semantics/duplicate-landmark-unlabeled`, which has its own
 *   message specifically about disambiguation among siblings. We cede
 *   that case to avoid double-firing on the same elements.
 *
 * Acceptable accessible-name sources (presence only):
 *
 * - `aria-label` with any non-whitespace value
 * - `aria-labelledby` referencing at least one id token (dangling-id
 *   validation is `aria/labelledby-target-exists`'s job; this rule
 *   only checks whether the author pointed somewhere)
 * - `title` with any non-whitespace value (the html-aria mapping
 *   accepts `title` as a name source for `<form>`, even though it's
 *   not preferred — surface only when ALL three are missing, so a
 *   `title`-only form is still valid)
 *
 * Fragment files (Jekyll `_includes/`, Astro slots, Handlebars
 * partials) are NOT skipped: the predicate is purely attribute-level
 * (this `<form>` either has a name source or it doesn't), not a
 * composition guess. Whether the partial composes into a full page or
 * a modal, an unlabeled `<form>` will not surface as a landmark in
 * either context. The agent reading the candidate has full file
 * context to dismiss if the form is incidental — the deterministic
 * source-level disable pragma (`<!-- ra11y-disable wcag22:4.1.2 -->`)
 * is the durable mechanism, per the AI-first consumer doctrine.
 */

import { defineRule } from "../../api/plugin.ts";
import { findHtmlElementsByTag, getHtmlAttribute } from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";
import type { FileContext } from "../../types/rule.ts";

export const rule = defineRule({
  id: "semantics/form-landmark-name-missing",
  satisfies: ["wcag22:1.3.1", "wcag22:4.1.2"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      "A standalone <form> needs an accessible name (aria-label, aria-labelledby, or title) so it surfaces as the ARIA form landmark. Without one, the browser strips the landmark role and the form does not appear in the screen-reader landmark list. The multi-form case is handled by semantics/duplicate-landmark-unlabeled.",
    rationale:
      'ARIA exposes <form> as the \'form\' landmark only when the element has an accessible name. An unlabeled <form> is announced as a generic group and is invisible to landmark navigation (NVDA D, JAWS R, VoiceOver VO+U) — a blind user cursoring landmarks skips over the form entirely. The fix is mechanical: add aria-label="<purpose>" (e.g. "Search", "Subscribe", "Contact us") describing what the form does. The rule fires only when the file contains exactly one <form>; multi-form documents are covered by semantics/duplicate-landmark-unlabeled, which adds disambiguation framing to its message.',
    goodExample:
      '<form aria-label="Search"><input type="search" name="q"><button>Go</button></form>',
    badExample: '<form action="/search"><input type="search" name="q"><button>Go</button></form>',
    normativeQuote:
      "For all user interface components, the name and role can be programmatically determined.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/TR/html-aria/#el-form",
      "https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/examples/form.html",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;
    checkSingleForm(ctx, doc);
  },
});

/**
 * Fire only when the file has exactly one `<form>`. Multi-form files
 * are owned by `semantics/duplicate-landmark-unlabeled`, which fires
 * per unlabeled instance with sibling-disambiguation framing — we
 * deliberately cede the count >= 2 branch to avoid double-emission on
 * the same `<form>` element. Zero-form files emit nothing.
 */
function checkSingleForm(ctx: FileContext, doc: HtmlDocument): void {
  const forms = findHtmlElementsByTag(doc, "form");
  if (forms.length !== 1) return;
  const form = forms[0];
  if (!form) return;
  if (hasAccessibleName(form)) return;

  ctx.emit({
    severity: "warning",
    location: {
      filePath: "",
      line: form.loc.start.line,
      column: form.loc.start.column,
    },
    message:
      "<form> has no accessible name (aria-label / aria-labelledby / title); ARIA strips the implicit form landmark role, so the form does not appear in the screen-reader landmark list.",
    suggestion: buildSuggestion(form),
  });
}

/**
 * Presence-only accessible-name signal for `<form>`. Mirrors
 * `semantics/duplicate-landmark-unlabeled` and `semantics/section-
 * accessible-name-missing` — we intentionally do NOT resolve
 * `aria-labelledby` targets (a dangling labelledby is `aria/
 * labelledby-target-exists`'s problem).
 *
 * Unlike the duplicate / section rules, `title` IS accepted here:
 * the html-aria mapping for `<form>` lists `title` as a name source
 * (less preferred than aria-label, but recognized), so a `title`-only
 * form should not fire. The duplicate-landmark rule rejects `title`
 * because the duplication-disambiguation use-case calls for a
 * stronger label; this single-form rule is asking only "does the form
 * have any name at all," which `title` satisfies.
 */
function hasAccessibleName(form: HtmlElement): boolean {
  const label = getHtmlAttribute(form, "aria-label");
  if (label !== null && label.trim().length > 0) return true;
  const labelledby = getHtmlAttribute(form, "aria-labelledby");
  if (labelledby !== null && labelledby.trim().length > 0) return true;
  const title = getHtmlAttribute(form, "title");
  if (title !== null && title.trim().length > 0) return true;
  return false;
}

/**
 * Inline an action="…", id="…", or class="…" descriptor when present
 * so the agent can disambiguate which form is unlabeled if other
 * forms are added later. action= is the most informative for `<form>`
 * (it usually names the endpoint purpose); id and class fall back when
 * action is absent.
 */
function describeIdentity(form: HtmlElement): string {
  const action = getHtmlAttribute(form, "action");
  if (action !== null && action.length > 0) return ` with action="${action}"`;
  const id = getHtmlAttribute(form, "id");
  if (id !== null && id.length > 0) return ` with id="${id}"`;
  const cls = getHtmlAttribute(form, "class");
  if (cls !== null && cls.length > 0) return ` with class="${cls}"`;
  return "";
}

function buildSuggestion(form: HtmlElement): string {
  const idHint = describeIdentity(form);
  return `This <form>${idHint} has no aria-label, aria-labelledby, or title. Pick one of: (a) add aria-label="<purpose>" naming the form's job (e.g. "Search", "Subscribe", "Contact us", "Sign in"); (b) add aria-labelledby="<id-of-existing-heading>" pointing at a heading already on the page (e.g. an <h2>Sign in</h2> sitting above the form); (c) add a visible <legend> inside a <fieldset> or a leading <h2>, then reference it via aria-labelledby. Without a name the <form> is not exposed as a landmark — screen-reader users cannot jump to it via the landmark list.`;
}
