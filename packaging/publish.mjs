#!/usr/bin/env node
/**
 * packaging/publish.mjs — does locally, from one command, what
 * `.github/workflows/release.yml`'s `publish` job would do in CI: build the
 * host platform's archives, checksum them, generate release notes, and
 * create/update the GitHub Release with the archives attached.
 *
 * It exists because Actions is unavailable for this repo (billing), so
 * v0.1.0 was assembled and uploaded by hand — this script is that hand
 * process, written down, so the next release is reproducible and can't
 * silently omit a channel (v0.1.0's editor archive was built locally and
 * then never uploaded).
 *
 * Deliberately talks to the GitHub REST API with `fetch` and a PAT rather
 * than shelling out to `gh` — the `gh` CLI is not installed on the Windows
 * box this runs on, and a PAT in an env var is what's actually available.
 *
 * Usage:
 *   $env:GITHUB_TOKEN = "<PAT with 'contents: write' on this repo>"
 *   node packaging/publish.mjs                       # build all 3 channels, publish v<version>
 *   node packaging/publish.mjs --dry-run             # build + checksum + print notes, no API calls
 *   node packaging/publish.mjs --skip-build          # reuse whatever's already in packaging/out/
 *   node packaging/publish.mjs --channels lite,editor
 *   node packaging/publish.mjs --extra-dir ..\from-semaphore   # also attach macOS/Linux archives
 *                                                    # built elsewhere (see .semaphore/semaphore.yml)
 *
 * Flags:
 *   --tag <v1.2.3>     Release tag. Default: `v<package.json version>`.
 *   --channels <list>  Comma-separated: lite,editor,standalone. Default: all three.
 *   --extra-dir <dir>  Directory of additional `.zip`/`.tar.gz` archives to
 *                      attach (e.g. downloaded from Semaphore's artifact
 *                      store). Any `SHA256SUMS` in there is ignored — this
 *                      script recomputes one covering every attached asset.
 *   --require-pinned   Passed through to build.mjs for the standalone channel:
 *                      refuse to bundle an ffmpeg build with no checksum pin
 *                      in packaging/checksums.json.
 *   --skip-build       Don't run build.mjs; collect existing archives instead.
 *   --draft            Create the release as a draft.
 *   --prerelease       Mark the release as a prerelease.
 *   --target <ref>     Commit-ish for GitHub to create the tag from if it
 *                      doesn't exist remotely. Default: current HEAD sha.
 *   --repo <owner/name>  Default: parsed from `git remote get-url origin`.
 *   --dry-run          Do everything except the API writes.
 *
 * The token is read from `GITHUB_TOKEN` or `GH_TOKEN` and is never printed,
 * not even in error messages (API error bodies are echoed, request headers
 * never are).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const outRoot = join(repoRoot, "packaging", "out");

const ALL_CHANNELS = ["lite", "editor", "standalone"];
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
function value(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
}

function log(message) {
  process.stdout.write(`[publish] ${message}\n`);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.trim()}`);
  return result.stdout.trim();
}

/** Same `cmd.exe` indirection build.mjs uses, for the same `.cmd`-isn't-executable reason. */
function runNode(args) {
  log(`$ node ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`node ${args.join(" ")} failed (exit ${result.status})`);
}

function captureNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`node ${args.join(" ")} failed (exit ${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", rejectPromise)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function parseRepoSlug() {
  const explicit = value("--repo");
  if (explicit) return explicit;
  const url = git(["remote", "get-url", "origin"]);
  const match = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!match) throw new Error(`Could not parse an owner/name out of origin remote "${url}". Pass --repo.`);
  return `${match[1]}/${match[2]}`;
}

/**
 * `hfmpeg-<version>-<os>-<arch>-<channel>.<ext>` → its `<os>-<arch>` and
 * `<channel>`, so the release notes can state exactly which platforms this
 * particular hand-built release actually covers instead of implying the full
 * CI matrix was published.
 */
function describeAsset(name) {
  const match = name.match(/^hfmpeg-[\d.]+-(\w+)-(\w+)-(lite|editor|standalone)\.(zip|tar\.gz)$/);
  if (!match) return undefined;
  return { platform: `${match[1]}-${match[2]}`, channel: match[3] };
}

function collectArchives(version, channels) {
  const wanted = [];
  const fromDir = (dir, { channelFilter }) => {
    if (!existsSync(dir)) throw new Error(`No such directory: ${dir}`);
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".zip") && !entry.endsWith(".tar.gz")) continue;
      const described = describeAsset(entry);
      if (!described) {
        log(`Ignoring unrecognised archive name: ${entry}`);
        continue;
      }
      if (!entry.includes(`-${version}-`)) {
        log(`Ignoring ${entry} — not version ${version}.`);
        continue;
      }
      if (channelFilter && !channelFilter.includes(described.channel)) continue;
      wanted.push({ path: join(dir, entry), name: entry, ...described });
    }
  };

  fromDir(outRoot, { channelFilter: channels });
  const extraDir = value("--extra-dir");
  if (extraDir) fromDir(resolve(extraDir), { channelFilter: undefined });

  if (wanted.length === 0) {
    throw new Error(
      `No archives found for version ${version}. Build them first (npm run package:lite / :editor / :standalone) ` +
        `or drop them in --extra-dir.`,
    );
  }
  wanted.sort((a, b) => a.name.localeCompare(b.name));
  return wanted;
}

