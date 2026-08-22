import { existsSync, statSync } from "node:fs";
import { findRemoteReferences } from "../hermetic.js";
import { CliError, EXIT_CODES, toCliError, usageError } from "../output/errors.js";
import { printCliError, printJsonEnvelope } from "../output/json.js";
import { readEntryHtml, resolveProjectInput } from "../project.js";
import { loadProducer } from "../runtime/producer.js";

export interface LintArgs {
  positionalDir?: string;
  composition?: string;
  strict: boolean;
  verbose: boolean;
  json: boolean;
  /** `--hermetic`: escalate every remote reference from `info` to `error`. */
  hermetic: boolean;
}

/**
 * Structural mirror of `@hyperframes/lint`'s `HyperframeLintFinding` — that
 * type isn't re-exported through `@hyperframes/producer`'s public surface
 * (only `prepareHyperframeLintBody`/`runHyperframeLint` are), and the lint
 * package itself is a transitive dependency we don't declare.
 */
interface LintFinding {
  code: string;
  severity: string;
  message: string;
  file?: string;
  fixHint?: string;
  snippet?: string;
}

/**
 * Findings for network references the composition makes (see
 * `hermetic.ts`). `info` by default — a remote reference is not wrong, it
 * just means the pack can't render offline or reproducibly — and an `error`
 * under `--hermetic`, which turns "is this pack self-contained?" into a
 * one-command CI gate for a vendored-only policy.
 */
function remoteReferenceFindings(
  projectDir: string,
  entryFile: string | undefined,
  hermetic: boolean,
): LintFinding[] {
  const html = readEntryHtml(projectDir, entryFile);
  return findRemoteReferences(html, projectDir, entryFile).map((ref) => ({
    code: "remote_reference",
    severity: hermetic ? ("error" as const) : ("info" as const),
    message: `Remote ${ref.kind} reference: ${ref.url}`,
    file: ref.file,
    fixHint:
      "Vendor this asset into the pack. Remote references are fetched at compile time on every render — they make the render non-reproducible and fail on an offline or restricted network.",
  }));
}

export function parseLintArgs(argv: string[]): LintArgs {
  const args: LintArgs = { strict: false, verbose: false, json: false, hermetic: false };
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
    if (token === "--hermetic") {
      args.hermetic = true;
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
    const remote = remoteReferenceFindings(projectDir, entryFile, args.hermetic);

    const allFindings: LintFinding[] = [...result.findings, ...remote];
    const errorCount = result.errorCount + remote.filter((f) => f.severity === "error").length;
    const infoCount = result.infoCount + remote.filter((f) => f.severity === "info").length;

    const findings = args.verbose
      ? allFindings
      : allFindings.filter((f) => f.severity !== "info");

    const ok = errorCount === 0 && (!args.strict || result.warningCount === 0);

    if (args.json) {
      printJsonEnvelope({
        ok,
        command: "lint",
        data: {
          errorCount,
          warningCount: result.warningCount,
          infoCount,
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
      console.log(`\n${errorCount} error(s), ${result.warningCount} warning(s), ${infoCount} info.`);
    }

    return ok ? EXIT_CODES.OK : EXIT_CODES.LINT_OR_STRICT_FAILED;
  } catch (err) {
    const cliError = toCliError(err);
    printCliError("lint", cliError, args.json);
    return cliError.exitCode;
  }
}
