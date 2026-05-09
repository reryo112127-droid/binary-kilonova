@echo off
setlocal

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE="C:\Program Files\nodejs\node.exe"
set LOG_DIR=%PROJECT_DIR%\logs

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f "delims=" %%D in ('%NODE% -e "process.stdout.write(new Date().toISOString().slice(0,10).replace(/-/g,''))"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\weekly_fanza_%TODAY%.log

echo ======================================== >> "%LOG_FILE%"
echo  FANZA 週次価格更新開始: %date% %time% >> "%LOG_FILE%"
echo  範囲: 直近72ヶ月（6年分） >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

%NODE% "%PROJECT_DIR%\scripts\fanza_daily_update.js" --months 72 >> "%LOG_FILE%" 2>&1

echo ======================================== >> "%LOG_FILE%"
echo  FANZA 週次価格更新完了: %date% %time% (exit: %errorlevel%) >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