async function hashLocalAssets(assets) {
  for (const asset of assets) {
    asset.sha256 = await sha256File(asset.path);
  }
  log(`Local checksums:\n${assets.map((a) => `  ${a.sha256}  ${a.name}`).join("\n")}`);
}

/**
 * `sha256sum`/`shasum -a 256` output format (two spaces, binary-mode marker
 * omitted) so `sha256sum -c SHA256SUMS` works verbatim for anyone who
 * downloads it — same file release.yml's `publish` job would have produced.
 */
function writeChecksumsFile(lines) {
  const path = join(outRoot, "SHA256SUMS");
  writeFileSync(path, `${lines.join("\n")}\n`);
  log(`Wrote ${path}:\n${lines.map((l) => `  ${l}`).join("\n")}`);
  return { path, name: "SHA256SUMS" };
}

/**
 * The generated notes from release-notes.mjs, prefixed with an honest
 * account of how this build was produced and which platforms it covers —
 * because a locally built release genuinely is narrower than a CI one and
 * pretending otherwise wastes a downloader's time.
 *
 * `names` is every archive attached to the release, not just the ones this
 * run uploaded: a release is assembled from more than one machine (win-x64
 * here, macos-arm64 from Semaphore — see `.semaphore/semaphore.yml`), and a
 * second run must not rewrite the body to claim only its own platform.
 */
function buildNotes(names) {
  const generated = captureNode([join(repoRoot, "packaging", "release-notes.mjs")]);

  const byPlatform = new Map();
  for (const name of names) {
    const described = describeAsset(name);
    if (!described) continue;
    if (!byPlatform.has(described.platform)) byPlatform.set(described.platform, []);
    byPlatform.get(described.platform).push(described.channel);
  }
  const coverage = [...byPlatform.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, channels]) => `> - \`${platform}\`: ${ALL_CHANNELS.filter((c) => channels.includes(c)).join(", ")}`)
    .join("\n");

  const preamble = `> **Note:** these archives were built and published from a maintainer's
> machine rather than by CI (GitHub Actions is unavailable for this repo —
> see \`packaging/publish.mjs\`). Each one was still smoke-tested by
> \`packaging/build.mjs\` on the platform it targets, including a real
> end-to-end render. Platforms attached to this release:
>
${coverage}
>
> Any platform not listed above is not published yet.

`;
  return preamble + generated;
}

class GitHub {
  constructor(slug, token) {
    this.slug = slug;
    this.token = token;
  }

