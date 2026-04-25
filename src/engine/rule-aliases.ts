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
 * deprecatedSince, removeIn }` records. The table grew with V1-RULE-
 * NAVIGATION-HREF-VOID-RENAME (the original umbrella rename) and then
 * Q7-NAVIGATION-HREF-RULE-RENAME (the umbrella split into two rules).
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
export const RULE_ALIASES: readonly RuleAlias[] = Object.freeze([
  // Q7-NAVIGATION-HREF-RULE-RENAME: the umbrella `navigation/href-placeholder`
  // rule (itself a rename from the older `navigation/href-javascript-void`)
  // covered three distinct placeholder shapes — `javascript:` schemes,
  // bare `#`, and empty `href=""` — under one ID. A pragma/config entry
  // suppressing the umbrella ID silenced ALL three shapes; agents
  // triaging by ID could not distinguish "we know this jQuery toggle
  // uses javascript:void" from "we know this Forgot-password? link
  // is intentionally a placeholder." Split into two rules:
  //
  //   - navigation/href-javascript-scheme  (matches `javascript:…` only)
  //   - navigation/href-empty-fragment     (matches `href="#"` and `href=""`)
  //
  // Both legacy IDs (`href-javascript-void`, `href-placeholder`) resolve
  // through the alias table; both point at `href-javascript-scheme` because
  // (a) the original `href-javascript-void` literal name unambiguously
  // names that shape, and (b) the umbrella rename's primary continuity
  // line was the JS-scheme heir — pointing the umbrella legacy ID at the
  // empty-fragment heir would silently flip suppression intent for the
  // most common legacy callers. The deprecation warning is the migration
  // signal: agents reading `deprecated_rule_id:navigation/href-placeholder:
  // navigation/href-javascript-scheme` learn the umbrella was split and
  // that the second new ID (`href-empty-fragment`) may also need explicit
  // suppression. The chained-alias invariant (B in `from` ≠ another entry's
  // `to`) is preserved: neither legacy ID's `from` is another entry's `to`.
  //
  // Doctrine: surface, don't suppress. The alias resolves to one ID by
  // contract; the previously-too-broad umbrella suppression now catches
  // one shape and the other shape resurfaces (with the deprecation warning
  // pointing at the rewrite). That's an honest "your old pragma was
  // doing more than you asked for" signal rather than the silent
  // continuation of a labeled-bucket-style umbrella.
  {
    from: "navigation/href-javascript-void",
    to: "navigation/href-javascript-scheme",
    deprecatedSince: "0.2.0",
    removeIn: "0.3.0",
  },
  {
    from: "navigation/href-placeholder",
    to: "navigation/href-javascript-scheme",
    deprecatedSince: "0.2.0",
    removeIn: "0.3.0",
  },
]);

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
