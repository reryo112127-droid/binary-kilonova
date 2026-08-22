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

REM === keep the PC awake for the whole batch (prevents auto-sleep killing it = 0xFF) ===
REM keep_awake.ps1 holds SetThreadExecutionState while it lives; we kill it at the end.
set KEEPAWAKE_PID=%LOG_DIR%\keepawake.pid
del "%KEEPAWAKE_PID%" 2>nul
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\scripts\keep_awake.ps1" -PidFile "%KEEPAWAKE_PID%" -MaxMinutes 360
echo [awake] keep-awake started at %time% >> "%LOG_FILE%"

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
echo [3b/6] MGS buy-price backfill (slow): %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\build_mgs_buy_price.js" --limit 500 >> "%LOG_FILE%" 2>&1
echo [3b/6] done: %errorlevel% at %time% >> "%LOG_FILE%"
REM FANZA人気順(rank)スコアを収集(ランキング両PF公平化のB成分。-localと女優ランキングの前に)
echo [3c/6] FANZA popularity (slow): %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\build_fanza_popularity.js" >> "%LOG_FILE%" 2>&1
echo [3c/6] done: %errorlevel% at %time% >> "%LOG_FILE%"
REM === [3d] Pull actresses filled in D1 back into the local SQLite ===
REM AVWIKI/seesaawiki backfills update D1 ONLY, so the local DB drifts behind
REM (first sync found 68,239 rows where D1 had a cast but the local DB was empty).
REM The static caches are built FROM the local DB, so this must run BEFORE
REM generate-static-cache-local.mjs or the site cards keep showing no actress name.
echo [3d/6] actresses sync D1 -> local: %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\sync_actresses_d1_to_local.js" >> "%LOG_FILE%" 2>&1
echo [3d/6] done: %errorlevel% at %time% >> "%LOG_FILE%"

echo [4/5] cache+deploy (local DB): %time% >> "%LOG_FILE%"
cd /d "%PROJECT_DIR%\site"
"%NODE%" scripts\generate-static-cache-local.mjs >> "%LOG_FILE%" 2>&1
REM actress ranking from D1 (fresh names) overwrites the local-DB ranking to avoid stale-name artifacts
"%NODE%" "%PROJECT_DIR%\scripts\build_actress_ranking_d1.js" >> "%LOG_FILE%" 2>&1
REM cross-platform id map (MGS<->FANZA) for product detail price compare
"%NODE%" "%PROJECT_DIR%\scripts\build_cross_platform.js" >> "%LOG_FILE%" 2>&1
REM : products_new_cache 0()
REM Guard: never deploy an empty cache (a failed generation must not wipe the live site).
REM The count is written to a temp file and read back with `set /p`. The previous
REM `for /f` one-liner was a cmd.exe SYNTAX ERROR that aborted this batch right here,
REM so steps [5]-[7] (R2 invalidate / MGS price update / purge) never ran at all.
set CACHE_CNT=0
"%NODE%" -e "const a=require('./public/data/products_new_cache.json');process.stdout.write(String(a.length))" > "%LOG_DIR%\cache_cnt.txt" 2>nul
if exist "%LOG_DIR%\cache_cnt.txt" set /p CACHE_CNT=<"%LOG_DIR%\cache_cnt.txt"
del "%LOG_DIR%\cache_cnt.txt" 2>nul
if "%CACHE_CNT%"=="0" (
    echo [4/5] SKIP deploy: products_new_cache.json is empty >> "%LOG_FILE%"
) else (
    call "%NPM%" run deploy:cf >> "%LOG_FILE%" 2>&1
    echo [4/5] done ^(%CACHE_CNT%^): %time% >> "%LOG_FILE%"
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
call "%NPM%" run deploy:cf >> "%LOG_FILE%" 2>&1
echo [6/6] price re-deploy done: %time% >> "%LOG_FILE%"

REM === [7] purge works with unknown cast, older than 3 months (best-effort, LAST) ===
REM Deletes 30,000 rows per run to stay under the D1 free-tier write cap (100k rows/day;
REM the FTS sync trigger writes on top of each delete). The script re-selects by condition
REM every run, so it just resumes the next day until the backlog is gone (~6 days).
REM Runs after the deploy so a slow or sleep-killed purge can never block the site update.
REM HOME_MAKERS brands are excluded, and every deleted row is backed up to
REM data\purged\purge_YYYY-MM-DD.jsonl so it can be restored.
cd /d "%PROJECT_DIR%"
echo [7/7] purge unknown-cast old works: %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\purge_unknown_actress.js" --limit=30000 >> "%LOG_FILE%" 2>&1
echo [7/7] purge done: %errorlevel% at %time% >> "%LOG_FILE%"

REM === release keep-awake (allow normal sleep again) ===
for /f "usebackq delims=" %%P in ("%KEEPAWAKE_PID%") do taskkill /PID %%P /F >nul 2>&1
del "%KEEPAWAKE_PID%" 2>nul
echo [awake] keep-awake released at %time% >> "%LOG_FILE%"

echo ======================================== >> "%LOG_FILE%"
echo main daily update done: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
