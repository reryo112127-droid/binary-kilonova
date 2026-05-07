@echo off
setlocal

set PROJECT_DIR=C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova
set NODE="C:\Program Files\nodejs\node.exe"
set LOG_DIR=%PROJECT_DIR%\logs

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f "delims=" %%D in ('%NODE% -e "process.stdout.write(new Date().toISOString().slice(0,10).replace(/-/g,''))"') do set TODAY=%%D
set LOG_FILE=%LOG_DIR%\daily_mgs_%TODAY%.log

echo ======================================== >> "%LOG_FILE%"
echo  MGS 日次新作取得開始: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

:: CI=true でTursoをknownIDsのソースとして使用
set CI=true
%NODE% "%PROJECT_DIR%\scripts\phase3_daily_update.js" >> "%LOG_FILE%" 2>&1

echo ======================================== >> "%LOG_FILE%"
echo  MGS 日次新作取得完了: %date% %time% (exit: %errorlevel%) >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

:: 完了後に静的キャッシュ更新・ビルド・デプロイ
if %errorlevel% == 0 (
    echo  キャッシュ更新・デプロイ中... >> "%LOG_FILE%"
    cd /d "%PROJECT_DIR%\site"
    %NODE% scripts\generate-static-cache.mjs >> "%LOG_FILE%" 2>&1
    npm run deploy:cf >> "%LOG_FILE%" 2>&1
    echo  デプロイ完了 >> "%LOG_FILE%"
)

endlocal
