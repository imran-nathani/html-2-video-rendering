import { readFileSync } from "node:fs";
import { extractCompositionRoot } from "../composition.js";
import { usageError } from "../output/errors.js";

export type VariablesObject = Record<string, unknown>;

function parseJsonObject(raw: string, sourceLabel: string): VariablesObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw usageError(`Invalid JSON in ${sourceLabel}: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(`${sourceLabel} must be a JSON object, e.g. {"title":"Q4 Report"}.`);
  }
  return parsed as VariablesObject;
}

/**
 * Merge `--variables` (inline JSON) over `--variables-file` (JSON file), per
 * `00-COMMANDS.md`: "JSON object merged over the composition's
 * `data-composition-variables` defaults." Inline `--variables` wins over the
 * file when both are given.
 */
export function resolveVariables(
  variablesJson: string | undefined,
  variablesFilePath: string | undefined,
): VariablesObject | undefined {
  let merged: VariablesObject | undefined;

  if (variablesFilePath) {
    let raw: string;
    try {
      raw = readFileSync(variablesFilePath, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw usageError(`Could not read --variables-file "${variablesFilePath}": ${message}`);
    }
    merged = parseJsonObject(raw, `--variables-file "${variablesFilePath}"`);
  }

  if (variablesJson) {
    const inline = parseJsonObject(variablesJson, "--variables");
    merged = merged ? { ...merged, ...inline } : inline;
  }

  return merged;
}

/**
 * Extract the composition's declared variable ids from the
 * `data-composition-variables` JSON attribute on its `[data-composition-id]`
 * root, without a full DOM parse. Matches the shape written by
 * `parseCompositionVariables` (`@hyperframes/parsers`): an array of
 * `{ id, type, ... }` objects (see `CompositionVariableBase`). Returns `[]`
 * when the attribute is absent or malformed — `--strict-variables` only has
 * something to enforce when declarations exist.
 */
export function extractDeclaredVariableNames(html: string): string[] {
  const root = extractCompositionRoot(html);
  return root?.variables.map((v) => v.id) ?? [];
}

/**
 * `--strict-variables`: fail (instead of silently falling back to the
 * composition's own defaults) when a declared variable has no value in the
 * merged `--variables`/`--variables-file` overrides.
 */
export function assertStrictVariables(
  html: string,
  variables: VariablesObject | undefined,
): void {
  const declared = extractDeclaredVariableNames(html);
  if (declared.length === 0) return;

  const provided = new Set(Object.keys(variables ?? {}));
  const missing = declared.filter((name) => !provided.has(name));
  if (missing.length > 0) {
    throw usageError(
      `--strict-variables: missing value(s) for declared variable(s): ${missing.join(", ")}.`,
      "Pass them via --variables or --variables-file, or drop --strict-variables to use the composition's defaults.",
    );
  }
}
