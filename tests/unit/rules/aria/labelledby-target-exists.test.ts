import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/labelledby-target-exists.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/labelledby-target-exists", () => {
  describe("HTML: does NOT fire when", () => {
    it("aria-labelledby resolves to an existing id", () => {
      const v = runRule(
        rule,
        `<h2 id="billing">Billing</h2><section aria-labelledby="billing">…</section>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("aria-describedby resolves to an existing id", () => {
      const v = runRule(
        rule,
        `<input id="pw" type="password" aria-describedby="pw-hint"><p id="pw-hint">8+ chars</p>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("aria-controls points at an element with that id", () => {
      const v = runRule(
        rule,
        `<button aria-expanded="false" aria-controls="panel">Toggle</button><div id="panel" hidden>…</div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("IDREF-list with multiple whitespace-separated tokens all resolving", () => {
      const v = runRule(
        rule,
        `<h1 id="t">Title</h1><p id="d">desc</p><section aria-labelledby="t d">…</section>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("aria-errormessage resolves to an existing id", () => {
      const v = runRule(
        rule,
        `<input id="email" aria-invalid="true" aria-errormessage="email-err"><span id="email-err">required</span>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("aria-activedescendant resolves to an existing id", () => {
      const v = runRule(
        rule,
        `<ul role="listbox" tabindex="0" aria-activedescendant="opt-1"><li role="option" id="opt-1">One</li><li role="option" id="opt-2">Two</li></ul>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("aria-details resolves to an existing id", () => {
      const v = runRule(
        rule,
        `<p aria-details="chart-note">Sales trend.</p><div id="chart-note">Data from FY24.</div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("HTML: fires when", () => {
    it("aria-labelledby references an id that does not exist", () => {
      const v = runRule(
        rule,
        `<h2 id="billing-title">Billing</h2><section aria-labelledby="billing-titl">…</section>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("billing-titl");
      // Typo within Levenshtein distance 2 surfaces as a did-you-mean hint.
      expect(v[0]?.suggestion).toContain(`"billing-title"`);
    });

    it("aria-describedby points at a nonexistent id", () => {
      const v = runRule(rule, `<input id="pw" type="password" aria-describedby="pw-desc">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("pw-desc");
    });

    it("aria-controls points at a nonexistent panel id", () => {
      const v = runRule(
        rule,
        `<button aria-expanded="false" aria-controls="drawer-panel">Menu</button>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("drawer-panel");
    });

    it("aria-owns references a missing id", () => {
      const v = runRule(rule, `<div role="tree" aria-owns="orphan-item"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("orphan-item");
    });

    it("aria-flowto references a missing id", () => {
      const v = runRule(rule, `<section aria-flowto="section-next">Intro</section>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });

    it("aria-errormessage references a missing id", () => {
      const v = runRule(
        rule,
        `<input id="email" aria-invalid="true" aria-errormessage="email-error">`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("email-error");
    });

    it("aria-activedescendant references a missing id", () => {
      const v = runRule(
        rule,
        `<ul role="listbox" tabindex="0" aria-activedescendant="opt-3"><li role="option" id="opt-1">One</li></ul>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("opt-3");
    });

    it("aria-details references a missing id", () => {
      const v = runRule(rule, `<p aria-details="footnote-1">See reference.</p>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("footnote-1");
    });

    it("aria-activedescendant with multiple whitespace-separated tokens is a shape error", () => {
      // IDREF (single) per WAI-ARIA 1.2 — only the first token is consulted.
      const v = runRule(
        rule,
        `<ul role="listbox" id="lb" aria-activedescendant="a b"><li role="option" id="a">A</li><li role="option" id="b">B</li></ul>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("IDREF");
    });

    it("aria-details with multiple whitespace-separated tokens is a shape error", () => {
      const v = runRule(
        rule,
        `<p id="p" aria-details="fn1 fn2">Notes.</p><div id="fn1">1</div><div id="fn2">2</div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("IDREF");
    });

    it("id lookup is case-sensitive (token casing mismatches target)", () => {
      const v = runRule(rule, `<h2 id="title">T</h2><section aria-labelledby="Title">…</section>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain(`"Title"`);
    });

    it("aria-errormessage given a space-separated list of tokens (IDREF, not IDREF-list)", () => {
      // aria-errormessage is IDREF (single). Multiple tokens are a shape
      // error — only the first token is consulted at runtime, the rest
      // are silently ignored.
      const v = runRule(
        rule,
        `<span id="a">a</span><span id="b">b</span><input id="i" aria-errormessage="a b">`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("IDREF");
    });
  });

  describe("IDREF-list edge cases", () => {
    it("flags a space-separated list with one valid and one broken token", () => {
      const v = runRule(
        rule,
        `<h1 id="t">Title</h1><section aria-labelledby="t missing">…</section>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("missing");
      // Header text should acknowledge the partial resolution, not claim
      // the whole value is broken.
      expect(v[0]?.message).toContain("broken token");
    });

    it("collapses adjacent whitespace in IDREF-list values (multiple spaces between tokens)", () => {
      const v = runRule(
        rule,
        `<h1 id="t">Title</h1><p id="d">Desc</p><section aria-labelledby="t   d">…</section>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("emits a warning (not error) for an empty-string value", () => {
      const v = runRule(rule, `<section aria-labelledby="">…</section>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("empty");
    });

    it("emits a warning for a whitespace-only value", () => {
      const v = runRule(rule, `<section aria-labelledby="   ">…</section>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
    });
  });

  describe("JSX", () => {
    it("does not fire when aria-labelledby resolves in the same module", () => {
      const v = runRule(
        rule,
        `const Panel = () => (<><h2 id="billing">Billing</h2><section aria-labelledby="billing">…</section></>);`,
      );
      expect(v).toHaveLength(0);
    });

    it("fires when aria-controls points at a missing id in the same file", () => {
      const v = runRule(
        rule,
        `const Toggle = () => <button aria-expanded="false" aria-controls="panel">T</button>;`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("panel");
    });

    it("downgrades to info when aria-labelledby is a JSX expression", () => {
      const v = runRule(
        rule,
        `const Row = ({ labelId }: { labelId: string }) => <section aria-labelledby={labelId}>…</section>;`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain("JSX expression");
      expect(v[0]?.suggestion).toContain("useId");
    });

    it("flags shorthand JSX usage (aria-labelledby with no value)", () => {
      const v = runRule(rule, `const Bad = () => <section aria-labelledby>…</section>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("shorthand");
    });

    it("partial IDREF-list with one broken token surfaces as one error", () => {
      const v = runRule(
        rule,
        `const Panel = () => (<><h1 id="title">T</h1><section aria-labelledby="title gone">…</section></>);`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("gone");
    });
  });

  describe("metadata", () => {
    it("declares wcag22:4.1.2 and wcag21:4.1.2", () => {
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
    });

    it("cites the WAI-ARIA 1.2 IDREF spec in docs.references", () => {
      expect(rule.docs.references).toContain("https://www.w3.org/TR/wai-aria-1.2/#idref");
    });
  });
});
