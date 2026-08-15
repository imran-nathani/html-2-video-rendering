import { usageError } from "../output/errors.js";

const COMMANDS = ["render", "probe", "lint", "doctor", "deps", "version", "help", "completion"];

function bashScript(): string {
  return `# hfmpeg bash completion
_hfmpeg_completions() {
  local cur commands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  commands="${COMMANDS.join(" ")}"
  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
  fi
}
complete -F _hfmpeg_completions hfmpeg
`;
}

function zshScript(): string {
  return `#compdef hfmpeg
_hfmpeg() {
  local -a commands
  commands=(${COMMANDS.map((c) => `'${c}'`).join(" ")})
  _describe 'command' commands
}
_hfmpeg
`;
}

function fishScript(): string {
  return COMMANDS.map((c) => `complete -c hfmpeg -n "__fish_use_subcommand" -a "${c}"`).join("\n") + "\n";
}

function powershellScript(): string {
  return `Register-ArgumentCompleter -Native -CommandName hfmpeg -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = @(${COMMANDS.map((c) => `'${c}'`).join(", ")})
  $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}

export function runCompletionCommand(shell: string | undefined): number {
  switch (shell) {
    case "bash":
      process.stdout.write(bashScript());
      return 0;
    case "zsh":
      process.stdout.write(zshScript());
      return 0;
    case "fish":
      process.stdout.write(fishScript());
      return 0;
    case "powershell":
      process.stdout.write(powershellScript());
      return 0;
    default:
      throw usageError(
        `Unknown shell "${shell ?? ""}" for "hfmpeg completion".`,
        "Expected one of: bash, zsh, fish, powershell.",
      );
  }
}
