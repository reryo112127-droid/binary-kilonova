@echo off
setlocal

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE=C:\Program Files\nodejs\node.exe
set NPM=C:\Program Files\nodejs\npm.cmd
set LOG_DIR=%PROJECT_DIR%\logs

set PATH=C:\Program Files\nodejs;%PATH%

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\daily_mgs_%TODAY%.log

echo ======================================== >> "%LOG_FILE%"
echo MGS daily update start: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

set CI=true
"%NODE%" "%PROJECT_DIR%\scripts\phase3_daily_update.js" >> "%LOG_FILE%" 2>&1
set SCRAPER_EXIT=%errorlevel%

echo scraper exit: %SCRAPER_EXIT% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"
echo MGS daily update done: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

if %SCRAPER_EXIT% == 0 (
    echo updating static cache... >> "%LOG_FILE%"
    cd /d "%PROJECT_DIR%\site"
    "%NODE%" scripts\generate-static-cache.mjs >> "%LOG_FILE%" 2>&1
    echo building and deploying... >> "%LOG_FILE%"
    "%NPM%" run deploy:cf >> "%LOG_FILE%" 2>&1
    echo deploy done: %date% %time% >> "%LOG_FILE%"
) else (
    echo scraper failed, skipping deploy >> "%LOG_FILE%"
)

endlocal
