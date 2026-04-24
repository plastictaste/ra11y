import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/parsing/invalid-id-shape.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule parsing/invalid-id-shape", () => {
  describe("fires a violation when", () => {
    it("an HTML id starts with '#' (author confused id with fragment syntax)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><section id="#top">Hello</section></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("parsing/invalid-id-shape");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.suggestion).toMatch(/'#' prefix|Strip the leading '#'/);
      // Suggestion must name the fixed id (with the '#' stripped).
      expect(violations[0]?.suggestion).toMatch(/id="top"/);
    });

    it("an HTML id contains whitespace", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><section id="hero banner">Hello</section></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/cannot contain spaces/);
      // Hyphen-joined and camelCase alternatives both present.
      expect(violations[0]?.suggestion).toMatch(/id="hero-banner"/);
      expect(violations[0]?.suggestion).toMatch(/id="heroBanner"/);
    });

    it('an HTML id is empty (id="")', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><section id="">Hello</section></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/empty id/);
      expect(violations[0]?.suggestion).toMatch(/Remove the id attribute/);
    });

    it('an HTML id is whitespace-only (id=" ")', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><section id="  ">Hello</section></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/whitespace-only id/);
    });

    it("a JSX id literal starts with '#'", () => {
      const violations = runRule(
        rule,
        `export const Page = () => <section id="#top">Hello</section>;`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/id="top"/);
    });

    it("a JSX id literal contains whitespace", () => {
      const violations = runRule(
        rule,
        `export const Page = () => <section id="hero banner">Hello</section>;`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/id="hero-banner"/);
    });

    it("an HTML id contains a non-ASCII accented character (é)", () => {
      // Real-world failure mode: id="présentation" + href="#présentation"
      // pair break the moment a copy-paste step normalizes the accent
      // away on one side but not the other. The conservative ASCII-safe
      // set sidesteps that mismatch entirely.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><section id="présentation">Hello</section></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/outside the ASCII-safe set/);
      // Suggestion proposes a transliterated ASCII alternative.
      expect(violations[0]?.suggestion).toMatch(/id="presentation"/);
      // Message names the offending character so the agent can spot it.
      expect(violations[0]?.message).toMatch(/'é'/);
    });

    it("an HTML id contains an emoji", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><section id="emoji-🎉">Hello</section></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/outside the ASCII-safe set/);
      // Stripping the non-ASCII character leaves "emoji-".
      expect(violations[0]?.suggestion).toMatch(/id="emoji-"/);
    });

    it("a JSX id literal contains a non-ASCII character", () => {
      const violations = runRule(
        rule,
        `export const Page = () => <section id="café">Hello</section>;`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/outside the ASCII-safe set/);
      expect(violations[0]?.suggestion).toMatch(/id="cafe"/);
    });
  });

  describe("does not fire when", () => {
    it("a legal HTML id has no whitespace or leading '#'", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><section id="main-content">Hello</section></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the element has no id attribute at all", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><section>Hello</section></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a JSX id uses a dynamic expression (scanner cannot statically verify)", () => {
      const violations = runRule(
        rule,
        `export const Page = ({ slug }: { slug: string }) => <section id={slug}>Hello</section>;`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a template directive wraps the id value (opaque to static analysis)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><section id="{{ page.slug }}">Hello</section></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("an id mixes underscores, hyphens, digits, and ASCII letters", () => {
      // The four characters in the conservative ASCII-safe set
      // [A-Za-z0-9_-] all coexist; the non-ASCII branch must not
      // over-fire on these legitimate ids.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><section id="my_id-1">Hello</section></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("an id that starts with a digit is legal HTML5 and stays silent", () => {
      // Deliberately NOT flagged — many CSS frameworks use digit-prefixed
      // ids (e.g. id="2024-roadmap"). Ruling these out would be a
      // heuristic on weaker evidence than the agent has.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><section id="2024-roadmap">Hello</section></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("multiple broken ids in one file each get their own violation", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <section id="#top">a</section>
          <section id="has space">b</section>
          <section id="">c</section>
        </body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(3);
      // Each violation's message differs — the rule classifies per shape.
      const messages = violations.map((v) => v.message).join("|");
      expect(messages).toMatch(/'#' prefix/);
      expect(messages).toMatch(/whitespace/);
      expect(messages).toMatch(/empty id/);
    });

    it("the violation location points at the attribute, not the element opening", () => {
      const source = `<!doctype html>
<html>
  <body>
    <section
      id="#top">Hello</section>
  </body>
</html>`;
      const violations = runRule(rule, source, { filePath: "input.html" });
      expect(violations).toHaveLength(1);
      // The `id` attribute sits on line 5; the element opens on line 4.
      // Point at the attribute so the agent's first read lands on the
      // offending characters, not the parent tag.
      expect(violations[0]?.location.line).toBe(5);
    });
  });
});
