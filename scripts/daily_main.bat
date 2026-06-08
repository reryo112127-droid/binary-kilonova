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
echo [1/4] MGS daily update: %time% >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\phase3_daily_update.js" >> "%LOG_FILE%" 2>&1
echo [1/4] done: %errorlevel% at %time% >> "%LOG_FILE%"

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
echo [4/5] cache+deploy (local DB): %time% >> "%LOG_FILE%"
cd /d "%PROJECT_DIR%\site"
"%NODE%" scripts\generate-static-cache-local.mjs >> "%LOG_FILE%" 2>&1
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
echo [5/5] R2 invalidate sale products: %time% >> "%LOG_FILE%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\scripts\invalidate_sale_r2.ps1" >> "%LOG_FILE%" 2>&1
echo [5/5] done: %errorlevel% at %time% >> "%LOG_FILE%"

echo ======================================== >> "%LOG_FILE%"
echo main daily update done: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
