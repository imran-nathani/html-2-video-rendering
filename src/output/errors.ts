/**
 * Exit codes and the error type carried through the CLI.
 * See `00-COMMANDS.md` "Exit codes" for the contract these numbers implement.
 */
export const EXIT_CODES = {
  OK: 0,
  RENDER_FAILED: 1,
  USAGE: 2,
  MISSING_DEPENDENCY: 3,
  LINT_OR_STRICT_FAILED: 4,
  COMPOSITION_INVALID: 5,
  CANCELLED: 6,
  OUTPUT_IO: 7,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly hint?: string;

  constructor(message: string, exitCode: ExitCode = EXIT_CODES.USAGE, hint?: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, EXIT_CODES.USAGE, hint);
}

export function toCliError(err: unknown, fallbackExitCode: ExitCode = EXIT_CODES.USAGE): CliError {
  if (err instanceof CliError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new CliError(message, fallbackExitCode);
}
