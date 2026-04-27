import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/label-adjacent-unassociated.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/label-adjacent-unassociated", () => {
  describe("fires a violation when", () => {
    it("an HTML <label> with no for= sits immediately above an <input> with id", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>Length</label>
  <input id="length" type="number">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/label-adjacent-unassociated");
      expect(violations[0]?.suggestion).toMatch(/for="length"/);
      // The mechanical edit should carry the concrete oldText/newText pair.
      const edit = violations[0]?.fixPaths?.primary.edit;
      expect(edit?.oldText).toBe("<label>");
      expect(edit?.newText).toBe('<label for="length">');
    });

    it("fires on <textarea> with adjacent unassociated label", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>Message</label>
  <textarea id="msg"></textarea>
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/for="msg"/);
      expect(violations[0]?.fixPaths?.primary.edit?.newText).toBe('<label for="msg">');
    });

    it("fires on <select> with adjacent unassociated label", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>Country</label>
  <select id="country"><option>US</option></select>
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/for="country"/);
    });

    it("fires when whitespace-only text sits between the label and the input", () => {
      // The adjacency check allows newlines / indentation between the
      // sibling <label> and the control — that's formatting, not content.
      const html = `<!DOCTYPE html>
<html><body>
  <label>Amount</label>


  <input id="amount" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });

    it("fires on JSX with adjacent <label> and <input> inside a fragment", () => {
      const jsx = `function Quiz() {
  return (
    <form>
      <label>Question</label>
      <input id="q1" type="text" />
    </form>
  );
}`;
      const violations = runRule(rule, jsx, { filePath: "Quiz.tsx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/htmlFor="q1"/);
      expect(violations[0]?.fixPaths?.primary.edit?.newText).toBe('<label htmlFor="q1">');
    });

    it("fires TWICE when two adjacent-unassociated shapes live in the same file", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>First</label>
  <input id="first" type="text">
  <label>Second</label>
  <input id="second" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(2);
    });

    it("fires on the Bootstrap-template orphan shape where neither element carries an id — synthesizes an id from the label text and ships TWO mechanical edits", () => {
      // This is the canonical bug this rule was widened for: Bootstrap-
      // templated forms with `<label>Text Input</label><input class="form-
      // control">` — 12+ instances per form in the wild. Before the fix
      // the rule was silent and `forms/labels-required` took over with
      // generic guidance; now the richer mechanical pair surfaces.
      const html = `<!DOCTYPE html>
<html><body>
  <label>Text Input</label>
  <input class="form-control">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      const v = violations[0];
      // Synthesized id: kebab-cased label text.
      expect(v?.message).toMatch(/for="text-input"/);
      expect(v?.message).toMatch(/id="text-input"/);
      // Primary edit rewrites the <label> to add for=.
      expect(v?.fixPaths?.primary.edit?.oldText).toBe("<label>");
      expect(v?.fixPaths?.primary.edit?.newText).toBe('<label for="text-input">');
      // First alternative carries the companion id= insertion on the input.
      const controlEdit = v?.fixPaths?.alternatives[0]?.edit;
      expect(controlEdit?.oldText).toBe('<input class="form-control">');
      expect(controlEdit?.newText).toBe('<input id="text-input" class="form-control">');
      // Suggestion text names both attributes concretely.
      expect(v?.suggestion).toMatch(/add for="text-input".*AND add id="text-input"/);
    });

    it("resolves synthesized-id collisions against existing document ids with a -2 suffix", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <input id="email" type="email">
  <label>Email</label>
  <input class="form-control" type="email">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      // One firing — on the orphan <label>Email</label> pair. The first
      // <input id="email"> is already labeled-by-id absence (no sibling),
      // so labels-required's territory; this rule stays silent there.
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/for="email-2"/);
      expect(violations[0]?.message).toMatch(/id="email-2"/);
    });

    it("resolves collisions between two orphan shapes that would both synthesize the same id", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>Name</label>
  <input class="form-control">
  <label>Name</label>
  <input class="form-control">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(2);
      expect(violations[0]?.message).toMatch(/for="name"/);
      expect(violations[1]?.message).toMatch(/for="name-2"/);
    });

    it("fires when the input has title= (a tooltip is not the same as a deliberate accessible name)", () => {
      // Bootstrap-template contact forms routinely ship `title=` on each
      // input as an inline validation tooltip ("Please enter a valid
      // email"). The author still drew an adjacent <label> intending IT
      // to be the label, and the for/id pair is still missing — the
      // orphan shape must surface regardless of `title=`. Earlier the
      // predicate treated `title=` as "already labeled" and silently
      // hid these (the highest-volume FN on real contact pages).
      const html = `<!DOCTYPE html>
<html><body>
  <label>Email</label>
  <input type="email" class="form-control" title="Please enter a valid email">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/for="email"/);
      expect(violations[0]?.message).toMatch(/id="email"/);
    });

    it("fires on JSX when the input has title= (mirror of the HTML invariant above)", () => {
      const jsx = `function Form() {
  return (
    <form>
      <label>Email</label>
      <input type="email" className="form-control" title="Please enter a valid email" />
    </form>
  );
}`;
      const violations = runRule(rule, jsx, { filePath: "Form.tsx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/htmlFor="email"/);
    });

    it("fires on JSX with no id — synthesizes id and emits both edits", () => {
      const jsx = `function Form() {
  return (
    <form>
      <label>First Name</label>
      <input type="text" className="form-control" />
    </form>
  );
}`;
      const violations = runRule(rule, jsx, { filePath: "Form.tsx" });
      expect(violations).toHaveLength(1);
      const v = violations[0];
      expect(v?.fixPaths?.primary.edit?.newText).toBe('<label htmlFor="first-name">');
      const controlEdit = v?.fixPaths?.alternatives[0]?.edit;
      expect(controlEdit?.oldText).toBe('<input type="text" className="form-control" />');
      expect(controlEdit?.newText).toBe(
        '<input id="first-name" type="text" className="form-control" />',
      );
    });
  });

  describe("does not fire when", () => {
    it("the label already has for= matching the input's id", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="length">Length</label>
  <input id="length" type="number">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("there is no label sibling at all — that's labels-required's territory", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <input id="orphan" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the label wraps the input implicitly", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>Length <input id="length" type="number"></label>
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("an aria-label provides the accessible name", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>Legacy text</label>
  <input id="length" aria-label="Length in inches" type="number">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the adjacent element is a <br> or other intervening element, not a label", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>Length</label>
  <br>
  <input id="length" type="number">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("prose text sits between the label and the input", () => {
      // Non-whitespace text between the two means the adjacency claim
      // is already weaker than "label sits on top of input" — let the
      // agent read the file before we mechanically fuse them.
      const html = `<!DOCTYPE html>
<html><body>
  <label>Length</label>
  please enter a value
  <input id="length" type="number">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the input is type=submit / type=hidden / type=button", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>Go</label>
  <input id="go" type="submit" value="Submit">
  <label>Meta</label>
  <input id="csrf" type="hidden" value="x">
  <label>Toggle</label>
  <input id="togglebtn" type="button" value="Toggle">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("does NOT fire on the truly-missing-label case so labels-required stays the canonical owner of that shape", () => {
      // This file contains BOTH shapes:
      //   1. <input id="first"> with no label sibling anywhere — out of scope for this rule.
      //   2. <label>Last</label><input id="last"> — in scope; adjacent-no-for.
      // Verifies the two rules are mutually exclusive by shape.
      const html = `<!DOCTYPE html>
<html><body>
  <input id="first" type="text">
  <label>Last</label>
  <input id="last" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      // Only the second shape fires — and on the label line, not the input line.
      expect(violations[0]?.message).toMatch(/htmlFor="last"|for="last"/);
    });

    it("id values with ASCII-safe characters pass through verbatim in the edit", () => {
      // Regression: the escaping path is only taken for `"` and `&`;
      // ordinary ids like dashes, underscores, and digits should make it
      // through without mutation.
      const html = `<!DOCTYPE html>
<html><body>
  <label>User name 2</label>
  <input id="user-name_2" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.fixPaths?.primary.edit?.newText).toBe('<label for="user-name_2">');
    });

    it("labels that already have non-for attributes ship guidance-only (no mechanical edit)", () => {
      // The edit is only safe when the open tag is the attribute-free
      // `<label>` literal. With `<label class="form-label">` the
      // insertion point is a style call — ship guidance, let the agent
      // decide where to place for=.
      const html = `<!DOCTYPE html>
<html><body>
  <label class="form-label">Length</label>
  <input id="length" type="number">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      // Suggestion still names the fix, just without a concrete oldText/newText.
      expect(violations[0]?.suggestion).toMatch(/for="length"/);
      expect(violations[0]?.fixPaths?.primary.edit).toBeUndefined();
    });

    it("label text with punctuation kebab-cases cleanly — 'E-mail Address:' → 'e-mail-address'", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>E-mail Address:</label>
  <input class="form-control">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.fixPaths?.primary.edit?.newText).toBe('<label for="e-mail-address">');
    });

    it("empty or non-ASCII-only label text falls back to 'input' as the synthesized id", () => {
      // An empty label is already a separate rule's concern
      // (forms/non-empty-label) — but this rule still fires on the
      // adjacency shape because the association channel is what's
      // broken. The synthesized id falls back to `input` so the
      // mechanical edit stays valid; the agent reads the file to
      // decide whether "input" is a reasonable name.
      const html = `<!DOCTYPE html>
<html><body>
  <label>   </label>
  <input class="form-control">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.fixPaths?.primary.edit?.newText).toBe('<label for="input">');
    });

    it("label text starting with a digit gets an 'input-' prefix so CSS selectors stay valid", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>2FA Code</label>
  <input class="form-control">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.fixPaths?.primary.edit?.newText).toBe('<label for="input-2fa-code">');
    });

    it("self-closing JSX input accepts the id-insertion edit", () => {
      const jsx = `function F() {
  return (
    <form>
      <label>Username</label>
      <input />
    </form>
  );
}`;
      const violations = runRule(rule, jsx, { filePath: "F.tsx" });
      expect(violations).toHaveLength(1);
      const controlEdit = violations[0]?.fixPaths?.alternatives[0]?.edit;
      expect(controlEdit?.oldText).toBe("<input />");
      expect(controlEdit?.newText).toBe('<input id="username" />');
    });

    it("JSX with expression-valued id={foo} does not attempt synthesis", () => {
      // The control has `id={dynamicId}` — we can't match a literal
      // synthesized id against the runtime expression, so the rule
      // stays silent (labels-required owns this case).
      const jsx = `function F({ dynamicId }: { dynamicId: string }) {
  return (
    <form>
      <label>Search</label>
      <input id={dynamicId} type="text" />
    </form>
  );
}`;
      const violations = runRule(rule, jsx, { filePath: "F.tsx" });
      expect(violations).toHaveLength(0);
    });
  });

  // Predicate ownership: this rule owns the bare-label-then-input
  // shape; `forms/labels-required` defers to it via the shared
  // adjacency helper. Pinning the fire here guards the contract from
  // either side regressing — if this rule stops firing on the canonical
  // shape, `labels-required` would also stay silent (because the
  // suppression set still excludes the control), and the agent would
  // see ZERO findings on a real defect.
  describe("predicate ownership against forms/labels-required", () => {
    it("fires solo on the canonical form-group shape with no id on the input", () => {
      const html = `<div class="form-group"><label>Email</label><input type="email"></div>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/label-adjacent-unassociated");
    });
  });
});
