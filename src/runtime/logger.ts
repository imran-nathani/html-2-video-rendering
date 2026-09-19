import type { LogLevel as ProducerLogLevel, ProducerLogger } from "@hyperframes/producer";
import { format } from "node:util";
import { isLevelEnabled, logAt, type LogLevel } from "../output/log.js";

/**
 * Bridge the producer's pluggable logger onto `hfmpeg`'s own
 * `--log-level`/`--verbose` gate (`output/log.ts`).
 *
 * Without this, `RenderConfig.logger` defaults to the producer's
 * `defaultLogger` — a module-scope `createConsoleLogger("info")` singleton
 * whose level is fixed at construction and reads no environment variable.
 * The visible consequence is that `--log-level silent` isn't silent: the
 * CLI's own diagnostics stop, but every `[INFO] [Compiler] …` /
 * `[Render:trace] …` line from the render pipeline keeps going to stderr.
 * For a host application capturing stderr for diagnostics (or parsing
 * `--progress json` NDJSON out of it) that's a lot of noise it explicitly
 * asked not to receive.
 *
 * The producer's level names are a subset of ours (`error|warn|info|debug`,
 * no `silent`), so the mapping is the identity plus `silent` dropping
 * everything — which our own `LEVEL_RANK` already handles.
 *
 * Line shape (`[WARN] message {"meta":…}`) is deliberately identical to
 * upstream's `createConsoleLogger`, so this only changes *whether* a line is
 * printed, never what it looks like — anything already parsing these lines
 * keeps working.
 *
 * Scope: this covers everything the render pipeline logs through the job's
 * logger. It does *not* cover `@hyperframes/engine`, which writes straight
 * to `console.log` with no logger to inject (`[BrowserManager] Browser
 * launched …`, `[initSession:screenshot] …`) — `withConsoleLevelGate` below
 * handles those.
 */
export function createProducerLogger(): ProducerLogger {
  const emit = (level: ProducerLogLevel, tag: string, message: string, meta?: Record<string, unknown>) => {
    logAt(level, `[${tag}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
  };

  return {
    error: (message, meta) => emit("error", "ERROR", message, meta),
    warn: (message, meta) => emit("warn", "WARN", message, meta),
    info: (message, meta) => emit("info", "INFO", message, meta),
    debug: (message, meta) => emit("debug", "DEBUG", message, meta),
    // Upstream gates expensive meta construction on this when present, so
    // implementing it means a silenced render doesn't pay to build metadata
    // that would immediately be thrown away.
    isLevelEnabled: (level) => isLevelEnabled(level),
  };
}

/** Which `--log-level` tier each `console` method's output belongs to. */
const CONSOLE_METHOD_LEVELS = {
  log: "info",
  info: "info",
  debug: "debug",
  warn: "warn",
  error: "error",
} as const satisfies Record<string, LogLevel>;

/**
 * `console.log`/`console.info`/`console.debug` all default to *stdout*
 * (`console.warn`/`console.error` already default to stderr, so `--json`
 * never has to touch them). Those three are the ones that can land in the
 * middle of a `--json` envelope.
 */
const STDOUT_CONSOLE_METHODS = new Set<keyof typeof CONSOLE_METHOD_LEVELS>(["log", "info", "debug"]);

/**
 * Run `fn` with `console` output filtered by `--log-level`, and — when
 * `json` is set — with the stdout-bound methods (`log`/`info`/`debug`)
 * additionally rerouted to stderr instead of merely level-gated.
 *
 * `@hyperframes/engine` — the layer that actually drives Chrome — logs with
 * bare `console.log`: `[BrowserManager] Browser launched …`,
 * `[initSession:screenshot] page.goto complete (637ms)`, per-phase capture
 * traces. There is no logger to inject and no environment variable to set;
 * `RenderConfig.logger` doesn't reach it. So `--log-level silent` stayed
 * noisy no matter what the producer-side adapter above did.
 *
 * Since `hfmpeg` owns the process, the honest fix is to filter at the only
 * place these lines pass through. Suppression is strictly opt-in — at the
 * default `info` level nothing is touched at all, and the patch is scoped to
 * the render call and always restored — so this can never swallow output the
 * user didn't explicitly ask to drop. A caller who wants everything simply
 * doesn't lower the level.
 *
 * `--json` promises *one parseable document on stdout* regardless of
 * `--verbose`/`--log-level`, both of which raise `effectiveRank()`
 * independently of the `--json`-implied `silent` default
 * (`args/global.ts`). Rather than let that combination re-enable
 * `console.log` on stdout and corrupt the envelope, `json: true` redirects
 * (rather than drops) any of those three methods that the current level
 * would otherwise leave enabled, so `--json --verbose` still surfaces the
 * engine's tracing — on stderr, alongside the envelope, never inside it.
 */
export async function withConsoleLevelGate<T>(
  fn: () => Promise<T>,
  options?: { json?: boolean },
): Promise<T> {
  const json = options?.json ?? false;
  const entries = Object.entries(CONSOLE_METHOD_LEVELS) as Array<[keyof typeof CONSOLE_METHOD_LEVELS, LogLevel]>;
  const patched = entries.filter(([method, level]) => !isLevelEnabled(level) || (json && STDOUT_CONSOLE_METHODS.has(method)));
  if (patched.length === 0) return await fn();

  const originals = patched.map(([method]) => [method, console[method]] as const);
  for (const [method, level] of patched) {
    if (!isLevelEnabled(level)) {
      console[method] = () => {};
    } else {
      // Enabled by level, but stdout-bound under `--json`: keep the
      // diagnostic alive on stderr instead of silencing it outright.
      console[method] = (...args: unknown[]) => {
        process.stderr.write(`${format(...args)}\n`);
      };
    }
  }
  try {
    return await fn();
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }
}
