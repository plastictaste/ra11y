/**
 * Tests for `buildSuggestFixPayload` — specifically Q2-VERIFYCMD, which
 * adds `verifyCommand` (prose) + `verifyCommandStructured` ({ tool:
 * "scan_file", args: { file, ruleId } }) to every response, regardless
 * of `kind`. Both fields are always populated — no conditional-spread —
 * because a suggest_fix response without a re-verify is never
 * meaningful.
 *
 * Other shape concerns around this function (mechanical edits, widened
 * anchors, caveats, snippet omission) are covered by
 * tests/unit/mcp/unique-anchor.test.ts and the integration suite in
 * tests/integration/mcp-tools.test.ts. This file focuses on the
 * verifyCommand fields.
 */

import { describe, expect, it } from "bun:test";

import {
  type BuildSuggestFixPayloadArgs,
  buildSuggestFixPayload,
  buildVerifyCommand,
} from "../../../src/mcp/tool-suggest-fix-internals.ts";
import type { Violation } from "../../../src/types/violation.ts";

const FILE_PATH = "src/components/Button.tsx";
const RULE_ID = "keyboard/handler-missing";

function violationWithFixPaths(overrides?: Partial<Violation>): Violation {
  return {
    ruleId: RULE_ID,
    fixClass: "mechanical",
    criteria: ["wcag22:2.1.1"],
    severity: "error",
    location: { filePath: FILE_PATH, line: 3, column: 1 },
    message: "Click handler without keyboard equivalent.",
    suggestion: "Add onKeyDown handler alongside onClick.",
    findingId: "abc123def456",
    groupKey: "def456abc123",
    fixPaths: {
      primary: {
        label: "Add onKeyDown sibling",
        edit: {
          oldText: "<div onClick={fn}>Click</div>",
          newText: "<div onClick={fn} onKeyDown={fn}>Click</div>",
        },
      },
      alternatives: [{ label: "Use a <button> element" }],
    },
    ...overrides,
  };
}

function violationGuidanceOnly(overrides?: Partial<Violation>): Violation {
  return {
    ruleId: RULE_ID,
    fixClass: "guidance",
    criteria: ["wcag22:2.1.1"],
    severity: "warning",
    location: { filePath: FILE_PATH, line: 3, column: 1 },
    message: "Interactive element lacks keyboard handler.",
    suggestion: "Review the surrounding context and add keyboard support.",
    findingId: "abc123def456",
    groupKey: "def456abc123",
    ...overrides,
  };
}

function baseArgs(
  match: Violation | undefined,
  overrides?: Partial<BuildSuggestFixPayloadArgs>,
): BuildSuggestFixPayloadArgs {
  return {
    ruleId: RULE_ID,
    line: 3,
    match,
    sourceContext: "line 1\nline 2\n<div onClick={fn}>Click</div>\nline 4\nline 5",
    source: "const x = 1;\nconst y = 2;\n<div onClick={fn}>Click</div>\nconst z = 3;\n",
    filePath: FILE_PATH,
    ...overrides,
  };
}

describe("buildVerifyCommand", () => {
  it("produces a scan_file-shaped structured hint with the given file + ruleId", () => {
    const result = buildVerifyCommand(FILE_PATH, RULE_ID);
    expect(result.verifyCommandStructured).toEqual({
      tool: "scan_file",
      args: { path: FILE_PATH },
      verifyRuleId: RULE_ID,
    });
  });

  it("names scan_file (not scan_project) in the prose — narrowest verify surface", () => {
    const result = buildVerifyCommand(FILE_PATH, RULE_ID);
    expect(result.verifyCommand).toContain("scan_file");
    expect(result.verifyCommand).not.toContain("scan_project");
  });

  it("quotes the file path in the prose so agents copy it verbatim", () => {
    const result = buildVerifyCommand(FILE_PATH, RULE_ID);
    expect(result.verifyCommand).toContain(JSON.stringify(FILE_PATH));
  });

  it("includes the ruleId in the prose so the agent knows what to re-check", () => {
    const result = buildVerifyCommand(FILE_PATH, RULE_ID);
    expect(result.verifyCommand).toContain(RULE_ID);
  });
});

