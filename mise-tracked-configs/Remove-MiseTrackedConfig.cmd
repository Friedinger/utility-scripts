@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Remove-MiseTrackedConfig.ps1" %*
echo.
pause
