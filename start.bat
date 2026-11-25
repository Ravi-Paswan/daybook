@echo off
setlocal EnableExtensions
title Daybook
rem Daybook launcher for Windows: double-click to run Daybook on this computer.
rem Starts a tiny local web server (tools\serve.py) and opens http://localhost:8080 in your browser.
rem Extra arguments are passed through, e.g.  start.bat --lan  (also reachable from your phone on the same Wi-Fi).
cd /d "%~dp0"

echo.
echo    =============================================
echo       Daybook  -  Life ^& Trade Journal
echo    =============================================
echo.

rem --- Find Python 3: "python" first, then the "py" launcher.
rem     (The Microsoft Store "python" placeholder fails this check, so it is skipped correctly.)
set "PY="
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)" >nul 2>&1 && set "PY=python"
if not defined PY (
  py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)" >nul 2>&1 && set "PY=py -3"
)
if not defined PY goto nopython

if not exist "tools\serve.py" goto noserver

rem --- Already running in another window? Just open it. Daybook always uses the same address,
rem     because your journal is saved per address (http://localhost:8080).
%PY% -c "import sys, urllib.request as u; r = u.urlopen('http://127.0.0.1:8080/manifest.webmanifest', timeout=1); sys.exit(0 if b'Daybook' in r.read() else 1)" >nul 2>&1
if not errorlevel 1 (
  echo    Daybook is already running. Opening it in your browser...
  start "" "http://localhost:8080/"
  timeout /t 3 >nul 2>&1
  exit /b 0
)

echo    Starting Daybook at  http://localhost:8080
echo    Your browser will open in a moment.
echo.
echo    Keep this window open while you use Daybook.
echo    To stop it, close this window or press Ctrl+C.
echo.
%PY% tools\serve.py --open --port 8080 %*
if errorlevel 1 (
  echo.
  echo    Daybook could not start. Another program may be using port 8080.
  echo    Close that program, then double-click start.bat again.
  echo.
  pause
  exit /b 1
)
echo.
echo    Daybook has stopped. See you tomorrow!
echo.
pause
exit /b 0

:nopython
echo    Daybook needs Python 3 to run on this computer, and it was not found.
echo.
echo    1. Download Python (free):  https://www.python.org/downloads/
echo    2. When installing, tick "Add python.exe to PATH".
echo    3. Double-click start.bat again.
echo.
echo    Tip: you can also put Daybook online for free and skip Python entirely.
echo         See README.md, section "Use it on your phone".
echo.
pause
exit /b 1

:noserver
echo    Could not find tools\serve.py next to start.bat.
echo    Keep start.bat inside the Daybook folder (with the tools, js and css folders).
echo.
pause
exit /b 1
