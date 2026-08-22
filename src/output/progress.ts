import { color } from "./color.js";

export type ProgressMode = "auto" | "bar" | "plain" | "json" | "none";

const VALID_PROGRESS_MODES: readonly ProgressMode[] = ["auto", "bar", "plain", "json", "none"];

export function isValidProgressMode(value: string): value is ProgressMode {
  return (VALID_PROGRESS_MODES as readonly string[]).includes(value);
}

/** Resolve `auto` against whether stderr is a TTY (bar) or not (plain). */
export function resolveProgressMode(requested: ProgressMode | undefined): ProgressMode {
  if (!requested || requested === "auto") {
    return process.stderr.isTTY ? "bar" : "plain";
  }
  return requested;
}

/**
 * Machine-readable counters for a progress event, when the render is far
 * enough along to have them. The producer interpolates the same numbers into
 * its human `stage` string ("Capturing frame 144/144 (4 workers)"); carrying
 * them as fields means a consumer driving a UI progress bar never has to
 * regex that prose — the wording is not part of any contract, the fields are.
 */
export interface ProgressCounts {
  totalFrames?: number;
  framesCompleted?: number;
}

export interface ProgressReporter {
  /**
   * `progress` is a **percentage, 0..100** — the unit the producer's
   * `job.progress` already uses (`updateJobStatus` clamps it to that range)
   * and the unit `--progress json` has always emitted. The `bar`/`plain`
   * modes previously re-scaled it by 100 on the way out, which was correct
   * for the batch path (it passes a 0..1 fraction) and printed `2500%` for
   * a real render; both call sites now pass a percentage.
   */
  report(progress: number, stage: string, counts?: ProgressCounts): void;
  /** Called once the render finishes (success or failure) to clean up any live line. */
  end(): void;
}

const NOOP_REPORTER: ProgressReporter = { report: () => {}, end: () => {} };

/** Guard the rendered bar/line against an out-of-range or non-finite percentage. */
function clampPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

/**
 * Build the render progress callback per `--progress <mode>`. `json` emits
 * one NDJSON line per progress event (`00-COMMANDS.md` "Gates & diagnostics"),
 * `bar` redraws a single carriage-returned line, `plain` prints one line per
 * event, `none` is silent.
 */
export function createProgressReporter(mode: ProgressMode, command: string): ProgressReporter {
  if (mode === "none") return NOOP_REPORTER;

  if (mode === "json") {
    // Deliberately stderr, not stdout: `--json` reserves stdout for the
    // single final envelope (00-COMMANDS.md's `--json` global flag), so
    // NDJSON progress lines must not interleave with it.
    return {
      report(progress, stage, counts) {
        // `undefined` fields are dropped by JSON.stringify, so an event from
        // a stage that has no frame counts yet (compile, probe, encode) is
        // byte-identical to what this emitted before they existed.
        process.stderr.write(
          `${JSON.stringify({
            command,
            event: "progress",
            progress,
            stage,
            totalFrames: counts?.totalFrames,
            framesCompleted: counts?.framesCompleted,
          })}\n`,
        );
      },
      end() {},
    };
  }

  if (mode === "plain") {
    return {
      report(progress, stage) {
        const pct = clampPercent(progress);
        process.stderr.write(`[${String(pct).padStart(3, " ")}%] ${stage}\n`);
      },
      end() {},
    };
  }

  // bar
  let wrote = false;
  return {
    report(progress, stage) {
      wrote = true;
      const pct = clampPercent(progress);
      const width = 24;
      const filled = Math.round((pct / 100) * width);
      const plainBar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
      const plainLine = `[${plainBar}] ${String(pct).padStart(3, " ")}% ${stage}`;
      // Colour the `#` fill only, then pad using the *plain* line's length —
      // ANSI escapes are invisible but still count toward `.length`, which
      // would otherwise under-pad the line and leave stale characters from a
      // longer previous line on screen.
      const coloredLine = plainLine.replace(plainBar, `${color.cyan("#".repeat(filled))}${"-".repeat(width - filled)}`);
      process.stderr.write(`\r${coloredLine}${" ".repeat(Math.max(0, 100 - plainLine.length))}`);
    },
    end() {
      if (wrote) process.stderr.write("\n");
    },
  };
}
