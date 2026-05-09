@echo off
setlocal

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE=C:\Program Files\nodejs\node.exe
set NPM=C:\Program Files\nodejs\npm.cmd
set LOG_DIR=%PROJECT_DIR%\logs

set PATH=C:\Program Files\nodejs;%PATH%

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\daily_%TODAY%.log

echo ======================================== >> "%LOG_FILE%"
echo daily update start: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

REM === [1] FANZA新作取得・価格更新 ===
echo [1/5] FANZA daily update: %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\fanza_daily_update.js" >> "%LOG_FILE%" 2>&1
echo [1/5] done: %errorlevel% at %time% >> "%LOG_FILE%"

REM === [2] MGS動画 新作取得・価格更新 ===
echo [2/5] MGS daily update: %time% >> "%LOG_FILE%"
set CI=true
"%NODE%" "%PROJECT_DIR%\scripts\phase3_daily_update.js" >> "%LOG_FILE%" 2>&1
echo [2/5] done: %errorlevel% at %time% >> "%LOG_FILE%"
set CI=

REM === [3] avwiki 新着product ページから出演者情報取得 (RSS 100件) ===
echo [3/5] avwiki daily products: %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\scrape_avwiki_products.js" --daily --count 100 >> "%LOG_FILE%" 2>&1
echo [3/5] done: %errorlevel% at %time% >> "%LOG_FILE%"

REM === [4] avwiki 更新女優ページから改名・SNS情報取得 ===
echo [4/5] avwiki daily actresses: %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\scrape_avwiki_full.js" --daily >> "%LOG_FILE%" 2>&1
echo [4/5] avwiki actresses done: %errorlevel% at %time% >> "%LOG_FILE%"
REM 取得した女優情報を Turso に反映
"%NODE%" "%PROJECT_DIR%\scripts\build_avwiki_profiles.js" >> "%LOG_FILE%" 2>&1
echo [4/5] profiles applied: %errorlevel% at %time% >> "%LOG_FILE%"

REM === [5] キャッシュ再生成 & デプロイ ===
echo [5/5] cache+deploy: %time% >> "%LOG_FILE%"
cd /d "%PROJECT_DIR%\site"
"%NODE%" scripts\generate-static-cache.mjs >> "%LOG_FILE%" 2>&1
"%NPM%" run deploy:cf >> "%LOG_FILE%" 2>&1
echo [5/5] done: %time% >> "%LOG_FILE%"

echo ======================================== >> "%LOG_FILE%"
echo daily update done: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
