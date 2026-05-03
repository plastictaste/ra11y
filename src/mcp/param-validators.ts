/**
 * Strict type-validating helpers for MCP tool input params.
 *
 * Each helper returns a discriminated `{ok: true, value}` /
 * `{ok: false, error}` so the calling handler can early-return a
 * structured `invalid-param` envelope rather than silently dropping
 * a wrong-type input. The pattern mirrors `configure-opts.ts` —
 * silent drops are dishonest per the AI-first consumer doctrine: the
 * agent thinks it configured a setting that never took effect.
 *
 * The legacy loose helpers (`strParam`, `numParam`, `strArrayParam`)
 * remain in `tools-helpers.ts` for the many call sites reading
 * internally-validated structures (parsed responses, scanner state).
 * Use the strict helpers here whenever a value comes directly off the
 * MCP `params` boundary — that's where wrong-type silent drops
 * accumulate as field-report regressions.
 */

import type { StructuredError } from "./tools-helpers.ts";

/**
 * Discriminated result from a strict param-shape check. On `ok: true`,
 * `value` is the validated value (or `undefined` when the caller
 * omitted the field). On `ok: false`, `error` is a {@link StructuredError}
 * naming the field and the received `typeof`.
 */
export type ParamCheckResult<T> =
  | { readonly ok: true; readonly value: T | undefined }
  | { readonly ok: false; readonly error: StructuredError };

/**
 * Strict boolean param: returns `value: undefined` when the field is
 * absent and `value: <bool>` when it is a real JSON boolean. Returns
 * an `invalid-param` error on any other type — `"true"` / `1` /
 * `null` / `[]` were silently dropped under the previous loose
 * `=== true` / `!== false` guards, leaving the caller's setting at
 * its default and the response shape indistinguishable from "I never
 * asked." Mirrors `configure-opts.ts.allowWrite`'s closure of the
 * same failure mode.
 */
export function requireBooleanParam(
  params: Record<string, unknown>,
  key: string,
): ParamCheckResult<boolean> {
  const v = params[key];
  if (!Object.hasOwn(params, key) || v === undefined) return { ok: true, value: undefined };
  if (typeof v === "boolean") return { ok: true, value: v };
  return {
    ok: false,
    error: {
      code: "invalid-param",
      message: `\`${key}\` must be a boolean (\`true\` or \`false\`). Non-boolean values are rejected rather than silently dropped so the caller's setting reflects what the host asked for.`,
      details: { param: key, received: typeof v },
      remediation: `Send \`${key}: true\` or \`${key}: false\` (JSON boolean), or omit the field to leave the default unchanged.`,
    },
  };
}

/**
 * Strict string-array param: returns `value: undefined` when absent,
 * `value: string[]` when a real array of strings. Returns
 * `invalid-param` on a non-array (the canonical silent-drop case for
 * `additionalPaths` / `restrictToPaths` — a wrong shape would
 * silently degrade a scoped scan into a full-tree scan,
 * indistinguishable from "the scope was applied with no matches").
 * Mixed-type arrays with at least one non-string entry also reject so
 * the agent learns the entry was lost rather than discovering missing
 * files later.
 */
export function requireStringArrayParam(
  params: Record<string, unknown>,
  key: string,
): ParamCheckResult<readonly string[]> {
  const v = params[key];
  if (!Object.hasOwn(params, key) || v === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(v)) {
    return {
      ok: false,
      error: {
        code: "invalid-param",
        message: `\`${key}\` must be an array of strings. Non-array values are rejected rather than silently dropped so the caller can tell scope-set from scope-misshapen.`,
        details: { param: key, received: typeof v === "object" ? "object" : typeof v },
        remediation: `Send \`${key}: ["path/one", "path/two"]\` or omit the field.`,
      },
    };
  }
  for (let i = 0; i < v.length; i += 1) {
    if (typeof v[i] !== "string") {
      return {
        ok: false,
        error: {
          code: "invalid-param",
          message: `\`${key}\` entries must be strings; entry at index ${i} was ${typeof v[i]}. Mixed-type arrays are rejected so silently-dropped entries don't surface as "missing files."`,
          details: { param: key, index: i, received: typeof v[i] },
          remediation: `Send \`${key}\` as a homogeneous \`string[]\`.`,
        },
      };
    }
  }
  return { ok: true, value: v as readonly string[] };
}

/**
 * Strict number param: returns `value: undefined` when absent,
 * `value: <num>` when a real JSON number (NaN / Infinity reject —
 * they're almost certainly a serialization bug rather than caller
 * intent). Returns `invalid-param` on any other type. Used for
 * paging / cap fields like `limit` / `offset` /
 * `maxCandidatesPerCriterion` where `params["limit"] = "100"` would
 * silently fall back to the default — the caller asked for one page
 * size and got another with no signal. Range validation
 * (`limit < 1`, etc.) stays at the call site; this helper only
 * enforces type honesty.
 */
export function requireNumberParam(
  params: Record<string, unknown>,
  key: string,
): ParamCheckResult<number> {
  const v = params[key];
  if (!Object.hasOwn(params, key) || v === undefined) return { ok: true, value: undefined };
  if (typeof v === "number" && Number.isFinite(v)) return { ok: true, value: v };
  return {
    ok: false,
    error: {
      code: "invalid-param",
      message: `\`${key}\` must be a finite number. Non-number / NaN / Infinity values are rejected rather than silently coerced to the default.`,
      details: { param: key, received: typeof v === "number" ? "non-finite" : typeof v },
      remediation: `Send \`${key}\` as a JSON number (e.g. \`${key}: 25\`), or omit to use the default.`,
    },
  };
}
