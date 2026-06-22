@echo off
setlocal
REM SNS hub promo: post a weekly LP/hub promo (/ranking, /genres, /genre/X, /sale) to Bluesky
REM to drive traffic + social signals to the long-tail landing pages. Run ~daily or a few times/week.
set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE=C:\Program Files\nodejs\node.exe
set LOG_DIR=%PROJECT_DIR%\logs
set PATH=C:\Program Files\nodejs;%PATH%
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\sns_hub_%TODAY%.log
cd /d "%PROJECT_DIR%"
echo [%time%] hub post start >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\sns_hub_post.js" >> "%LOG_FILE%" 2>&1
echo [%time%] hub post done: %errorlevel% >> "%LOG_FILE%"
endlocal
