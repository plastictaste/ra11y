/**
 * scan_file caller's notes-only nextStep handoff.
 *
 * Extracted from `next-step.ts` so the file stays under the limits
 * budget. When `buildNextStep` is invoked with `singleFilePath` and
 * the response carries zero error/warning findings (only info-severity
 * notes), the default scan_file-on-first-finding routing would echo
 * the caller's exact arguments and form a self-loop. Per
 * docs/kb/architecture/ai-first-consumer.md "NextStep handoffs must
 * terminate at a narrowing tool, never form a cycle." Route to
 * `checklist` when review-candidates exist on the file (manual-
 * review evidence is the next decision the agent can make); else
 * route to `suggest_fix` on the first info-level finding so the
 * agent inspects per-finding evidence directly.
 *
 * The `scan` tool path (no `singleFilePath`) keeps scan_file-on-first-
 * finding because that's a child-tool handoff, not a self-loop, and
 * that branch lives in the parent `notesNextStep` caller.
 */

interface NextStepStructuredShape {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

interface NextStepResultShape {
  readonly prose: string;
  readonly structured?: NextStepStructuredShape;
}

interface FirstFindingShape {
  readonly path: string;
  readonly line: number;
  readonly ruleId: string;
}

/**
 * Returns the prose+structured pair that breaks the self-loop on a
 * scan_file notes-only response. Called only from `notesNextStep` in
 * `next-step.ts` after the caller's predicate has already confirmed
 * `singleFilePath === first.path`.
 */
export function scanFileNotesNoSelfLoopResult(args: {
  readonly first: FirstFindingShape;
  readonly notes: number;
  readonly actionableManual: number;
  readonly iterativeTip: string;
  readonly head: string;
  readonly nPlural: string;
}): NextStepResultShape {
  if (args.actionableManual > 0) {
    const mPlural = args.actionableManual === 1 ? "" : "s";
    return {
      prose: `${args.head} Call \`checklist\` for the ${args.actionableManual} grounded manual-review item${mPlural}, or read the source to resolve the info note${args.nPlural}.${args.iterativeTip}`,
      structured: { tool: "checklist", args: {} },
    };
  }
  return {
    prose: `${args.head} Call \`suggest_fix\` on \`${args.first.ruleId}\` at ${args.first.path}:${args.first.line} for the inline fix surface, or read the source directly.${args.iterativeTip}`,
    structured: {
      tool: "suggest_fix",
      args: {
        ruleId: args.first.ruleId,
        file: args.first.path,
        line: args.first.line,
      },
    },
  };
}
