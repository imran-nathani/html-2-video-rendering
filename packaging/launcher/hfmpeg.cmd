@echo off
setlocal
rem hfmpeg lite launcher (00-PLAN.md §3, packaging/launcher/).
rem Resolves the archive root relative to this script and execs the bundled
rem Node CLI. Lite archives bundle no ffmpeg/chromium/env overrides — those
rem are injected here only in the standalone launcher (Phase 5).
set "DIR=%~dp0.."
node "%DIR%\dist\cli.js" %*
exit /b %ERRORLEVEL%
