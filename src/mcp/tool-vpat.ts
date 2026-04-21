/**
 * The `vpat` MCP tool. Produces a VPAT 2.5 Rev (or "VPAT 2.5 Rev INT"
 * when EN 301 549 is in scope) conformance report for this project
 * from a fresh scan + optional durable attestations.
 *
 * This is the MCP-parity companion to `ra11y --vpat` — agents without a
 * CLI shell can now drive the same procurement artifact from a single
 * tool call. Mirrors `conformance_statement` in shape: structured
 * per-criterion entries, honest warnings for silent-failure modes,
 * `nextStep` prose + `nextStepStructured` pair routing to the canonical
 * follow-up tool.
 *
 * Product metadata (`productName`, `productVersion`) stays populated
 * even when the caller passes empty strings — the builder swaps in
 * `<Product Name>` / `<Product Version>` template placeholders so the
 * gap is visible in the rendered VPAT. The tool also emits
 * `warnings: ["product_metadata_placeholders_in_use"]` so the agent
 * knows to prompt the user for real values before shipping the VPAT.
 *
 * Read-only — no disk writes. Idempotent for a given
 * (cwd, files, attestations, product metadata, standards, level) tuple.
 */

import { type ParsedFile, runScan } from "../engine/scanner.ts";
import { buildVpatReport, renderVpatMarkdown } from "../reports/index.ts";
import type { VpatProductMetadata, VpatReport } from "../reports/vpat.ts";
import { BUILTIN_CANDIDATE_FINDERS } from "../review/index.ts";
import { BUILTIN_RULES } from "../rules/index.ts";
import { BUILTIN_STANDARDS } from "../standards/index.ts";
import { detectApplicability } from "./manual-applicability.ts";
import type { McpSession } from "./session.ts";
import {
  applyRuleSettings,
  errorResult,
  firstUnknownStandard,
  loadDurableAttestations,
  type McpTool,
  type McpToolResult,
  parseExplicitPaths,
  parseFiles,
  resolveLevel,
  resolveStandards,
  strArrayParam,
  strParam,
  textResult,
} from "./tools-helpers.ts";

const PLACEHOLDER_NAME = "<Product Name>";
const PLACEHOLDER_VERSION = "<Product Version>";