  async request(method, url, { body, headers = {}, raw } = {}) {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "hfmpeg-publish",
        ...headers,
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${method} ${url.replace(UPLOADS, "").replace(API, "")} -> ${res.status} ${res.statusText}\n${text}`);
    }
    if (res.status === 204) return undefined;
    return res.json();
  }

  getRelease(tag) {
    return this.request("GET", `${API}/repos/${this.slug}/releases/tags/${encodeURIComponent(tag)}`).catch((err) => {
      if (/-> 404/.test(err.message)) return undefined;
      throw err;
    });
  }

  createRelease(payload) {
    return this.request("POST", `${API}/repos/${this.slug}/releases`, { body: payload });
  }

  updateRelease(id, payload) {
    return this.request("PATCH", `${API}/repos/${this.slug}/releases/${id}`, { body: payload });
  }

  deleteAsset(id) {
    return this.request("DELETE", `${API}/repos/${this.slug}/releases/assets/${id}`);
  }

  listAssets(releaseId) {
    return this.request("GET", `${API}/repos/${this.slug}/releases/${releaseId}/assets?per_page=100`);
  }

  /**
   * Uploads are the one flaky step here — a 270 MB standalone archive over a
   * home connection times out often enough that a bare failure would leave
   * the release half-populated, which is worse than any other failure mode
   * in this script. Retry a few times; a same-named asset is deleted first
   * so a retry can't produce `foo.zip.1`.
   */
  async uploadAsset(release, asset, { attempts = 3 } = {}) {
    const contentType = asset.name.endsWith(".zip")
      ? "application/zip"
      : asset.name.endsWith(".tar.gz")
        ? "application/gzip"
        : "text/plain";
    const size = statSync(asset.path).size;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const existing = (await this.listAssets(release.id)).find((a) => a.name === asset.name);
      if (existing) {
        log(`Replacing existing asset ${asset.name} (id ${existing.id})`);
        await this.deleteAsset(existing.id);
      }
      try {
        const url = `${UPLOADS}/repos/${this.slug}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`;
        log(`Uploading ${asset.name} (${(size / (1024 * 1024)).toFixed(1)} MB, attempt ${attempt}/${attempts})`);
        // Buffered rather than streamed: GitHub's asset endpoint wants a
        // known Content-Length, and the largest archive here (~270 MB) fits
        // in memory far more cheaply than chunked-upload bookkeeping costs.
        const uploaded = await this.request("POST", url, {
          raw: readFileSync(asset.path),
          headers: { "content-type": contentType, "content-length": String(size) },
        });
        return uploaded;
      } catch (err) {
        if (attempt === attempts) throw err;
        log(`Upload failed (${err.message.split("\n")[0]}); retrying in 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    throw new Error("unreachable");
  }
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const tag = value("--tag", `v${pkg.version}`);
  const channels = value("--channels", ALL_CHANNELS.join(",")).split(",").map((c) => c.trim()).filter(Boolean);
  const invalid = channels.filter((c) => !ALL_CHANNELS.includes(c));
  if (invalid.length > 0) throw new Error(`Unknown channel(s): ${invalid.join(", ")}. Expected: ${ALL_CHANNELS.join(", ")}.`);