describe("buildSuggestFixPayload — verifyCommand on kind: 'edit'", () => {
  it("emits both verifyCommand + verifyCommandStructured when a mechanical edit is available", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    expect(payload["kind"]).toBe("edit");
    expect(typeof payload["verifyCommand"]).toBe("string");
    expect((payload["verifyCommand"] as string).length).toBeGreaterThan(0);
    expect(payload["verifyCommandStructured"]).toEqual({
      tool: "scan_file",
      args: { path: FILE_PATH },
      verifyRuleId: RULE_ID,
    });
  });

  it("verifyCommandStructured.tool is exactly 'scan_file'", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    const structured = payload["verifyCommandStructured"] as { tool: string };
    expect(structured.tool).toBe("scan_file");
  });

  it("verifyCommandStructured.args.path matches the input filePath exactly", () => {
    const customPath = "packages/ui/src/widgets/Toolbar.tsx";
    const payload = buildSuggestFixPayload(
      baseArgs(violationWithFixPaths(), { filePath: customPath }),
    );
    const structured = payload["verifyCommandStructured"] as {
      args: { path: string };
    };
    expect(structured.args.path).toBe(customPath);
  });

  it("verifyCommandStructured.verifyRuleId is a sibling of args (not inside args)", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    const structured = payload["verifyCommandStructured"] as {
      verifyRuleId?: string;
      args: Record<string, unknown>;
    };
    expect(structured.verifyRuleId).toBe(RULE_ID);
    expect(structured.args).not.toHaveProperty("ruleId");
  });
});

describe("buildSuggestFixPayload — verifyCommand on kind: 'guidance'", () => {
  it("emits both fields when the response is guidance-only (no mechanical edit)", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    expect(payload["kind"]).toBe("guidance");
    expect(typeof payload["verifyCommand"]).toBe("string");
    expect(payload["verifyCommandStructured"]).toEqual({
      tool: "scan_file",
      args: { path: FILE_PATH },
      verifyRuleId: RULE_ID,
    });
  });

  it("emits both fields when fixPaths exist but no mechanical primary.edit is present", () => {
    // A fixPaths with labels-only primary should fall into the
    // `kind: "guidance"` branch of the `fixPaths` block — exercise
    // that the verify fields still attach there.
    const match = violationWithFixPaths({
      fixPaths: {
        primary: { label: "Review cross-file handler binding" },
        alternatives: [{ label: "Use a semantic element" }],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(typeof payload["verifyCommand"]).toBe("string");
    expect(payload["verifyCommandStructured"]).toEqual({
      tool: "scan_file",
      args: { path: FILE_PATH },
      verifyRuleId: RULE_ID,
    });
  });
});

describe("buildSuggestFixPayload — verifyCommand on kind: 'none'", () => {
  it("emits both fields even when no violation matches at the requested line", () => {
    // `kind: "none"` is still a meaningful response — the agent may
    // want to re-verify the file after inspecting other lines or
    // after an unrelated edit. The verify hint is always honest.
    const payload = buildSuggestFixPayload(baseArgs(undefined));
    expect(payload["kind"]).toBe("none");
    expect(typeof payload["verifyCommand"]).toBe("string");
    expect(payload["verifyCommandStructured"]).toEqual({
      tool: "scan_file",
      args: { path: FILE_PATH },
      verifyRuleId: RULE_ID,
    });
  });
});

describe("buildSuggestFixPayload — response-level `warnings` plumbing", () => {
  // Doctrine (CLAUDE.md §1 "Zero-output success is ambiguous failure"):
  // suggest_fix surfaces scan-confidence codes under a single
  // response-level `warnings` field. The payload builder is pure — it
  // forwards the caller-supplied array verbatim and conditional-spreads
  // so an empty or undefined input omits the field entirely (never
  // `warnings: []`).
  it("forwards the caller-supplied warnings array verbatim on kind: 'edit'", () => {
    const payload = buildSuggestFixPayload(
      baseArgs(violationWithFixPaths(), { warnings: ["scanned_zero_files"] }),
    );
    expect(payload["kind"]).toBe("edit");
    expect(payload["warnings"]).toEqual(["scanned_zero_files"]);
  });

  it("forwards the warnings array on kind: 'guidance'", () => {
    const payload = buildSuggestFixPayload(
      baseArgs(violationGuidanceOnly(), { warnings: ["scanned_zero_files"] }),
    );
    expect(payload["kind"]).toBe("guidance");
    expect(payload["warnings"]).toEqual(["scanned_zero_files"]);
  });

  it("forwards the warnings array on kind: 'none'", () => {
    const payload = buildSuggestFixPayload(
      baseArgs(undefined, { warnings: ["scanned_zero_files"] }),
    );
    expect(payload["kind"]).toBe("none");
    expect(payload["warnings"]).toEqual(["scanned_zero_files"]);
  });

  it("omits the `warnings` field entirely when the caller passes undefined", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    expect(payload).not.toHaveProperty("warnings");
  });

  it("omits the `warnings` field entirely when the caller passes an empty array (never `warnings: []`)", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths(), { warnings: [] }));
    expect(payload).not.toHaveProperty("warnings");
  });
});

