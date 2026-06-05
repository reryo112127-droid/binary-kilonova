@echo off
setlocal

REM ============================================================
REM  メイン日次バッチ（10:30実行）
REM  MGS動画は10:00に新作公開されるため、その30分後に取得。
REM  深夜1:00取得済みのFANZAデータも含めて cache を再生成しdeployする。
REM  generate-static-cache.mjs は Turso行読み取りを大量消費するため
REM  1日1回（このバッチ）のみ実行する。
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

REM === [1] MGS動画 新作取得・価格更新 ===
echo [1/4] MGS daily update: %time% >> "%LOG_FILE%"
set CI=true
"%NODE%" "%PROJECT_DIR%\scripts\phase3_daily_update.js" >> "%LOG_FILE%" 2>&1
echo [1/4] done: %errorlevel% at %time% >> "%LOG_FILE%"
set CI=

REM === [2] 女優プロフィール更新（FANZA API・最新500件、日曜は全件） ===
echo [2/4] actress profiles: %time% >> "%LOG_FILE%"
for /f %%W in ('powershell -NoProfile -Command "(Get-Date).DayOfWeek.value__"') do set DOW=%%W
if "%DOW%"=="0" (
    echo [2/4] Sunday: full fetch >> "%LOG_FILE%"
    "%NODE%" "%PROJECT_DIR%\scripts\fetch_fanza_actresses.js" >> "%LOG_FILE%" 2>&1
) else (
    "%NODE%" "%PROJECT_DIR%\scripts\fetch_fanza_actresses.js" --recent 500 >> "%LOG_FILE%" 2>&1
)
echo [2/4] done: %errorlevel% at %time% >> "%LOG_FILE%"

REM === [3] actress_profiles.json → Turso 同期（月1回・毎月1日のみ） ===
echo [3/4] actress profiles sync to Turso: %time% >> "%LOG_FILE%"
for /f %%M in ('powershell -NoProfile -Command "(Get-Date).Day"') do set DOM=%%M
if "%DOM%"=="1" (
    echo [3/4] Day 1 of month: full sync >> "%LOG_FILE%"
    "%NODE%" "%PROJECT_DIR%\scripts\migrate_actress_profiles_to_turso.js" >> "%LOG_FILE%" 2>&1
    echo [3/4] done: %errorlevel% at %time% >> "%LOG_FILE%"
) else (
    echo [3/4] skipped ^(not day 1 of month: Turso sync runs monthly^) >> "%LOG_FILE%"
)

REM === [4] キャッシュ再生成 & デプロイ ===
REM 【重要】Turso無料枠が読み込みブロック中(〜月初リセット)のため、ローカルSQLite
REM (fanza.db/mgs.db)からキャッシュ生成する generate-static-cache-local.mjs を使用。
REM Turso読み込み枠が回復したら generate-static-cache.mjs (Turso版) に戻すこと。
echo [4/5] cache+deploy (local DB): %time% >> "%LOG_FILE%"
cd /d "%PROJECT_DIR%\site"
"%NODE%" scripts\generate-static-cache-local.mjs >> "%LOG_FILE%" 2>&1
REM 空キャッシュガード: products_new_cache が0件ならデプロイ中止(本番空デプロイ防止)
set CACHE_CNT=0
for /f %%C in ('""%NODE%" -e "try{console.log(require(String.raw`./public/data/products_new_cache.json`).length)}catch(e){console.log(0)}""') do set CACHE_CNT=%%C
if "%CACHE_CNT%"=="0" (
    echo [4/5] 空キャッシュ検出、デプロイ中止 >> "%LOG_FILE%"
) else (
    "%NPM%" run deploy:cf >> "%LOG_FILE%" 2>&1
    echo [4/5] done (%CACHE_CNT%件): %time% >> "%LOG_FILE%"
)

REM === [5] セール商品のR2キャッシュ無効化（価格鮮度確保） ===
REM R2 read-throughは永続のため、セール商品は日次でR2を削除して最新価格を再取得させる
echo [5/5] R2 invalidate sale products: %time% >> "%LOG_FILE%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\scripts\invalidate_sale_r2.ps1" >> "%LOG_FILE%" 2>&1
echo [5/5] done: %errorlevel% at %time% >> "%LOG_FILE%"

echo ======================================== >> "%LOG_FILE%"
echo main daily update done: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
