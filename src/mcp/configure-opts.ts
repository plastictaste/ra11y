/**
 * Params → validated opts for `McpSession.configure`. Kept in its own
 * file so the `allowWrite` honesty check (and any future per-field
 * validation) has a dedicated home; `tools-helpers.ts` consumes the
 * exports without tying its line budget to this module's growth.
 *
 * The canonical failure the validator is protecting against: a caller
 * that sends `allowWrite: "true"` (string) slipping past the
 * `typeof === "boolean"` guard, leaving the session's write gate at
 * its prior value, and getting `active.allowWrite: false` echoed back
 * — indistinguishable from "I never asked to flip it." See
 * `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field shapes
 * are dishonest."
 */

import type { StructuredError } from "./tools-helpers.ts";
import { strArrayParam, strParam } from "./tools-helpers.ts";

/** Builds the opts object for McpSession.configure from the configure tool's params. */
export interface ConfigureOpts {
  standard?: string;
  level?: "A" | "AA" | "AAA";
  exclude?: readonly string[];
  rules?: Readonly<Record<string, "error" | "warning" | "info" | "off">>;
  nativeWrappers?: readonly string[];
  /**
   * Wrapper → native-element map. Mirrors
   * `LoadedConfig.nativeWrapperElements` on the file-loaded side so the
   * object form of `Config.nativeWrappers` can round-trip through MCP.
   */
  nativeWrapperElements?: Readonly<Record<string, string>>;
  /**
   * Absolute path of the project the wrappers apply to. Forwarded
   * verbatim to `McpSession.configure` so the session records it as
   * the wrapper anchor; later scans against a different root surface
   * the mismatch via `session_wrappers_configured_for_different_cwd`.
   */
  cwd?: string;
  allowWrite?: boolean;
}

/**
 * Discriminated result from `buildConfigureOpts`: validated options on
 * success, or a {@link StructuredError} on a type mismatch. The
 * security-load-bearing case is `allowWrite` — silent drops at the
 * field level are dishonest per the AI-first consumer doctrine.
 */
export type ConfigureOptsResult =
  | { readonly ok: true; readonly opts: ConfigureOpts }
  | { readonly ok: false; readonly error: StructuredError };

/**
 * Extracts `{ [ruleId]: "error"|"warning"|"info"|"off" }` from the configure
 * tool's params. Keeps the configure handler pure over its Record input
 * while narrowing to the RuleSetting union.
 */
function readRuleSettings(
  params: Record<string, unknown>,
): Readonly<Record<string, "error" | "warning" | "info" | "off">> | undefined {
  const raw = (params as { rules?: unknown }).rules;
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, "error" | "warning" | "info" | "off"> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === "error" || value === "warning" || value === "info" || value === "off") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Reads the `nativeWrappers` param in either the flat array form
 * (`["Button", "Link"]`) or the flat object form
 * (`{ Button: "button", Link: "a" }`). Returns a split tuple so the
 * session `configure()` call receives each branch through its own
 * typed channel (names accumulate into `nativeWrappers`; the element
 * map populates `nativeWrapperElements`). The nested `NativeWrapperMap`
 * form accepted on the file-loader side is deliberately NOT parsed
 * here — nesting is compile-time ergonomics for authors editing a
 * config file, not a shape MCP callers need to emit. Agents with a
 * compound-component map flatten the dotted keys themselves, which
 * keeps the MCP schema flat and unambiguous.
 */
function readNativeWrappersParam(params: Record<string, unknown>): {
  readonly names?: readonly string[];
  readonly elements?: Readonly<Record<string, string>>;
} {
  const raw = params["nativeWrappers"];
  if (raw === undefined) return {};
  if (Array.isArray(raw)) {
    return { names: raw.filter((v): v is string => typeof v === "string") };
  }
  if (typeof raw === "object" && raw !== null) {
    const elements: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") elements[key] = value;
    }
    return { names: Object.keys(elements), elements };
  }
  return {};
}

export function buildConfigureOpts(params: Record<string, unknown>): ConfigureOptsResult {
  const opts: ConfigureOpts = {};
  const standard = strParam(params, "standard");
  const level = strParam(params, "level") as "A" | "AA" | "AAA" | undefined;
  const exclude = strArrayParam(params, "exclude");
  const rules = readRuleSettings(params);
  const { names: nativeWrappers, elements: nativeWrapperElements } =
    readNativeWrappersParam(params);
  const cwd = strParam(params, "cwd");
  // `allowWrite`: reject non-boolean rather than silently drop — absent
  // stays absent (no coercion), present-with-wrong-type surfaces an
  // `invalid-param` error the caller can act on.
  const allowWriteRaw = params["allowWrite"];
  if (Object.hasOwn(params, "allowWrite") && typeof allowWriteRaw !== "boolean") {
    return {
      ok: false,
      error: {
        code: "invalid-param",
        message:
          "`allowWrite` must be a boolean (`true` or `false`). Non-boolean values are rejected rather than silently dropped so the session's write gate reflects what the host asked for.",
        details: { param: "allowWrite", received: typeof allowWriteRaw },
        remediation:
          "Send `allowWrite: true` (JSON boolean) to unlock `apply_fix` / `suppress` / `attest`, or omit the field to leave the current setting untouched.",
      },
    };
  }
  if (standard !== undefined) opts.standard = standard;
  if (level !== undefined) opts.level = level;
  if (exclude !== undefined) opts.exclude = exclude;
  if (rules !== undefined) opts.rules = rules;
  if (nativeWrappers !== undefined) opts.nativeWrappers = nativeWrappers;
  if (nativeWrapperElements !== undefined) opts.nativeWrapperElements = nativeWrapperElements;
  if (cwd !== undefined) opts.cwd = cwd;
  if (typeof allowWriteRaw === "boolean") opts.allowWrite = allowWriteRaw;
  return { ok: true, opts };
}
