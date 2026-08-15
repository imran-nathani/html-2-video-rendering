export function printTopLevelHelp(): void {
  const lines = [
    "hfmpeg <command> [input] [flags]",
    "",
    "Commands:",
    "  render      Render a composition to mp4/webm/mov/gif/png-sequence",
    "  probe       Print composition metadata without rendering",
    "  lint        Static HTML checks on a composition, no browser",
    "  doctor      Report the environment: Node, FFmpeg, FFprobe, Chromium",
    "  deps        Manage FFmpeg/Chromium dependencies (status, chromium, ffmpeg)",
    "  version     Print hfmpeg version and upstream package versions",
    "  completion  Emit a shell completion script (bash, zsh, fish, powershell)",
    "  help        Usage for hfmpeg or one command",
    "",
    'Run "hfmpeg help <command>" for command-specific flags.',
  ];
  console.log(lines.join("\n"));
}

export function printRenderHelp(): void {
  const lines = [
    "hfmpeg render [dir] --output <path> [flags]",
    "",
    "Examples:",
    "  hfmpeg render ./my-video -o out.mp4",
    "  hfmpeg render ./my-video -c compositions/intro.html -o intro.mp4",
    "  hfmpeg render -i ./my-video/index.html -o out.mp4",
    "  hfmpeg render ./my-video --fps 30000/1001 --quality high -o ntsc.mp4",
    "",
    "Flags:",
    "  -i, --input <path>        Project directory or an .html file",
    "  -c, --composition <file>  Entry HTML relative to the project dir (default: index.html)",
    "  -o, --output <path>       Output file (required)",
    "      --format <fmt>        mp4 | webm | mov | gif | png-sequence (inferred from -o extension)",
    "  -f, --fps <n>             Integer 1..240, or a rational like \"30000/1001\" (default: 30)",
    "  -q, --quality <q>         draft | standard | high (default: standard)",
    "  -w, --workers <n>         1..24 Chrome workers (default: auto)",
    "      --quiet               Suppress progress output",
    "      --json                Print a single machine-readable JSON document",
    "      --dry-run             Resolve paths/binaries/config/duration and print the plan; do not render",
    "      --ffmpeg-path <path>  Explicit FFmpeg binary (sets HYPERFRAMES_FFMPEG_PATH)",
    "      --ffprobe-path <path> Explicit FFprobe binary (sets HYPERFRAMES_FFPROBE_PATH)",
    "      --chromium-path <path> Explicit Chrome/chrome-headless-shell (sets PRODUCER_HEADLESS_SHELL_PATH)",
  ];
  console.log(lines.join("\n"));
}

export function printProbeHelp(): void {
  const lines = [
    "hfmpeg probe [dir] [flags]",
    "",
    "Examples:",
    "  hfmpeg probe ./my-video",
    "  hfmpeg probe ./my-video --json",
    "  hfmpeg probe ./my-video --compositions",
    "  hfmpeg probe ./my-video --variables",
    "",
    "Flags:",
    "  -c, --composition <file>  Probe a specific entry file (default: index.html)",
    "      --compositions        List every composition in the project instead of describing one",
    "      --variables           Print only the declared variable schema",
    "      --assets              Print only the asset inventory, with resolution status",
    "      --fps <n>             Compute duration -> frame count against this rate",
    "      --json                Print a single machine-readable JSON document",
  ];
  console.log(lines.join("\n"));
}

export function printLintHelp(): void {
  const lines = [
    "hfmpeg lint [dir] [flags]",
    "",
    "Examples:",
    "  hfmpeg lint ./my-video",
    "  hfmpeg lint ./my-video --strict",
    "  hfmpeg lint ./my-video --json",
    "",
    "Flags:",
    "  -c, --composition <file>  Lint a specific entry file (default: index.html)",
    "      --strict              Exit non-zero on warnings as well as errors",
    "      --verbose             Include info-level findings (hidden by default)",
    "      --json                { errorCount, warningCount, infoCount, findings[] }",
  ];
  console.log(lines.join("\n"));
}

export function printDepsHelp(): void {
  const lines = [
    "hfmpeg deps <status|chromium|ffmpeg> [action] [flags]",
    "",
    "Examples:",
    "  hfmpeg deps status",
    "  hfmpeg deps chromium ensure",
    "  hfmpeg deps chromium path",
    "  hfmpeg deps chromium clear",
    "  hfmpeg deps ffmpeg path",
    "",
    "Flags:",
    "      --version <ver>   Pin a specific Chromium version instead of the release default",
    "      --cache-dir <path> Install/inspect somewhere other than the default cache",
    "      --force           Re-download even if a copy exists",
    "      --json            Machine-readable status",
  ];
  console.log(lines.join("\n"));
}

export function printCompletionHelp(): void {
  const lines = [
    "hfmpeg completion <bash|zsh|fish|powershell>",
    "",
    "Examples:",
    "  hfmpeg completion bash   >> ~/.bashrc",
    "  hfmpeg completion zsh    > \"${fpath[1]}/_hfmpeg\"",
    "  hfmpeg completion fish   > ~/.config/fish/completions/hfmpeg.fish",
  ];
  console.log(lines.join("\n"));
}
