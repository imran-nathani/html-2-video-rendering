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

export interface ProgressReporter {
  report(progress: number, stage: string): void;
  /** Called once the render finishes (success or failure) to clean up any live line. */
  end(): void;
}

const NOOP_REPORTER: ProgressReporter = { report: () => {}, end: () => {} };

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
      report(progress, stage) {
        process.stderr.write(
          `${JSON.stringify({ command, event: "progress", progress, stage })}\n`,
        );
      },
      end() {},
    };
  }

  if (mode === "plain") {
    return {
      report(progress, stage) {
        const pct = Math.round(progress * 100);
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
      const pct = Math.round(progress * 100);
      const width = 24;
      const filled = Math.round((pct / 100) * width);
      const bar = "#".repeat(filled).padEnd(width, "-");
      process.stderr.write(`\r[${bar}] ${String(pct).padStart(3, " ")}% ${stage}`.padEnd(100));
    },
    end() {
      if (wrote) process.stderr.write("\n");
    },
  };
}
