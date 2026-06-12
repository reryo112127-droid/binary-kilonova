@echo off
setlocal
REM Daily SNS pipeline: top up the post queue, then prepare the X manual-post batch.
set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE=C:\Program Files\nodejs\node.exe
set LOG_DIR=%PROJECT_DIR%\logs
set PATH=C:\Program Files\nodejs;%PATH%
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\sns_daily_%TODAY%.log
cd /d "%PROJECT_DIR%"
echo ======================================== >> "%LOG_FILE%"
echo [%time%] sns daily start >> "%LOG_FILE%"

REM [1] auto-select works into the approval queue (8 per genre = ~48/day buffer for 6 accounts x 6 runs)
"%NODE%" "%PROJECT_DIR%\scripts\x_queue_fill.js" --per=8 >> "%LOG_FILE%" 2>&1
echo [%time%] queue fill done: %errorlevel% >> "%LOG_FILE%"

REM (X posting is fully automated via x_browser_post.js on the "SNS X Browser Post" task; manual x_prepare retired)

echo [%time%] sns daily done >> "%LOG_FILE%"
endlocal
