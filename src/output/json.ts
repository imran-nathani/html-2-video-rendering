import { getChannel, getHfmpegVersion, type Channel } from "../meta.js";
import { color } from "./color.js";
import type { CliError } from "./errors.js";

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
  error: { message: string; exitCode: number; hint?: string };
}

/** Stable `{ ok, command, hfmpeg, data | error }` envelope for every command's `--json` output. */
export function printJsonEnvelope<T>(input: DataInput<T> | FailureInput): void {
  const hfmpeg: HfmpegEnvelopeMeta = { version: getHfmpegVersion(), channel: getChannel() };
  const envelope = { ...input, hfmpeg };
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

/** Report a `CliError` either as the JSON envelope or as plain stderr text. */
export function printCliError(command: string, error: CliError, json: boolean): void {
  if (json) {
    printJsonEnvelope({
      ok: false,
      command,
      error: { message: error.message, exitCode: error.exitCode, hint: error.hint },
    });
    return;
  }
  process.stderr.write(`${color.red("Error:")} ${error.message}\n`);
  if (error.hint) process.stderr.write(`${color.dim(error.hint)}\n`);
}
