/**
 * Builds per-file RuleContext objects consumed by rules.
 *
 * The engine calls `buildContext()` once per parsed file, passing in the
 * file path, source, parsed AST, and enabled standards. Rules receive a
 * narrow, read-only view that lets them emit violations and check inline
 * disable pragmas. Cross-rule state is intentionally not exposed — rules
 * are pure functions that see exactly what they need.
 */

import type { Ast, JsxElement } from "../types/ast.ts";
import type {
  EmittedViolation,
  Language,
  PolymorphicResolution,
  RuleContext,
} from "../types/rule.ts";
import { resolvePolymorphicTag } from "./ast-helpers.ts";

export interface ContextInput {
  readonly filePath: string;
  readonly source: string;
  readonly ast: Ast;
  readonly enabledStandards: ReadonlySet<string>;
  readonly disableMap: ReadonlyMap<number, ReadonlySet<string>>;
  /**
   * Resolved `LoadedConfig.nativeWrapperElements` passed through from the
   * scan-level config — wrapper component name → native element tag
   * (`{ Button: "button", Link: "a" }`). Empty or absent when the user
   * supplied only the string-array form or no `nativeWrappers` at all.
   * Per-rule access is via {@link RuleContext.wrappersForElement}, filtered
   * against the rule's `wrapperTreatsAsElement` target.
   */
  readonly nativeWrapperElements?: Readonly<Record<string, string>>;
}

/**
 * Engine-internal hook the rule runner passes through `buildContext` so
 * {@link RuleContext.markCrossFileCandidate} can bump the per-rule
 * `crossFileCandidates` counter on the active tracker. The runner is
 * the only caller that supplies one; unit tests that build a context
 * directly omit it and the method becomes a no-op.
 */
export type CrossFileCandidateMarker = () => void;

/**
 * Builds a fresh RuleContext. The returned object's `emit` pushes into
 * the supplied array. `wrapperTreatsAsElement` is the per-rule opt-in
 * tag (`"a"`, `"img"`, `"input"`) — when set, the resulting context's
 * `wrappersForElement` carries the wrapper component names whose
 * `nativeWrapperElements` mapping targets that tag. When unset, the set
 * is always empty and the rule sees identical behaviour to pre-.
 *
 * `markCrossFileCandidate`, when supplied by the rule runner, lets a
 * rule signal "I observed a cross-file-resolution-candidate token on
 * this file" — the per-rule-coverage builder gates the
 * `crossFileCapable: false` confidence downgrade on that signal so a
 * rule that never observed any candidate token stays at `"high"`
 * confidence (instead of defaulting to a pessimistic `"medium"`).
 */
export function buildContext(
  input: ContextInput,
  violationSink: EmittedViolation[],
  wrapperTreatsAsElement?: string,
  markCrossFileCandidate?: CrossFileCandidateMarker,
): RuleContext {
  const language = input.ast.language as Language;
  const wrappersForElement = resolveWrappersForElement(
    input.nativeWrapperElements,
    wrapperTreatsAsElement,
  );
  const ctx: RuleContext = {
    filePath: input.filePath,
    source: input.source,
    language,
    ast: input.ast.root,
    enabledStandards: input.enabledStandards,
    wrappersForElement,
    resolvePolymorphic(element: unknown): PolymorphicResolution {
      return resolvePolymorphicTag(element as JsxElement);
    },
    emit(violation: EmittedViolation): void {
      violationSink.push(violation);
    },
    isDisabled(line: number, ruleId: string): boolean {
      const disabled = input.disableMap.get(line);
      if (!disabled) return false;
      // Either an exact rule-id match or a wildcard entry for "disable all".
      return disabled.has(ruleId) || disabled.has("*");
    },
    ...(markCrossFileCandidate ? { markCrossFileCandidate } : {}),
  };
  return ctx;
}

/**
 * Filters the full `nativeWrapperElements` map down to wrapper component
 * names whose mapped native tag equals the rule's opted-in tag. Returns
 * an empty set when no opt-in was declared, no map was supplied, or no
 * entry matches — rules that don't opt in see the same shape as before
 * the mapping config was added.
 */
function resolveWrappersForElement(
  map: Readonly<Record<string, string>> | undefined,
  wrapperTreatsAsElement: string | undefined,
): ReadonlySet<string> {
  if (!(wrapperTreatsAsElement && map)) return EMPTY_WRAPPER_SET;
  const target = wrapperTreatsAsElement.toLowerCase();
  const matched = new Set<string>();
  for (const [name, element] of Object.entries(map)) {
    if (element.toLowerCase() === target) matched.add(name);
  }
  return matched.size === 0 ? EMPTY_WRAPPER_SET : matched;
}

/** Shared empty set — avoids allocating an unused `Set` per rule/file. */
const EMPTY_WRAPPER_SET: ReadonlySet<string> = new Set<string>();
