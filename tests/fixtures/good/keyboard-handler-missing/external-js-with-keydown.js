// Good fixture for rule `keyboard/handler-missing`.
//
// External-JS handler grammar done correctly: the variable `btn` has
// a click listener AND a sibling keydown listener that handles both
// Enter and Space. Keyboard users can reach the action (assuming the
// element has tabindex or is natively focusable in the paired HTML)
// and activate it.
//
// The rule must NOT fire on this file.

const btn = document.querySelector("#save-tile");

btn.addEventListener("click", () => {
  saveThing();
});

btn.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    saveThing();
  }
});
