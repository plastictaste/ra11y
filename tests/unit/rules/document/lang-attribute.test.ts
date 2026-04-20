import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/document/lang-attribute.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule document/lang-attribute", () => {
  it("fires when <html> has no lang attribute", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html><head><title>x</title></head><body></body></html>`,
      {
        filePath: "index.html",
      },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.message).toContain("missing the lang attribute");
  });

  it("fires when <html> has an empty lang", () => {
    const v = runRule(rule, `<html lang=""><body></body></html>`, { filePath: "index.html" });
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("empty");
  });

  it("fires when <html> has whitespace-only lang", () => {
    const v = runRule(rule, `<html lang="   "><body></body></html>`, { filePath: "index.html" });
    expect(v).toHaveLength(1);
  });

  it("does not fire when <html lang='en'>", () => {
    const v = runRule(rule, `<html lang="en"><body></body></html>`, { filePath: "index.html" });
    expect(v).toHaveLength(0);
  });

  it("does not fire when <html lang='ja'>", () => {
    const v = runRule(rule, `<html lang="ja"><body></body></html>`, { filePath: "index.html" });
    expect(v).toHaveLength(0);
  });

  it("accepts xml:lang as a fallback", () => {
    const v = runRule(rule, `<html xml:lang="en"><body></body></html>`, { filePath: "index.html" });
    expect(v).toHaveLength(0);
  });

  it("does not fire on HTML fragments (no <html> root)", () => {
    const v = runRule(rule, `<p>just a fragment</p>`, { filePath: "fragment.html" });
    expect(v).toHaveLength(0);
  });

  it("suggestion mentions BCP 47", () => {
    const v = runRule(rule, `<html><body></body></html>`, { filePath: "index.html" });
    expect(v[0]?.suggestion).toContain("BCP 47");
  });

  it("fallback suggestion names multiple concrete BCP-47 examples", () => {
    // No meta hints anywhere in the document — the ladder falls through
    // to the generic branch, which must still be concrete (multiple
    // examples) rather than a bare "use BCP 47" string.
    const v = runRule(rule, `<html><body></body></html>`, { filePath: "index.html" });
    const suggestion = v[0]?.suggestion ?? "";
    expect(suggestion).toContain('lang="en"');
    expect(suggestion).toContain('lang="fr"');
    expect(suggestion).toContain('lang="ja"');
  });

  it("echoes <meta http-equiv='Content-Language'> value into the fix text", () => {
    const v = runRule(
      rule,
      `<!DOCTYPE html><html><head><meta http-equiv="Content-Language" content="fr"></head><body></body></html>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    const suggestion = v[0]?.suggestion ?? "";
    expect(suggestion).toContain('lang="fr"');
    expect(suggestion).toContain("http-equiv");
  });

  it("accepts a comma-separated Content-Language list, picking the primary", () => {
    const v = runRule(
      rule,
      `<html><head><meta http-equiv="Content-Language" content="es-ES, en"></head><body></body></html>`,
      { filePath: "index.html" },
    );
    expect(v[0]?.suggestion ?? "").toContain('lang="es-ES"');
  });

  it("falls back to <meta name='language'> when http-equiv is absent", () => {
    const v = runRule(
      rule,
      `<html><head><meta name="language" content="de"></head><body></body></html>`,
      { filePath: "index.html" },
    );
    const suggestion = v[0]?.suggestion ?? "";
    expect(suggestion).toContain('lang="de"');
    expect(suggestion).toContain("non-standard");
  });

  it("hints Japanese for legacy shift_jis charset", () => {
    const v = runRule(rule, `<html><head><meta charset="shift_jis"></head><body></body></html>`, {
      filePath: "index.html",
    });
    const suggestion = v[0]?.suggestion ?? "";
    expect(suggestion).toContain('lang="ja"');
    expect(suggestion).toContain("shift_jis");
  });

  it("hints Simplified Chinese for gb2312 charset via legacy Content-Type meta", () => {
    const v = runRule(
      rule,
      `<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"></head><body></body></html>`,
      { filePath: "index.html" },
    );
    const suggestion = v[0]?.suggestion ?? "";
    expect(suggestion).toContain('lang="zh-Hans"');
  });

  it("does not hint a language for region-neutral utf-8 charset", () => {
    const v = runRule(rule, `<html><head><meta charset="utf-8"></head><body></body></html>`, {
      filePath: "index.html",
    });
    const suggestion = v[0]?.suggestion ?? "";
    // utf-8 carries no region signal → fall through to the generic
    // BCP-47 ladder entry, not a charset-specific one.
    expect(suggestion).not.toContain("legacy encoding");
    expect(suggestion).toContain("BCP 47");
  });

  it("prefers http-equiv over charset hint when both are present", () => {
    const v = runRule(
      rule,
      `<html><head><meta charset="shift_jis"><meta http-equiv="Content-Language" content="en"></head><body></body></html>`,
      { filePath: "index.html" },
    );
    const suggestion = v[0]?.suggestion ?? "";
    expect(suggestion).toContain('lang="en"');
    expect(suggestion).not.toContain("legacy encoding");
  });

  it("cites wcag22:3.1.1 and wcag21:3.1.1", () => {
    expect(rule.satisfies).toContain("wcag22:3.1.1");
    expect(rule.satisfies).toContain("wcag21:3.1.1");
  });
});
