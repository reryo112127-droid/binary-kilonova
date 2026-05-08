@echo off
setlocal

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE=C:\Program Files\nodejs\node.exe
set SCRIPT=%PROJECT_DIR%\scripts\scrape_avwiki_full.js
set LOG_DIR=%PROJECT_DIR%\logs
set LOCK_FILE=%PROJECT_DIR%\data\avwiki_scraper.lock

set PATH=C:\Program Files\nodejs;%PATH%

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\avwiki_%TODAY%.log

if exist "%LOCK_FILE%" (
    echo [%time%] already running (lock file exists). skip. >> "%LOG_FILE%"
    exit /b 0
)

echo %date% %time% > "%LOCK_FILE%"

echo ======================================== >> "%LOG_FILE%"
echo AVWiki scraper start: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

"%NODE%" "%SCRIPT%" >> "%LOG_FILE%" 2>&1
set EXIT_CODE=%errorlevel%

echo [%time%] exit: %EXIT_CODE% >> "%LOG_FILE%"

del "%LOCK_FILE%" 2>nul

endlocal
exit /b %EXIT_CODE%
