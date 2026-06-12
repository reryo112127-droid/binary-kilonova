@echo off
setlocal

REM ============================================================
REM  10:30
REM  MGS10:0030
REM  1:00FANZA cache deploy
REM  generate-static-cache.mjs  Turso
REM  11
REM ============================================================

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE=C:\Program Files\nodejs\node.exe
set NPM=C:\Program Files\nodejs\npm.cmd
set LOG_DIR=%PROJECT_DIR%\logs

set PATH=C:\Program Files\nodejs;%PATH%

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\daily_main_%TODAY%.log

echo ======================================== >> "%LOG_FILE%"
echo main daily update start: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

REM === [1] MGS  ===
REM : CI=true  phase3 mgs.dbskipstep4
REM generate-static-cache-local 
REM CI+D1
REM [1] MGS new works only (--pages 0 skips the long price scan that gets killed by sleep)
echo [1/6] MGS new works (no price): %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\phase3_daily_update.js" --pages 0 >> "%LOG_FILE%" 2>&1
echo [1/6] done: %errorlevel% at %time% >> "%LOG_FILE%"

REM [1b] Backfill NULL sale_start_date so brand-new works appear in the new list
echo [1b/6] MGS date backfill: %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\backfill_mgs_dates.js" >> "%LOG_FILE%" 2>&1
echo [1b/6] done: %errorlevel% at %time% >> "%LOG_FILE%"

REM === [2] FANZA API500 ===
echo [2/4] actress profiles: %time% >> "%LOG_FILE%"
for /f %%W in ('powershell -NoProfile -Command "(Get-Date).DayOfWeek.value__"') do set DOW=%%W
if "%DOW%"=="0" (
    echo [2/4] Sunday: full fetch >> "%LOG_FILE%"
    "%NODE%" "%PROJECT_DIR%\scripts\fetch_fanza_actresses.js" >> "%LOG_FILE%" 2>&1
) else (
    "%NODE%" "%PROJECT_DIR%\scripts\fetch_fanza_actresses.js" --recent 500 >> "%LOG_FILE%" 2>&1
)
echo [2/4] done: %errorlevel% at %time% >> "%LOG_FILE%"

REM === [3] actress_profiles.json  Turso 11 ===
echo [3/4] actress profiles sync to Turso: %time% >> "%LOG_FILE%"
for /f %%M in ('powershell -NoProfile -Command "(Get-Date).Day"') do set DOM=%%M
if "%DOM%"=="1" (
    echo [3/4] Day 1 of month: full sync >> "%LOG_FILE%"
    "%NODE%" "%PROJECT_DIR%\scripts\migrate_actress_profiles_to_turso.js" >> "%LOG_FILE%" 2>&1
    echo [3/4] done: %errorlevel% at %time% >> "%LOG_FILE%"
) else (
    echo [3/4] skipped ^(not day 1 of month: Turso sync runs monthly^) >> "%LOG_FILE%"
)

REM === [4]  &  ===
REM Turso()SQLite
REM (fanza.db/mgs.db) generate-static-cache-local.mjs 
REM Turso generate-static-cache.mjs (Turso) 
REM cross-platform作品のMGSダウンロード買い切り価格を補完(未取得分のみ、最大500件/日で時間制限)
"%NODE%" "%PROJECT_DIR%\scripts\build_mgs_buy_price.js" --limit 500 >> "%LOG_FILE%" 2>&1
echo [4/5] cache+deploy (local DB): %time% >> "%LOG_FILE%"
cd /d "%PROJECT_DIR%\site"
"%NODE%" scripts\generate-static-cache-local.mjs >> "%LOG_FILE%" 2>&1
REM actress ranking from D1 (fresh names) overwrites the local-DB ranking to avoid stale-name artifacts
"%NODE%" "%PROJECT_DIR%\scripts\build_actress_ranking_d1.js" >> "%LOG_FILE%" 2>&1
REM cross-platform id map (MGS<->FANZA) for product detail price compare
"%NODE%" "%PROJECT_DIR%\scripts\build_cross_platform.js" >> "%LOG_FILE%" 2>&1
REM : products_new_cache 0()
set CACHE_CNT=0
for /f %%C in ('""%NODE%" -e "try{console.log(require(String.raw`./public/data/products_new_cache.json`).length)}catch(e){console.log(0)}""') do set CACHE_CNT=%%C
if "%CACHE_CNT%"=="0" (
    echo [4/5]  >> "%LOG_FILE%"
) else (
    "%NPM%" run deploy:cf >> "%LOG_FILE%" 2>&1
    echo [4/5] done (%CACHE_CNT%): %time% >> "%LOG_FILE%"
)

REM === [5] R2 ===
REM R2 read-throughR2
echo [5/6] R2 invalidate sale products: %time% >> "%LOG_FILE%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\scripts\invalidate_sale_r2.ps1" >> "%LOG_FILE%" 2>&1
echo [5/6] done: %errorlevel% at %time% >> "%LOG_FILE%"

REM === [6] MGS price update (best-effort, LAST) ===
REM The long price scan (200 pages with waits) can be killed when the PC sleeps.
REM Running it LAST means new releases are already cached and deployed above, so a
REM kill here is harmless. Prices then refresh and re-deploy when the PC stays awake.
echo [6/6] MGS price update (best-effort): %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\phase3_daily_update.js" --no-preorder >> "%LOG_FILE%" 2>&1
echo [6/6] price update done: %errorlevel% at %time% >> "%LOG_FILE%"
cd /d "%PROJECT_DIR%\site"
"%NODE%" scripts\generate-static-cache-local.mjs >> "%LOG_FILE%" 2>&1
"%NODE%" "%PROJECT_DIR%\scripts\build_actress_ranking_d1.js" >> "%LOG_FILE%" 2>&1
"%NPM%" run deploy:cf >> "%LOG_FILE%" 2>&1
echo [6/6] price re-deploy done: %time% >> "%LOG_FILE%"

echo ======================================== >> "%LOG_FILE%"
echo main daily update done: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
