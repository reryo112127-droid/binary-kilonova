@echo off
:: av-wiki.net 全女優スクレイパー 起動スクリプト
:: タスクスケジューラで毎日1回実行することで、クラッシュ後も自動再開する
::
:: タスクスケジューラへの登録（管理者として実行）:
::   schtasks /create /tn "AVWiki Scraper" /tr "%~f0" /sc HOURLY /f
::
:: 手動実行:
::   scripts\run_avwiki_scraper.bat

setlocal

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE="C:\Program Files\nodejs\node.exe"
set SCRIPT=%PROJECT_DIR%\scripts\scrape_avwiki_full.js
set LOG_DIR=%PROJECT_DIR%\logs
set LOG_FILE=%LOG_DIR%\avwiki_%date:~0,4%%date:~5,2%%date:~8,2%.log
set PROGRESS_FILE=%PROJECT_DIR%\data\avwiki_full_progress.json

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: 既に実行中かチェック（ロックファイル）
set LOCK_FILE=%PROJECT_DIR%\data\avwiki_scraper.lock
if exist "%LOCK_FILE%" (
    echo [%time%] 既に実行中です（ロックファイルあり）。スキップ。 >> "%LOG_FILE%"
    exit /b 0
)

:: ロックファイル作成
echo %date% %time% > "%LOCK_FILE%"

echo ======================================== >> "%LOG_FILE%"
echo  AVWiki スクレイパー起動: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

:: スクレイパー実行
%NODE% "%SCRIPT%" >> "%LOG_FILE%" 2>&1
set EXIT_CODE=%errorlevel%

echo [%time%] 終了 (exit: %EXIT_CODE%) >> "%LOG_FILE%"

:: ロックファイル削除
del "%LOCK_FILE%" 2>nul

endlocal
exit /b %EXIT_CODE%
