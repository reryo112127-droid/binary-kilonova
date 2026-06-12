@echo off
setlocal
REM Bluesky auto post: post 1 approved work from the queue. Schedule every few hours.
set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE=C:\Program Files\nodejs\node.exe
set LOG_DIR=%PROJECT_DIR%\logs
set PATH=C:\Program Files\nodejs;%PATH%
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\sns_bluesky_%TODAY%.log
cd /d "%PROJECT_DIR%"
echo [%time%] bluesky post start >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\bluesky_autopost.js" --account=main >> "%LOG_FILE%" 2>&1
echo [%time%] bluesky post done: %errorlevel% >> "%LOG_FILE%"
endlocal
