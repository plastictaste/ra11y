/**
 * CLI entry point called from src/cli.ts. Parses argv, constructs the
 * registry once for this invocation, dispatches to the matching
 * command, writes stdout/stderr, and returns the exit code.
 *
 * Stage 3 of ADR 0022's migration: the CLI bootstrap owns a single
 * Registry for the command run and threads it into every handler as
 * the context parameter, replacing the per-command `BUILTIN_*` imports.
 */

import { createBuiltinRegistry } from "../engine/registry/registry.ts";
import { startMcpServer } from "../mcp/server.ts";
import { setColorEnabled } from "../utils/ansi.ts";
import { setLogLevel } from "../utils/logger.ts";
import { parseCliArgs } from "./args.ts";
import { runAttestCommand } from "./commands/attest.ts";
import { runAttestationsCommand } from "./commands/attestations.ts";
import { runBaselineCommand } from "./commands/baseline.ts";
import { runCertification } from "./commands/certification.ts";
import { runChecklist } from "./commands/checklist.ts";
import { runConformance } from "./commands/conformance.ts";
import { runCoverage } from "./commands/coverage.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runExplain } from "./commands/explain.ts";
import { runInit } from "./commands/init.ts";
import { runListRules } from "./commands/list-rules.ts";
import { runListStandards } from "./commands/list-standards.ts";
import { runScanCommand, type ScanExit } from "./commands/scan.ts";
import { runVpat } from "./commands/vpat.ts";
import { ExitCode } from "./exit-codes.ts";
import { renderHelp, VERSION } from "./help.ts";

export async function runCli(argv: readonly string[]): Promise<ScanExit> {
  const options = parseCliArgs(argv);

  if (options.noColor) setColorEnabled(false);
  if (options.debug) setLogLevel("debug");

  const registry = createBuiltinRegistry();

  switch (options.command) {
    case "help":
      return { stdout: renderHelp(), stderr: "", exitCode: ExitCode.OK };
    case "version":
      return { stdout: `ra11y v${VERSION}\n`, stderr: "", exitCode: ExitCode.OK };
    case "list-rules":
      return runListRules();
    case "list-standards":
      return runListStandards();
    case "explain":
      return runExplain(options.ruleId ?? "");
    case "coverage":
      return runCoverage(options, registry);
    case "checklist":
      return runChecklist(options, registry);
    case "vpat":
      return runVpat(options, registry);
    case "certification":
      return runCertification(options, registry);
    case "mcp":
      await startMcpServer();
      return { stdout: "", stderr: "", exitCode: ExitCode.OK };
    case "init":
      return runInit(options);
    case "doctor":
      return runDoctor();
    case "baseline":
      return runBaselineCommand(options);
    case "attestations":
      return runAttestationsCommand(options);
    case "attest":
      return runAttestCommand(options);
    case "conformance":
      return runConformance(options, registry);
    case "scan":
      return runScanCommand(options, registry);
  }
}
