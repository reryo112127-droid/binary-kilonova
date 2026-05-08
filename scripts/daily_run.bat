@echo off
setlocal

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE=C:\Program Files\nodejs\node.exe
set NPM=C:\Program Files\nodejs\npm.cmd
set LOG_DIR=%PROJECT_DIR%\logs

set PATH=C:\Program Files\nodejs;%PATH%

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\daily_%TODAY%.log

echo ======================================== >> "%LOG_FILE%"
echo FANZA daily update start: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

"%NODE%" "%PROJECT_DIR%\scripts\fanza_daily_update.js" >> "%LOG_FILE%" 2>&1
set FANZA_EXIT=%errorlevel%
echo [FANZA] exit: %FANZA_EXIT% at %time% >> "%LOG_FILE%"

echo [CACHE+DEPLOY] start: %time% >> "%LOG_FILE%"
cd /d "%PROJECT_DIR%\site"
"%NODE%" scripts\generate-static-cache.mjs >> "%LOG_FILE%" 2>&1
"%NPM%" run deploy:cf >> "%LOG_FILE%" 2>&1
echo [CACHE+DEPLOY] done: %time% >> "%LOG_FILE%"

echo ======================================== >> "%LOG_FILE%"
echo FANZA daily update done: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
