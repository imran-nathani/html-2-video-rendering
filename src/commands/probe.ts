import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import {
  extractCompositionRoot,
  findAssetSources,
  findSubCompositionRefs,
  REMOTE_SRC_RE,
  summarizeTimeline,
} from "../composition.js";
import { parseFpsArg } from "../args/fps.js";
import { EXIT_CODES, toCliError, usageError } from "../output/errors.js";
import { printCliError, printJsonEnvelope } from "../output/json.js";
import { readEntryHtml, resolveProjectInput } from "../project.js";

export interface ProbeArgs {
  positionalDir?: string;
  composition?: string;
  compositions: boolean;
  variablesOnly: boolean;
  assetsOnly: boolean;
  fps?: string;
  json: boolean;
}

export function parseProbeArgs(argv: string[]): ProbeArgs {
  const args: ProbeArgs = { compositions: false, variablesOnly: false, assetsOnly: false, json: false };
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === "--composition" || token === "-c") {
      const value = argv[i + 1];
      if (value === undefined) throw usageError(`Flag "${token}" requires a value.`);
      args.composition = value;
      i += 2;
      continue;
    }
    if (token === "--fps") {
      const value = argv[i + 1];
      if (value === undefined) throw usageError(`Flag "${token}" requires a value.`);
      args.fps = value;
      i += 2;
      continue;
    }
    if (token === "--compositions") {
      args.compositions = true;
      i += 1;
      continue;
    }
    if (token === "--variables") {
      args.variablesOnly = true;
      i += 1;
      continue;
    }
    if (token === "--assets") {
      args.assetsOnly = true;
      i += 1;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      throw usageError(`Unknown flag "${token}".`, "Run `hfmpeg help probe` for usage.");
    }
    if (args.positionalDir === undefined) {
      args.positionalDir = token;
      i += 1;
      continue;
    }
    throw usageError(`Unexpected argument "${token}".`);
  }
  return args;
}

function resolveAssetRefs(projectDir: string, sources: string[]) {
  return sources.map((src) => {
    if (REMOTE_SRC_RE.test(src)) return { src, remote: true };
    const absolute = resolve(projectDir, src);
    return { src, remote: false, exists: existsSync(absolute) };
  });
}

function describeComposition(projectDir: string, entryFile: string | undefined, fpsArg: string | undefined) {
  const html = readEntryHtml(projectDir, entryFile);
  const root = extractCompositionRoot(html);
  const timeline = summarizeTimeline(html);
  const subCompositions = findSubCompositionRefs(html);
  const assets = resolveAssetRefs(projectDir, findAssetSources(html));

  let frameCountAtFps: number | undefined;
  if (fpsArg !== undefined && root?.durationSeconds !== undefined) {
    const fps = parseFpsArg(fpsArg);
    frameCountAtFps = Math.round((root.durationSeconds * fps.num) / fps.den);
  }

  return {
    entryFile: entryFile ?? "index.html",
    compositionId: root?.compositionId,
    width: root?.width,
    height: root?.height,
    fps: root?.fps,
    durationSeconds: root?.durationSeconds,
    frameCountAtFps,
    clipCount: timeline.clipCount,
    trackCount: timeline.trackCount,
    elementCounts: timeline.elementCounts,
    variables: root?.variables ?? [],
    subCompositions,
    assets,
  };
}

/** `--compositions`: recursively list every `.html` file under the project dir that has a composition root. */
function listCompositions(projectDir: string) {
  const results: Array<{
    file: string;
    compositionId?: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
  }> = [];

  const skipDirs = new Set(["node_modules", ".git", "dist"]);

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (!skipDirs.has(entry)) walk(full);
        continue;
      }
      if (extname(entry).toLowerCase() !== ".html") continue;
      const html = readFileSync(full, "utf8");
      const root = extractCompositionRoot(html);
      if (!root?.compositionId) continue;
      results.push({
        file: relative(projectDir, full).split("\\").join("/"),
        compositionId: root.compositionId,
        width: root.width,
        height: root.height,
        durationSeconds: root.durationSeconds,
      });
    }
  };

  walk(projectDir);
  return results;
}

export function runProbeCommand(args: ProbeArgs): number {
  try {
    const { projectDir, entryFile } = resolveProjectInput({
      positionalDir: args.positionalDir,
      composition: args.composition,
    });
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
      throw usageError(`Project directory not found: ${projectDir}`);
    }

    if (args.compositions) {
      const compositions = listCompositions(projectDir);
      if (args.json) {
        printJsonEnvelope({ ok: true, command: "probe", data: { compositions } });
      } else {
        for (const c of compositions) {
          console.log(
            `${c.file}  id=${c.compositionId ?? "?"}  ${c.width ?? "?"}x${c.height ?? "?"}  duration=${c.durationSeconds ?? "?"}s`,
          );
        }
      }
      return EXIT_CODES.OK;
    }

    const data = describeComposition(projectDir, entryFile, args.fps);

    if (args.variablesOnly) {
      if (args.json) {
        printJsonEnvelope({ ok: true, command: "probe", data: { variables: data.variables } });
      } else {
        for (const v of data.variables) {
          console.log(`${v.id}  (${v.type})  default=${JSON.stringify(v.default)}`);
        }
      }
      return EXIT_CODES.OK;
    }

    if (args.assetsOnly) {
      if (args.json) {
        printJsonEnvelope({ ok: true, command: "probe", data: { assets: data.assets } });
      } else {
        for (const a of data.assets) {
          const status = a.remote ? "remote" : a.exists ? "ok" : "MISSING";
          console.log(`[${status}] ${a.src}`);
        }
      }
      return EXIT_CODES.OK;
    }

    if (args.json) {
      printJsonEnvelope({ ok: true, command: "probe", data });
    } else {
      console.log(`composition   ${data.compositionId ?? "(none found)"}`);
      console.log(`size           ${data.width ?? "?"}x${data.height ?? "?"}`);
      console.log(`fps            ${data.fps ?? "(default 30)"}`);
      console.log(`duration       ${data.durationSeconds ?? "?"}s`);
      if (data.frameCountAtFps !== undefined) console.log(`frames @ --fps ${data.frameCountAtFps}`);
      console.log(`clips/tracks   ${data.clipCount} clip(s) across ${data.trackCount} track(s)`);
      console.log(
        `elements       img=${data.elementCounts.img} video=${data.elementCounts.video} audio=${data.elementCounts.audio} canvas=${data.elementCounts.canvas} other=${data.elementCounts.other}`,
      );
      console.log(`variables      ${data.variables.length}`);
      console.log(`sub-comps      ${data.subCompositions.length}`);
      console.log(
        `assets         ${data.assets.length} (${data.assets.filter((a) => !a.remote && a.exists === false).length} missing)`,
      );
    }
    return EXIT_CODES.OK;
  } catch (err) {
    const cliError = toCliError(err);
    printCliError("probe", cliError, args.json);
    return cliError.exitCode;
  }
}
