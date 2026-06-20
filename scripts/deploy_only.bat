@echo off
setlocal
REM Dedicated deploy task: deploy whatever static caches daily_main already generated.
REM daily_main.bat builds caches but is often killed before its deploy step, leaving the
REM live home page stale. This standalone task deploys the freshly-generated caches and
REM is short, so it reliably reaches wrangler deploy even if the long batch died earlier.
set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NPM=C:\Program Files\nodejs\npm.cmd
set LOG_DIR=%PROJECT_DIR%\logs
set PATH=C:\Program Files\nodejs;%PATH%
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\deploy_only_%TODAY%.log
cd /d "%PROJECT_DIR%\site"
echo [%time%] deploy start >> "%LOG_FILE%"
"%NPM%" run deploy:cf >> "%LOG_FILE%" 2>&1
echo [%time%] deploy done: %errorlevel% >> "%LOG_FILE%"
endlocal
