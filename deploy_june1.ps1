# 6月1日 Turso解除後 自動デプロイスクリプト
# タスクスケジューラから実行される

$projectDir = "C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova"
$siteDir = "$projectDir\site"
$logFile = "$projectDir\deploy_june1.log"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts  $msg" | Tee-Object -FilePath $logFile -Append
}

Log "=== 6月1日 Turso解除後デプロイ開始 ==="

Set-Location $siteDir

# Step 1: Turso版キャッシュ生成
Log "[1/3] generate-static-cache.mjs 実行中..."
$result = node scripts/generate-static-cache.mjs 2>&1
Log $result
if ($LASTEXITCODE -ne 0) {
    Log "ERROR: キャッシュ生成スクリプト失敗。終了します。"
    exit 1
}

# 空キャッシュガード: Tursoがまだブロック中の場合はデプロイしない
$cacheContent = Get-Content "$siteDir\public\data\products_new_cache.json" -Raw -ErrorAction SilentlyContinue
if ($cacheContent -eq $null -or $cacheContent.Trim() -eq "[]" -or $cacheContent.Trim() -eq "") {
    Log "ERROR: products_new_cache.json が空です。Tursoがまだブロック中の可能性があります。デプロイを中断します。"
    Log "       Tursoダッシュボードで読み取り制限の解除を確認してから手動で再実行してください。"
    exit 1
}
Log "[1/3] キャッシュ生成完了"

# Step 2: Cloudflare Workers ビルド & デプロイ
Log "[2/3] Cloudflare Workers ビルド & デプロイ中..."
$result = npm run deploy:cf 2>&1
Log $result
if ($LASTEXITCODE -ne 0) {
    Log "ERROR: CF デプロイ失敗。終了します。"
    exit 1
}
Log "[2/3] CF デプロイ完了"

# Step 3: GitHub Push
Log "[3/3] GitHub Push中..."
Set-Location $projectDir

# キャッシュ更新分をコミット
git add site/data/*_cache.json site/public/data/*_cache.json 2>&1 | ForEach-Object { Log $_ }
$commitResult = git commit -m "chore: Turso解除後キャッシュ更新 (2026-06-01)" 2>&1
Log $commitResult

# push
git push origin main 2>&1 | ForEach-Object { Log $_ }
if ($LASTEXITCODE -ne 0) {
    Log "ERROR: git push 失敗"
    exit 1
}
Log "[3/3] GitHub Push完了"

Log "=== 全工程完了 ==="
