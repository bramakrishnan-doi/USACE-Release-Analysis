@echo off
setlocal
title USACE Release Analysis

echo =======================================================
echo     USACE Release Analysis - Windows Launcher
echo =======================================================
echo.

cd /d "%~dp0"

:: Attempt 1: Node.js static server (preferred)
where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [OK] Node.js detected.
    echo [*] Starting static server on http://localhost:3000 ...
    echo [*] Opening application in your default web browser...
    start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"
    call npx --yes http-server -p 3000 -c-1 -s
    goto :end
)

:: Attempt 2: Python static server
where python >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [!] Node.js not found, but Python is available.
    echo [*] Starting lightweight Python web server on http://localhost:3000...
    start "" http://localhost:3000
    python -m http.server 3000
    goto :end
)

:: Attempt 3: Open index.html directly
echo [!] Neither Node.js nor Python was detected.
echo [*] Opening index.html directly in your default browser...
start "" "%~dp0index.html"

echo.
echo Note: If your browser restricts USGS API requests when opening from a local file,
echo install Node.js from https://nodejs.org/ and run this launcher again.
echo.
pause

:end