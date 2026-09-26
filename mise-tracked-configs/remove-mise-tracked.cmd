@echo off
setlocal
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0remove-mise-tracked.ps1" %*
echo.
pause
