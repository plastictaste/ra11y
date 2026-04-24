import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/button-name.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/button-name", () => {
  describe("HTML: fires when", () => {
    it("button is empty", () => {
      const violations = runRule(rule, `<button></button>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/button-name");
      expect(violations[0]?.severity).toBe("error");
    });

    it("button contains only whitespace", () => {
      const violations = runRule(rule, `<button>   </button>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
    });

    it("icon-only button has no aria-label", () => {
      const violations = runRule(rule, `<button><svg></svg></button>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("input type=button has empty value", () => {
      const violations = runRule(rule, `<input type="button" value="">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("role=button div has no accessible name", () => {
      const violations = runRule(rule, `<div role="button" tabindex="0"></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: does not fire when", () => {
    it("button has visible text", () => {
      const violations = runRule(rule, `<button>Save</button>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("icon-only button has aria-label", () => {
      const violations = runRule(rule, `<button aria-label="Close"><svg></svg></button>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("button has aria-labelledby", () => {
      const violations = runRule(rule, `<button aria-labelledby="h1"><svg></svg></button>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("input type=submit has value", () => {
      const violations = runRule(rule, `<input type="submit" value="Send">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("input type=submit with empty value uses UA default (Submit)", () => {
      // type=submit/reset have a UA-default name per HTML spec. False-
      // negative vs strict interpretation, but matches ARIA's behavior.
      const violations = runRule(rule, `<input type="submit">`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("button wraps an <img> with alt text", () => {
      const violations = runRule(rule, `<button><img src="x.png" alt="Close"></button>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("non-button, non-role=button elements are ignored", () => {
      const violations = runRule(rule, `<div></div>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("button with SVG <title> child is accessibly named (V1-DETECT-BUTTON-NAME-SVG)", () => {
      const v = runRule(rule, `<button><svg><title>Close dialog</title></svg></button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("button with SVG <text> child is accessibly named", () => {
      const v = runRule(rule, `<button><svg><text>Close</text></svg></button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("button with SVG <title> nested under <g> is accessibly named", () => {
      const v = runRule(rule, `<button><svg><g><title>Close</title></g></svg></button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("role=button with SVG <title> descendant is accessibly named", () => {
      const v = runRule(
        rule,
        `<div role="button" tabindex="0"><svg><title>Close</title></svg></div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("button with empty SVG still fires (no <title>/<text> text)", () => {
      const v = runRule(rule, `<button><svg><circle /></svg></button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });
  });

  describe('HTML: <input type="image"> (V1-DETECT-BUTTON-NAME-IMAGE-INPUT)', () => {
    it("fires when image input has no accessible name", () => {
      const v = runRule(rule, `<input type="image" src="submit.png">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.ruleId).toBe("semantics/button-name");
    });

    it("fires when image input has empty alt", () => {
      const v = runRule(rule, `<input type="image" src="submit.png" alt="">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });

    it("does not fire when image input has alt", () => {
      const v = runRule(rule, `<input type="image" src="submit.png" alt="Submit">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("does not fire when image input has title", () => {
      const v = runRule(rule, `<input type="image" src="submit.png" title="Submit">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("does not fire when image input has aria-label", () => {
      const v = runRule(rule, `<input type="image" src="submit.png" aria-label="Submit">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("does not fire when image input has aria-labelledby", () => {
      const v = runRule(rule, `<input type="image" src="s.png" aria-labelledby="lbl">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("fires when image input only has `value` (not a name source for type=image)", () => {
      // Per HTML §4.10.5.1.18, `value` is not an accessible-name source
      // for <input type="image"> — it is submitted as form data, not
      // rendered or announced. Only `alt`, aria-*, and `title` count.
      const v = runRule(rule, `<input type="image" src="s.png" value="Submit">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });
  });

  describe("JSX: fires when", () => {
    it("icon-only button has no aria-label", () => {
      const violations = runRule(rule, `const X = <button><Icon /></button>;`);
      // The <Icon /> is PascalCase so we treat it as potentially having its
      // own accessible name. False-negative we accept.
      expect(violations).toHaveLength(0);
    });

    it("empty button", () => {
      const violations = runRule(rule, `const X = <button />;`);
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("button has text content", () => {
      const violations = runRule(rule, `const X = <button>Save</button>;`);
      expect(violations).toHaveLength(0);
    });

    it("button has aria-label", () => {
      const violations = runRule(rule, `const X = <button aria-label="Close" />;`);
      expect(violations).toHaveLength(0);
    });

    it("button has runtime-valued aria-label", () => {
      const violations = runRule(rule, `const X = <button aria-label={t('close')} />;`);
      expect(violations).toHaveLength(0);
    });

    it("button has SVG <title> descendant (V1-DETECT-BUTTON-NAME-SVG)", () => {
      const v = runRule(rule, `const X = <button><svg><title>Close</title></svg></button>;`);
      expect(v).toHaveLength(0);
    });

    it("button has SVG <text> descendant", () => {
      const v = runRule(rule, `const X = <button><svg><text>Close</text></svg></button>;`);
      expect(v).toHaveLength(0);
    });
  });

  describe('JSX: <input type="image"> (V1-DETECT-BUTTON-NAME-IMAGE-INPUT)', () => {
    it("fires when image input has no accessible name", () => {
      const v = runRule(rule, `const X = <input type="image" src="s.png" />;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.ruleId).toBe("semantics/button-name");
    });

    it("fires when image input only has `value` (not a name source)", () => {
      const v = runRule(rule, `const X = <input type="image" src="s.png" value="Submit" />;`);
      expect(v).toHaveLength(1);
    });

    it("does not fire when image input has alt", () => {
      const v = runRule(rule, `const X = <input type="image" src="s.png" alt="Submit" />;`);
      expect(v).toHaveLength(0);
    });

    it("does not fire when image input has runtime alt={x}", () => {
      const v = runRule(rule, `const X = <input type="image" src="s.png" alt={label} />;`);
      expect(v).toHaveLength(0);
    });

    it("does not fire when image input has aria-label", () => {
      const v = runRule(rule, `const X = <input type="image" src="s.png" aria-label="Submit" />;`);
      expect(v).toHaveLength(0);
    });

    it("does not fire when image input has title", () => {
      const v = runRule(rule, `const X = <input type="image" src="s.png" title="Submit" />;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX: primitive component (info, not error)", () => {
    it("unnamed <button> with spread props emits info", () => {
      const v = runRule(rule, `const Btn = (props) => <button {...props} />;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain("spread");
    });

    it('<div role="button"> with spread props emits info', () => {
      const v = runRule(rule, `const DropIndicator = (props) => <div role="button" {...props} />;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
    });

    it("unnamed <button> without spread stays an error", () => {
      const v = runRule(rule, `const X = <button />;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });
  });

  describe("fix suggestions are context-aware (V1-FIX-BUTTON-NAME)", () => {
    it("button wrapping <svg> (no title) names <title> + aria-label fixes by shell kind", () => {
      const v = runRule(rule, `<button><svg><circle /></svg></button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      // Must cite the actual icon shell (<svg>) and both fix paths.
      expect(suggestion).toContain("<svg>");
      expect(suggestion).toContain("<title>");
      expect(suggestion).toContain("aria-label");
      // Must NOT fall back to the generic <button>Close</button> text.
      expect(suggestion).not.toContain("Add visible text");
    });

    it("button wrapping <img> inlines filename-derived subject", () => {
      const v = runRule(rule, `<button><img src="icons/trash-bin.png"></button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      // Derived subject "Trash Bin" is the name hint the agent needs.
      expect(suggestion).toContain("Trash Bin");
      expect(suggestion).toContain("alt=");
      expect(suggestion).toContain("aria-label=");
    });

    it("empty <button> fallback suggests visible text with the host tag", () => {
      const v = runRule(rule, `<button></button>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      expect(suggestion).toContain("Add visible text");
      expect(suggestion).toContain("<button>Close</button>");
      // Must NOT mention wrapping an <img> or <svg> — nothing was wrapped.
      expect(suggestion).not.toContain("wraps an <img>");
      expect(suggestion).not.toContain("wraps an <svg>");
    });

    it('<input type="image"> fix text names alt/title/aria-label and never suggests nested text', () => {
      const v = runRule(rule, `<input type="image" src="icons/submit.png">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      // It IS the image — don't describe it as "wraps an <img>".
      expect(suggestion).not.toContain("wraps an <img>");
      // Don't recommend nested text children — <input> is void.
      expect(suggestion).not.toContain("Add visible text");
      // Must name the valid name sources per HTML §4.10.5.1.18.
      expect(suggestion).toContain("alt=");
      expect(suggestion).toContain("aria-label=");
      // Should surface the filename-derived subject hint.
      expect(suggestion).toContain("Submit");
    });

    it('<input type="image"> with no src still names alt/aria-label, not nested children', () => {
      const v = runRule(rule, `<input type="image">`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      expect(suggestion).not.toContain("Add visible text");
      expect(suggestion).not.toContain("wraps an <img>");
      expect(suggestion).toContain("alt=");
      expect(suggestion).toContain("aria-label=");
    });

    it('<input type="submit"> with empty value suggests value= / aria-label, not nested children', () => {
      const v = runRule(rule, `<input type="button" value="">`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      // Input controls cannot contain text children — must not say so.
      expect(suggestion).not.toContain("Add visible text");
      expect(suggestion).toContain("value=");
      expect(suggestion).toContain("aria-label=");
    });

    it('JSX <input type="image"> with src inlines filename-derived subject', () => {
      const v = runRule(rule, `const X = <input type="image" src="icons/submit.png" />;`);
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      expect(suggestion).not.toContain("wraps an <img>");
      expect(suggestion).not.toContain("Add visible text");
      expect(suggestion).toContain("Submit");
      expect(suggestion).toContain("alt=");
      expect(suggestion).toContain("aria-label=");
    });

    it("JSX empty <button /> fallback does not reference wrapped img/svg", () => {
      const v = runRule(rule, `const X = <button />;`);
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      expect(suggestion).toContain("Add visible text");
      expect(suggestion).not.toContain("wraps an <img>");
      expect(suggestion).not.toContain("wraps an <svg>");
    });
  });

  describe("Font Awesome glyph-derived fix text (Q5-BUTTON-NAME-ICON-GLYPH-MAP)", () => {
    it('button wrapping <i class="fa-bars"> suggests aria-label="Menu" as primary', () => {
      const v = runRule(rule, `<button><i class="fa-bars"></i></button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      // Primary fix names the glyph-derived label.
      expect(suggestion).toContain('aria-label="Menu"');
      expect(suggestion).toContain("fa-bars");
      // Secondary fix path — visible text — is still mentioned.
      expect(suggestion).toContain("visible text");
      // Must echo the button host so the agent can apply the edit.
      expect(suggestion).toContain("<button>");
      // Must NOT fall back to the generic "<button>Close</button>" placeholder.
      expect(suggestion).not.toContain("<button>Close</button>");
    });

    it('fa-times and fa-xmark both map to "Close" (FA4→FA6 rename preserved)', () => {
      const times = runRule(rule, `<button><i class="fas fa-times"></i></button>`, {
        filePath: "index.html",
      });
      expect(times[0]?.suggestion).toContain('aria-label="Close"');
      const xmark = runRule(rule, `<button><i class="fa-solid fa-xmark"></i></button>`, {
        filePath: "index.html",
      });
      expect(xmark[0]?.suggestion).toContain('aria-label="Close"');
    });

    it("fa-arrow-left → Previous, fa-arrow-right → Next", () => {
      const prev = runRule(rule, `<button><i class="fa fa-arrow-left"></i></button>`, {
        filePath: "index.html",
      });
      expect(prev[0]?.suggestion).toContain('aria-label="Previous"');
      const next = runRule(rule, `<button><i class="fa fa-arrow-right"></i></button>`, {
        filePath: "index.html",
      });
      expect(next[0]?.suggestion).toContain('aria-label="Next"');
    });

    it('fa-search and fa-magnifying-glass both map to "Search"', () => {
      const s1 = runRule(rule, `<button><i class="fa fa-search"></i></button>`, {
        filePath: "index.html",
      });
      expect(s1[0]?.suggestion).toContain('aria-label="Search"');
      const s2 = runRule(rule, `<button><i class="fa-solid fa-magnifying-glass"></i></button>`, {
        filePath: "index.html",
      });
      expect(s2[0]?.suggestion).toContain('aria-label="Search"');
    });

    it("fa-bell → Notifications, fa-user → Account", () => {
      const bell = runRule(rule, `<button><i class="fa fa-bell"></i></button>`, {
        filePath: "index.html",
      });
      expect(bell[0]?.suggestion).toContain('aria-label="Notifications"');
      const user = runRule(rule, `<button><i class="fa fa-user"></i></button>`, {
        filePath: "index.html",
      });
      expect(user[0]?.suggestion).toContain('aria-label="Account"');
    });

    it("unknown glyph (fa-flux-capacitor) keeps the generic empty-button fix primary", () => {
      // Doctrine: no heuristic suppression. When the map doesn't speak
      // for the glyph, we do not invent a label — the existing generic
      // fix stays primary and the agent decides from surrounding code.
      const v = runRule(rule, `<button><i class="fa fa-flux-capacitor"></i></button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      // Falls back to the "empty" branch — must mention <button>Close</button>
      // placeholder, not invent an aria-label.
      expect(suggestion).toContain("<button>Close</button>");
      expect(suggestion).not.toContain("fa-flux-capacitor");
    });

    it('role="button" div wrapping fa-bars glyph gets the same glyph-derived fix', () => {
      const v = runRule(rule, `<div role="button" tabindex="0"><i class="fa fa-bars"></i></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain('aria-label="Menu"');
    });

    it('mentions aria-hidden="true" on the inner <i> so AT doesn\'t double-announce', () => {
      // Pairs with aria/icon-font-hidden — once the <button> has a label,
      // the icon should carry aria-hidden="true" to silence AT duplication.
      const v = runRule(rule, `<button><i class="fa-bars"></i></button>`, {
        filePath: "index.html",
      });
      expect(v[0]?.suggestion).toContain('aria-hidden="true"');
    });

    it('JSX: button wrapping <i className="fa-bars"> is not (yet) detected (existing heuristic)', () => {
      // The JSX path's jsxHasContentChildren heuristic treats any
      // JsxElement child as evidence the button has a name — so this
      // doesn't fire today. Pinning this gap here documents that the
      // icon-glyph fix-text change is HTML-only for now; widening JSX
      // detection is a separate backlog change.
      const v = runRule(rule, `const X = <button><i className="fa-bars"></i></button>;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:4.1.2 and wcag21:4.1.2", () => {
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
    });
  });

  // V1-LIQUID-TEMPLATE-EXPRESSION-AS-SOLE-CHILD-REASON-ENRICHMENT:
  // a `<button>{{ t.submit }}</button>` has its only child stripped by
  // the HTML parser — static analysis sees "no accessible name," but
  // the rendered output is whatever the Liquid expression evaluates
  // to. Surface-don't-suppress: finding still emits at `error`; reason
  // text carries the template_directive_stripped signal.
  describe("HTML: template-directive enrichment", () => {
    it("enriches reason when <button> sole child is a Liquid interpolation", () => {
      const v = runRule(rule, `<button>{{ t.submit }}</button>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("template expression");
      expect(v[0]?.message).toContain("ra11y-disable");
    });

    it("enriches reason when role=button sole child is a Liquid tag", () => {
      const v = runRule(rule, `<div role="button">{% t "submit" %}</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("template expression");
    });

    it("does NOT enrich reason when <button> is plainly empty", () => {
      const v = runRule(rule, `<button></button>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).not.toContain("template expression");
    });
  });

  describe("nativeWrapperElements mapping (Q2-WRAPMAP-RULES)", () => {
    it("opts in to the native `button` tag so mapped wrappers fire", () => {
      expect(rule.wrapperTreatsAsElement).toBe("button");
    });

    it("fires on a wrapper declared to render `<button>` via the mapping with no name", () => {
      const v = runRule(rule, `const X = <IconButton />;`, {
        nativeWrapperElements: { IconButton: "button" },
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.ruleId).toBe("semantics/button-name");
    });

    it("silences when the mapped wrapper call site has aria-label", () => {
      const v = runRule(rule, `const X = <IconButton aria-label="Close" />;`, {
        nativeWrapperElements: { IconButton: "button" },
      });
      expect(v).toHaveLength(0);
    });

    it("does not fire on an unmapped PascalCase component", () => {
      const v = runRule(rule, `const X = <UnknownButton />;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("polymorphic as/asChild resolution (Q2R2-POLYMORPHIC)", () => {
    it('fires on <Box as="button" /> with no accessible name', () => {
      const v = runRule(rule, `const X = <Box as="button" />;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.ruleId).toBe("semantics/button-name");
    });

    it('does not fire when polymorphic `as="button"` call site supplies aria-label', () => {
      const v = runRule(rule, `const X = <Box as="button" aria-label="Close" />;`);
      expect(v).toHaveLength(0);
    });

    it('does not fire when polymorphic `as="button"` has visible text children', () => {
      const v = runRule(rule, `const X = <Box as="button">Save</Box>;`);
      expect(v).toHaveLength(0);
    });

    it("fires on <Slot asChild><button /></Slot> — inner button has no name", () => {
      // Both the inner <button> and the <Slot asChild> call site fail the
      // accessible-name check independently. Two surfaces are honest per
      // AI-first doctrine — the agent dismisses duplicates in one read.
      const v = runRule(rule, `const X = <Slot asChild><button /></Slot>;`);
      expect(v.length).toBeGreaterThanOrEqual(1);
      expect(v[0]?.ruleId).toBe("semantics/button-name");
    });

    it("does not re-dispatch when `as` is a non-literal expression (honest — agent reads)", () => {
      const v = runRule(rule, `const X = <Box as={tag} />;`);
      expect(v).toHaveLength(0);
    });

    it('does not re-dispatch when `as="div"` resolves to a non-target tag', () => {
      const v = runRule(rule, `const X = <Box as="div" />;`);
      expect(v).toHaveLength(0);
    });

    it("does not re-dispatch when `as` is absent", () => {
      const v = runRule(rule, `const X = <Box />;`);
      expect(v).toHaveLength(0);
    });
  });
});
