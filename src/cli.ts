#!/usr/bin/env node
import { applyEnvAliases, applyGlobalFlags, extractGlobalFlags } from "./args/global.js";
import { parseRenderArgs } from "./args/parse.js";
import { runCompletionCommand } from "./commands/completion.js";
import { runDepsCommand } from "./commands/deps.js";
import { runDoctorCommand } from "./commands/doctor.js";
import {
  printCompletionHelp,
  printDepsHelp,
  printLintHelp,
  printProbeHelp,
  printRenderHelp,
  printTopLevelHelp,
} from "./commands/help.js";
import { parseLintArgs, runLintCommand } from "./commands/lint.js";
import { parseProbeArgs, runProbeCommand } from "./commands/probe.js";
import { runRenderCommand } from "./commands/render.js";
import { runVersionCommand } from "./commands/version.js";
import { EXIT_CODES } from "./output/errors.js";
import { printCliError } from "./output/json.js";
import { toCliError } from "./output/errors.js";

const HELP_BY_COMMAND: Record<string, () => void> = {
  render: printRenderHelp,
  probe: printProbeHelp,
  lint: printLintHelp,
  deps: printDepsHelp,
  completion: printCompletionHelp,
};

async function main(): Promise<number> {
  // Global flags (`00-COMMANDS.md` "Global flags") work in any position, for
  // every command, so they're stripped out of the raw argv up front — the
  // command-name lookup and every command-specific parser below see argv as
  // if these flags were never there.
  let globalRest: string[];
  try {
    const { flags, rest: stripped } = extractGlobalFlags(process.argv.slice(2));
    applyGlobalFlags(flags);
    applyEnvAliases();
    globalRest = stripped;
  } catch (err) {
    printCliError("hfmpeg", toCliError(err), process.argv.includes("--json"));
    return toCliError(err).exitCode;
  }

  const [command, ...rest] = globalRest;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    const target = command === "help" ? rest[0] : undefined;
    (target && HELP_BY_COMMAND[target] ? HELP_BY_COMMAND[target] : printTopLevelHelp)();
    return EXIT_CODES.OK;
  }

  if (command === "--version") {
    return runVersionCommand(false);
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    const printHelp = HELP_BY_COMMAND[command];
    if (printHelp) {
      printHelp();
      return EXIT_CODES.OK;
    }
  }

  switch (command) {
    case "version":
      return runVersionCommand(rest.includes("--json"));

    case "doctor":
      return runDoctorCommand(rest.includes("--json"));

    case "deps":
      return runDepsCommand(rest);

    case "completion":
      try {
        return runCompletionCommand(rest[0]);
      } catch (err) {
        printCliError("completion", toCliError(err), false);
        return toCliError(err).exitCode;
      }

    case "render": {
      try {
        const args = parseRenderArgs(rest);
        return await runRenderCommand(rest, args);
      } catch (err) {
        printCliError("render", toCliError(err), rest.includes("--json"));
        return toCliError(err).exitCode;
      }
    }

    case "probe": {
      try {
        const args = parseProbeArgs(rest);
        return runProbeCommand(args);
      } catch (err) {
        printCliError("probe", toCliError(err), rest.includes("--json"));
        return toCliError(err).exitCode;
      }
    }

    case "lint": {
      try {
        const args = parseLintArgs(rest);
        return await runLintCommand(args);
      } catch (err) {
        printCliError("lint", toCliError(err), rest.includes("--json"));
        return toCliError(err).exitCode;
      }
    }

    default:
      process.stderr.write(`Unknown command "${command}".\n\n`);
      printTopLevelHelp();
      return EXIT_CODES.USAGE;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`Unexpected error: ${message}\n`);
    process.exitCode = EXIT_CODES.RENDER_FAILED;
  });
