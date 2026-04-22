import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/expanded-on-disclosure.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/expanded-on-disclosure", () => {
  describe("HTML: fires when", () => {
    it("a <button aria-controls=…> points at an existing id and has no aria-expanded", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button aria-controls="panel-1">Details</button>
          <div id="panel-1" hidden>secret</div>
        </body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/expanded-on-disclosure");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
      expect(violations[0]?.suggestion).toMatch(/aria-expanded="false"/);
      expect(violations[0]?.message).toMatch(
        /aria-controls points at an element with id="panel-1"/,
      );
    });

    it('an <a data-bs-toggle="collapse"> has no aria-expanded (framework-agnostic shape match)', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <a href="#c1" data-bs-toggle="collapse">Toggle</a>
        </body></html>`,
        { filePath: "collapse.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/data-bs-toggle="collapse"/);
    });

    it("a <button onclick=\"el.classList.toggle('collapse')\"> has no aria-expanded", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button onclick="document.getElementById('p').classList.toggle('collapse')">Toggle</button>
        </body></html>`,
        { filePath: "inline.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/inline onclick toggles a visibility class/);
    });

    it('a role="button" span with data-toggle="dropdown" has no aria-expanded', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <span role="button" data-toggle="dropdown">Menu</span>
        </body></html>`,
        { filePath: "role.html" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: does not fire when", () => {
    it('a disclosure trigger already has aria-expanded="false"', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button aria-controls="panel-1" aria-expanded="false">Details</button>
          <div id="panel-1" hidden>x</div>
        </body></html>`,
        { filePath: "ok.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('a disclosure trigger has aria-expanded="true" AND aria-controls pointing to an existing id', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <a href="#c1" aria-controls="c1" data-bs-toggle="collapse" aria-expanded="true">Toggle</a>
          <div id="c1">x</div>
        </body></html>`,
        { filePath: "ok2.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('a plain <a href="/page"> link with no disclosure hints exists', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <a href="/about">About us</a>
        </body></html>`,
        { filePath: "plain-link.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a <button> has aria-controls but the referenced id does not exist in the document", () => {
      // aria-controls alone is not enough evidence if the target is not
      // present — avoids false-positives on ID-less page fragments.
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button aria-controls="nowhere">Details</button>
        </body></html>`,
        { filePath: "dangling.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a <summary> inside <details> has no aria-expanded (native disclosure, exempt)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <details><summary>More</summary><p>Hidden text</p></details>
        </body></html>`,
        { filePath: "details.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('a <button data-bs-toggle="popover"> has no aria-expanded (popovers are tooltip-shaped, not disclosure)', () => {
      // Popovers expose state via role="tooltip" + aria-describedby, not
      // aria-expanded. The disclosure rule must not fire here; popover
      // shape is checked by src/rules/tooltip/dismissable.ts.
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button type="button" data-bs-toggle="popover" data-bs-content="Hello">Open popover</button>
        </body></html>`,
        { filePath: "popover.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('an <a data-bs-toggle="popover"> has no aria-expanded (popover anchor, not disclosure)', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <a href="#" data-bs-toggle="popover" title="Popover title">Link-triggered popover</a>
        </body></html>`,
        { filePath: "popover-anchor.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("a <button aria-controls> targets an in-document id and has no aria-expanded", () => {
      const violations = runRule(
        rule,
        `function Panel() {
           return (
             <>
               <button aria-controls="p1">Details</button>
               <div id="p1" hidden>secret</div>
             </>
           );
         }`,
        { filePath: "Panel.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/aria-expanded="false"/);
    });

    it("an onClick={() => el.classList.toggle('show')} handler on <a> has no aria-expanded", () => {
      const violations = runRule(
        rule,
        `function Toggle() {
           return (
             <a href="#x" onClick={() => document.getElementById('x').classList.toggle('show')}>
               Open
             </a>
           );
         }`,
        { filePath: "Toggle.tsx" },
      );
      expect(violations).toHaveLength(1);
    });

    it('a data-toggle="offcanvas" attribute on <button> has no aria-expanded', () => {
      const violations = runRule(
        rule,
        `function Menu() {
           return <button data-toggle="offcanvas">Menu</button>;
         }`,
        { filePath: "Menu.tsx" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("a PascalCase component uses aria-controls (opaque wrapper, do not recurse)", () => {
      const violations = runRule(
        rule,
        `function App() {
           return <MyDisclosure aria-controls="p1" />;
         }`,
        { filePath: "App.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a <button> has aria-expanded bound to an expression", () => {
      const violations = runRule(
        rule,
        `function Details({ open }) {
           return <button aria-controls="p1" aria-expanded={open}>Details</button>;
         }`,
        { filePath: "Details.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it('a plain <button type="submit"> in a form has no disclosure evidence', () => {
      const violations = runRule(
        rule,
        `function Form() {
           return <button type="submit">Save</button>;
         }`,
        { filePath: "Form.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it('a <button data-bs-toggle="popover"> does not fire (popover is tooltip-shaped)', () => {
      const violations = runRule(
        rule,
        `function Popover() {
           return <button type="button" data-bs-toggle="popover" data-bs-content="Hi">Open</button>;
         }`,
        { filePath: "Popover.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("matches Bootstrap 5's data-bs-toggle AND generic data-toggle with the same rule (shape-based, not vendor)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <a data-bs-toggle="collapse" href="#a">BS5</a>
          <a data-toggle="collapse" href="#b">Generic</a>
          <a data-ui-toggle="collapse" href="#c">CustomLib</a>
        </body></html>`,
        { filePath: "multi.html" },
      );
      expect(violations).toHaveLength(3);
    });

    it('does not fire on data-toggle with a non-disclosure value like data-toggle="buttons"', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <div data-toggle="buttons"><button>Yes</button></div>
        </body></html>`,
        { filePath: "buttons.html" },
      );
      // The <button> inside has no disclosure hints; the outer div is not
      // interactive. The `data-toggle="buttons"` value is not in the
      // disclosure set, so the predicate should not fire.
      expect(violations).toHaveLength(0);
    });

    it("fires on Bootstrap-canonical dropdown: aria-expanded present, data-bs-toggle=dropdown, no aria-controls", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button data-bs-toggle="dropdown" aria-expanded="false">Menu</button>
        </body></html>`,
        { filePath: "bs-dropdown.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/missing aria-controls/);
      expect(violations[0]?.suggestion).toMatch(/aria-controls="<id>"/);
    });

    it("fires on JSX Bootstrap dropdown: aria-expanded present, data-bs-toggle=dropdown, no aria-controls", () => {
      const violations = runRule(
        rule,
        `function Dropdown() {
           return <button data-bs-toggle="dropdown" aria-expanded="false">Menu</button>;
         }`,
        { filePath: "Dropdown.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/missing aria-controls/);
    });

    it("does not fire when aria-expanded is present and aria-controls points to an existing id (pattern complete)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button aria-expanded="false" aria-controls="m1" data-bs-toggle="dropdown">Menu</button>
          <ul id="m1"><li>item</li></ul>
        </body></html>`,
        { filePath: "complete.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("is robust to aria-controls with leading/trailing whitespace", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button aria-controls="  panel-1  ">Details</button>
          <div id="panel-1">x</div>
        </body></html>`,
        { filePath: "ws.html" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("reason-text enrichment (visually-hidden label child / inline aria-label)", () => {
    it('appends a note when a <button data-bs-toggle="collapse"> has a <span class="sr-only"> child', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#nav">
            <span class="navbar-toggler-icon"></span>
            <span class="sr-only">Toggle navigation</span>
          </button>
        </body></html>`,
        { filePath: "collapse.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/visually-hidden text child \(\.sr-only\)/);
      expect(violations[0]?.message).toMatch(
        /if that is the disclosure label, verify the accessible name is complete/,
      );
      expect(violations[0]?.suggestion).toMatch(/visually-hidden text child \(\.sr-only\)/);
    });

    it("appends a note for a .visually-hidden child on an HTML disclosure trigger", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <a href="#m" data-bs-toggle="collapse">
            <i class="bi bi-list"></i>
            <span class="visually-hidden">Open menu</span>
          </a>
        </body></html>`,
        { filePath: "visually-hidden.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/visually-hidden text child \(\.visually-hidden\)/);
    });

    it("appends a note when the disclosure trigger carries an inline aria-label", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button aria-label="Open menu" data-bs-toggle="collapse" data-bs-target="#m"></button>
        </body></html>`,
        { filePath: "aria-label.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/an inline aria-label/);
      expect(violations[0]?.message).toMatch(/verify the accessible name is complete/);
    });

    it("combines both signals when the element has both aria-label AND a hidden child", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button aria-label="Toggle" data-bs-toggle="collapse" data-bs-target="#m">
            <span class="sr-only">Toggle navigation</span>
          </button>
        </body></html>`,
        { filePath: "both.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/visually-hidden text child/);
      expect(violations[0]?.message).toMatch(/aria-label/);
    });

    it("enriches the Bootstrap-canonical missing-aria-controls finding when a .sr-only child is present", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button data-bs-toggle="dropdown" aria-expanded="false">
            <span class="sr-only">Open user menu</span>
          </button>
        </body></html>`,
        { filePath: "bs-dropdown-sr.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/missing aria-controls/);
      expect(violations[0]?.message).toMatch(/visually-hidden text child \(\.sr-only\)/);
    });

    it("omits the enrichment note when no label evidence is present (present-when-meaningful)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button data-bs-toggle="collapse" data-bs-target="#m">Toggle</button>
        </body></html>`,
        { filePath: "no-label.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).not.toMatch(/note: element has/);
      expect(violations[0]?.suggestion).not.toMatch(/note: element has/);
    });

    it("does not enrich when a deep descendant (not a direct child) carries the visually-hidden token", () => {
      // The label heuristic is direct-child-only: a grandchild carrying
      // the token is not reliably the disclosure label, and the agent
      // can read the file to confirm. Per doctrine, we point — we don't
      // duplicate capability the agent already has.
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <button data-bs-toggle="collapse" data-bs-target="#m">
            <span class="wrapper"><span class="sr-only">Toggle</span></span>
          </button>
        </body></html>`,
        { filePath: "deep.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).not.toMatch(/note: element has/);
    });

    it('enriches a JSX trigger with a <span className="sr-only"> child', () => {
      const violations = runRule(
        rule,
        `function Toggle() {
           return (
             <button data-bs-toggle="collapse" data-bs-target="#m">
               <span className="sr-only">Toggle navigation</span>
             </button>
           );
         }`,
        { filePath: "Toggle.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/visually-hidden text child \(\.sr-only\)/);
    });

    it("enriches a JSX trigger with a literal aria-label", () => {
      const violations = runRule(
        rule,
        `function Menu() {
           return <button aria-label="Open menu" data-bs-toggle="collapse" data-bs-target="#m" />;
         }`,
        { filePath: "Menu.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/an inline aria-label/);
    });

    it("does not enrich when className is a dynamic expression (points, doesn't duplicate agent capability)", () => {
      const violations = runRule(
        rule,
        `function Toggle() {
           const hiddenCls = "sr-only";
           return (
             <button data-bs-toggle="collapse" data-bs-target="#m">
               <span className={hiddenCls}>Toggle</span>
             </button>
           );
         }`,
        { filePath: "Dynamic.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).not.toMatch(/note: element has/);
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:4.1.2 and wcag21:4.1.2 in satisfies", () => {
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
    });

    it("cites WCAG 2.2 in references and has a normativeQuote", () => {
      expect(rule.docs.normativeQuote).toBeDefined();
      expect(rule.docs.normativeQuote?.length ?? 0).toBeGreaterThan(0);
      expect(rule.docs.references.some((r) => r.includes("WCAG22"))).toBe(true);
    });

    it('is a mechanical fix class (aria-expanded="false" is a safe initial value)', () => {
      expect(rule.fixClass).toBe("mechanical");
    });
  });
});
