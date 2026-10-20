@echo off
chcp 65001 >nul
title CHARGE - Detailing Studio
cd /d "%~dp0"

echo.
echo  ==========================================================
echo    CHARGE  -  Detailing Studio  (Saint-Petersburg)
echo    Premium detailing website - local development
echo  ==========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js not found. Install Node.js 18+ and try again.
  echo      https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo  [1/2] Installing dependencies (npm install)...
  call npm install
  if errorlevel 1 (
    echo  [X] npm install failed.
    pause
    exit /b 1
  )
) else (
  echo  [1/2] Dependencies are installed.
)

echo  [2/2] Starting dev server on http://localhost:5173
echo.
echo  The site will open in your browser automatically.
echo  Press Ctrl+C in this window to stop the server.
echo.

start "" cmd /c "timeout /t 5 /nobreak >nul & start ""http://localhost:5173"""
call npm run dev

echo.
echo  Server stopped.
pause
