// JSX counterpart. React spells `for=` as `htmlFor=`, so the mechanical
// fix the rule proposes is `<label htmlFor="q1">…</label>` — matching the
// attribute an author would actually type in a .tsx file.
export function Quiz() {
  return (
    <form>
      <label>Question</label>
      <input id="q1" type="text" />
    </form>
  );
}
