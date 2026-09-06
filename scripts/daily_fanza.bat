@echo off
setlocal

REM ============================================================
REM  FANZA catalog refresh -- MANUAL ENTRY POINT ONLY (no scheduled task).
REM
REM  2026-09-06: the task that used to run this ("MGS Daily Update" -- the name was
REM  wrong, it ran FANZA) had been failing with 0xFF and disabled since 2026-06-05,
REM  which is why data/fanza.db was a month behind. It has been deleted.
REM
REM  Current split:
REM    - D1 (production catalog)  -> .github/workflows/daily-update.yml at 9:10 JST
REM    - local data/fanza.db      -> daily_main.bat step [3c2] at 10:30 JST
REM
REM  So this script is only for ad-hoc catch-up. It runs LOCAL-ONLY (--no-d1) on
REM  purpose: running the D1 path from the PC as well would double-spend the D1
REM  write quota and, via the price scan, the read quota.
REM  To fill a past hole:  fanza_daily_update.js --from 2026-06-01 --to 2026-07-31 --no-price --no-d1
REM ============================================================

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE=C:\Program Files\nodejs\node.exe
set LOG_DIR=%PROJECT_DIR%\logs

set PATH=C:\Program Files\nodejs;%PATH%

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\daily_fanza_%TODAY%.log

echo ======================================== >> "%LOG_FILE%"
echo FANZA daily update start: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

REM Local catalog only. D1 is updated by GitHub Actions (daily-update.yml).
"%NODE%" "%PROJECT_DIR%\scripts\fanza_daily_update.js" --no-d1 --no-price >> "%LOG_FILE%" 2>&1
echo FANZA done: %errorlevel% at %time% >> "%LOG_FILE%"

echo ======================================== >> "%LOG_FILE%"
echo FANZA daily update done: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
