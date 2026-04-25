/**
 * Rule-ID alias resolver.
 *
 * Backs the rename-behind-alias semver carve-out in CLAUDE.md §12:
 * before this seam existed, renaming a rule was major — its ID stopped
 * being honored in suppression pragmas, `ra11y.config.ts`, CLI `--rules`
 * flags, and every other user-input path that names a rule. With the
 * resolver in place, an old ID stays accepted for a deprecation window
 * and every resolution emits a structured `deprecated_rule_id:<old>:<new>`
 * warning so agents can offer to rewrite the reference. No quiet
 * aliasing — the warning is the contract.
 *
 * Matches the shape every mainstream linter settled on (ESLint, Biome,
 * Stylelint, axe-core) — a tiny frozen table of `{ from, to,
 * deprecatedSince, removeIn }` records. The table is empty until the
 * first rename; the first consumer is V1-RULE-NAVIGATION-HREF-VOID-RENAME.
 *
 * The resolver is a pure function over its input + the frozen table.
 * Callers branch on the optional `deprecated` field to decide whether
 * to attach the warning string to their response's warnings channel.
 * The caller owns the emission because the warnings channel on each
 * tool is already strongly typed to that tool's vocabulary — the
 * resolver stays free of MCP-surface coupling.
 *
 * Doctrine: "Surface, don't suppress" (see
 * `docs/kb/architecture/ai-first-consumer.md`). The old ID keeps
 * working — rejecting it would silently break downstream tooling that
 * still references it — but the warning makes the rewrite path visible
 * in every response that touched an alias.
 */

/**
 * One alias entry. `from` is the old ID that still parses; `to` is the
 * current canonical ID. `deprecatedSince` and `removeIn` are semver
 * strings surfaced back through `list_rules` so an agent planning a
 * rewrite knows the window — `deprecatedSince` is the version that
 * introduced the alias, `removeIn` is the version the alias will be
 * dropped (and the rename becomes a hard break again).
 */
export interface RuleAlias {
  readonly from: string;
  readonly to: string;
  readonly deprecatedSince: string;
  readonly removeIn: string;
}

/**
 * Frozen alias table. Add new renames here as `{ from, to,
 * deprecatedSince, removeIn }`. Order doesn't matter — `resolveRuleId`
 * does an O(n) scan and the table is small by construction (one entry
 * per active rename). Keep duplicates out: a given `from` must have at
 * most one live entry. Chaining (A → B → C) is not supported; if B is
 * itself renamed to C, change A's `to` to C in the same commit that
 * retires B so the alias table stays a one-hop map.
 */
export const RULE_ALIASES: readonly RuleAlias[] = Object.freeze([]);

/**
 * Result of a rule-ID resolution. `resolved` is the ID callers should
 * use downstream (the registry lookup key, the pragma token that
 * controls suppression, the config.rules map key after normalization).
 * `deprecated` is populated only when the input was an old ID that the
 * table rewrote to `resolved`; callers omit the warning when this
 * field is absent.
 */
export interface ResolvedRuleId {
  readonly resolved: string;
  readonly deprecated?: RuleAlias;
}

/**
 * Resolves a user-supplied rule ID through the alias table.
 *
 * Pure function: given the same input and the same frozen table, the
 * output is identical. No I/O, no globals, no side effects.
 *
 * When `input` matches an alias's `from`, returns the alias's `to`
 * plus the full alias record so the caller can format the warning. When
 * `input` does not match any alias, returns `{ resolved: input }` with
 * no `deprecated` field — the caller proceeds with the input unchanged.
 *
 * @param input - Rule ID as it appeared in the user's source (pragma
 *   token, config.rules key, CLI flag value). Case-sensitive; the
 *   alias table's `from` field is matched literally.
 * @returns Resolved ID plus the alias record on a match, or just the
 *   resolved ID (equal to input) when no alias fired.
 */
export function resolveRuleId(input: string): ResolvedRuleId {
  for (const alias of RULE_ALIASES) {
    if (alias.from === input) {
      return { resolved: alias.to, deprecated: alias };
    }
  }
  return { resolved: input };
}

/**
 * Returns the alias record for a canonical (current) rule ID, or
 * `undefined` when the ID is not the `to` side of any alias. Drives the
 * `list_rules` `deprecated: true` + `replacedBy: <to>` fields — those
 * fields surface on the OLD rule entry (the `from` side), so if an
 * agent lists rules and sees both IDs in the catalog, only the
 * deprecated one carries the metadata.
 *
 * Used by `list_rules` to enumerate the alias entries next to the
 * regular rule entries so agents discovering the catalog can find the
 * rewrite target without a separate call.
 */
export function findAliasByFrom(from: string): RuleAlias | undefined {
  for (const alias of RULE_ALIASES) {
    if (alias.from === from) return alias;
  }
  return undefined;
}

/**
 * Formats the structured warning string an MCP tool emits when a
 * caller's rule-ID input resolved through the alias table. Shape:
 * `deprecated_rule_id:<old>:<new>`. The agent parses the three
 * colon-separated components to build a rewrite suggestion without
 * reading a paired `warningsDetails` payload.
 *
 * Kept as a helper (rather than inlined) so every emission site uses
 * the same wire format — the string is a contract surface, not
 * formatted prose.
 */
export function formatDeprecatedRuleIdWarning(alias: RuleAlias): string {
  return `deprecated_rule_id:${alias.from}:${alias.to}`;
}