  const dryRun = has("--dry-run");
  const slug = parseRepoSlug();
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token && !dryRun) {
    throw new Error(
      "No GITHUB_TOKEN (or GH_TOKEN) in the environment. Set it to a PAT with `contents: write` on " +
        `${slug}, or pass --dry-run to build and checksum without publishing.`,
    );
  }

  log(`Publishing ${tag} to ${slug}${dryRun ? " (DRY RUN — no API writes)" : ""}`);

  if (!has("--skip-build")) {
    for (const channel of channels) {
      log(`=== Building + smoke-testing the ${channel} archive ===`);
      const args = [join(repoRoot, "packaging", "build.mjs"), "--channel", channel];
      if (channel === "standalone" && has("--require-pinned")) args.push("--require-pinned");
      runNode(args);
    }
  } else {
    log("Skipping builds (--skip-build) — collecting existing archives.");
    // release-notes.mjs needs dist/meta.js, which build.mjs would have made.
    if (!existsSync(join(repoRoot, "dist", "meta.js"))) {
      throw new Error("--skip-build, but dist/meta.js is missing. Run `npm run build` first.");
    }
  }

  const assets = collectArchives(pkg.version, channels);
  log(`Attaching ${assets.length} archive(s):\n${assets.map((a) => `  - ${a.name}`).join("\n")}`);

  const missing = channels.filter((c) => !assets.some((a) => a.channel === c));
  if (missing.length > 0) {
    throw new Error(`Requested channel(s) with no built archive: ${missing.join(", ")}.`);
  }

  await hashLocalAssets(assets);

  if (dryRun) {
    writeChecksumsFile(assets.map((a) => `${a.sha256}  ${a.name}`));
    const notes = buildNotes(assets.map((a) => a.name));
    log(`Release notes for ${tag}:\n${"-".repeat(72)}\n${notes}${"-".repeat(72)}`);
    log("Dry run complete — nothing was uploaded.");
    return;
  }

  const gh = new GitHub(slug, token);
  let release = await gh.getRelease(tag);
  if (release) {
    log(`Release ${tag} already exists (id ${release.id}) — replacing this platform's assets.`);
  } else {
    const target = value("--target", git(["rev-parse", "HEAD"]));
    log(`Creating release ${tag} (tag created from ${target.slice(0, 12)} if it doesn't exist remotely).`);
    release = await gh.createRelease({
      tag_name: tag,
      name: `hfmpeg ${tag}`,
      body: buildNotes(assets.map((a) => a.name)),
      draft: has("--draft"),
      prerelease: has("--prerelease"),
      target_commitish: target,
    });
  }

  for (const asset of assets) {
    await gh.uploadAsset(release, asset);
  }

  // SHA256SUMS and the release body are both derived from *everything*
  // currently attached, after the uploads — so publishing macos-arm64 from
  // Semaphore into a release that already has win-x64 archives extends both
  // files rather than clobbering them.
  //
  // Hashes come from GitHub's own reported `digest` rather than from our
  // local files, which doubles as upload verification: a truncated upload is
  // the one failure this process really can't afford, and the API hands us
  // the hash for free.
  const attached = await gh.listAssets(release.id);
  const archives = attached.filter((a) => describeAsset(a.name)).sort((a, b) => a.name.localeCompare(b.name));
  const lines = [];
  for (const remote of archives) {
    const local = assets.find((a) => a.name === remote.name);
    const digest = (remote.digest ?? "").replace(/^sha256:/, "");
    if (local && digest && digest !== local.sha256) {
      throw new Error(
        `Upload verification failed for ${remote.name}: GitHub reports sha256 ${digest}, local file is ${local.sha256}. ` +
          `Re-run to replace the asset.`,
      );
    }
    const hash = digest || local?.sha256;
    if (!hash) {
      log(`WARNING: no checksum available for the already-attached ${remote.name} — omitted from SHA256SUMS.`);
      continue;
    }
    lines.push(`${hash}  ${remote.name}`);
    log(`Verified ${remote.name}${local ? " (uploaded now, sha256 matches)" : " (already attached)"}`);
  }

  for (const asset of assets) {
    if (!archives.some((a) => a.name === asset.name)) {
      throw new Error(`Verification failed: ${asset.name} is not attached to the release.`);
    }
  }

  await gh.uploadAsset(release, writeChecksumsFile(lines));
  release = await gh.updateRelease(release.id, {
    name: `hfmpeg ${tag}`,
    body: buildNotes(archives.map((a) => a.name)),
  });

  log(`Done: ${release.html_url}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    process.stderr.write(`[publish] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
