/**
 * Unit tests for the review/timing finder.
 * Covers wcag22:2.2.1, 2.2.2, 2.2.3, 2.2.4, 2.2.5, 2.2.6.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finder } from "../../../src/review/finders/timing.ts";
import { runFinder } from "../../helpers/run-finder.ts";

const FIXTURE_ROOT = join(import.meta.dir, "..", "..", "fixtures", "review", "timing");

function loadFixture(kind: "good" | "bad", name: string): string {
  return readFileSync(join(FIXTURE_ROOT, kind, name), "utf8");
}

describe("review/timing", () => {
  it('flags <meta http-equiv="refresh"> in HTML', () => {
    const out = runFinder(finder, `<meta http-equiv="refresh" content="30; url=/next">`, {
      filePath: "a.html",
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("refresh");
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:2.2.1")).toBe(true);
  });

  it("flags setInterval call in TSX source", () => {
    const out = runFinder(finder, `setInterval(() => tick(), 1000);`);
    const hits = out.filter((c) => c.reason.includes("setInterval"));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.criterionId).toBe("wcag22:2.2.1");
  });

  it("flags setTimeout call in TSX source", () => {
    const out = runFinder(finder, `setTimeout(() => logout(), 60_000);`);
    const hits = out.filter((c) => c.reason.includes("setTimeout"));
    expect(hits.length).toBeGreaterThan(0);
  });

  it("does not flag mere references to the identifiers (no paren)", () => {
    const out = runFinder(finder, `const fn = setTimeout;`);
    // `setTimeout;` with no paren should NOT match because regex requires `\s*\(`
    const hits = out.filter((c) => c.reason.includes("setTimeout"));
    expect(hits).toHaveLength(0);
  });

  it('flags <meta httpEquiv="refresh"> in JSX', () => {
    const out = runFinder(finder, `const X = <meta httpEquiv="refresh" content="60" />;`);
    expect(out.length).toBeGreaterThan(0);
  });

  it("does not flag <meta charset> etc.", () => {
    const out = runFinder(finder, `<meta charset="utf-8">`, { filePath: "a.html" });
    expect(out).toEqual([]);
  });

  it("every hit carries both wcag22 and wcag21 equivalents", () => {
    const out = runFinder(finder, `setInterval(() => tick(), 1000);`);
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:2.2.1")).toBe(true);
    expect(ids.has("wcag21:2.2.1")).toBe(true);
  });

  it("one setTimeout + one setInterval → two distinct candidate offsets", () => {
    const out = runFinder(finder, `setInterval(() => a(), 100); setTimeout(() => b(), 200);`);
    const offsets = new Set(out.map((c) => `${c.location.line}:${c.location.column}`));
    expect(offsets.size).toBeGreaterThanOrEqual(2);
  });

  describe("duration + enclosing-function enrichment", () => {
    // The finder appends the second argument of each setTimeout /
    // setInterval call and the enclosing function/method name to the
    // reason text verbatim. This is additive context the agent would
    // otherwise re-derive by reading the file — same site set, richer
    // triage signal per candidate. See ai-first-consumer.md on
    // encoding numbers as reason text rather than thresholding.

    it("cites a numeric literal duration on setInterval", () => {
      const out = runFinder(finder, `setInterval(() => tick(), 300);`);
      const hit = out.find((c) => c.reason.includes("setInterval"));
      expect(hit?.reason).toContain("duration `300`");
    });

    it("cites a member-expression duration (e.g. this._config.delay)", () => {
      const src = `
        class Tooltip {
          show() {
            setTimeout(() => this._open(), this._config.delay);
          }
        }
      `;
      const out = runFinder(finder, src);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("duration `this._config.delay`");
    });

    it("cites an identifier duration", () => {
      const out = runFinder(finder, `setTimeout(cb, delay);`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("duration `delay`");
    });

    it("ignores commas inside the callback when locating the duration", () => {
      // The callback parameter list `(a, b)` contains a comma that is
      // NOT the call's argument separator. Extraction must track paren
      // depth rather than splitting on the first comma it sees.
      const out = runFinder(finder, `setTimeout((a, b) => combine(a, b), 500);`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("duration `500`");
    });

    it("omits the duration clause when the call has no second argument", () => {
      // Degenerate but syntactically valid. The finder still surfaces
      // the call (presence of a timer is concrete evidence of
      // time-dependent behavior) but must not invent a duration.
      const out = runFinder(finder, `setTimeout(() => tick());`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit).toBeDefined();
      expect(hit?.reason).not.toContain("duration `");
    });

    it("cites the enclosing method for method-shorthand class bodies", () => {
      const src = `
        class Carousel {
          _transitionStart() {
            setInterval(() => this._next(), 5000);
          }
        }
      `;
      const out = runFinder(finder, src);
      const hit = out.find((c) => c.reason.includes("setInterval"));
      expect(hit?.reason).toContain("in `_transitionStart()`");
    });

    it("cites the enclosing name for named function declarations", () => {
      const src = `
        function pollStatus() {
          setInterval(fetchStatus, 10_000);
        }
      `;
      const out = runFinder(finder, src);
      const hit = out.find((c) => c.reason.includes("setInterval"));
      expect(hit?.reason).toContain("in `pollStatus()`");
    });

    it("cites the enclosing name for arrow-assigned function expressions", () => {
      const src = `
        const scheduleRetry = () => {
          setTimeout(retry, 1000);
        };
      `;
      const out = runFinder(finder, src);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("in `scheduleRetry()`");
    });

    it("omits the enclosing clause when the call is at module scope", () => {
      // Honest omission rather than inventing a fake name. The call is
      // still surfaced; the agent opens the file to see the context.
      const out = runFinder(finder, `setTimeout(() => boot(), 0);`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit).toBeDefined();
      expect(hit?.reason).not.toContain(" in `");
    });

    it("does not label control-flow blocks (if/for/while) as functions", () => {
      // A top-level `if (cond) { setTimeout(...) }` has a `)` before `{`
      // that superficially looks like a parameter list, but the enclosing
      // block is not a function. The probe must return null.
      const out = runFinder(finder, `if (ready) { setTimeout(() => tick(), 200); }`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit).toBeDefined();
      expect(hit?.reason).not.toContain(" in `if()`");
      expect(hit?.reason).not.toContain(" in `for()`");
      expect(hit?.reason).not.toContain(" in `while()`");
    });

    it("keeps the normative review prompt after the enrichment clauses", () => {
      // Enrichment is additive — the base reason text that tells the
      // agent what the candidate is asking must still be present.
      const src = `
        class Toast {
          show() {
            setTimeout(() => this._hide(), this._config.delay);
          }
        }
      `;
      const out = runFinder(finder, src);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("setTimeout() call");
      expect(hit?.reason).toContain("duration `this._config.delay`");
      expect(hit?.reason).toContain("in `show()`");
      expect(hit?.reason).toContain("verify the user can pause, extend, or disable");
    });
  });

  describe("no filename-based classification (CLAUDE.md §1 regression guard)", () => {
    // Prior design attached "(file looks like a X — likely not user-facing)"
    // hints to setTimeout/setInterval candidates, keyed off filename
    // regexes for debounce/telemetry/authManager/etc. That's the tool
    // duplicating agent-side classification — and risking confidently
    // wrong output when, say, authManager legitimately houses a session
    // timeout or useDebouncedCallback governs user-perceived latency.
    // Pin the removal so the hints never sneak back in.
    const suspectFiles: readonly string[] = [
      "src/hooks/useDebouncedCallback.ts",
      "lib/useThrottledScroll.ts",
      "services/authManager.ts",
      "services/telemetryService.ts",
      "lib/indexedDbTransport.ts",
      "workers/backgroundWorker.ts",
      "utils/retry.ts",
      "lib/heartbeat.ts",
    ];
    for (const file of suspectFiles) {
      it(`does NOT attach filename-derived user-facing judgments for ${file}`, () => {
        const out = runFinder(finder, `setTimeout(() => x(), 1000);`, { filePath: file });
        const hit = out.find((c) => c.reason.includes("setTimeout"));
        expect(hit).toBeDefined();
        expect(hit?.reason).not.toContain("file looks like");
        expect(hit?.reason).not.toContain("likely not user-facing");
      });
    }

    it("keeps the normative review prompt so the agent knows what to check", () => {
      const out = runFinder(finder, `setTimeout(() => x(), 1000);`, {
        filePath: "src/hooks/useDebouncedCallback.ts",
      });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("verify the user can pause, extend, or disable");
    });
  });

  describe("Pause, Stop, Hide (2.2.2) escalation for DOM-mutating setInterval", () => {
    // When a setInterval callback statically mutates DOM state (style,
    // className, classList, attributes, innerHTML, etc.), the finder
    // enriches the reason text with the Pause/Stop/Hide sentence and
    // emits additional candidates under wcag22:2.2.2 + wcag21:2.2.2 so
    // the 2.2.2 question reaches the agent alongside 2.2.1. Reason-text
    // enrichment per ai-first-consumer.md — no severity change, no
    // suppression, candidate stays in the primary list.

    it("escalates when the inline arrow body writes to .style", () => {
      const src = `setInterval(() => { el.style.transform = "translateX(" + x + "px)"; }, 2000);`;
      const out = runFinder(finder, src, { filePath: "carousel.js" });
      const hit = out.find((c) => c.criterionId === "wcag22:2.2.1");
      expect(hit?.reason).toContain("WCAG 2.2.2");
      expect(hit?.reason).toContain("Pause, Stop, Hide");
      expect(hit?.reason).toContain("auto-advancing visual motion");
    });

    it("adds wcag22:2.2.2 + wcag21:2.2.2 candidates at the same location", () => {
      const src = `setInterval(() => { el.classList.add("on"); }, 1500);`;
      const out = runFinder(finder, src, { filePath: "blink.js" });
      const ids = new Set(out.map((c) => c.criterionId));
      expect(ids.has("wcag22:2.2.2")).toBe(true);
      expect(ids.has("wcag21:2.2.2")).toBe(true);
    });

    it("escalates on .classList.add/remove/toggle", () => {
      const src = loadFixture("bad", "carousel-inline-arrow-classlist.js");
      const out = runFinder(finder, src, { filePath: "carousel.js" });
      const mutating = out.find((c) => c.reason.includes("Pause, Stop, Hide"));
      expect(mutating).toBeDefined();
    });

    it("escalates on .innerHTML assignment", () => {
      const src = loadFixture("bad", "blink-innerhtml-mutation.js");
      const out = runFinder(finder, src, { filePath: "counter.js" });
      const hit = out.find((c) => c.reason.includes("Pause, Stop, Hide"));
      expect(hit).toBeDefined();
    });

    it("escalates on .setAttribute", () => {
      const src = `setInterval(() => { el.setAttribute("data-step", step); }, 2000);`;
      const out = runFinder(finder, src, { filePath: "a.js" });
      const hit = out.find((c) => c.criterionId === "wcag22:2.2.2");
      expect(hit).toBeDefined();
    });

    it("escalates via identifier callback with same-file function declaration", () => {
      // This is the canonical image-carousel shape: setInterval(run, 2000)
      // where `run` is defined as a named function in the same file and
      // mutates DOM state. The probe must resolve the identifier one hop.
      const src = loadFixture("bad", "carousel-inline-style-mutation.js");
      const out = runFinder(finder, src, { filePath: "script.js" });
      const hit = out.find((c) => c.reason.includes("Pause, Stop, Hide"));
      expect(hit).toBeDefined();
    });

    it("escalates via identifier callback with const arrow definition", () => {
      const src = `
        const advance = () => {
          el.style.left = next + "px";
        };
        setInterval(advance, 2500);
      `;
      const out = runFinder(finder, src, { filePath: "slider.js" });
      const hit = out.find((c) => c.reason.includes("Pause, Stop, Hide"));
      expect(hit).toBeDefined();
    });

    it("does NOT escalate when the interval callback does not write to the DOM", () => {
      const src = loadFixture("good", "polling-no-dom-write.js");
      const out = runFinder(finder, src, { filePath: "poll.js" });
      const hasEscalation = out.some((c) => c.reason.includes("Pause, Stop, Hide"));
      expect(hasEscalation).toBe(false);
      // The base 2.2.1 candidate still surfaces — the agent reads the
      // file to judge whether the fetch's result reaches the DOM.
      const base = out.find((c) => c.criterionId === "wcag22:2.2.1");
      expect(base).toBeDefined();
    });

    it("does NOT escalate setTimeout calls that write to the DOM", () => {
      // setTimeout fires once — it is not "auto-updating information"
      // under 2.2.2 even when it mutates the DOM. Surface at 2.2.1 as
      // always; omit the Pause, Stop, Hide prefix.
      const src = loadFixture("good", "settimeout-dom-mutation.js");
      const out = runFinder(finder, src, { filePath: "notice.js" });
      const hasEscalation = out.some((c) => c.reason.includes("Pause, Stop, Hide"));
      expect(hasEscalation).toBe(false);
      const ids = new Set(out.map((c) => c.criterionId));
      expect(ids.has("wcag22:2.2.2")).toBe(false);
      expect(ids.has("wcag22:2.2.1")).toBe(true);
    });

    it("does NOT escalate when the identifier callback cannot be resolved in-file", () => {
      // `rotate` is imported from elsewhere; the probe is intentionally
      // narrow (same-file, single hop) and must silently not escalate
      // rather than guess. The agent reading the file sees the import
      // and decides.
      const src = `
        import { rotate } from "./util";
        setInterval(rotate, 4000);
      `;
      const out = runFinder(finder, src, { filePath: "main.js" });
      const hasEscalation = out.some((c) => c.reason.includes("Pause, Stop, Hide"));
      expect(hasEscalation).toBe(false);
    });

    it("keeps duration and enclosing-function enrichment after the 2.2.2 prefix", () => {
      const src = `
        class Carousel {
          start() {
            setInterval(() => { this.el.style.opacity = "0"; }, 5000);
          }
        }
      `;
      const out = runFinder(finder, src, { filePath: "carousel.tsx" });
      const hit = out.find((c) => c.criterionId === "wcag22:2.2.1");
      expect(hit?.reason).toContain("Pause, Stop, Hide");
      expect(hit?.reason).toContain("duration `5000`");
      expect(hit?.reason).toContain("in `start()`");
      expect(hit?.reason).toContain("verify the user can pause, extend, or disable");
    });

    it("preserves confidence medium on the escalated candidates", () => {
      // Escalation is additive annotation — it doesn't let the finder
      // claim stronger evidence about user-facing intent. Stay at
      // medium so consumers that filter by confidence see consistent
      // semantics across 2.2.1 / 2.2.2 candidates from this finder.
      const src = `setInterval(() => { el.style.color = "red"; }, 1000);`;
      const out = runFinder(finder, src, { filePath: "blink.js" });
      const twoTwoTwo = out.filter((c) => c.criterionId.endsWith(":2.2.2"));
      expect(twoTwoTwo.length).toBeGreaterThan(0);
      for (const c of twoTwoTwo) {
        expect(c.confidence).toBe("medium");
      }
    });
  });

  describe("duration-class enrichment (non-literal durations)", () => {
    // Field reports surface candidates whose duration is a member-
    // access (`self.options.interval`), an identifier (`delay`), or a
    // call expression (`getDelay()`) — values the agent cannot resolve
    // from the call site alone. The base reason already echoes the
    // expression verbatim; this enrichment names the *kind* so the
    // agent's dismissal path is "follow the binding" rather than
    // "guess from the verbatim slice." Per ai-first-consumer.md the
    // hint is additive — confidence stays "medium," candidate stays
    // in the primary list, no severity change.
    // V1-FINDER-2.2.1-SETTIMEOUT-VENDOR-FILE-GATE.

    it("flags member-access durations (this._config.delay)", () => {
      const src = `
        class Tooltip {
          show() {
            setTimeout(() => this._open(), this._config.delay);
          }
        }
      `;
      const out = runFinder(finder, src);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("duration `this._config.delay`");
      expect(hit?.reason).toContain("member-access reference");
      expect(hit?.reason).toContain("resolve the binding chain");
    });

    it("flags member-access durations through optional chaining", () => {
      const src = `setInterval(() => tick(), opts?.timeout);`;
      const out = runFinder(finder, src);
      const hit = out.find((c) => c.reason.includes("setInterval"));
      expect(hit?.reason).toContain("member-access reference");
    });

    it("flags member-access durations rooted at `self` (jQuery/Bootstrap shape)", () => {
      // The canonical real-world shape from the field report:
      //   setTimeout(self._show.bind(self), self.options.interval)
      // — duration is a member access on the captured `self`. The
      // agent must read the surrounding constructor or method to know
      // what `self.options.interval` resolves to.
      const src = `
        function bootstrap() {
          var self = this;
          setTimeout(function() { self._tick(); }, self.options.interval);
        }
      `;
      const out = runFinder(finder, src, { filePath: "vendor/bootstrap.js" });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("duration `self.options.interval`");
      expect(hit?.reason).toContain("member-access reference");
    });

    it("flags identifier durations (bare variable name)", () => {
      const out = runFinder(finder, `setTimeout(cb, delay);`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("identifier reference");
      expect(hit?.reason).toContain("resolve the binding in scope");
    });

    it("flags call-expression durations", () => {
      const out = runFinder(finder, `setTimeout(cb, getDelay());`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("call-expression reference");
    });

    it("flags computed-expression durations (binary, ternary, etc.)", () => {
      const out = runFinder(finder, `setTimeout(cb, delay * 2);`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("computed expression");
    });

    it("does NOT attach a duration-class clause to plain numeric literals", () => {
      const out = runFinder(finder, `setTimeout(() => tick(), 300);`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("duration `300`");
      expect(hit?.reason).not.toContain("member-access reference");
      expect(hit?.reason).not.toContain("identifier reference");
      expect(hit?.reason).not.toContain("call-expression reference");
      expect(hit?.reason).not.toContain("computed expression");
    });

    it("does NOT attach a duration-class clause to underscore-separated numeric literals", () => {
      const out = runFinder(finder, `setTimeout(() => logout(), 60_000);`);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("duration `60_000`");
      expect(hit?.reason).not.toContain("identifier reference");
      expect(hit?.reason).not.toContain("computed expression");
    });

    it("does NOT attach a duration-class clause to hex / exponent / decimal literals", () => {
      const cases = [
        { src: `setTimeout(cb, 0x100);`, dur: "0x100" },
        { src: `setTimeout(cb, 5e2);`, dur: "5e2" },
        { src: `setTimeout(cb, 1.5);`, dur: "1.5" },
      ];
      for (const { src, dur } of cases) {
        const out = runFinder(finder, src);
        const hit = out.find((c) => c.reason.includes("setTimeout"));
        expect(hit?.reason).toContain(`duration \`${dur}\``);
        expect(hit?.reason).not.toContain("reference");
      }
    });

    it("keeps the normative review prompt after the duration-class clause", () => {
      const src = `setTimeout(cb, this._config.delay);`;
      const out = runFinder(finder, src);
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("member-access reference");
      expect(hit?.reason).toContain("verify the user can pause, extend, or disable");
    });
  });

  describe("vendor-bundle filename enrichment", () => {
    // When the cited file's basename matches a canonical vendor
    // library bundle name — `bootstrap.js`, `jquery-1.10.2.js`,
    // `popper.js` — the call site is almost certainly library
    // internals (e.g. Bootstrap's Tooltip._timeout, jQuery's
    // setTimeout-driven deferred work) the page author does not
    // control. The reason text annotates this so the agent's
    // dismissal path is "library code" rather than "investigate as
    // potential session timeout." Per ai-first-consumer.md the
    // candidate is NEVER suppressed on filename signal — annotation,
    // not silencing. The dedicated content-level vendor-banner
    // detector (V1-VENDOR-LIBRARY-BANNER-DETECTION) is not yet
    // shipped; this filename probe is a narrow stand-in until then.
    // V1-FINDER-2.2.1-SETTIMEOUT-VENDOR-FILE-GATE.

    it("annotates `bootstrap.js` with a vendor-bundle hint", () => {
      const out = runFinder(finder, `setTimeout(function(){},2000);`, {
        filePath: "vendor/bootstrap.js",
      });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("vendor library bundle name");
      expect(hit?.reason).toContain("`bootstrap`");
      expect(hit?.reason).toContain("third-party library internals");
    });

    it("annotates version-suffixed jQuery (`jquery-1.10.2.js`)", () => {
      const out = runFinder(finder, `setTimeout(function(){},5000);`, {
        filePath: "static/vendor/jquery-1.10.2.js",
      });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("vendor library bundle name");
      expect(hit?.reason).toContain("`jquery`");
    });

    it("annotates several canonical vendor names", () => {
      const cases: readonly { readonly file: string; readonly lib: string }[] = [
        { file: "vendor/popper.js", lib: "popper" },
        { file: "vendor/tether.js", lib: "tether" },
        { file: "vendor/lodash.js", lib: "lodash" },
        { file: "vendor/swiper-9.0.0.js", lib: "swiper" },
        { file: "vendor/slick.js", lib: "slick" },
        { file: "vendor/jquery-ui.js", lib: "jquery-ui" },
      ];
      for (const { file, lib } of cases) {
        const out = runFinder(finder, `setTimeout(function(){},1000);`, { filePath: file });
        const hit = out.find((c) => c.reason.includes("setTimeout"));
        expect(hit?.reason).toContain(`\`${lib}\``);
        expect(hit?.reason).toContain("vendor library bundle name");
      }
    });

    it("matches case-insensitively (Windows-style downloads)", () => {
      const out = runFinder(finder, `setTimeout(function(){},1000);`, {
        filePath: "vendor/Bootstrap.js",
      });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("vendor library bundle name");
    });

    it("does NOT annotate ordinary user files", () => {
      const out = runFinder(finder, `setTimeout(() => tick(), 300);`, {
        filePath: "src/components/Carousel.tsx",
      });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit).toBeDefined();
      expect(hit?.reason).not.toContain("vendor library bundle");
    });

    it("does NOT annotate files whose basename merely contains a library name", () => {
      // `bootstrap-config.js` / `myJqueryHelpers.js` / `lodashy.js`
      // are user files whose names start with or contain a library
      // name but are not vendor drops. The pattern requires the
      // basename to BE the library (with an optional version suffix
      // separated by `.`/`-`/`_`) — substring matches don't trigger.
      const cases: readonly string[] = [
        "src/myJqueryHelpers.js",
        "src/lodashy.js",
        "src/popperWrapper.js",
      ];
      for (const file of cases) {
        const out = runFinder(finder, `setTimeout(() => tick(), 300);`, { filePath: file });
        const hit = out.find((c) => c.reason.includes("setTimeout"));
        expect(hit?.reason).not.toContain("vendor library bundle");
      }
    });

    it("the candidate is NOT suppressed or downgraded — confidence stays medium", () => {
      // Doctrine pin: filename enrichment is annotation, not
      // suppression. Even when the vendor clause fires, the candidate
      // surfaces at the same confidence the call-site evidence earned
      // (medium for setTimeout/setInterval), and every wcag22:2.2.1
      // criterion remains attached.
      const out = runFinder(finder, `setTimeout(function(){},2000);`, {
        filePath: "vendor/bootstrap.js",
      });
      const hit = out.find(
        (c) => c.criterionId === "wcag22:2.2.1" && c.reason.includes("setTimeout"),
      );
      expect(hit).toBeDefined();
      expect(hit?.confidence).toBe("medium");
    });

    it("composes with the duration-class clause when both apply", () => {
      // Real-world shape: the vendor bundle uses a member-access
      // duration. Both clauses should fire so the agent has full
      // dismissal vocabulary.
      const src = `
        function bootstrap() {
          var self = this;
          setTimeout(function() { self._tick(); }, self.options.interval);
        }
      `;
      const out = runFinder(finder, src, { filePath: "vendor/bootstrap.js" });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("member-access reference");
      expect(hit?.reason).toContain("vendor library bundle name");
    });
  });

  describe("minified-file locator enrichment", () => {
    // When the cited file is a minified bundle (`.min.` infix OR a
    // single line > 1000 chars), the bare `line:column` pointer is
    // unhelpful — on a 6-line file where line 6 is 50 KB, eight
    // setTimeout calls on that line all point at "col 1" visually even
    // though their underlying column values differ. The enrichment
    // restates the offset as a byte-column within the enclosing line
    // and echoes a ~80-char context window so the agent can locate
    // the specific call without guessing. Reason-text enrichment per
    // ai-first-consumer.md — no severity change, candidate stays in
    // the primary list. Q6-MINIFIED-FILE-SNIPPET-COLUMN-ENRICHMENT.

    it("enriches reason when the basename carries a `.min.` infix", () => {
      // Short source (single-line but under the 1000-char threshold) —
      // the filename infix alone triggers the enrichment.
      const src = `var x=1;setTimeout(function(){},2000);var y=2;`;
      const out = runFinder(finder, src, { filePath: "vendor/bootstrap.min.js" });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("minified file — match at byte col");
      expect(hit?.reason).toContain("setTimeout(function");
    });

    it("enriches reason when a single line exceeds 1000 chars (no .min. in name)", () => {
      // Simulate a minified bundle whose basename happens NOT to carry
      // `.min.` (e.g. a concatenated vendor dump under `dist/`). The
      // single-long-line heuristic still earns the enrichment.
      const filler = `var pad=[${"0,".repeat(600)}0];`;
      const src = `${filler}setTimeout(function(){},5000);var end=1;`;
      expect(src.length).toBeGreaterThan(1000);
      const out = runFinder(finder, src, { filePath: "dist/bundle.js" });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("minified file — match at byte col");
    });

    it("does NOT enrich on ordinary authored multi-line files", () => {
      const src = `function boot() {\n  setTimeout(() => tick(), 300);\n}\n`;
      const out = runFinder(finder, src, { filePath: "src/boot.js" });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit).toBeDefined();
      expect(hit?.reason).not.toContain("minified file — match at byte col");
    });

    it("does NOT enrich on short single-line authored files", () => {
      // A one-line authored source under the 1000-char threshold (and
      // with no `.min.` in the path) stays un-enriched — the enrichment
      // only earns its place when the pointer is definitionally
      // unhelpful. The column field on the candidate is already the
      // byte-offset-from-start; restating it as "minified file" prose
      // would be misleading on an ordinary one-liner.
      const src = `setTimeout(() => tick(), 100);`;
      const out = runFinder(finder, src, { filePath: "src/util.js" });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit).toBeDefined();
      expect(hit?.reason).not.toContain("minified file");
    });

    it("two same-line matches get distinct byte-col offsets in the reason", () => {
      // Regression: the bug in the field report was eight `setTimeout`
      // calls on line 6 all displaying as "col 1" — the agent could
      // not disambiguate among them. After enrichment, the reason
      // text carries per-match byte columns that vary with each call
      // site, so the candidates are distinguishable on reason alone.
      // Use an interior semicolon to ensure `\b` re-engages between the
      // two call sites (the `setTimeout` regex requires a word boundary
      // before the identifier).
      const src =
        `var a=1;setTimeout(function(){a++;},100);` +
        "var b=2;".repeat(40) +
        `;setTimeout(function(){a++;},200);`;
      const out = runFinder(finder, src, { filePath: "lib.min.js" });
      const hits = out
        .filter((c) => c.criterionId === "wcag22:2.2.1")
        .filter((c) => c.reason.includes("setTimeout"));
      expect(hits.length).toBeGreaterThanOrEqual(2);
      const byteCols = new Set(
        hits.map((c) => /byte col (\d+)/.exec(c.reason)?.[1]).filter(Boolean),
      );
      expect(byteCols.size).toBeGreaterThanOrEqual(2);
    });

    it("keeps the normative review prompt alongside the minified clause", () => {
      const src = `var x=1;setTimeout(function(){},2000);`;
      const out = runFinder(finder, src, { filePath: "vendor/jquery.min.js" });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("verify the user can pause, extend, or disable");
      expect(hit?.reason).toContain("minified file");
    });

    it("preserves duration + enclosing clauses before the minified clause", () => {
      const src = `var x=1;function run(){setTimeout(function(){tick();},4000);}`;
      const out = runFinder(finder, src, { filePath: "vendor/app.min.js" });
      const hit = out.find((c) => c.reason.includes("setTimeout"));
      expect(hit?.reason).toContain("duration `4000`");
      expect(hit?.reason).toContain("in `run()`");
      // The minified clause suffix comes after existing enrichment.
      const reason = hit?.reason ?? "";
      const durationIdx = reason.indexOf("duration `4000`");
      const minIdx = reason.indexOf("minified file");
      expect(durationIdx).toBeGreaterThan(-1);
      expect(minIdx).toBeGreaterThan(durationIdx);
    });
  });
});
