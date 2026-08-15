export interface FpsArgValue {
  num: number;
  den: number;
}

/**
 * Parse `--fps`: an integer `1..240`, or an ffmpeg-style rational like
 * `30000/1001`. See `00-COMMANDS.md` "Timing & size".
 */
export function parseFpsArg(raw: string): FpsArgValue {
  const trimmed = raw.trim();

  if (trimmed.includes("/")) {
    const [numStr, denStr] = trimmed.split("/");
    const num = Number(numStr);
    const den = Number(denStr);
    if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) {
      throw new Error(`Invalid --fps rational "${raw}". Expected e.g. "30000/1001".`);
    }
    return { num, den };
  }

  const num = Number(trimmed);
  if (!Number.isInteger(num) || num <= 0 || num > 240) {
    throw new Error(
      `Invalid --fps "${raw}". Expected an integer 1..240, or a rational like "30000/1001".`,
    );
  }
  return { num, den: 1 };
}
