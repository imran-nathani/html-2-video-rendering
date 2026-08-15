@echo off
setlocal
rem hfmpeg standalone launcher (00-PLAN.md §2.2/§3/§1 "Zero host deps").
rem Unlike the lite launcher, this bundles its own Node runtime (no `node`
rem on PATH required) and injects the bundled ffmpeg/ffprobe/chromium paths
rem as env overrides — but only when the user hasn't already set one, so
rem --ffmpeg-path / HYPERFRAMES_FFMPEG_PATH / etc. still win (flag > env >
rem bundled, same precedence as everywhere else — D11/section 2.4).
rem HFMPEG_NO_BUNDLED_BINARIES (00-COMMANDS.md "Environment variables") skips
rem this injection entirely, so even a standalone archive can be forced to
rem resolve everything from PATH.
set "DIR=%~dp0.."

if defined HFMPEG_NO_BUNDLED_BINARIES goto :run

if not defined HYPERFRAMES_FFMPEG_PATH set "HYPERFRAMES_FFMPEG_PATH=%DIR%\bin\ffmpeg.exe"
if not defined HYPERFRAMES_FFPROBE_PATH set "HYPERFRAMES_FFPROBE_PATH=%DIR%\bin\ffprobe.exe"
if not defined PRODUCER_HEADLESS_SHELL_PATH set "PRODUCER_HEADLESS_SHELL_PATH=%DIR%\bin\chrome-headless-shell\chrome-headless-shell.exe"

:run
"%DIR%\bin\node.exe" "%DIR%\dist\cli.js" %*
exit /b %ERRORLEVEL%