export const vpatTool: McpTool = {
  def: {
    name: "vpat",
    description:
      'Produce a VPAT 2.5 Rev conformance report (VPAT 2.5 Rev INT when EN 301 549 is in scope) for this project. MCP companion to `ra11y --vpat`. Runs a fresh scan, threads `detectApplicability` so media SCs (1.2.1–1.2.9, 1.4.2) emit `Not Applicable` with a deterministic reason when no `<video>`/`<audio>` elements exist, and returns one entry per criterion with a procurement-grade conformance verdict plus auditor remarks.\n\nProduct metadata — `productName`, `productVersion`, and optional contact/evaluation fields — fills the VPAT header. Passing empty strings carries through the `<Product Name>` / `<Product Version>` template placeholders AND emits `warnings: ["product_metadata_placeholders_in_use"]` so the agent knows to prompt the user before shipping the artifact. Required shape; read-only.\n\n`format: "markdown"` additionally returns a `markdownRendering` field with the full markdown VPAT table (paste into a VPAT template). `format: "json"` (default) omits it — the structured entries are already the machine shape.',
    inputSchema: {
      type: "object",
      properties: {
        productName: {
          type: "string",
          description:
            "Product name for the VPAT header. Required. An empty string carries through the `<Product Name>` placeholder and raises `product_metadata_placeholders_in_use` so the gap is visible to both the VPAT reader and the agent.",
        },
        productVersion: {
          type: "string",
          description:
            "Product version string for the VPAT header. Required. Empty strings behave the same as `productName` — placeholder + warning.",
        },
        contactEmail: {
          type: "string",
          description:
            "Optional procurement contact email. Omit or pass an empty string to leave it out of the header.",
        },
        contactOrganization: {
          type: "string",
          description:
            "Optional organization name (the entity producing the VPAT). Omitted from the header when absent.",
        },
        evaluationMethods: {
          type: "string",
          description:
            "Optional free-form prose summarizing how the evaluation was performed (tools, runs, manual-review passes). Omitted when absent.",
        },
        notesOnEvaluation: {
          type: "string",
          description:
            "Optional free-form notes accompanying the VPAT (caveats, excluded subsystems, dated context). Omitted when absent.",
        },
        cwd: {
          type: "string",
          description:
            "Project root. Used to load `ra11y.config.ts`, `.ra11y/attestations.jsonl`, and resolve relative scan paths. Defaults to the MCP server's spawn directory.",
        },
        additionalPaths: {
          type: "array",
          items: { type: "string" },
          description:
            "Extra paths to scan beyond the auto-discovered tree — `.gitignore` and default build-dir skips are bypassed for these. Same semantics as `scan_project.additionalPaths`. Use to include compiled CSS/HTML so color-contrast and focus-visible rules evaluate real styles.",
        },
        standards: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional list of standard IDs to evaluate (e.g. `["wcag22"]`, `["wcag22", "en301549"]`). Defaults to the session\'s `standard` value. When EN 301 549 is in the enabled set the template version flips to `VPAT 2.5 Rev INT`.',
        },
        level: {
          type: "string",
          enum: ["A", "AA", "AAA"],
          description: "WCAG conformance level to report against. Defaults to session config.",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description:
            "Output format. `json` (default) returns the structured entries only. `markdown` additionally attaches `markdownRendering` — a ready-to-paste Markdown VPAT table. Structured entries are returned in both cases.",
        },
      },
      required: ["productName", "productVersion"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    const validated = validateVpatParams(params, session);
    if ("error" in validated) return validated.error;
    const { productName, productVersion, cwd, additionalPaths, standards, level, format } =
      validated;

    const baseFiles = await parseFiles([cwd], session, cwd);
    const extraFiles =
      additionalPaths.length > 0 ? await parseExplicitPaths(additionalPaths, session, cwd) : [];
    const files: readonly ParsedFile[] = [...baseFiles, ...extraFiles];
    const attestations = await loadDurableAttestations(cwd);

    const { result, report: scanReport } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: applyRuleSettings(BUILTIN_RULES, session.config.rules),
      enabled: standards,
      files,
      finders: BUILTIN_CANDIDATE_FINDERS,
      level,
      ...(attestations.length > 0 && { attestations }),
    });

    const applicability = detectApplicability(files);
    const report = buildVpatReport(result, BUILTIN_STANDARDS, {
      candidates: scanReport.candidates ?? [],
      applicability,
      product: { productName, productVersion, ...buildOptionalProductFields(params) },
      // Forward attestations so runtime-evidence-required criteria
      // (RUNTIME_EVIDENCE_REQUIRED_CRITERIA — keyboard, focus, contrast,
      // heading adequacy, pointer interaction, auth flow) with a fresh
      // `pass`/`fail`/`n/a` verdict route through the normal conformance
      // logic instead of defaulting to "Not Evaluated."
      ...(attestations.length > 0 && { attestations }),
    });

    const warnings = computeWarnings({
      filesScanned: result.filesScanned,
      product: report.product,
      configSource: await loadConfigSourceSafe(session, cwd),
    });

    const nextStep = buildNextStep(report);
    const includeMarkdown = format === "markdown";

    return textResult({
      templateVersion: report.templateVersion,
      product: report.product,
      evaluator: report.evaluator,
      generatedAt: report.generatedAt,
      standards: report.standards,
      ...(includeMarkdown ? { markdownRendering: renderVpatMarkdown(report) } : {}),
      nextStep: nextStep.prose,
      nextStepStructured: nextStep.structured,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  },
};

/**
 * Validated, resolved params for the `vpat` handler. Collapsing all the
 * per-param guards into one helper keeps the handler body under the
 * project's cognitive-complexity budget and keeps the error-emission
 * policy in one place: each invalid input returns a structured
 * `McpToolResult` via the `error` branch instead of throwing.
 */
interface ValidatedVpatParams {
  readonly productName: string;
  readonly productVersion: string;
  readonly cwd: string;
  readonly additionalPaths: readonly string[];
  readonly standards: readonly string[];
  readonly level: ReturnType<typeof resolveLevel>;
  readonly format: "json" | "markdown";
}

function validateVpatParams(
  params: Record<string, unknown>,
  session: McpSession,
): ValidatedVpatParams | { readonly error: McpToolResult } {
  const productName = strParam(params, "productName");
  if (productName === undefined) {
    return {
      error: errorResult({
        code: "missing-required-param",
        message: "productName must be a string (empty strings are allowed but trigger a warning).",
        details: { param: "productName" },
        remediation:
          "Pass `productName` with the product's name as it should appear on the VPAT header.",
      }),
    };
  }
  const productVersion = strParam(params, "productVersion");
  if (productVersion === undefined) {
    return {
      error: errorResult({
        code: "missing-required-param",
        message: "productVersion must be a string.",
        details: { param: "productVersion" },
        remediation:
          "Pass `productVersion` with the evaluated product's version (e.g. `1.2.3`, `2026.Q2`).",
      }),
    };
  }

  const cwd = strParam(params, "cwd") ?? process.cwd();
  const additionalPaths = strArrayParam(params, "additionalPaths") ?? [];

  const standardsParam = strArrayParam(params, "standards");
  const standards =
    standardsParam !== undefined && standardsParam.length > 0
      ? standardsParam
      : resolveStandards(strParam(params, "standard"), session);
  const unknown = firstUnknownStandard(standards);
  if (unknown !== null) {
    return {
      error: errorResult({
        code: "standard-not-found",
        message: `Unknown standard '${unknown}'. Loaded: ${BUILTIN_STANDARDS.map((s) => s.id).join(", ")}.`,
        details: { requested: unknown, loaded: BUILTIN_STANDARDS.map((s) => s.id) },
        remediation:
          "Pass `standards` with loaded IDs, or omit to fall through to the session default.",
      }),
    };
  }

  const level = resolveLevel(strParam(params, "level"), session);
  const formatRaw = strParam(params, "format") ?? "json";
  if (formatRaw !== "markdown" && formatRaw !== "json") {
    return {
      error: errorResult({
        code: "invalid-param",
        message: `format must be 'markdown' or 'json'; got ${JSON.stringify(formatRaw)}.`,
        details: { param: "format", requested: formatRaw },
      }),
    };
  }

  return {
    productName,
    productVersion,
    cwd,
    additionalPaths,
    standards,
    level,
    format: formatRaw,
  };
}

/**
 * Collects the optional product-metadata fields, conditional-spread so
 * empty strings don't ship as sentinel values through the builder. The
 * builder itself conditional-spreads again when rendering — this is the
 * tool-boundary defense so the API payload mirrors the doctrine
 * (CLAUDE.md §1 "Ambiguous field shapes are dishonest").
 */
function buildOptionalProductFields(params: Record<string, unknown>): Partial<VpatProductMetadata> {
  const contactEmail = strParam(params, "contactEmail");
  const contactOrganization = strParam(params, "contactOrganization");
  const evaluationMethods = strParam(params, "evaluationMethods");
  const notesOnEvaluation = strParam(params, "notesOnEvaluation");
  return {
    ...(contactEmail && contactEmail.length > 0 ? { contactEmail } : {}),
    ...(contactOrganization && contactOrganization.length > 0 ? { contactOrganization } : {}),
    ...(evaluationMethods && evaluationMethods.length > 0 ? { evaluationMethods } : {}),
    ...(notesOnEvaluation && notesOnEvaluation.length > 0 ? { notesOnEvaluation } : {}),
  };
}

/**
 * Computes the top-level `warnings` list. Three silent-failure modes
 * qualify (CLAUDE.md §1 "Zero-output success is ambiguous failure"):
 *
 *   - `scanned_zero_files` — the VPAT rows would all be "Not Evaluated"
 *     via the no-evidence path; the reader needs to know the tool never
 *     saw any source.
 *   - `no_config_found` — no `ra11y.config.ts` resolved from `cwd`.
 *     Doesn't invalidate the scan, but tells the agent its nativeWrappers
 *     / per-rule overrides / excludes weren't applied.
 *   - `product_metadata_placeholders_in_use` — the builder inserted the
 *     `<Product Name>` / `<Product Version>` template placeholders because
 *     the caller passed empty strings. A VPAT header with these
 *     placeholders is visibly incomplete; the warning routes the agent
 *     back to the user before shipping the artifact.
 */
function computeWarnings(inputs: {
  readonly filesScanned: number;
  readonly product: VpatProductMetadata;
  readonly configSource: string | null;
}): readonly string[] {
  const out: string[] = [];
  if (inputs.filesScanned === 0) out.push("scanned_zero_files");
  if (inputs.configSource === null) out.push("no_config_found");
  if (
    inputs.product.productName === PLACEHOLDER_NAME ||
    inputs.product.productVersion === PLACEHOLDER_VERSION
  ) {
    out.push("product_metadata_placeholders_in_use");
  }
  return out;
}

/**
 * Builds the prose + structured nextStep pair. Three outcomes:
 *
 *   - Any entry with `Does Not Support` → call `scan_project` for the
 *     failing rules (fix violations before claiming conformance).
 *   - Any un-attested manual criterion (`Not Evaluated`) → call `attest`
 *     to record evidence.
 *   - Otherwise → paste the VPAT into procurement channels.
 */
function buildNextStep(report: VpatReport): {
  readonly prose: string;
  readonly structured: { readonly tool: string; readonly args: Record<string, unknown> };
} {
  const hasFailures = report.standards.some((s) =>
    s.entries.some((e) => e.conformance === "Does Not Support"),
  );
  if (hasFailures) {
    return {
      prose:
        "One or more criteria report `Does Not Support`. Call `scan_project` (or `suggest_fix` on the cited findings) to resolve the violations before distributing the VPAT.",
      structured: { tool: "scan_project", args: {} },
    };
  }
  const hasNotEvaluated = report.standards.some((s) =>
    s.entries.some((e) => e.conformance === "Not Evaluated"),
  );
  if (hasNotEvaluated) {
    return {
      prose:
        "Manual criteria report `Not Evaluated`. Call `attest` per criterion (or drive the `checklist` tool interactively) to record evidence and close the gap.",
      structured: { tool: "attest", args: {} },
    };
  }
  return {
    prose:
      "VPAT is ready. Paste `markdownRendering` (markdown format) or the `standards[].entries[]` array into your procurement template, and commit `.ra11y/attestations.jsonl` so the evidence trail persists.",
    structured: { tool: "conformance_statement", args: {} },
  };
}

/**
 * Loads the project config to determine whether a `ra11y.config.*`
 * resolved at `cwd`. Returns the `sourcePath` string when one loaded,
 * `null` when the walk-up completed empty. Swallows malformed-config
 * errors (mirrors `tool-conformance-statement.ts::loadProjectConfigSafe`)
 * so the VPAT tool keeps emitting even when the user's config file is
 * broken — the absence of a valid config still surfaces via the
 * `no_config_found` warning.
 */
async function loadConfigSourceSafe(
  session: Parameters<typeof vpatTool.handler>[1],
  cwd: string,
): Promise<string | null> {
  try {
    const loaded = await session.loadProjectConfig(cwd);
    return loaded.sourcePath;
  } catch {
    return null;
  }
}
