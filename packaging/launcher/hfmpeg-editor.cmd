@echo off
setlocal
rem hfmpeg editor launcher — like the standalone launcher (bundles its own
rem Node runtime, bundles the pinned chrome-headless-shell), but deliberately
rem does NOT bundle or inject an ffmpeg/ffprobe override: this channel is for
rem embedding inside a host application that already ships its own FFmpeg,
rem so FFmpeg/FFprobe resolve from the host exactly like the lite launcher
rem (PATH / HYPERFRAMES_FFMPEG_PATH / --ffmpeg-path, all handled inside the
rem CLI itself). HFMPEG_NO_BUNDLED_BINARIES skips even the Chromium
rem injection, so this can be forced to resolve everything from PATH too.
set "DIR=%~dp0.."

if defined HFMPEG_NO_BUNDLED_BINARIES goto :run

if not defined PRODUCER_HEADLESS_SHELL_PATH set "PRODUCER_HEADLESS_SHELL_PATH=%DIR%\bin\chrome-headless-shell\chrome-headless-shell.exe"

:run
"%DIR%\bin\node.exe" "%DIR%\dist\cli.js" %*
exit /b %ERRORLEVEL%
