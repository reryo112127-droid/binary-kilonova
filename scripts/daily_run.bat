@echo off
setlocal

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE="C:\Program Files\nodejs\node.exe"
set LOG_DIR=%PROJECT_DIR%\logs

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: node で日付を取得（%date% はロケール依存で信頼できないため）
for /f "delims=" %%D in ('%NODE% -e "process.stdout.write(new Date().toISOString().slice(0,10).replace(/-/g,''))"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\daily_%TODAY%.log

echo ======================================== >> "%LOG_FILE%"
echo  日次更新開始: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

:: FANZA日次更新
echo [FANZA] 開始: %time% >> "%LOG_FILE%"
%NODE% "%PROJECT_DIR%\scripts\fanza_daily_update.js" >> "%LOG_FILE%" 2>&1
echo [FANZA] 終了: %time% (exit: %errorlevel%) >> "%LOG_FILE%"

:: MGS日次更新
echo [MGS] 開始: %time% >> "%LOG_FILE%"
%NODE% "%PROJECT_DIR%\scripts\phase3_daily_update.js" >> "%LOG_FILE%" 2>&1
echo [MGS] 終了: %time% (exit: %errorlevel%) >> "%LOG_FILE%"

echo ======================================== >> "%LOG_FILE%"
echo  日次更新完了: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
