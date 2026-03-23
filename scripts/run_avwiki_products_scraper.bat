@echo off
:: av-wiki.net 品番ページ女優特定スクレイパー
:: タスクスケジューラで毎時実行 → クラッシュ後も自動再開

setlocal

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE="C:\Program Files\nodejs\node.exe"
set SCRIPT=%PROJECT_DIR%\scripts\scrape_avwiki_products.js
set LOG_DIR=%PROJECT_DIR%\logs
set LOG_FILE=%LOG_DIR%\avwiki_products_%date:~0,4%%date:~5,2%%date:~8,2%.log
set LOCK_FILE=%PROJECT_DIR%\data\avwiki_products_scraper.lock

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

if exist "%LOCK_FILE%" (
    echo [%time%] 既に実行中。スキップ。 >> "%LOG_FILE%"
    exit /b 0
)

echo %date% %time% > "%LOCK_FILE%"
echo ======================================== >> "%LOG_FILE%"
echo  AVWiki品番スクレイパー起動: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

%NODE% "%SCRIPT%" >> "%LOG_FILE%" 2>&1
set EXIT_CODE=%errorlevel%

echo [%time%] 終了 (exit: %EXIT_CODE%) >> "%LOG_FILE%"
del "%LOCK_FILE%" 2>nul

endlocal
exit /b %EXIT_CODE%
