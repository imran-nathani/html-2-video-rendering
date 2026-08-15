/**
 * Minimal ANSI colour gating (`00-COMMANDS.md` "Global flags": `--no-color`,
 * default `auto`, "also honours `NO_COLOR`"). No dependency — `hfmpeg`'s
 * decorative output is a handful of status markers, not worth pulling in a
 * colour library for.
 */
let disabled = false;

/** Set by `args/global.ts` when `--no-color` is passed. */
export function setColorDisabled(value: boolean): void {
  disabled = value;
}

/** `auto`: on for a TTY stream, unless disabled by `--no-color` or `NO_COLOR` (any non-empty value, per no-color.org). */
export function isColorEnabled(stream: NodeJS.WriteStream = process.stderr): boolean {
  if (disabled) return false;
  if (process.env.NO_COLOR) return false;
  return Boolean(stream.isTTY);
}

const CODES = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
} as const;

function paint(code: keyof typeof CODES, text: string, stream: NodeJS.WriteStream): string {
  return isColorEnabled(stream) ? `${CODES[code]}${text}${CODES.reset}` : text;
}

export const color = {
  red: (text: string, stream?: NodeJS.WriteStream) => paint("red", text, stream ?? process.stderr),
  green: (text: string, stream?: NodeJS.WriteStream) => paint("green", text, stream ?? process.stderr),
  yellow: (text: string, stream?: NodeJS.WriteStream) => paint("yellow", text, stream ?? process.stderr),
  cyan: (text: string, stream?: NodeJS.WriteStream) => paint("cyan", text, stream ?? process.stderr),
  dim: (text: string, stream?: NodeJS.WriteStream) => paint("dim", text, stream ?? process.stderr),
};
