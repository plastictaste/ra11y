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

  // ── xml:lang vs lang mismatch ───────────────────────────────────────
  // A conforming AT may consult either attribute; when the two
  // disagree the announced language is nondeterministic. WCAG 3.1.1
  // hinges on the page's language being *programmatically
  // determinable*, so two contradicting sources of truth are a
  // 3.1.1 failure even when each individually looks valid.

  it("fires when xml:lang and lang disagree (primary vs primary+region)", () => {
    const v = runRule(rule, `<html xml:lang="en" lang="en-us"><body></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.message).toContain("en-us");
    expect(v[0]?.message).toContain("disagree");
  });

  it("fires when xml:lang and lang differ in primary subtag", () => {
    const v = runRule(rule, `<html xml:lang="fr" lang="en"><body></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("en");
    expect(v[0]?.message).toContain("fr");
  });

  it("does NOT fire when xml:lang and lang match exactly", () => {
    const v = runRule(rule, `<html xml:lang="en-US" lang="en-US"><body></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(0);
  });

  it("does NOT fire when xml:lang and lang differ only in case", () => {
    // Per BCP 47 §2.1.1, case in language tags carries no meaning —
    // `en-US` and `EN-us` refer to the same tag. Flagging purely
    // cosmetic differences would be noise.
    const v = runRule(rule, `<html xml:lang="en-US" lang="EN-us"><body></body></html>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(0);
  });

  it("suggestion proposes both replacement options without picking a winner", () => {
    const v = runRule(rule, `<html xml:lang="en" lang="en-us"><body></body></html>`, {
      filePath: "index.html",
    });
    const suggestion = v[0]?.suggestion ?? "";
    // Both candidate tags surfaced as the "unify on this value"
    // proposals, so the agent can pick by reading the content —
    // cf. ai-first-consumer.md "Review candidates, not assertions".
    expect(suggestion).toContain('xml:lang="en-us"');
    expect(suggestion).toContain('lang="en"');
  });

  // ── V1-FIX-LANG-AUTOCOMPLETE-ALT-MECHANICAL-DOWNGRADE: fixPaths.edit ─
  // The rule is `fixClass: "verify-in-source"` because the language tag
  // requires inference. On the high-signal lanes — author has already
  // declared a `<meta http-equiv="Content-Language">` or `<meta
  // name="language">` somewhere on the page — the inferred tag is
  // deterministic and the rule emits `fixPaths.primary.edit` so
  // `suggest_fix` returns `kind: "edit"`. The bare `<html>` (no in-page
  // hint) and charset-only branches stay guidance-only.

  describe("fixPaths.edit (V1-FIX-LANG-AUTOCOMPLETE-ALT-MECHANICAL-DOWNGRADE)", () => {
    it("emits primary.edit inserting lang from <meta http-equiv='Content-Language'>", () => {
      const source =
        '<html><head><meta http-equiv="Content-Language" content="fr"></head><body></body></html>';
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      const edit = v[0]?.fixPaths?.primary.edit;
      expect(edit).toBeDefined();
      expect(edit?.oldText).toBe("<html>");
      expect(edit?.newText).toBe('<html lang="fr">');
      expect(v[0]?.fixPaths?.primary.label).toContain('lang="fr"');
      expect(v[0]?.fixPaths?.alternatives).toHaveLength(0);
    });

    it("emits primary.edit using the primary tag from a comma-separated Content-Language list", () => {
      const source =
        '<html><head><meta http-equiv="Content-Language" content="es-ES, en"></head><body></body></html>';
      const v = runRule(rule, source, { filePath: "index.html" });
      const edit = v[0]?.fixPaths?.primary.edit;
      expect(edit).toBeDefined();
      expect(edit?.newText).toBe('<html lang="es-ES">');
    });

    it("emits primary.edit using <meta name='language'> when http-equiv is absent", () => {
      const source = '<html><head><meta name="language" content="de"></head><body></body></html>';
      const v = runRule(rule, source, { filePath: "index.html" });
      const edit = v[0]?.fixPaths?.primary.edit;
      expect(edit).toBeDefined();
      expect(edit?.newText).toBe('<html lang="de">');
    });

    it("does NOT emit fixPaths.edit for bare <html> without any in-page language hint", () => {
      // The fallback ladder still produces prose `suggestion`, but the
      // structured edit lane stays absent because no deterministic tag
      // exists. suggest_fix will return kind: "guidance" with
      // `meta.mechanicalInPrinciple: true` (verify-in-source lane).
      const source = "<html><body></body></html>";
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.fixPaths).toBeUndefined();
    });

    it("does NOT emit fixPaths.edit for legacy charset hints (charset is a region family, not one tag)", () => {
      // shift_jis identifies "Japanese content" — but that's a language
      // family hint the rule's prose lays out for the agent to verify;
      // promoting it to a structured edit would risk pasting `lang="ja"`
      // into a Korean or Chinese-via-shift_jis page. Encoding the family
      // as a deterministic tag would be a guess; honest shape is prose-
      // only. See ai-first-consumer.md "No heuristic suppression."
      const source = '<html><head><meta charset="shift_jis"></head><body></body></html>';
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.fixPaths).toBeUndefined();
    });
  });
});
