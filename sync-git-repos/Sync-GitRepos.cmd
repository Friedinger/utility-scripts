@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Sync-GitRepos.ps1" %*
echo.
pause
