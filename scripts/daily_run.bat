@echo off
setlocal

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE="C:\Program Files\nodejs\node.exe"
set LOG_DIR=%PROJECT_DIR%\logs
set LOG_FILE=%LOG_DIR%\daily_%date:~0,4%%date:~5,2%%date:~8,2%.log

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

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
