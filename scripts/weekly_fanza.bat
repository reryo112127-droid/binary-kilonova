@echo off
setlocal

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE="C:\Program Files\nodejs\node.exe"
set LOG_DIR=%PROJECT_DIR%\logs

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f "delims=" %%D in ('%NODE% -e "process.stdout.write(new Date().toISOString().slice(0,10).replace(/-/g,''))"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\weekly_fanza_%TODAY%.log

echo ======================================== >> "%LOG_FILE%"
echo  FANZA : %date% %time% >> "%LOG_FILE%"
echo  : 726 >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

REM 2026-09-06: `--months 72` was never a real flag (only --ahead / --years exist), so this
REM ran a plain default update and the intended "last 6 years" price refresh never happened.
REM That job now lives in .github/workflows/weekly-price-refresh.yml (Thu 23:00 JST FANZA /
REM Fri 15:00 JST MGS). This file is kept as a manual fallback with the correct flag.
%NODE% "%PROJECT_DIR%\scripts\fanza_daily_update.js" --years 6 >> "%LOG_FILE%" 2>&1

echo ======================================== >> "%LOG_FILE%"
echo  FANZA : %date% %time% (exit: %errorlevel%) >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
