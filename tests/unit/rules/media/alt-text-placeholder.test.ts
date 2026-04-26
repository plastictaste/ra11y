import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/media/alt-text-placeholder.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule media/alt-text-placeholder", () => {
  describe("HTML: fires a violation when", () => {
    it("alt is the medium word 'image'", () => {
      const violations = runRule(rule, `<img src="x.png" alt="image">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/alt-text-placeholder");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.criteria).toContain("wcag22:1.1.1");
      expect(violations[0]?.suggestion).toMatch(/alt=""/);
    });

    it("alt is a case-mixed medium word ('Screenshot')", () => {
      const violations = runRule(rule, `<img src="x.png" alt="Screenshot">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/restates the medium/);
    });

    it("alt is an authoring placeholder ('TODO')", () => {
      const violations = runRule(rule, `<img src="x.png" alt="TODO">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/authoring placeholder/);
    });

    it("alt is 'placeholder'", () => {
      const violations = runRule(rule, `<img src="x.png" alt="placeholder">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("alt is a meta word ('description')", () => {
      const violations = runRule(rule, `<img src="x.png" alt="description">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/names the attribute/);
    });

    it("alt is single-word repetition ('image image')", () => {
      const violations = runRule(rule, `<img src="x.png" alt="image image">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/repeats a single word/);
    });

    it("alt is 'fix me' (multi-word authoring placeholder)", () => {
      const violations = runRule(rule, `<img src="x.png" alt="fix me">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("<input type='image'> has placeholder alt", () => {
      const violations = runRule(rule, `<input type="image" src="go.png" alt="image">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("alt is 'logo' (role-as-alt antipattern on a brand mark)", () => {
      const violations = runRule(rule, `<img src="img/logo.png" alt="logo">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/restates the medium/);
    });

    it("alt is a role-noun phrase ('image of mountain')", () => {
      const violations = runRule(rule, `<img src="m.png" alt="image of mountain">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/role-noun phrase/);
    });

    it("alt is a role-noun phrase ('photo of dog')", () => {
      const violations = runRule(rule, `<img src="d.png" alt="photo of dog">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("alt is a sequential carousel-slide label ('First slide')", () => {
      const violations = runRule(rule, `<img src="s1.png" alt="First slide">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/sequential positional label/);
      expect(violations[0]?.suggestion).toMatch(/THIS slide/);
    });

    it("alt is a numeric carousel-slide label ('Slide 1')", () => {
      const violations = runRule(rule, `<img src="s1.png" alt="Slide 1">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/sequential positional label/);
    });

    it("alt is a numbered-image label ('Image 3')", () => {
      const violations = runRule(rule, `<img src="i3.png" alt="Image 3">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/sequential positional label/);
    });

    it("alt is a numbered-photo label ('Photo 7')", () => {
      const violations = runRule(rule, `<img src="p7.png" alt="Photo 7">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("alt is an ordinal slide later in the sequence ('Third slide')", () => {
      const violations = runRule(rule, `<img src="s3.png" alt="Third slide">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("alt is a navigation slide label ('Next slide')", () => {
      const violations = runRule(rule, `<img src="n.png" alt="Next slide">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("alt is a multi-digit slide number ('Slide 12')", () => {
      const violations = runRule(rule, `<img src="s12.png" alt="Slide 12">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("alt restates the src basename ('balloons.gif' / 'balloons')", () => {
      const violations = runRule(rule, `<img src="balloons.gif" alt="balloons">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/restates the src filename/);
      expect(violations[0]?.message).toMatch(/"balloons"/);
      expect(violations[0]?.suggestion).toMatch(/already in the src/);
    });

    it("alt restates a hyphenated basename, case-insensitive ('team-photo.jpg' / 'Team Photo')", () => {
      const violations = runRule(rule, `<img src="/path/to/team-photo.jpg" alt="Team Photo">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/restates the src filename/);
      expect(violations[0]?.message).toMatch(/"team photo"/);
    });

    it("alt is a sub-word of a hyphenated basename ('team-photo.jpg' / 'photo')", () => {
      // Single-token alt that's a strict subset of the basename's
      // tokens — alt = {photo}, stem = {team, photo}. The author
      // typed one of the filename pieces; same failure mode.
      // (Note: alt="photo" alone would also trigger the medium-word
      // category; pinning srcBasename via a token NOT in MEDIUM_WORDS
      // is harder to construct without contriving the basename.)
      const violations = runRule(rule, `<img src="team-photo.jpg" alt="team">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/restates the src filename/);
    });

    it("alt restates an underscore-separated basename ('hero_banner.png' / 'Hero Banner')", () => {
      const violations = runRule(
        rule,
        `<img src="https://cdn.example.com/img/hero_banner.png?v=2" alt="Hero Banner">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/"hero banner"/);
    });
  });

  describe("HTML: does not fire when", () => {
    it("alt is a real description that happens to contain 'image'", () => {
      const violations = runRule(rule, `<img src="p.png" alt="Aerial image of Paris at dusk">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("alt is a real description that starts with 'Screenshot of'", () => {
      const violations = runRule(
        rule,
        `<img src="ss.png" alt="Screenshot of the dashboard with Q4 sales chart">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("alt is explicitly empty (decorative)", () => {
      const violations = runRule(rule, `<img src="f.png" alt="">`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("alt attribute is absent (missing rule owns this)", () => {
      const violations = runRule(rule, `<img src="f.png">`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("alt is whitespace-only (missing rule owns this)", () => {
      const violations = runRule(rule, `<img src="f.png" alt="   ">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("alt is a meaningful non-placeholder sentence", () => {
      const violations = runRule(
        rule,
        `<img src="c.png" alt="Bar chart: Q1 $1.2M, Q2 $2.4M, Q3 $3.1M, Q4 $3.8M">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("alt is 'Acme Corp logo' (proper-name-plus-role identifies the brand)", () => {
      const violations = runRule(rule, `<img src="img/logo.png" alt="Acme Corp logo">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("alt is a long descriptive 'image of …' sentence (>4 tokens)", () => {
      const violations = runRule(
        rule,
        `<img src="t.png" alt="An image of Lake Tahoe at sunset reflecting the mountains">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("alt that ends with role noun ('Acme Corp icon') does not match (phrase must START with role noun)", () => {
      const violations = runRule(rule, `<img src="i.png" alt="Acme Corp icon">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("alt is a real slide description ('Lake Tahoe at sunset') does not match the carousel pattern", () => {
      const violations = runRule(rule, `<img src="s1.png" alt="Lake Tahoe at sunset">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("alt that contains 'slide' but is descriptive ('Slide deck cover with company logo') does not match", () => {
      const violations = runRule(
        rule,
        `<img src="s.png" alt="Slide deck cover with company logo">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("alt that mentions an image number in a real description does not match", () => {
      const violations = runRule(
        rule,
        `<img src="i3.png" alt="Image 3 of 5: revenue trends 2024-2026">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("alt is a real description even when the basename is descriptive ('balloons.gif' / 'Two children playing with balloons')", () => {
      const violations = runRule(
        rule,
        `<img src="balloons.gif" alt="Two children playing with balloons">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("alt is empty (decorative) even when src basename is descriptive", () => {
      const violations = runRule(rule, `<img src="balloons.gif" alt="">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("very short basename ('x.jpg') does not trigger basename match on coincidental alt", () => {
      // Short stems coincidentally match short alts; we skip stems
      // ≤ 2 chars so `x.jpg` / `a.png` don't fire. The alt itself
      // also doesn't match any other category.
      const violations = runRule(rule, `<img src="x.jpg" alt="xx">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("alt and basename share only stop-words / unrelated tokens (no match)", () => {
      // alt = {a, sunset, over, the, lake} — none overlap with stem
      // = {balloons}. Neither subset direction holds.
      const violations = runRule(rule, `<img src="balloons.gif" alt="A sunset over the lake">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires a violation when", () => {
    it("alt prop is 'image'", () => {
      const violations = runRule(rule, `const X = <img src="x.png" alt="image" />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/alt-text-placeholder");
    });

    it("alt prop is 'TODO'", () => {
      const violations = runRule(rule, `const X = <img src="x.png" alt="TODO" />;`);
      expect(violations).toHaveLength(1);
    });

    it("alt prop is 'FIXME' (case insensitive)", () => {
      const violations = runRule(rule, `const X = <img src="x.png" alt="FIXME" />;`);
      expect(violations).toHaveLength(1);
    });

    it("multiple offending imgs produce multiple violations", () => {
      const src = `const X = <div><img src="a.png" alt="image" /><img src="b.png" alt="TODO" /></div>;`;
      const violations = runRule(rule, src);
      expect(violations).toHaveLength(2);
    });

    it("wrapper-mapped component (Avatar → img) with placeholder alt", () => {
      const violations = runRule(rule, `const X = <Avatar src="me.png" alt="photo" />;`, {
        nativeWrapperElements: { Avatar: "img" },
      });
      expect(violations).toHaveLength(1);
    });

    it("alt prop is 'logo' (role-as-alt antipattern)", () => {
      const violations = runRule(rule, `const X = <img src="logo.png" alt="logo" />;`);
      expect(violations).toHaveLength(1);
    });

    it("alt prop is 'image of dog'", () => {
      const violations = runRule(rule, `const X = <img src="d.png" alt="image of dog" />;`);
      expect(violations).toHaveLength(1);
    });

    it("alt prop is a carousel-slide label ('First slide')", () => {
      const violations = runRule(rule, `const X = <img src="s1.png" alt="First slide" />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/sequential positional label/);
    });

    it("alt prop is a numbered-image label ('Image 3')", () => {
      const violations = runRule(rule, `const X = <img src="i3.png" alt="Image 3" />;`);
      expect(violations).toHaveLength(1);
    });

    it("alt prop restates the src basename ('balloons.gif' / 'balloons')", () => {
      const violations = runRule(rule, `const X = <img src="balloons.gif" alt="balloons" />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/restates the src filename/);
    });

    it("alt prop restates a hyphenated basename, case-insensitive", () => {
      const violations = runRule(
        rule,
        `const X = <img src="/assets/team-photo.jpg" alt="Team Photo" />;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/"team photo"/);
    });
  });

  describe("JSX: does not fire when", () => {
    it("alt prop is a real description", () => {
      const violations = runRule(
        rule,
        `const X = <img src="c.png" alt="Revenue chart showing 220% YoY growth" />;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("alt prop is an expression (runtime value, not statically a placeholder)", () => {
      const violations = runRule(rule, `const X = <img src="x.png" alt={caption} />;`);
      expect(violations).toHaveLength(0);
    });

    it("alt is empty (decorative)", () => {
      const violations = runRule(rule, `const X = <img src="f.png" alt="" />;`);
      expect(violations).toHaveLength(0);
    });

    it("alt prop is descriptive even when basename overlaps", () => {
      const violations = runRule(
        rule,
        `const X = <img src="balloons.gif" alt="Two children playing with balloons" />;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("dynamic src expression is not checked against alt (no static URL evidence)", () => {
      // Parser exposes no string value for `src={imageUrl}`, so the
      // basename check skips. The alt "balloons" matches no other
      // category either.
      const violations = runRule(rule, `const X = <img src={imageUrl} alt="balloons" />;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("alt with leading/trailing whitespace ('  image  ') still matches", () => {
      const violations = runRule(rule, `<img src="x.png" alt="  image  ">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("repetition requires the exact same token (not 'image picture')", () => {
      const violations = runRule(rule, `<img src="x.png" alt="image picture">`, {
        filePath: "index.html",
      });
      // Two different medium words: fails to match any single-word
      // category AND fails the repetition check. We intentionally do
      // not flag composed medium phrases — keeping the rule honest
      // avoids encoding a heuristic about what "basically a medium
      // restatement" looks like.
      expect(violations).toHaveLength(0);
    });

    it("alt='icon' flags (standalone icon word)", () => {
      const violations = runRule(rule, `<img src="x.png" alt="icon">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("alt='home icon' does not flag (descriptive use of 'icon')", () => {
      const violations = runRule(rule, `<img src="x.png" alt="home icon">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("role-noun phrase at the 4-token boundary ('image of Lake Tahoe') still flags", () => {
      // PHRASE_MAX_TOKENS = 4. "image of Lake Tahoe" is exactly 4
      // tokens — within the cap, starts with a role noun followed
      // by `of`, so it matches. The 5+ token form is the long-prose
      // escape hatch.
      const violations = runRule(rule, `<img src="t.png" alt="image of Lake Tahoe">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("'screenshot of …' is intentionally not in the phrase-lead set (conventional usage)", () => {
      // `screenshot of` is canonical descriptive prose ("screenshot
      // of the dashboard") — flagging it would over-fire on real
      // descriptions, so it stays out of PHRASE_LEAD_ROLE_WORDS even
      // though `screenshot` is in MEDIUM_WORDS.
      const violations = runRule(rule, `<img src="s.png" alt="screenshot of dashboard">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });
});
