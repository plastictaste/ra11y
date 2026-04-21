import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/document/charset-first-1024-bytes.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule document/charset-first-1024-bytes", () => {
  describe("fires a violation when", () => {
    it("no charset meta is declared anywhere in <head>", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html lang="en"><head><title>Hello</title></head><body></body></html>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("document/charset-first-1024-bytes");
      expect(violations[0]?.message).toContain("no character-encoding declaration");
      expect(violations[0]?.suggestion).toMatch(/first element inside <head>/);
    });

    it("charset meta is present but a <title> precedes it", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html lang="en"><head><title>Hello</title><meta charset="utf-8"></head><body></body></html>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("not the first child of <head>");
      expect(violations[0]?.message).toContain("<title>");
      expect(violations[0]?.suggestion).toContain("<title>");
    });

    it("charset meta is serialized past the 1024-byte cap", () => {
      // 1100-byte comment before <html> pushes the charset meta past 1024.
      const source = `<!-- ${"x".repeat(1100)} -->
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Hello</title></head>
<body></body>
</html>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/ends at byte \d+/);
      expect(violations[0]?.message).toContain("1024-byte cap");
      expect(violations[0]?.suggestion).toContain("comment");
    });

    it('legacy <meta http-equiv="Content-Type"> form is still constrained', () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html lang="en"><head><title>Hello</title><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body></body></html>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("not the first child of <head>");
    });
  });

  describe("does not fire when", () => {
    it('the standard `<meta charset="utf-8">` is the first child of <head>', () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Hello</title></head><body></body></html>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the legacy http-equiv form is the first child of <head>", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>Hello</title></head><body></body></html>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a whitespace-only text node precedes the charset meta (common formatted output)", () => {
      const violations = runRule(
        rule,
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Hello</title>
</head>
<body></body>
</html>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the document has no <head> at all (other rules cover this)", () => {
      const violations = runRule(rule, `<!DOCTYPE html><html lang="en"><body></body></html>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("charset meta ending just under 1024 bytes is allowed (boundary below cap)", () => {
      // Build a prolog whose byte length is tuned so the charset meta's
      // end byte lands under 1024. The fixed suffix ending on the meta's
      // closing `>` is 67 bytes on this layout; pad to 950 prolog bytes
      // so the meta ends around byte 1017 (< 1024).
      const fixedSuffix = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">`;
      const fixedBytes = new TextEncoder().encode(fixedSuffix).length;
      const targetPrologBytes = 1024 - fixedBytes - 8; // 8-byte safety margin
      const xCount = Math.max(0, targetPrologBytes - "<!--  -->\n".length);
      const padding = `<!-- ${"x".repeat(xCount)} -->\n`;
      const source = `${padding}${fixedSuffix}\n<title>Hello</title>\n</head>\n<body></body>\n</html>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("non-ASCII bytes in a preceding comment count toward the 1024-byte cap", () => {
      // 700 × "é" = 1400 UTF-8 bytes, 700 chars — proves byte (not char) counting.
      const source = `<!-- ${"é".repeat(700)} -->
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Hello</title></head>
<body></body>
</html>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("1024-byte cap");
    });
  });

  describe("rule metadata", () => {
    it("declares parsing / info-and-relationships criteria + mechanical fix", () => {
      expect(rule.satisfies).toContain("wcag21:4.1.1");
      expect(rule.satisfies).toContain("wcag22:1.3.1");
      expect(rule.satisfies).toContain("wcag21:1.3.1");
      expect(rule.fixClass).toBe("mechanical");
    });
  });
});
