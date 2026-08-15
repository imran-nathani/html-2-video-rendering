import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CliError, EXIT_CODES } from "./output/errors.js";

export interface ResolvedProjectInput {
  projectDir: string;
  entryFile?: string;
}

export interface ProjectInputArgs {
  /** `--input, -i` — a project directory or an `.html` file. */
  input?: string;
  /** Positional `[dir]` argument. */
  positionalDir?: string;
  /** `--composition, -c` — entry HTML relative to the project dir, wins over a file passed via `--input`. */
  composition?: string;
}

/**
 * Shared "which project directory / entry file did the user mean" resolver
 * (`00-COMMANDS.md` "Input & output"), used by `render`, `probe`, and `lint`
 * so all three commands agree on `-i`/`[dir]`/`-c` precedence.
 */
export function resolveProjectInput(args: ProjectInputArgs): ResolvedProjectInput {
  const raw = args.input ?? args.positionalDir ?? ".";
  const resolved = resolve(raw);

  let projectDir = resolved;
  let entryFile: string | undefined;

  if (existsSync(resolved) && statSync(resolved).isFile()) {
    projectDir = dirname(resolved);
    entryFile = basename(resolved);
  }

  if (args.composition) entryFile = args.composition;

  return { projectDir, entryFile };
}

/** Read the entry HTML file, surfacing a `CliError` with `COMPOSITION_INVALID` on failure. */
export function readEntryHtml(projectDir: string, entryFile: string | undefined): string {
  const path = join(projectDir, entryFile ?? "index.html");
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `Could not read entry file "${path}": ${message}`,
      EXIT_CODES.COMPOSITION_INVALID,
    );
  }
}
