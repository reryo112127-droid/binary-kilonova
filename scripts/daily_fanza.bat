@echo off
setlocal

REM ============================================================
REM  FANZA日次取得バッチ（深夜1:00実行）
REM  FANZAは深夜0:00に予約作品が公開されるため、その直後に取得する。
REM  cache生成・deployは行わない（10:30のdaily_main.batでまとめて反映）。
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

REM FANZA新作・予約作品取得＋価格更新
"%NODE%" "%PROJECT_DIR%\scripts\fanza_daily_update.js" >> "%LOG_FILE%" 2>&1
echo FANZA done: %errorlevel% at %time% >> "%LOG_FILE%"

echo ======================================== >> "%LOG_FILE%"
echo FANZA daily update done: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

endlocal
