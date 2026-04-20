// Good: aria-expanded is bound to a runtime expression — state is
// programmatically determinable. The rule accepts any value (including
// expressions) on the attribute; only its absence is a violation.

import { useState } from "react";

export function Disclosure() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button aria-controls="panel" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Details
      </button>
      <div id="panel" hidden={!open}>
        <p>Content that the button toggles.</p>
      </div>
    </>
  );
}
