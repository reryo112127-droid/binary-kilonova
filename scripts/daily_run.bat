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
echo [1/8] FANZA daily update: %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\fanza_daily_update.js" >> "%LOG_FILE%" 2>&1
echo [1/8] done: %errorlevel% at %time% >> "%LOG_FILE%"

REM === [2] MGS動画 新作取得・価格更新 ===
echo [2/8] MGS daily update: %time% >> "%LOG_FILE%"
set CI=true
"%NODE%" "%PROJECT_DIR%\scripts\phase3_daily_update.js" >> "%LOG_FILE%" 2>&1
echo [2/8] done: %errorlevel% at %time% >> "%LOG_FILE%"
set CI=

REM === [3] avwiki 新着product ページから出演者情報取得 (RSS 100件) ===
echo [3/8] avwiki daily products: %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\scrape_avwiki_products.js" --daily --count 100 >> "%LOG_FILE%" 2>&1
echo [3/8] done: %errorlevel% at %time% >> "%LOG_FILE%"

REM === [4] avwiki 更新女優ページから改名・SNS情報取得 ===
echo [4/8] avwiki daily actresses: %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\scrape_avwiki_full.js" --daily >> "%LOG_FILE%" 2>&1
echo [4/8] avwiki actresses done: %errorlevel% at %time% >> "%LOG_FILE%"
REM 取得した女優情報を Turso に反映
"%NODE%" "%PROJECT_DIR%\scripts\build_avwiki_profiles.js" >> "%LOG_FILE%" 2>&1
echo [4/8] profiles applied: %errorlevel% at %time% >> "%LOG_FILE%"

REM === [5] AVWIKI未収録作品の出演者情報（SeesaaWiki）を反映 ===
REM NOTE: seesaawiki_actress_map.jsonl が存在する場合のみ反映
echo [5/8] seesaawiki apply: %time% >> "%LOG_FILE%"
if exist "%PROJECT_DIR%\data\seesaawiki_actress_map.jsonl" (
    "%NODE%" "%PROJECT_DIR%\scripts\seesaawiki_by_actress.js" --apply-only >> "%LOG_FILE%" 2>&1
    echo [5/8] done: %errorlevel% at %time% >> "%LOG_FILE%"
) else (
    echo [5/8] skipped ^(seesaawiki_actress_map.jsonl not found^) >> "%LOG_FILE%"
)

REM === [6] 女優プロフィール更新（FANZA API・最新500件） ===
REM 全件更新は毎週日曜のみ、それ以外は最新500件のみ
echo [6/8] actress profiles: %time% >> "%LOG_FILE%"
for /f %%W in ('powershell -NoProfile -Command "(Get-Date).DayOfWeek.value__"') do set DOW=%%W
if "%DOW%"=="0" (
    echo [6/8] Sunday: full fetch >> "%LOG_FILE%"
    "%NODE%" "%PROJECT_DIR%\scripts\fetch_fanza_actresses.js" >> "%LOG_FILE%" 2>&1
) else (
    "%NODE%" "%PROJECT_DIR%\scripts\fetch_fanza_actresses.js" --recent 500 >> "%LOG_FILE%" 2>&1
)
echo [6/8] done: %errorlevel% at %time% >> "%LOG_FILE%"

REM === [7] actress_profiles.json → Turso 同期（月1回・毎日実行するとTurso行読み取りを消費するため） ===
echo [7/8] actress profiles sync to Turso: %time% >> "%LOG_FILE%"
for /f %%M in ('powershell -NoProfile -Command "(Get-Date).Day"') do set DOM=%%M
if "%DOM%"=="1" (
    echo [7/8] Day 1 of month: full sync >> "%LOG_FILE%"
    "%NODE%" "%PROJECT_DIR%\scripts\migrate_actress_profiles_to_turso.js" >> "%LOG_FILE%" 2>&1
    echo [7/8] done: %errorlevel% at %time% >> "%LOG_FILE%"
) else (
    echo [7/8] skipped ^(not day 1 of month: Turso sync runs monthly^) >> "%LOG_FILE%"
)

REM === [8] キャッシュ再生成 & デプロイ ===
REM NOTE: generate-static-cache は Turso 行読み取りを大量消費するため毎日1回のみ実行
REM       デプロイのみ行う場合は generate-static-cache をスキップして npm run deploy:cf のみ実行
echo [8/8] cache+deploy: %time% >> "%LOG_FILE%"
cd /d "%PROJECT_DIR%\site"
"%NODE%" scripts\generate-static-cache.mjs >> "%LOG_FILE%" 2>&1
if %errorlevel% neq 0 (
    echo [8/8] cache generation failed, deploying with existing cache >> "%LOG_FILE%"
)
"%NPM%" run deploy:cf >> "%LOG_FILE%" 2>&1
echo [8/8] done: %time% >> "%LOG_FILE%"

echo ======================================== >> "%LOG_FILE%"
echo daily update done: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
