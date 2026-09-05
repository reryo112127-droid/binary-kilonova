@echo off
setlocal

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE=C:\Program Files\nodejs\node.exe
set SCRIPT=%PROJECT_DIR%\scripts\scrape_avwiki_full.js
set LOG_DIR=%PROJECT_DIR%\logs
set LOCK_FILE=%PROJECT_DIR%\data\avwiki_scraper.lock

set PATH=C:\Program Files\nodejs;%PATH%

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\avwiki_%TODAY%.log

REM --- stale lock guard ---------------------------------------------------
REM The lock is only deleted on a normal exit, so a killed run (sleep kill,
REM Ctrl+C, D1 quota errors) leaves it behind and EVERY later run skips
REM silently forever. This happened on 2026-09-03: the run died on D1 quota
REM errors and the 17:49 lock blocked the task on 09-04 and 09-05.
REM A lock older than 6 hours is treated as stale and removed.
if not exist "%LOCK_FILE%" goto :lock_ok
for /f "delims=" %%A in ('powershell -NoProfile -Command "if (((Get-Date) - (Get-Item $env:LOCK_FILE).LastWriteTime).TotalHours -gt 6) { Write-Output stale } else { Write-Output live }"') do set LOCK_STATE=%%A
if "%LOCK_STATE%"=="stale" goto :lock_stale
echo [%time%] already running ^(lock file exists^). skip. >> "%LOG_FILE%"
exit /b 0
:lock_stale
echo [%time%] stale lock ^(older than 6h^). removing and continuing. >> "%LOG_FILE%"
del "%LOCK_FILE%" 2>nul
:lock_ok

echo %date% %time% > "%LOCK_FILE%"

echo ======================================== >> "%LOG_FILE%"
echo AVWiki scraper start: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

"%NODE%" "%SCRIPT%" >> "%LOG_FILE%" 2>&1
set EXIT_CODE=%errorlevel%

echo [%time%] exit: %EXIT_CODE% >> "%LOG_FILE%"

del "%LOCK_FILE%" 2>nul

endlocal
exit /b %EXIT_CODE%
