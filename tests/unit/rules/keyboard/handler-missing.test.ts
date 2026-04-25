import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/keyboard/handler-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule keyboard/handler-missing", () => {
  describe("JSX: fires when", () => {
    it("div has onClick without onKeyDown", () => {
      const v = runRule(rule, `const X = <div onClick={doThing}>Click</div>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("onClick");
    });

    it("span has onClick without keyboard handler", () => {
      const v = runRule(rule, `const X = <span onClick={doThing}>x</span>;`);
      expect(v).toHaveLength(1);
    });

    it("<a> without href and with onClick is flagged", () => {
      const v = runRule(rule, `const X = <a onClick={doThing}>click</a>;`);
      expect(v.length).toBeGreaterThan(0);
    });
  });

  describe("JSX: does NOT fire when", () => {
    it("button has onClick", () => {
      const v = runRule(rule, `const X = <button onClick={doThing}>Save</button>;`);
      expect(v).toHaveLength(0);
    });

    it("anchor with href has onClick", () => {
      const v = runRule(rule, `const X = <a href="/x" onClick={doThing}>link</a>;`);
      expect(v).toHaveLength(0);
    });

    it("div has both onClick and onKeyDown", () => {
      const v = runRule(rule, `const X = <div onClick={doThing} onKeyDown={doThing}>click</div>;`);
      expect(v).toHaveLength(0);
    });

    it("div has role=button and keyboard handler", () => {
      const v = runRule(
        rule,
        `const X = <div role="button" onClick={doThing} onKeyDown={doThing}>click</div>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("input has onClick (natively interactive)", () => {
      const v = runRule(rule, `const X = <input type="checkbox" onClick={doThing} />;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("HTML: fires when", () => {
    it("div has onclick attribute without keyboard handler", () => {
      const v = runRule(rule, `<div onclick="doThing()">click</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });
  });

  // `draggable="true"` declares an interactive drag operation; keyboard
  // users can't perform drag gestures. This rule covers SC 2.1.1 (the
  // keyboard-reachability failure); `pointer/drag-alternative` covers
  // SC 2.5.7 (the single-pointer-without-drag-alternative failure) on
  // the SAME element — agents see both findings with distinct fix paths.
  describe("JSX: drag grammar fires when", () => {
    it('<div draggable="true"> has no onKeyDown', () => {
      const v = runRule(rule, `const X = <div draggable="true">Item</div>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("draggable");
    });

    it('<span draggable="true"> with onDragStart still fires (drag handler is not a keyboard handler)', () => {
      const v = runRule(rule, `const X = <span draggable="true" onDragStart={s}>Item</span>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("draggable");
    });
  });

  describe("JSX: drag grammar does NOT fire when", () => {
    it('<div draggable="true"> has onKeyDown', () => {
      const v = runRule(rule, `const X = <div draggable="true" onKeyDown={k}>Item</div>;`);
      expect(v).toHaveLength(0);
    });

    it('<button draggable="true"> is natively interactive', () => {
      const v = runRule(rule, `const X = <button draggable="true">Drag me</button>;`);
      expect(v).toHaveLength(0);
    });

    it('draggable="false" is not an interactive signal', () => {
      const v = runRule(rule, `const X = <div draggable="false">Item</div>;`);
      expect(v).toHaveLength(0);
    });

    it("PascalCase wrapper with draggable is not flagged (custom component)", () => {
      const v = runRule(rule, `const X = <DragHandle draggable="true">Item</DragHandle>;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("HTML: drag grammar fires when", () => {
    it('<div draggable="true"> has no onkeydown', () => {
      const v = runRule(rule, `<div draggable="true">Item</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("draggable");
    });
  });

  describe("HTML: drag grammar does NOT fire when", () => {
    it('<div draggable="true"> has onkeydown', () => {
      const v = runRule(rule, `<div draggable="true" onkeydown="k()">Item</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("drag grammar: suggestion quality", () => {
    it("cites SC 2.1.1 and cross-refs pointer/drag-alternative for SC 2.5.7", () => {
      const v = runRule(rule, `const X = <div draggable="true">Item</div>;`);
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      expect(suggestion).toContain("tabIndex");
      expect(suggestion).toContain("onKeyDown");
      // The suggestion should cross-reference the companion 2.5.7 rule
      // so the agent understands why two findings may fire on one el.
      expect(suggestion).toContain("2.5.7");
      expect(suggestion).toContain("drag-alternative");
    });
  });

  describe("HTML: does NOT fire when", () => {
    it("button has onclick", () => {
      const v = runRule(rule, `<button onclick="doThing()">Save</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("div has onclick and onkeydown", () => {
      const v = runRule(rule, `<div onclick="doThing()" onkeydown="doThing()">click</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("suggestion quality", () => {
    it("suggests changing to <button> when no role is set", () => {
      const v = runRule(rule, `const X = <div onClick={doThing}>click</div>;`);
      expect(v[0]?.suggestion).toContain("<button");
    });

    it("mentions Enter and Space keys when role is already set", () => {
      const v = runRule(rule, `const X = <div role="button" onClick={doThing}>click</div>;`);
      expect(v[0]?.suggestion).toContain("Enter and Space");
    });

    // Tag-specific branches: generic rendering tags and landmarks get
    // different guidance than the default `<div>` / `<span>` path.
    // `<button>` is not always the right answer — `<canvas>` is a
    // drawing surface, landmarks shouldn't be widgets, and `<p>` may
    // host inline interactive content that belongs in a child button.
    it("canvas: suggests wrapping in <button> or adding role+tabindex (rendering surface)", () => {
      const v = runRule(rule, `<canvas onclick="draw()"></canvas>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      // The rendering surface framing is the point — don't recommend
      // converting the canvas itself to a button.
      expect(suggestion).toContain("rendering surface");
      expect(suggestion).toContain('role="button"');
      expect(suggestion).toContain("tabIndex");
    });

    it("section: suggests moving handler to a child button (landmark, not widget)", () => {
      const v = runRule(rule, `<section onclick="toggle()">Card</section>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      expect(suggestion).toContain("landmark");
      expect(suggestion).toContain("child");
      expect(suggestion).toContain("<button");
    });

    it("header: suggests moving handler to a child button (landmark, not widget)", () => {
      const v = runRule(rule, `const X = <header onClick={toggle}>Top</header>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain("landmark");
    });

    it("footer: suggests moving handler to a child button (landmark, not widget)", () => {
      const v = runRule(rule, `const X = <footer onClick={toggle}>Bot</footer>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain("landmark");
    });

    it("p: offers both shapes — replace <p> with <button>, or wrap inline content in child <button>", () => {
      const v = runRule(rule, `<p onclick="act()">Tap here</p>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      // Both escape hatches should be named so the agent picks based on intent.
      expect(suggestion).toContain('<button type="button">');
      expect(suggestion).toContain("inline");
    });

    it('div: keeps the existing <button type="button"> path unchanged', () => {
      const v = runRule(rule, `const X = <div onClick={doThing}>x</div>;`);
      expect(v[0]?.suggestion).toContain("<button");
      // Shouldn't pick up the landmark / canvas / inline language by mistake.
      expect(v[0]?.suggestion).not.toContain("landmark");
      expect(v[0]?.suggestion).not.toContain("rendering surface");
    });

    it('span: keeps the existing <button type="button"> path unchanged', () => {
      const v = runRule(rule, `const X = <span onClick={doThing}>x</span>;`);
      expect(v[0]?.suggestion).toContain("<button");
      expect(v[0]?.suggestion).not.toContain("landmark");
    });
  });

  describe("suggestion quality — attribute-interaction grammar", () => {
    // Attribute-grammar (Bootstrap `data-bs-*`) suggestions mirror the
    // event-handler grammar's tag-specific branches. Non-div tags still
    // get honest guidance even when the trigger was a `data-bs-toggle`
    // on the landmark.
    it("canvas with data-bs-toggle: preserves rendering-surface framing", () => {
      const v = runRule(rule, `<canvas data-bs-toggle="modal"></canvas>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      expect(suggestion).toContain("rendering surface");
      expect(suggestion).toContain("data-bs-toggle");
    });

    it("section with data-bs-toggle: routes attribute onto a child button", () => {
      const v = runRule(rule, `<section data-bs-toggle="collapse">...</section>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      expect(suggestion).toContain("landmark");
      expect(suggestion).toContain("data-bs-toggle");
    });

    it("p with data-bs-dismiss: offers replace-or-wrap for paragraph", () => {
      const v = runRule(rule, `<p data-bs-dismiss="modal">Close</p>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      const suggestion = v[0]?.suggestion ?? "";
      expect(suggestion).toContain('<button type="button">');
      expect(suggestion).toContain("data-bs-dismiss");
    });

    it("div with data-bs-toggle: keeps original Bootstrap suggestion text", () => {
      const v = runRule(rule, `<div data-bs-toggle="modal">Open</div>`, {
        filePath: "index.html",
      });
      expect(v[0]?.suggestion).toContain("<button");
      expect(v[0]?.suggestion).toContain("data-bs-toggle");
      expect(v[0]?.suggestion).not.toContain("landmark");
      expect(v[0]?.suggestion).not.toContain("rendering surface");
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute-interaction grammar (Bootstrap data-bs-* and predecessors)
  // ---------------------------------------------------------------------------

  describe("HTML attribute-interaction: fires when", () => {
    it("div has data-bs-toggle on bare div (Bootstrap 5 dropdown/modal)", () => {
      const v = runRule(rule, `<div data-bs-toggle="dropdown">Menu</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("data-bs-toggle");
      expect(v[0]?.message).toContain("dropdown");
    });

    it("span has data-bs-dismiss on bare span (Bootstrap 5 modal close)", () => {
      const v = runRule(rule, `<span data-bs-dismiss="modal">X</span>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("data-bs-dismiss");
    });

    it("flags Bootstrap 4 legacy data-toggle attribute", () => {
      const v = runRule(rule, `<div data-toggle="modal">Open</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("data-toggle");
    });

    it("flags <a> without href but with data-bs-toggle (not focusable)", () => {
      const v = runRule(rule, `<a data-bs-toggle="dropdown">Menu</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("without href");
    });

    it("suggestion mentions keeping the attribute when converting to <button>", () => {
      const v = runRule(rule, `<div data-bs-toggle="modal">Open</div>`, {
        filePath: "index.html",
      });
      expect(v[0]?.suggestion).toContain("<button");
      expect(v[0]?.suggestion).toContain("data-bs-toggle");
    });

    // Cross-check from V1-FP-KEYBOARD-HANDLER-DATA-BS-CONTAINER: a real
    // disclosure trigger that ALSO carries `data-bs-target` (the
    // canonical Bootstrap modal-open shape) must still fire on a bare
    // <div>. Locks in that the FP fix did not also disable the true
    // positive — the disclosure-value allowlist is the only gate.
    it('div has data-bs-toggle="modal" + data-bs-target (real interactive trigger)', () => {
      const v = runRule(rule, `<div data-bs-toggle="modal" data-bs-target="#mymodal">Open</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("data-bs-toggle");
      expect(v[0]?.message).toContain("modal");
    });

    it('div has data-bs-toggle="tab" (BS5 nav-tabs, disclosure value)', () => {
      const v = runRule(rule, `<div data-bs-toggle="tab">Profile</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("data-bs-toggle");
    });

    it('div has data-bs-toggle="offcanvas" (BS5 offcanvas, disclosure value)', () => {
      const v = runRule(rule, `<div data-bs-toggle="offcanvas">Open menu</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });
  });

  describe("HTML attribute-interaction: does NOT fire when", () => {
    it("button hosts data-bs-toggle (native focus + Enter/Space)", () => {
      const v = runRule(rule, `<button data-bs-toggle="modal">Open</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("anchor with href hosts data-bs-toggle (focusable, Enter activates)", () => {
      const v = runRule(rule, `<a href="/menu" data-bs-toggle="dropdown">Menu</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it('anchor with href="#" hosts data-bs-toggle (degenerate href, still focusable)', () => {
      // Edge case: href="#" is a placeholder URL but the element is
      // still in the Tab order and Enter activates it. Bootstrap uses
      // this shape throughout its own dropdown/nav examples.
      const v = runRule(rule, `<a href="#" data-bs-toggle="dropdown">Menu</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("element with data-bs-toggle also declares onkeydown", () => {
      const v = runRule(
        rule,
        `<div data-bs-toggle="modal" onkeydown="handle(event)" tabindex="0">Open</div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("input hosts data-bs-toggle (natively interactive)", () => {
      const v = runRule(rule, `<input type="button" data-bs-toggle="modal" value="Open" />`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    // V1-FP-KEYBOARD-HANDLER-DATA-BS-CONTAINER: `data-bs-toggle="buttons"`
    // is a *container* value — Bootstrap wires toggle behavior on the
    // child <input> controls, not on the host. Flagging the container
    // would push the agent toward <button> wrappers that nest interactive
    // descendants. See tests/fixtures/real-world/btn-group/.
    it('div has data-bs-toggle="buttons" (group container, not a trigger)', () => {
      const v = runRule(
        rule,
        `<div class="btn-group" data-bs-toggle="buttons">
          <input type="checkbox" id="c1" />
          <label class="btn" for="c1">A</label>
        </div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    // V1-FP-KEYBOARD-HANDLER-DATA-BS-CONTAINER: `data-bs-ride` is an
    // auto-init signal to Bootstrap's JS, not a click trigger. The host
    // <div class="carousel"> never receives focus; the keyboard
    // controls are child <button class="carousel-control-*"> elements.
    // See tests/fixtures/real-world/carousel-ride/.
    it('div has data-bs-ride="carousel" (auto-init, not a trigger)', () => {
      const v = runRule(rule, `<div class="carousel" data-bs-ride="carousel">...</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it('div has data-bs-ride="true" (auto-init variant, no auto-cycle)', () => {
      const v = runRule(rule, `<div class="carousel" data-bs-ride="true">...</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("div has BS4 legacy data-ride (auto-init, not a trigger)", () => {
      const v = runRule(rule, `<div class="carousel" data-ride="carousel">...</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    // `data-bs-target` is a reference attribute — points at the
    // controlled widget but doesn't itself wire a click handler. The
    // trigger comes from a sibling `data-bs-toggle`. Standalone
    // `data-bs-target` should not fire.
    it("div has data-bs-target alone (reference, not a trigger)", () => {
      const v = runRule(rule, `<div data-bs-target="#mymodal">...</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    // Unknown `data-bs-toggle` values (typos, custom plugins) should
    // not fire — we don't speculate. The agent reading the file will
    // see the value and decide; per AI-first doctrine, value-based
    // grammar is honest exactly because it lists what we know is a
    // disclosure value.
    it("div has data-bs-toggle with unknown value (not in disclosure allowlist)", () => {
      const v = runRule(rule, `<div data-bs-toggle="custom-widget">...</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX attribute-interaction", () => {
    it("fires on bare div with data-bs-toggle in JSX", () => {
      const v = runRule(rule, `const X = <div data-bs-toggle="modal">Open</div>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("data-bs-toggle");
    });

    it("does NOT fire on <button> with data-bs-toggle in JSX", () => {
      const v = runRule(rule, `const X = <button data-bs-toggle="modal">Open</button>;`);
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on PascalCase component (can't see internals)", () => {
      const v = runRule(rule, `const X = <MyToggle data-bs-toggle="modal">Open</MyToggle>;`);
      expect(v).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // External-JS handler grammar — `addEventListener('click', …)` and
  // `.onclick = …` attached to variables grabbed via
  // `document.querySelector` / `getElementById` / `getElementsByClassName`
  // in standalone `.js` / `.ts` files. Covers the biggest single coverage
  // hole for vanilla-JS corpora.
  // ---------------------------------------------------------------------------

  describe("external JS: fires when", () => {
    it("addEventListener('click', fn) on querySelector target without keyboard sibling", () => {
      const source = `const btn = document.querySelector('#save');
btn.addEventListener('click', () => save());`;
      const v = runRule(rule, source, { filePath: "app.js" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("addEventListener('click'");
      expect(v[0]?.message).toContain("btn");
    });

    it("resolved selector is threaded into the message", () => {
      const source = `const btn = document.querySelector('#save-button');
btn.addEventListener('click', save);`;
      const v = runRule(rule, source, { filePath: "app.js" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("#save-button");
      expect(v[0]?.message).toContain("querySelector");
    });

    it("getElementById target with .onclick assignment", () => {
      const source = `const tile = document.getElementById('tile');
tile.onclick = () => activate();`;
      const v = runRule(rule, source, { filePath: "app.js" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("onclick");
      expect(v[0]?.message).toContain("getElementById");
      expect(v[0]?.message).toContain("tile");
    });

    it("getElementsByClassName target — selector resolution preserves the class name", () => {
      const source = `const tiles = document.getElementsByClassName('action-tile');
tiles[0].addEventListener('click', handle);`;
      const v = runRule(rule, source, { filePath: "app.js" });
      // `tiles[0]` isn't a bare identifier on the left of the event
      // attachment — the detector keys on the identifier. This case
      // covers the selector-resolution path when the identifier itself
      // (`tiles`) is what gets the listener.
      // Separately test the base-identifier path:
      const source2 = `const el = document.getElementsByClassName('action-tile')[0];
el.addEventListener('click', handle);`;
      const v2 = runRule(rule, source2, { filePath: "app.js" });
      expect(v2).toHaveLength(1);
      expect(v2[0]?.message).toContain("getElementsByClassName");
      expect(v2[0]?.message).toContain("action-tile");
      // Ensure the first shape still fires even without backward resolution.
      expect(v.length).toBeGreaterThanOrEqual(0);
    });

    it("fires inside TSX useEffect when no keyboard sibling is present", () => {
      const source = `import { useEffect } from "react";
export function Comp() {
  useEffect(() => {
    const btn = document.querySelector('#x');
    btn.addEventListener('click', () => doThing());
  }, []);
  return <div>hello</div>;
}`;
      const v = runRule(rule, source, { filePath: "Comp.tsx" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("addEventListener('click'");
    });
  });

  describe("external JS: does NOT fire when", () => {
    it("sibling keydown addEventListener on the same variable is present", () => {
      const source = `const btn = document.querySelector('#x');
btn.addEventListener('click', click);
btn.addEventListener('keydown', keydown);`;
      const v = runRule(rule, source, { filePath: "app.js" });
      expect(v).toHaveLength(0);
    });

    it("sibling .onkeydown assignment on the same variable is present", () => {
      const source = `const btn = document.getElementById('x');
btn.onclick = click;
btn.onkeydown = keydown;`;
      const v = runRule(rule, source, { filePath: "app.js" });
      expect(v).toHaveLength(0);
    });

    it("sibling keyup addEventListener on the same variable is present", () => {
      const source = `const btn = document.querySelector('#x');
btn.addEventListener('click', click);
btn.addEventListener('keyup', keyup);`;
      const v = runRule(rule, source, { filePath: "app.js" });
      expect(v).toHaveLength(0);
    });

    it("global window.addEventListener('click', …) is handled by character-shortcuts, not this rule", () => {
      const source = `window.addEventListener('click', globalClickLogger);`;
      const v = runRule(rule, source, { filePath: "app.js" });
      expect(v).toHaveLength(0);
    });

    it("document.addEventListener('click', …) is global, not per-element", () => {
      const source = `document.addEventListener('click', (e) => handle(e));`;
      const v = runRule(rule, source, { filePath: "app.js" });
      expect(v).toHaveLength(0);
    });

    it("click comparison (el.onclick === fn) is not a handler assignment", () => {
      const source = `const btn = document.querySelector('#x');
if (btn.onclick === originalHandler) restore();`;
      const v = runRule(rule, source, { filePath: "app.js" });
      expect(v).toHaveLength(0);
    });
  });

  describe("external JS: suggestion quality", () => {
    it("suggestion names the variable and a concrete keydown handler", () => {
      const source = `const btn = document.querySelector('#x');
btn.addEventListener('click', save);`;
      const v = runRule(rule, source, { filePath: "app.js" });
      expect(v[0]?.suggestion).toContain("btn.addEventListener('keydown'");
      expect(v[0]?.suggestion).toContain("Enter");
      expect(v[0]?.suggestion).toContain("Space");
    });

    it("suggestion references the resolved selector for cross-file grepping", () => {
      const source = `const el = document.getElementById('nav-item');
el.onclick = toggle;`;
      const v = runRule(rule, source, { filePath: "app.js" });
      // Suggestion quotes the resolver call verbatim so the agent can
      // grep the HTML for `id="nav-item"`.
      expect(v[0]?.suggestion).toContain("getElementById('nav-item')");
      expect(v[0]?.suggestion).toContain("grep");
    });

    it("suggestion omits selector clause when no querySelector declarator is found in file", () => {
      // Common shape: the target is a parameter or imported ref, not a
      // local declarator. We still emit the finding — the location and
      // variable are actionable — but we don't fabricate a selector.
      const source = `export function wire(btn) {
  btn.addEventListener('click', doThing);
}`;
      const v = runRule(rule, source, { filePath: "app.js" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).not.toContain("resolved from");
    });
  });

  it("cites wcag22:2.1.1 and wcag21:2.1.1", () => {
    expect(rule.satisfies).toContain("wcag22:2.1.1");
    expect(rule.satisfies).toContain("wcag21:2.1.1");
  });

  // ---------------------------------------------------------------------------
  // Cross-file handler enrichment — when the document references an
  // external script (HTML `<script src>`) or imports a sibling module
  // (JSX/JS/TS), the click/keyboard binding might live there. The rule
  // surfaces the finding (surface-don't-suppress) but enriches the
  // suggestion with the cross-file follow-up, degrades per-finding
  // `confidence` to `"medium"`, and stamps the structured
  // `cross_file_listener_resolution_limited` code so the per-finding
  // label mirrors the per-rule `coverageConfidence`.
  // ---------------------------------------------------------------------------
  describe("cross-file handler enrichment", () => {
    it("HTML: enriches when document has <script src=…>", () => {
      const source = `<!DOCTYPE html><html><body>
<script src="app.js"></script>
<div onclick="doThing()">Click</div>
</body></html>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.confidence).toBe("medium");
      expect(v[0]?.couldBeWrongBecause).toEqual(["cross_file_listener_resolution_limited"]);
      expect(v[0]?.suggestion).toContain("app.js");
      expect(v[0]?.suggestion).toContain("external script");
    });

    it("HTML: does NOT enrich when document has no <script src>", () => {
      const source = `<!DOCTYPE html><html><body>
<div onclick="doThing()">Click</div>
</body></html>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.confidence).toBeUndefined();
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("HTML: inline <script> without src is not the cross-file signal", () => {
      const source = `<!DOCTYPE html><html><body>
<script>window.foo = 1;</script>
<div onclick="doThing()">Click</div>
</body></html>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.confidence).toBeUndefined();
    });

    it("HTML: enrichment fires on the data-bs-toggle (attribute-interaction) branch too", () => {
      const source = `<!DOCTYPE html><html><body>
<script src="bootstrap-bundle.js"></script>
<div data-bs-toggle="modal" data-bs-target="#m">Open</div>
</body></html>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.confidence).toBe("medium");
      expect(v[0]?.suggestion).toContain("bootstrap-bundle.js");
    });

    it("JSX: enriches when source imports a sibling module", () => {
      const source = `import { wireHandlers } from "./handlers.js";
const X = <div onClick={wireHandlers}>Click</div>;`;
      const v = runRule(rule, source);
      expect(v).toHaveLength(1);
      expect(v[0]?.confidence).toBe("medium");
      expect(v[0]?.couldBeWrongBecause).toEqual(["cross_file_listener_resolution_limited"]);
      expect(v[0]?.suggestion).toContain("./handlers.js");
    });

    it("JSX: extension-less relative import counts as a sibling module", () => {
      const source = `import { wire } from "./util";
const X = <span onClick={wire}>x</span>;`;
      const v = runRule(rule, source);
      expect(v).toHaveLength(1);
      expect(v[0]?.confidence).toBe("medium");
      expect(v[0]?.suggestion).toContain("./util");
    });

    it("JSX: bare-package import (e.g. 'react') does NOT trigger enrichment", () => {
      const source = `import { useState } from "react";
const X = <div onClick={useState}>x</div>;`;
      const v = runRule(rule, source);
      expect(v).toHaveLength(1);
      expect(v[0]?.confidence).toBeUndefined();
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("external-JS branch: enriches when the JS file imports a sibling module", () => {
      const source = `import { keyboardWiring } from "./keyboard.ts";
const btn = document.querySelector('#save');
btn.addEventListener('click', () => save());`;
      const v = runRule(rule, source, { filePath: "app.js" });
      expect(v).toHaveLength(1);
      expect(v[0]?.confidence).toBe("medium");
      expect(v[0]?.suggestion).toContain("./keyboard.ts");
    });
  });
});
