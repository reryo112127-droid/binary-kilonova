@echo off
setlocal

REM ============================================================
REM  AVWiki13:00
REM  AVWiki/SNS
REM  DB10:30
REM  daily_main.bat  cachecache11
REM ============================================================

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE=C:\Program Files\nodejs\node.exe
set LOG_DIR=%PROJECT_DIR%\logs

set PATH=C:\Program Files\nodejs;%PATH%

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\daily_avwiki_%TODAY%.log

echo ======================================== >> "%LOG_FILE%"
echo AVWiki daily scrape start: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

REM === [1] avwiki productRSS 100 ===
echo [1/3] avwiki products: %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\scrape_avwiki_products.js" --daily --count 100 >> "%LOG_FILE%" 2>&1
echo [1/3] done: %errorlevel% at %time% >> "%LOG_FILE%"

REM === [2] avwiki SNSTurso ===
echo [2/3] avwiki actresses: %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\scrape_avwiki_full.js" --daily >> "%LOG_FILE%" 2>&1
"%NODE%" "%PROJECT_DIR%\scripts\build_avwiki_profiles.js" >> "%LOG_FILE%" 2>&1
echo [2/3] done: %errorlevel% at %time% >> "%LOG_FILE%"

REM === [3] SeesaaWiki  ===
echo [3/3] seesaawiki apply: %time% >> "%LOG_FILE%"
if exist "%PROJECT_DIR%\data\seesaawiki_actress_map.jsonl" (
    "%NODE%" "%PROJECT_DIR%\scripts\seesaawiki_by_actress.js" --apply-only >> "%LOG_FILE%" 2>&1
    echo [3/3] done: %errorlevel% at %time% >> "%LOG_FILE%"
) else (
    echo [3/3] skipped ^(seesaawiki_actress_map.jsonl not found^) >> "%LOG_FILE%"
)

echo ======================================== >> "%LOG_FILE%"
echo AVWiki daily scrape done: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
