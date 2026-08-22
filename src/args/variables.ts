import { readFileSync } from "node:fs";
import { extractCompositionRoot } from "../composition.js";
import { usageError } from "../output/errors.js";
import { logWarn } from "../output/log.js";

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
    // Strip a UTF-8 BOM before parsing: `JSON.parse` rejects it ("Unexpected
    // token '\uFEFF'"), and PowerShell's `Set-Content -Encoding utf8` writes
    // one by default — so a perfectly valid variables file authored on
    // Windows would otherwise fail with a JSON syntax error that says nothing
    // about the real cause.
    merged = parseJsonObject(raw.replace(/^\uFEFF/, ""), `--variables-file "${variablesFilePath}"`);
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

/**
 * The inverse of `assertStrictVariables`: keys the caller *provided* that the
 * composition never *declared*. An override for an undeclared key is dropped
 * on the floor by the runtime — the render succeeds, exit 0, and the graphic
 * simply ignores the value — so a typo'd key (`titel`, `accentColor` vs
 * `accent`) is invisible to both the CLI and a host application driving it.
 *
 * Returns `[]` when the composition declares nothing at all: that's
 * indistinguishable from "we couldn't parse the declarations", and the same
 * conservative guard `assertStrictVariables` uses — we must never reject a
 * legitimate override just because we failed to find the attribute.
 */
export function findUndeclaredVariableNames(
  html: string,
  variables: VariablesObject | undefined,
): string[] {
  const provided = Object.keys(variables ?? {});
  if (provided.length === 0) return [];

  const declared = new Set(extractDeclaredVariableNames(html));
  if (declared.size === 0) return [];

  return provided.filter((name) => !declared.has(name));
}

/**
 * Report provided-but-undeclared variable keys. A warning by default (an
 * override that lands nowhere is nearly always a typo, but rejecting it
 * outright would break callers who deliberately pass a superset of keys
 * across several compositions); a hard usage error under
 * `--strict-variables`, which already means "I want variable mismatches to
 * fail the run" for the mirror-image case.
 */
export function checkUndeclaredVariables(
  html: string,
  variables: VariablesObject | undefined,
  strict: boolean,
): void {
  const unknown = findUndeclaredVariableNames(html, variables);
  if (unknown.length === 0) return;

  const declared = extractDeclaredVariableNames(html);
  const detail =
    `variable(s) not declared by this composition: ${unknown.join(", ")}. ` +
    `Declared: ${declared.join(", ")}.`;

  if (strict) {
    throw usageError(
      `--strict-variables: ${detail}`,
      "Check for a typo in --variables/--variables-file, or drop --strict-variables to pass them anyway (they will be ignored).",
    );
  }
  logWarn(`${detail} These override(s) will be ignored.`);
}
