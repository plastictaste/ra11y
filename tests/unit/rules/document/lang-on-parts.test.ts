import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/document/lang-on-parts.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule document/lang-on-parts", () => {
  // --- positive (should fire) -------------------------------------------------

  it("fires on empty lang attribute", () => {
    const v = runRule(rule, `<html lang="en"><body><span lang="">word</span></body></html>`, {
      filePath: "x.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.message).toContain("empty");
  });

  it("fires on underscore separator (en_US)", () => {
    const v = runRule(rule, `<html lang="en"><body><div lang="en_US">x</div></body></html>`, {
      filePath: "x.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.message).toContain("underscore");
    expect(v[0]?.suggestion).toContain('lang="en-US"');
  });

  it("fires on malformed tag (numbers in primary subtag)", () => {
    const v = runRule(rule, `<html lang="en"><body><cite lang="xyz123">x</cite></body></html>`, {
      filePath: "x.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.message).toContain("not a valid BCP 47 tag");
  });

  it("fires on word-as-language ('english')", () => {
    const v = runRule(rule, `<html lang="en"><body><p lang="english">hi</p></body></html>`, {
      filePath: "x.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
  });

  // --- negative (should not fire) ---------------------------------------------

  it("does not fire on valid 'en'", () => {
    const v = runRule(rule, `<html lang="en"><body><span lang="en">x</span></body></html>`, {
      filePath: "x.html",
    });
    expect(v).toHaveLength(0);
  });

  it("does not fire on valid 'fr-CA'", () => {
    const v = runRule(
      rule,
      `<html lang="en"><body><span lang="fr-CA">bonjour</span></body></html>`,
      { filePath: "x.html" },
    );
    expect(v).toHaveLength(0);
  });

  it("does not fire on valid 'zh-Hans'", () => {
    const v = runRule(rule, `<html lang="en"><body><span lang="zh-Hans">汉</span></body></html>`, {
      filePath: "x.html",
    });
    expect(v).toHaveLength(0);
  });

  it("does not fire on element without a lang attribute", () => {
    const v = runRule(rule, `<html lang="en"><body><span>hello</span></body></html>`, {
      filePath: "x.html",
    });
    expect(v).toHaveLength(0);
  });

  it("ignores <html> (covered by document/lang-attribute / 3.1.1)", () => {
    // Even with a malformed root lang, this rule should stay silent —
    // the 3.1.1 rule owns root-level reporting.
    const v = runRule(rule, `<html lang="en_US"><body></body></html>`, { filePath: "x.html" });
    expect(v).toHaveLength(0);
  });

  // --- edge cases -------------------------------------------------------------

  it("warns (not errors) on uppercase primary subtag", () => {
    const v = runRule(rule, `<html lang="en"><body><span lang="EN">x</span></body></html>`, {
      filePath: "x.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("warning");
    expect(v[0]?.suggestion).toContain('lang="en"');
  });

  it("accepts private-use tag x-klingon", () => {
    const v = runRule(
      rule,
      `<html lang="en"><body><span lang="x-klingon">tlhIngan</span></body></html>`,
      { filePath: "x.html" },
    );
    expect(v).toHaveLength(0);
  });

  it("flags bare 'x' (private-use needs a subtag)", () => {
    const v = runRule(rule, `<html lang="en"><body><span lang="x">y</span></body></html>`, {
      filePath: "x.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.message).toContain("private-use");
  });

  it("flags xml:lang the same way as lang", () => {
    const v = runRule(rule, `<html lang="en"><body><span xml:lang="en_US">x</span></body></html>`, {
      filePath: "x.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("xml:lang");
  });

  it("works on JSX with string-literal lang", () => {
    const v = runRule(rule, `export const X = () => (<section lang="en_US">hi</section>);`, {
      filePath: "x.tsx",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("underscore");
  });

  it("ignores JSX expression-valued lang ({locale})", () => {
    const v = runRule(
      rule,
      `export const X = ({locale}: {locale: string}) => (<section lang={locale}>hi</section>);`,
      { filePath: "x.tsx" },
    );
    expect(v).toHaveLength(0);
  });

  it("cites wcag22:3.1.2 and wcag21:3.1.2", () => {
    expect(rule.satisfies).toContain("wcag22:3.1.2");
    expect(rule.satisfies).toContain("wcag21:3.1.2");
  });

  // --- framework-convention hosts (predicate-mismatch closure) ---------------
  // `<style lang="scss">` / `<script lang="ts">` overload `lang` as a
  // build-tool preprocessor tag (Vue SFC, Astro, Svelte); PascalCase tags
  // are JSX components whose `lang` is a custom prop. BCP 47 is not the
  // contract on those tags. Per AI-first doctrine "Reason text and
  // severity must agree" — firing error-severity on a non-BCP-47 host is
  // the canonical predicate-mismatch failure.

  it('ignores <style lang="scss"> in HTML (Vue SFC / Astro preprocessor tag)', () => {
    const v = runRule(
      rule,
      `<html lang="en"><body><style lang="scss">.x{color:red}</style></body></html>`,
      { filePath: "Component.html" },
    );
    expect(v).toHaveLength(0);
  });

  it('ignores <script lang="ts"> in HTML (Vue SFC / Astro preprocessor tag)', () => {
    const v = runRule(
      rule,
      `<html lang="en"><body><script lang="ts">const x: number = 1;</script></body></html>`,
      { filePath: "Component.html" },
    );
    expect(v).toHaveLength(0);
  });

  it('ignores <style lang="scss"> in JSX', () => {
    const v = runRule(rule, `export const X = () => (<style lang="scss">.x{color:red}</style>);`, {
      filePath: "Component.tsx",
    });
    expect(v).toHaveLength(0);
  });

  it('ignores <script lang="ts"> in JSX', () => {
    const v = runRule(rule, 'export const X = () => (<script lang="ts">const x = 1;</script>);', {
      filePath: "Component.tsx",
    });
    expect(v).toHaveLength(0);
  });

  it('ignores PascalCase component <Heading lang="..."> in JSX (custom prop)', () => {
    const v = runRule(rule, `export const X = () => (<Heading lang="primary">x</Heading>);`, {
      filePath: "Component.tsx",
    });
    expect(v).toHaveLength(0);
  });

  it('ignores nested PascalCase <Code lang="ts"> (custom prop, not BCP 47)', () => {
    const v = runRule(rule, `export const X = () => (<Code lang="ts">const x = 1;</Code>);`, {
      filePath: "Component.tsx",
    });
    expect(v).toHaveLength(0);
  });

  it('still fires on lowercase <p lang="english"> alongside framework-convention siblings', () => {
    // The framework-convention skip must be precise — sibling lowercase
    // BCP-47-bearing elements still get checked.
    const v = runRule(
      rule,
      'export const X = () => (<><style lang="scss">.x{}</style><p lang="english">hi</p></>);',
      { filePath: "Component.tsx" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("<p");
  });
});
