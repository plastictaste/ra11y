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
      args: { file: FILE_PATH, ruleId: RULE_ID },
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
      args: { file: FILE_PATH, ruleId: RULE_ID },
    });
  });

  it("verifyCommandStructured.tool is exactly 'scan_file'", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    const structured = payload["verifyCommandStructured"] as { tool: string };
    expect(structured.tool).toBe("scan_file");
  });

  it("verifyCommandStructured.args.file matches the input filePath exactly", () => {
    const customPath = "packages/ui/src/widgets/Toolbar.tsx";
    const payload = buildSuggestFixPayload(
      baseArgs(violationWithFixPaths(), { filePath: customPath }),
    );
    const structured = payload["verifyCommandStructured"] as {
      args: { file: string };
    };
    expect(structured.args.file).toBe(customPath);
  });

  it("verifyCommandStructured.args.ruleId is included when the rule is known", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationWithFixPaths()));
    const structured = payload["verifyCommandStructured"] as {
      args: { ruleId?: string };
    };
    expect(structured.args.ruleId).toBe(RULE_ID);
  });
});

describe("buildSuggestFixPayload — verifyCommand on kind: 'guidance'", () => {
  it("emits both fields when the response is guidance-only (no mechanical edit)", () => {
    const payload = buildSuggestFixPayload(baseArgs(violationGuidanceOnly()));
    expect(payload["kind"]).toBe("guidance");
    expect(typeof payload["verifyCommand"]).toBe("string");
    expect(payload["verifyCommandStructured"]).toEqual({
      tool: "scan_file",
      args: { file: FILE_PATH, ruleId: RULE_ID },
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
      args: { file: FILE_PATH, ruleId: RULE_ID },
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
      args: { file: FILE_PATH, ruleId: RULE_ID },
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
