@echo off
setlocal

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE="C:\Program Files\nodejs\node.exe"
set LOG_DIR=%PROJECT_DIR%\logs

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f "delims=" %%D in ('%NODE% -e "process.stdout.write(new Date().toISOString().slice(0,10).replace(/-/g,''))"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\weekly_mgs_%TODAY%.log

echo ======================================== >> "%LOG_FILE%"
echo  MGS : %date% %time% >> "%LOG_FILE%"
echo  : 7006 >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

%NODE% "%PROJECT_DIR%\scripts\phase3_daily_update.js" --pages 700 >> "%LOG_FILE%" 2>&1

echo ======================================== >> "%LOG_FILE%"
echo  MGS : %date% %time% (exit: %errorlevel%) >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
