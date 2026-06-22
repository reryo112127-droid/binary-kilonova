@echo off
setlocal
REM X engagement collector: scrape likes/replies/RT/impressions of recent posts and rebuild
REM data/x_actress_perf.json + x_hour_perf.json (feedback loop). Run once or twice a day.
set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE=C:\Program Files\nodejs\node.exe
set LOG_DIR=%PROJECT_DIR%\logs
set PATH=C:\Program Files\nodejs;%PATH%
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\sns_x_engagement_%TODAY%.log
cd /d "%PROJECT_DIR%"
echo [%time%] engagement collect start >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\x_engagement_collect.js" --days=7 >> "%LOG_FILE%" 2>&1
echo [%time%] engagement collect done: %errorlevel% >> "%LOG_FILE%"
endlocal
