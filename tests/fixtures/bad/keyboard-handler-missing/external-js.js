// Bad fixture for rule `keyboard/handler-missing`.
//
// A standalone .js file that wires a click handler to an element grabbed
// via `document.querySelector(...)` with NO sibling keydown/keyup
// listener on the same variable. This is the biggest single coverage
// hole for vanilla-JS corpora — inline `onclick="…"` attributes get
// flagged by the HTML branch of this rule, but the equivalent
// `.addEventListener('click', …)` attach in a separate .js file was
// invisible until.
//
// Expected violation: 1 — pointed at the `btn.addEventListener(...)`
// line, with `#save-tile` surfaced in the reason so the agent can grep
// the paired HTML file.

const btn = document.querySelector("#save-tile");
btn.addEventListener("click", () => {
  saveThing();
});