describe("buildSuggestFixPayload — kind: 'guidance' primary/alternatives shape (Q-SHARED-SUGGEST-FIX-GUIDANCE-PRIMARY)", () => {
  // Doctrine (CLAUDE.md §1 "Ambiguous field shapes are dishonest" +
  // tool description promise): `kind: "guidance"` responses nest the
  // ranked fix under `primary: { approach, explanation, sourceContext,
  // confidence }` to match the advertised shape. `alternatives` is
  // present-when-meaningful — omitted when only one approach is
  // reasonable. `verifyCommand` + `verifyCommandStructured` stay at
  // top level.

  it("no-fixPaths guidance: nests explanation + sourceContext + confidence under primary", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as {
      approach: string;
      explanation: string;
      sourceContext: string;
      confidence: string;
    };
    expect(typeof primary.approach).toBe("string");
    expect(primary.approach.length).toBeGreaterThan(0);
    expect(primary.explanation).toBe("Review the surrounding context and add keyboard support.");
    expect(typeof primary.sourceContext).toBe("string");
    expect(primary.confidence).toBe("medium");
  });

  it("no-fixPaths guidance: top-level does NOT carry a duplicate explanation or sourceContext", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    expect(payload).not.toHaveProperty("explanation");
    expect(payload).not.toHaveProperty("sourceContext");
  });

  it("no-fixPaths guidance: omits alternatives entirely (single-approach case is the common one)", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    expect(payload).not.toHaveProperty("alternatives");
  });

  it("no-fixPaths guidance: approach is a terse label derived from the prose", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    const primary = payload["primary"] as { approach: string };
    // First-sentence derivation strips the trailing period.
    expect(primary.approach).toBe("Review the surrounding context and add keyboard support");
  });

  it("fixPaths-guidance (no mechanical edit): primary carries the path label as approach", () => {
    const match = violationWithFixPaths({
      fixPaths: {
        primary: { label: "Review cross-file handler binding" },
        alternatives: [{ label: "Use a semantic element" }],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as {
      approach: string;
      explanation: string;
      confidence: string;
    };
    expect(primary.approach).toBe("Review cross-file handler binding");
    expect(typeof primary.explanation).toBe("string");
    expect(primary.confidence).toBe("high");
  });

  it("fixPaths-guidance with alternatives: emits alternatives[] with approach + explanation per entry", () => {
    const match = violationWithFixPaths({
      fixPaths: {
        primary: { label: "Review cross-file handler binding" },
        alternatives: [
          { label: "Use a semantic element" },
          { label: "Attach handler to an outer control" },
        ],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    const alternatives = payload["alternatives"] as ReadonlyArray<{
      approach: string;
      explanation: string;
    }>;
    expect(Array.isArray(alternatives)).toBe(true);
    expect(alternatives).toHaveLength(2);
    expect(alternatives[0]?.approach).toBe("Use a semantic element");
    expect(typeof alternatives[0]?.explanation).toBe("string");
    expect(alternatives[1]?.approach).toBe("Attach handler to an outer control");
  });

  it("fixPaths-guidance with empty alternatives: omits the alternatives field entirely", () => {
    const match = violationWithFixPaths({
      fixPaths: {
        primary: { label: "Review cross-file handler binding" },
        alternatives: [],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload).not.toHaveProperty("alternatives");
  });

  it("guidance: verifyCommand + verifyCommandStructured stay at top level (not under primary)", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    expect(typeof payload["verifyCommand"]).toBe("string");
    expect(payload["verifyCommandStructured"]).toBeDefined();
    const primary = payload["primary"] as Record<string, unknown>;
    expect(primary).not.toHaveProperty("verifyCommand");
    expect(primary).not.toHaveProperty("verifyCommandStructured");
  });

  it("kind: 'edit' retains the flat primary/alternatives FixPath shape (regression guard)", () => {
    // The primary/alternatives nesting change is scoped to the guidance
    // lane. `kind: "edit"` keeps primary as a structured FixPath carrying
    // `label` + `edit` so apply_fix's literal find-and-replace still
    // resolves as before.
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    expect(payload["kind"]).toBe("edit");
    const primary = payload["primary"] as {
      label: string;
      edit?: { oldText: string; newText: string };
    };
    expect(primary.label).toBe("Add onKeyDown sibling");
    expect(primary.edit).toBeDefined();
    expect(payload).toHaveProperty("alternatives");
    // The flat shape preserves top-level `explanation` + `sourceContext`
    // so existing apply_fix consumers keep reading them there.
    expect(typeof payload["explanation"]).toBe("string");
    expect(typeof payload["sourceContext"]).toBe("string");
  });
});

describe("buildSuggestFixPayload — template-directive poisoning of newText", () => {
  // Doctrine (docs/kb/architecture/ai-first-consumer.md
  // "Ambiguous field shapes are dishonest"): a `newText` that
  // interpolates raw Liquid/Jinja/ERB template directives is worse
  // than an omitted edit — an agent applying `primary.edit` verbatim
  // would paste `aria-label="{% for x in y %}..."` into the static
  // file, silently shipping a broken accessible name on every render.
  //
  // `suggest_fix` is the final assembly layer before the response
  // reaches the agent; rules that harvest visible-text may forget to
  // sanitize before synthesizing an edit (Q4 field report on Jekyll
  // `docs_contents_mobile` via `semantics/label-in-name`). The
  // response builder defends the response shape regardless of rule
  // correctness — when `newText` carries template directives, drop
  // the edit and downgrade the outcome to `kind: "guidance"` with a
  // caveat naming the failure mode.
  //
  // `oldText` is intentionally NOT sanitized — it must literal-match
  // the source file, which for a Liquid template legitimately
  // contains `{% … %}` / `{{ … }}`. The poison check targets `newText`
  // only.

  function liquidFixPaths(newText: string): Violation {
    return violationWithFixPaths({
      fixPaths: {
        primary: {
          label: "widen aria-label to include the visible text",
          edit: { oldText: 'aria-label="Choose"', newText },
        },
        alternatives: [{ label: "rephrase aria-label" }],
      },
    });
  }

  it("downgrades kind to 'guidance' when primary.edit.newText contains a `{% … %}` directive", () => {
    const match = liquidFixPaths('aria-label="{% for section in site.data.docs_nav %}Choose"');
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
  });

  it("omits the poisoned edit from primary — never emits a newText containing a Liquid tag", () => {
    const poisoned = 'aria-label="{% for section in site.data.docs_nav %}Choose"';
    const match = liquidFixPaths(poisoned);
    const payload = buildSuggestFixPayload(baseArgs(match));
    const primary = payload["primary"] as { readonly edit?: { readonly newText: string } };
    // No edit field on primary — the poisoned pair was dropped.
    expect(primary.edit).toBeUndefined();
  });

  it("downgrades when primary.edit.newText contains a `{{ … }}` interpolation", () => {
    const match = liquidFixPaths('aria-label="{{ page.title }} Choose"');
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { readonly edit?: unknown };
    expect(primary.edit).toBeUndefined();
  });

  it("downgrades when primary.edit.newText contains an ERB `<% … %>` directive", () => {
    const match = liquidFixPaths('aria-label="<%= title %> Choose"');
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { readonly edit?: unknown };
    expect(primary.edit).toBeUndefined();
  });

  it("emits a `caveat` naming the template-directive poison so the agent learns why the edit was dropped", () => {
    const match = liquidFixPaths('aria-label="{% for section in site.data.docs_nav %}Choose"');
    const payload = buildSuggestFixPayload(baseArgs(match));
    const caveat = payload["caveat"];
    expect(typeof caveat).toBe("string");
    expect(caveat as string).toMatch(/template|directive|liquid/i);
  });

  it("preserves a clean primary.edit when newText has no template directives (regression guard)", () => {
    // Sanity check: the non-poisoned path still produces kind: 'edit'
    // with the normal mechanical newText. Nothing about the poison
    // defense can affect the clean case.
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    expect(payload["kind"]).toBe("edit");
    const primary = payload["primary"] as { readonly edit?: { readonly newText: string } };
    expect(primary.edit).toBeDefined();
    expect(primary.edit?.newText).toContain("onKeyDown");
  });

  it("drops a poisoned `editCandidate` on primary without promoting kind — candidate was never an edit", () => {
    // `editCandidate` is a softer sibling of `edit` — its presence
    // doesn't promote kind to 'edit'. When it carries a template
    // directive it's still dishonest (agents that crib from
    // candidates get the same poison). The field is dropped, kind
    // stays 'guidance'.
    const match = violationWithFixPaths({
      fixPaths: {
        primary: {
          label: "rephrase the label",
          editCandidate: {
            oldText: 'aria-label="Choose"',
            newText: 'aria-label="{% for section in x %} Choose"',
          },
        },
        alternatives: [{ label: "widen aria-label" }],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { readonly editCandidate?: unknown };
    expect(primary.editCandidate).toBeUndefined();
  });

  it("oldText containing directives is allowed — only newText is checked (regression guard)", () => {
    // A Liquid template legitimately has `{% … %}` / `{{ … }}` in
    // source. oldText must literal-match that source, so stripping
    // it would break the find-and-replace. The poison check targets
    // newText only.
    const match = violationWithFixPaths({
      fixPaths: {
        primary: {
          label: "swap aria-hidden for inert",
          edit: {
            oldText: '{% if focused %}aria-hidden="true"{% endif %}',
            newText: "{% if focused %}inert{% endif %}",
          },
        },
        alternatives: [],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    // newText has directives too — this case also downgrades. The
    // underlying rule would have to hand us a genuinely clean newText
    // to keep the edit; the defense is one-sided (target newText
    // only) because that's the field the agent pastes into the file.
    expect(payload["kind"]).toBe("guidance");
  });
});

describe("buildSuggestFixPayload — meta.mechanicalInPrinciple (Q6-SUGGEST-FIX-MECHANICAL-VS-GUIDANCE-DRIFT)", () => {
  // Doctrine (CLAUDE.md §1 "Composite headline counts are dishonest" +
  // "Ambiguous field shapes are dishonest"): the scan's
  // `plan.fixesByClass.mechanical` counts rules with `fixClass:
  // "mechanical"` (and `safeEditsAvailable` also covers
  // `verify-in-source` when an inline edit is shipped). But
  // `suggest_fix` on a specific finding may return `kind: "guidance"`
  // because the rule didn't emit `fixPaths` for that finding's
  // context. The two surfaces appear to contradict unless the
  // guidance response signals "the rule family supports a mechanical
  // path in principle." That signal is `meta.mechanicalInPrinciple:
  // true`, present-when-true only (conditional-spread).
  //
  // Concrete case that motivated this: `navigation/href-javascript-void`
  // is `fixClass: "verify-in-source"` and ships no `fixPaths`, so
  // `suggest_fix` falls into the prose-only guidance branch. The rule
  // lives in a source-edit lane in principle; agents need that signal
  // so they don't read "guidance" as "nothing mechanical is possible."

  it("no-fixPaths guidance: emits meta.mechanicalInPrinciple when match.fixClass is 'verify-in-source'", () => {
    // Concrete navigation/href-javascript-void case — prose-only
    // suggestion, rule lane is verify-in-source.
    const match = violationGuidanceOnly({
      ruleId: "navigation/href-javascript-void",
      fixClass: "verify-in-source",
      suggestion:
        'change `<a href="javascript:void(0)">` to `<button type="button">` — this control does not navigate, so it should announce as a button.',
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload["meta"]).toEqual({ mechanicalInPrinciple: true });
  });

  it("no-fixPaths guidance: emits meta.mechanicalInPrinciple when match.fixClass is 'mechanical'", () => {
    // A mechanical-class rule that for some reason didn't ship
    // fixPaths (e.g. a context the rule declined to synthesize for).
    // The cross-surface consistency signal still fires.
    const match = violationGuidanceOnly({ fixClass: "mechanical" });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload["meta"]).toEqual({ mechanicalInPrinciple: true });
  });

  it("no-fixPaths guidance: OMITS the meta field when match.fixClass is 'guidance'", () => {
    // `fixClass: "guidance"` is honestly guidance — nothing in
    // principle lives in a source-edit lane. The field is absent,
    // never `mechanicalInPrinciple: false`, per the present-when-
    // meaningful rule.
    const match = violationGuidanceOnly({ fixClass: "guidance" });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload).not.toHaveProperty("meta");
  });

  it("no-fixPaths guidance: OMITS the meta field when match.fixClass is 'runtime-only'", () => {
    const match = violationGuidanceOnly({ fixClass: "runtime-only" });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload).not.toHaveProperty("meta");
  });

  it("fixPaths-guidance (no mechanical edit): emits meta.mechanicalInPrinciple when fixClass is 'verify-in-source'", () => {
    // fixPaths present but no primary.edit → falls into the fixPaths
    // branch's guidance lane. Same in-principle signal applies.
    const match = violationWithFixPaths({
      fixClass: "verify-in-source",
      fixPaths: {
        primary: { label: "Review cross-file handler binding" },
        alternatives: [{ label: "Use a semantic element" }],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload["meta"]).toEqual({ mechanicalInPrinciple: true });
  });

  it("fixPaths-guidance (no mechanical edit): OMITS meta when fixClass is 'guidance'", () => {
    const match = violationWithFixPaths({
      fixClass: "guidance",
      fixPaths: {
        primary: { label: "Rewrite the surrounding copy" },
        alternatives: [],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload).not.toHaveProperty("meta");
  });

  it("kind: 'edit' with mechanical fixClass: OMITS the meta field (the edit is concrete)", () => {
    // The `kind: "edit"` lane has already shipped a concrete
    // newText; the in-principle hint would be noise there. The
    // signal is scoped to the guidance lane.
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    expect(payload["kind"]).toBe("edit");
    expect(payload).not.toHaveProperty("meta");
  });

  it("kind: 'none': OMITS the meta field (no match to classify)", () => {
    const payload = buildSuggestFixPayload(baseArgs(undefined));
    expect(payload["kind"]).toBe("none");
    expect(payload).not.toHaveProperty("meta");
  });

  it("poisoned-newText downgrade: emits meta.mechanicalInPrinciple when fixClass is 'mechanical'", () => {
    // A mechanical-class rule whose fixPaths shipped a poisoned
    // primary.edit drops into the fixpaths-branch guidance lane via
    // the template-directive sanitizer. The rule family still lives
    // in the mechanical lane — the signal fires.
    const match = violationWithFixPaths({
      fixClass: "mechanical",
      fixPaths: {
        primary: {
          label: "widen aria-label to include the visible text",
          edit: {
            oldText: 'aria-label="Choose"',
            newText: 'aria-label="{% for section in site.data.docs_nav %}Choose"',
          },
        },
        alternatives: [],
      },
    });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["kind"]).toBe("guidance");
    expect(payload["meta"]).toEqual({ mechanicalInPrinciple: true });
  });

  it("meta is a sibling of primary/verifyCommand — never nested under primary", () => {
    const match = violationGuidanceOnly({ fixClass: "mechanical" });
    const payload = buildSuggestFixPayload(baseArgs(match));
    expect(payload["meta"]).toEqual({ mechanicalInPrinciple: true });
    const primary = payload["primary"] as Record<string, unknown>;
    expect(primary).not.toHaveProperty("meta");
    expect(primary).not.toHaveProperty("mechanicalInPrinciple");
  });
});
