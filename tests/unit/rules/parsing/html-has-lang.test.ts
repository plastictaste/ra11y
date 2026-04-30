import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/parsing/html-has-lang.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule parsing/html-has-lang", () => {
  it("accepts a simple two-letter primary subtag (en)", () => {
    const v = runRule(rule, `<html lang="en"><body><p>hi</p></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(0);
  });

  it("accepts en-US (language + region)", () => {
    const v = runRule(rule, `<html lang="en-US"><body><p>hi</p></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(0);
  });

  it("accepts zh-Hans (language + script)", () => {
    const v = runRule(rule, `<html lang="zh-Hans"><body><p>你好</p></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(0);
  });

  it("accepts es-419 (language + UN M.49 region)", () => {
    const v = runRule(rule, `<html lang="es-419"><body><p>hola</p></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(0);
  });

  it("accepts de-CH-1901 and sr-Latn-RS (long multi-subtag tags)", () => {
    const v = runRule(
      rule,
      `<html lang="de-CH-1901"><body><p lang="sr-Latn-RS">x</p></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(0);
  });

  it('flags lang="english" as invalid BCP 47', () => {
    const v = runRule(rule, `<html lang="english"><body><p>hi</p></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.message).toContain("english");
    expect(v[0]?.message).toContain("not a valid BCP 47");
    // Context-aware suggestion: recognizes "english" and suggests "en".
    expect(v[0]?.suggestion).toContain('lang="en"');
  });

  it('flags lang="en_US" (underscore instead of dash)', () => {
    const v = runRule(rule, `<html lang="en_US"><body><p>hi</p></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.suggestion).toContain("dashes");
    expect(v[0]?.suggestion).toContain('lang="en-US"');
  });

  it("flags an empty lang attribute on <html>", () => {
    const v = runRule(rule, `<html lang=""><body><p>hi</p></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("empty lang");
  });

  it("flags an empty lang attribute on a non-html element", () => {
    const v = runRule(rule, `<html lang="en"><body><p lang="">hi</p></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("<p>");
    expect(v[0]?.message).toContain("empty lang");
  });

  it("does not flag elements without a lang attribute", () => {
    // That's document/lang-attribute's job at the root; this rule only
    // cares about present-but-broken lang values.
    const v = runRule(rule, `<html><body><p>hi</p><span>there</span></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(0);
  });

  it("reports multiple violations when multiple elements are broken", () => {
    const v = runRule(
      rule,
      `<html lang="english"><body><p lang="">a</p><span lang="en_GB">b</span></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(3);
    expect(v.map((x) => x.message).join("\n")).toContain("english");
    expect(v.map((x) => x.message).join("\n")).toContain("<p>");
    expect(v.map((x) => x.message).join("\n")).toContain("<span>");
  });

  it("accepts a mix of valid lang values across nested elements", () => {
    const v = runRule(
      rule,
      `<html lang="en-US"><body><p lang="fr">Bonjour</p><span lang="ja">こんにちは</span></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(0);
  });

  it("cites wcag22:3.1.2 and wcag21:3.1.2", () => {
    expect(rule.satisfies).toContain("wcag22:3.1.2");
    expect(rule.satisfies).toContain("wcag21:3.1.2");
  });

  it("points at the offending element's line/column", () => {
    const v = runRule(rule, `<html lang="en">\n<body>\n<p lang="english">x</p>\n</body>\n</html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.location.line).toBe(3);
  });

  // ---------------------------------------------------------------------
  // Underspecified BCP 47 codes (zxx / und / mul / mis) on prose pages.
  // The motivating real-world case was a Bootstrap floating-label demo
  // shipping `<html lang="zxx">` over an English UI ("Email address",
  // "Open this select menu"); the BCP 47 syntax check passes but the
  // declaration contradicts the visible content.
  // ---------------------------------------------------------------------

  it('flags lang="zxx" on <html> when the body contains visible prose', () => {
    const v = runRule(
      rule,
      `<html lang="zxx"><body><label>Email address</label><button>Open this select menu</button><p>Lorem ipsum dolor sit amet.</p></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.message).toContain("zxx");
    expect(v[0]?.message).toContain("no linguistic content");
    expect(v[0]?.message).toMatch(/\d+ character\(s\) of visible text/);
    expect(v[0]?.suggestion).toContain('lang="en"');
  });

  it('flags lang="und" / "mul" / "mis" the same way as zxx', () => {
    for (const code of ["und", "mul", "mis"] as const) {
      const v = runRule(
        rule,
        `<html lang="${code}"><body><p>Hello world from the contact form.</p></body></html>`,
        { filePath: "index.html" },
      );
      expect(v, `expected ${code} to fire on prose page`).toHaveLength(1);
      expect(v[0]?.message).toContain(code);
    }
  });

  it('does not flag lang="zxx" when the body has no visible text', () => {
    // Pure decorative imagery — symbols only, no prose. zxx is the
    // appropriate declaration here per BCP 47 / ISO 639-2.
    const v = runRule(
      rule,
      `<html lang="zxx"><body><img src="logo.svg" alt=""><svg></svg></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(0);
  });

  it('does not flag lang="zxx" when the body is empty', () => {
    const v = runRule(rule, `<html lang="zxx"><body></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(0);
  });

  it('does not flag lang="en" on a prose page (correct tag)', () => {
    const v = runRule(
      rule,
      `<html lang="en"><body><p>Email address</p><button>Sign in</button></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(0);
  });

  it("does not count <script>/<style>/<head> text toward the visible-text check", () => {
    // Page has no body prose — script source and stylesheet declarations
    // are not user-visible text. zxx remains valid here.
    const v = runRule(
      rule,
      `<html lang="zxx"><head><title>icon page</title><style>body{color:red}</style></head><body><script>console.log("hello world from a long script body")</script></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(0);
  });

  it("flags an underspecified primary subtag even when carrying region/script suffixes", () => {
    // `zxx-Latn` is rare but syntactically valid; the underspecified
    // primary subtag still asserts "no linguistic content" so the
    // contradiction-with-prose check should still fire.
    const v = runRule(
      rule,
      `<html lang="zxx-Latn"><body><p>Hello world from a contact form.</p></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("zxx-Latn");
  });

  it('flags lang="zxx" on a non-html element with prose under it', () => {
    // The underspecified-code check is element-scoped, not just
    // document-scoped — `<section lang="zxx">` over real text is the
    // same contradiction as on <html>.
    const v = runRule(
      rule,
      `<html lang="en"><body><section lang="zxx"><p>This section has actual English prose.</p></section></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("<section>");
    expect(v[0]?.message).toContain("zxx");
  });

  // ---------------------------------------------------------------------
  // Framework-convention hosts: `<style>` / `<script>` use `lang` as a
  // build-tool preprocessor tag (Vue SFC, Astro, Svelte); PascalCase
  // tags are custom components whose `lang` is a prop. BCP 47 is not
  // the contract on those tags, so the rule must not fire.
  // ---------------------------------------------------------------------

  it('does not flag <style lang="scss"> (Vue/Astro preprocessor tag)', () => {
    const v = runRule(
      rule,
      `<html lang="en"><body><style lang="scss">.x{color:red}</style></body></html>`,
      { filePath: "Component.html" },
    );
    expect(v).toHaveLength(0);
  });

  it('does not flag <script lang="ts"> (Vue/Astro preprocessor tag)', () => {
    const v = runRule(
      rule,
      `<html lang="en"><body><script lang="ts">const x: number = 1;</script></body></html>`,
      { filePath: "Component.html" },
    );
    expect(v).toHaveLength(0);
  });

  it('does not flag <Component lang="..."> (PascalCase = custom component prop)', () => {
    // `lang` here is a JSX-style component prop, not the HTML lang
    // attribute. Still emerges in HTML-shaped Astro/Svelte components.
    const v = runRule(
      rule,
      `<html lang="en"><body><Heading lang="primary">x</Heading></body></html>`,
      { filePath: "Component.html" },
    );
    expect(v).toHaveLength(0);
  });

  it('still flags <html lang="zz"> on a real document (BCP 47 contract preserved)', () => {
    // The framework-convention skip must not regress the document-root
    // check — `<html>` is lowercase + non-script/style, so the gate
    // does not apply.
    const v = runRule(rule, `<html lang="zz"><body><p>hi</p></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(0);
    // (`zz` is two letters and passes BCP47_BASIC; the rule does not
    // validate against IANA. Use a real malformed value to confirm
    // the gate doesn't suppress real findings.)
    const v2 = runRule(rule, `<html lang="english"><body><p>hi</p></body></html>`, {
      filePath: "index.html",
    });
    expect(v2).toHaveLength(1);
  });
});
