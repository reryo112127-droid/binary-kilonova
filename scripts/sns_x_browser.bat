@echo off
setlocal
REM X browser auto-post: post 1 thread per account (all accounts) via Playwright. Scheduler controls timing.
set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE=C:\Program Files\nodejs\node.exe
set LOG_DIR=%PROJECT_DIR%\logs
set PATH=C:\Program Files\nodejs;%PATH%
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\sns_x_%TODAY%.log
cd /d "%PROJECT_DIR%"
echo [%time%] x browser post start >> "%LOG_FILE%"
"%NODE%" "%PROJECT_DIR%\scripts\x_browser_post.js" --all --now >> "%LOG_FILE%" 2>&1
echo [%time%] x browser post done: %errorlevel% >> "%LOG_FILE%"
endlocal
