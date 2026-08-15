import { existsSync, statSync } from "node:fs";
import { CliError, EXIT_CODES, toCliError, usageError } from "../output/errors.js";
import { printCliError, printJsonEnvelope } from "../output/json.js";
import { resolveProjectInput } from "../project.js";
import { loadProducer } from "../runtime/producer.js";

export interface LintArgs {
  positionalDir?: string;
  composition?: string;
  strict: boolean;
  verbose: boolean;
  json: boolean;
}

export function parseLintArgs(argv: string[]): LintArgs {
  const args: LintArgs = { strict: false, verbose: false, json: false };
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === "--composition" || token === "-c") {
      const value = argv[i + 1];
      if (value === undefined) throw usageError(`Flag "${token}" requires a value.`);
      args.composition = value;
      i += 2;
      continue;
    }
    if (token === "--strict") {
      args.strict = true;
      i += 1;
      continue;
    }
    if (token === "--verbose") {
      args.verbose = true;
      i += 1;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      throw usageError(`Unknown flag "${token}".`, "Run `hfmpeg help lint` for usage.");
    }
    if (args.positionalDir === undefined) {
      args.positionalDir = token;
      i += 1;
      continue;
    }
    throw usageError(`Unexpected argument "${token}".`);
  }
  return args;
}

export async function runLintCommand(args: LintArgs): Promise<number> {
  try {
    const { projectDir, entryFile } = resolveProjectInput({
      positionalDir: args.positionalDir,
      composition: args.composition,
    });
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
      throw usageError(`Project directory not found: ${projectDir}`);
    }

    const { prepareHyperframeLintBody, runHyperframeLint } = await loadProducer();
    const prepared = prepareHyperframeLintBody({ projectDir, entryFile });
    if ("error" in prepared) {
      throw new CliError(`lint: ${prepared.error}`, EXIT_CODES.COMPOSITION_INVALID);
    }

    const result = await runHyperframeLint(prepared.prepared);
    const findings = args.verbose
      ? result.findings
      : result.findings.filter((f) => f.severity !== "info");

    const ok = result.errorCount === 0 && (!args.strict || result.warningCount === 0);

    if (args.json) {
      printJsonEnvelope({
        ok,
        command: "lint",
        data: {
          errorCount: result.errorCount,
          warningCount: result.warningCount,
          infoCount: result.infoCount,
          findings,
        },
      });
    } else if (findings.length === 0) {
      console.log("No findings.");
    } else {
      for (const f of findings) {
        console.log(`[${f.severity}] ${f.code}: ${f.message}`);
        if (f.snippet) console.log(`  ${f.snippet}`);
        if (f.fixHint) console.log(`  hint: ${f.fixHint}`);
      }
      console.log(`\n${result.errorCount} error(s), ${result.warningCount} warning(s), ${result.infoCount} info.`);
    }

    return ok ? EXIT_CODES.OK : EXIT_CODES.LINT_OR_STRICT_FAILED;
  } catch (err) {
    const cliError = toCliError(err);
    printCliError("lint", cliError, args.json);
    return cliError.exitCode;
  }
}
