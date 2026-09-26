@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-repos.ps1" %*
echo.
pause
