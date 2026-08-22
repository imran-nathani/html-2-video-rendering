import { getChannel, getHfmpegVersion, type Channel } from "../meta.js";
import { color } from "./color.js";
import type { CliError, CliErrorReason, StructuredFinding, StructuredWarning } from "./errors.js";

interface HfmpegEnvelopeMeta {
  version: string;
  channel: Channel;
}

interface DataInput<T> {
  /** Usually command-success, but `doctor` overloads this with environment health. */
  ok: boolean;
  command: string;
  data: T;
}

interface FailureInput {
  ok: false;
  command: string;
  error: {
    message: string;
    exitCode: number;
    hint?: string;
    /** Disambiguates exit codes shared by more than one failure mode (notably 4). */
    reason?: CliErrorReason;
    /** Flat code list — the cheap thing to switch on; `warnings` has the rest. */
    warningCodes?: string[];
    warnings?: StructuredWarning[];
    findings?: StructuredFinding[];
  };
}

/** Stable `{ ok, command, hfmpeg, data | error }` envelope for every command's `--json` output. */
export function printJsonEnvelope<T>(input: DataInput<T> | FailureInput): void {
  const hfmpeg: HfmpegEnvelopeMeta = { version: getHfmpegVersion(), channel: getChannel() };
  const envelope = { ...input, hfmpeg };
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

/**
 * Report a `CliError` either as the JSON envelope or as plain stderr text.
 *
 * When the error carries structured attribution (`CliError.details`) it is
 * merged into the `error` object: `reason` for the two distinct failures
 * that share exit 4, plus the producer's `warnings[]`/`warningCodes[]` or
 * the lint gate's `findings[]`. Without this, the only machine-readable
 * copy of a blocking warning code lives in a `[WARN]` line on stderr, so a
 * host application has to scrape logs (or regex the prose `message`) to
 * attribute a strict-mode failure — exactly the fragility the rest of the
 * `--json` contract avoids.
 */
export function printCliError(command: string, error: CliError, json: boolean): void {
  if (json) {
    const warnings = error.details?.warnings;
    printJsonEnvelope({
      ok: false,
      command,
      error: {
        message: error.message,
        exitCode: error.exitCode,
        hint: error.hint,
        reason: error.details?.reason,
        warningCodes: warnings?.map((warning) => warning.code),
        warnings,
        findings: error.details?.findings,
      },
    });
    return;
  }
  process.stderr.write(`${color.red("Error:")} ${error.message}\n`);
  if (error.hint) process.stderr.write(`${color.dim(error.hint)}\n`);
}
