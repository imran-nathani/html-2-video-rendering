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

/**
 * Why the run failed, beyond the exit code. Exists because exit `4`
 * (`LINT_OR_STRICT_FAILED`) covers two genuinely different outcomes — a
 * pre-flight lint gate rejecting the composition, and a completed capture
 * blocked afterwards by correctness warnings under `--no-best-effort`. A
 * machine consumer that has to choose between "tell the user their
 * composition is broken" and "tell the user the render is untrustworthy"
 * cannot make that call from the number alone, and shouldn't have to
 * regex the prose message to do it.
 */
export type CliErrorReason = "lint_gate" | "correctness_warnings";

/** A `RenderWarning` from the producer, as carried in the `--json` error payload. */
export interface StructuredWarning {
  code: string;
  message?: string;
  stage?: string;
  details?: Record<string, unknown>;
}

/** A lint finding, as carried in the `--json` error payload. */
export interface StructuredFinding {
  code: string;
  severity: string;
  message: string;
}

/**
 * Machine-readable attribution for a failure, surfaced verbatim under
 * `error` in the `--json` envelope. Everything here is optional: the shape
 * of a failure envelope is unchanged for errors that carry none of it.
 */
export interface CliErrorDetails {
  reason?: CliErrorReason;
  warnings?: StructuredWarning[];
  findings?: StructuredFinding[];
}

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly hint?: string;
  readonly details?: CliErrorDetails;

  constructor(
    message: string,
    exitCode: ExitCode = EXIT_CODES.USAGE,
    hint?: string,
    details?: CliErrorDetails,
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.hint = hint;
    this.details = details;
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, EXIT_CODES.USAGE, hint);
}

export function toCliError(
  err: unknown,
  fallbackExitCode: ExitCode = EXIT_CODES.USAGE,
  details?: CliErrorDetails,
): CliError {
  if (err instanceof CliError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new CliError(message, fallbackExitCode, undefined, details);
}
