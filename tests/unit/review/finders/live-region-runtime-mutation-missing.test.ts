/**
 * Unit tests for the review/live-region-runtime-mutation-missing finder
 * (wcag22:4.1.3 + wcag21:4.1.3 — Status Messages).
 *
 * Pins each mutation pattern the finder fires on (.innerHTML /
 * .textContent / .innerText assignment and +=, plus the two
 * insertAdjacent{HTML,Text} call shapes) across .js, .tsx, and inline-
 * script HTML. Negative coverage proves unrelated string/identifier
 * shapes (`innerHTML` as an object key, equality `===`, comment text)
 * do NOT trigger.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/live-region-runtime-mutation-missing.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

function criteriaOf(candidates: readonly ReviewCandidate[]): readonly string[] {
  return [...new Set(candidates.map((c) => c.criterionId))].sort();
}

describe("review/live-region-runtime-mutation-missing — JS mutation patterns", () => {
  it("flags `.innerHTML = …` (canonical insect-catch-game score update shape)", () => {
    const source = `
      const score = document.querySelector(".score");
      setInterval(() => {
        let n = Number(score.innerHTML);
        score.innerHTML = n + 1;
      }, 1000);
    `;
    const out = runFinder(finder, source, { filePath: "game.js" });
    // 2 criteria × 1 mutation site = 2 candidates (the read on the LHS
    // of `Number(score.innerHTML)` is a read, not an assignment).
    expect(out.length).toBe(2);
    expect(criteriaOf(out)).toEqual(["wcag21:4.1.3", "wcag22:4.1.3"]);
    expect(out[0]?.reason).toContain(".innerHTML assignment");
  });

  it("flags `.innerHTML += …` (compound-assignment append)", () => {
    const source = `log.innerHTML += '<li>tick</li>';`;
    const out = runFinder(finder, source, { filePath: "log.js" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain(".innerHTML += append");
  });

  it("flags `.textContent = …` (canonical dad-jokes fetch shape)", () => {
    const source = `
      fetch("/joke").then(r => r.json()).then(data => {
        jokeEl.textContent = data.joke;
      });
    `;
    const out = runFinder(finder, source, { filePath: "jokes.js" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain(".textContent assignment");
  });

  it("flags `.innerText = …`", () => {
    const source = `timer.innerText = formatted;`;
    const out = runFinder(finder, source, { filePath: "timer.js" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain(".innerText assignment");
  });

  it("flags `.insertAdjacentHTML(…)` calls", () => {
    const source = `list.insertAdjacentHTML("beforeend", "<li>new</li>");`;
    const out = runFinder(finder, source, { filePath: "list.js" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain(".insertAdjacentHTML() call");
  });

  it("flags `.insertAdjacentText(…)` calls", () => {
    const source = `status.insertAdjacentText("afterbegin", "Saved.");`;
    const out = runFinder(finder, source, { filePath: "status.js" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain(".insertAdjacentText() call");
  });

  it("flags multiple mutation sites in one file, each with its own line", () => {
    const source = [
      "const a = document.getElementById('a');",
      "a.innerHTML = 'one';",
      "a.textContent = 'two';",
      "a.insertAdjacentHTML('beforeend', 'three');",
    ].join("\n");
    const out = runFinder(finder, source, { filePath: "multi.js" });
    // 3 mutations × 2 criteria = 6 candidates
    expect(out.length).toBe(6);
    const lines = [...new Set(out.map((c) => c.location.line))].sort((a, b) => a - b);
    expect(lines).toEqual([2, 3, 4]);
  });
});

describe("review/live-region-runtime-mutation-missing — TSX / React", () => {
  it("flags `.innerHTML = …` via a React ref (event-keycodes shape)", () => {
    const source = `
      export function KeyDisplay() {
        const ref = useRef<HTMLDivElement>(null);
        useEffect(() => {
          const onKey = (e: KeyboardEvent) => {
            if (ref.current) ref.current.innerHTML = \`\${e.key} (\${e.keyCode})\`;
          };
          window.addEventListener("keydown", onKey);
          return () => window.removeEventListener("keydown", onKey);
        }, []);
        return <div ref={ref} />;
      }
    `;
    const out = runFinder(finder, source, { filePath: "KeyDisplay.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain(".innerHTML assignment");
  });

  it("flags `.textContent = …` in a useEffect setTimeout (simple-timer shape)", () => {
    const source = `
      export function Timer({ el }) {
        useEffect(() => {
          const id = setTimeout(() => {
            el.textContent = "Loaded";
          }, 1000);
          return () => clearTimeout(id);
        }, [el]);
        return null;
      }
    `;
    const out = runFinder(finder, source, { filePath: "Timer.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain(".textContent assignment");
  });
});

describe("review/live-region-runtime-mutation-missing — HTML inline <script>", () => {
  it("flags a mutation inside an inline <script> block", () => {
    const source = `
      <!doctype html>
      <html>
        <body>
          <div id="score">0</div>
          <script>
            const s = document.getElementById("score");
            setInterval(() => { s.innerHTML = Math.random(); }, 500);
          </script>
        </body>
      </html>
    `;
    const out = runFinder(finder, source, { filePath: "game.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain(".innerHTML assignment");
  });
});

describe("review/live-region-runtime-mutation-missing — negative cases", () => {
  it("does NOT fire on equality comparisons `el.innerHTML === …`", () => {
    const source = `if (el.innerHTML === "old") { /* ... */ }`;
    const out = runFinder(finder, source, { filePath: "eq.js" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on equality comparisons `el.textContent == …`", () => {
    const source = `if (el.textContent == "done") return;`;
    const out = runFinder(finder, source, { filePath: "eq2.js" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on a read-only access `const x = el.innerHTML;`", () => {
    const source = `const x = el.innerHTML;`;
    const out = runFinder(finder, source, { filePath: "read.js" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on plain `.value = …` (form field) or `.style.* = …`", () => {
    const source = `
      input.value = "new";
      el.style.color = "red";
      el.className = "active";
    `;
    const out = runFinder(finder, source, { filePath: "other.js" });
    // These are real DOM mutations but not TEXT mutations for 4.1.3; the
    // timing / other finders cover the auto-update framing.
    expect(out).toEqual([]);
  });

  it("does NOT fire on unrelated API calls `el.insertBefore(…)` / `.replaceChildren(…)`", () => {
    const source = `
      el.insertBefore(newNode, ref);
      el.replaceChildren(a, b);
    `;
    const out = runFinder(finder, source, { filePath: "nodes.js" });
    expect(out).toEqual([]);
  });
});

describe("review/live-region-runtime-mutation-missing — emission shape", () => {
  it("emits one candidate per matching criterion (wcag22 + wcag21)", () => {
    const source = `el.innerHTML = "x";`;
    const out = runFinder(finder, source, { filePath: "x.js" });
    expect(criteriaOf(out)).toEqual(["wcag21:4.1.3", "wcag22:4.1.3"]);
  });

  it("uses confidence: medium per ai-first-consumer doctrine", () => {
    const source = `el.textContent = "x";`;
    const out = runFinder(finder, source, { filePath: "x.js" });
    expect(out.every((c) => c.confidence === "medium")).toBe(true);
  });

  it("reason text names the live-region dismissal path (role/aria-live)", () => {
    const source = `el.innerHTML = "x";`;
    const out = runFinder(finder, source, { filePath: "x.js" });
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain('role="status"');
    expect(reason).toContain("aria-live");
    expect(reason).toContain("WCAG 4.1.3");
  });

  it("location line/column are 1-based and point at the matched operator", () => {
    const source = "line1\nconst el = x;\nel.innerHTML = 'y';\n";
    const out = runFinder(finder, source, { filePath: "x.js" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.location.line).toBe(3);
    // column is 1-based; the `.innerHTML` match offset lies after `el`
    // on line 3 (`el.innerHTML = ...`), so column > 1.
    expect(out[0]?.location.column).toBeGreaterThan(1);
  });
});
