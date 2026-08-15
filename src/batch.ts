import { readFileSync } from "node:fs";
import { usageError } from "./output/errors.js";

export type BatchRow = Record<string, unknown>;

/**
 * Parse `--batch <path>`: a JSON array of rows, or `{ "rows": [...] }`
 * (`00-COMMANDS.md` "Variables & batch").
 */
export function readBatchRows(path: string): BatchRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw usageError(`Could not read --batch "${path}": ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw usageError(`Invalid JSON in --batch "${path}": ${message}`);
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed) && Array.isArray(parsed.rows)
      ? parsed.rows
      : undefined;

  if (!rows) {
    throw usageError(`--batch "${path}" must be a JSON array of rows, or { "rows": [...] }.`);
  }
  for (const row of rows) {
    if (!isPlainObject(row)) {
      throw usageError(`--batch "${path}": every row must be a JSON object.`);
    }
  }
  return rows as BatchRow[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Substitute `{key}` tokens in an output path/template from a batch row. */
export function substituteOutputTemplate(template: string, row: BatchRow): string {
  return template.replace(/\{([^{}]+)\}/g, (full, key: string) => {
    const value = row[key];
    if (value === undefined) {
      throw usageError(`Output template "${template}" references unknown row key "${key}".`);
    }
    return String(value);
  });
}

export interface BatchRunOptions {
  concurrency: number;
  failFast: boolean;
}

export interface BatchRowResult {
  index: number;
  row: BatchRow;
  output: string;
  ok: boolean;
  error?: string;
  exitCode?: number;
  data?: unknown;
}

/**
 * Run one render per row with bounded concurrency. Stops launching new rows
 * (but lets in-flight ones finish) as soon as one fails, when `failFast` is
 * set.
 */
export async function runBatch(
  rows: BatchRow[],
  outputTemplate: string,
  options: BatchRunOptions,
  renderOne: (row: BatchRow, output: string, index: number) => Promise<unknown>,
): Promise<BatchRowResult[]> {
  const results: BatchRowResult[] = new Array(rows.length);
  let nextIndex = 0;
  let stop = false;

  async function worker(): Promise<void> {
    while (true) {
      if (stop) return;
      const index = nextIndex;
      if (index >= rows.length) return;
      nextIndex += 1;

      const row = rows[index];
      const output = substituteOutputTemplate(outputTemplate, row);
      try {
        const data = await renderOne(row, output, index);
        results[index] = { index, row, output, ok: true, data };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const exitCode =
          err && typeof err === "object" && "exitCode" in err
            ? (err as { exitCode: number }).exitCode
            : undefined;
        results[index] = { index, row, output, ok: false, error: message, exitCode };
        if (options.failFast) stop = true;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(options.concurrency, rows.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
