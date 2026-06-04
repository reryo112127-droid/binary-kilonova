# ============================================================
#  セール商品のR2キャッシュを無効化（価格鮮度確保）
#  daily_main.bat から日次で呼ばれる。
#  当日のセール商品 + 前日のセール商品（セール終了分）のR2エントリを
#  /api/admin/r2-invalidate 経由で削除し、次アクセスで最新価格を再取得させる。
# ============================================================
$ErrorActionPreference = 'Continue'

$proj     = "C:\Users\Owner\.gemini\antigravity\playground\binary-kilonova"
$saleFile = "$proj\site\public\data\sale_cache.json"
$prevFile = "$proj\data\sale_cache_prev.json"
$envFile  = "$proj\site\.env.local"
$url      = "https://avrankings.com/api/admin/r2-invalidate"

# ADMIN_KEY を .env.local から読み込み
$adminKey = $null
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^ADMIN_KEY=(.+)$') { $adminKey = $Matches[1].Trim() }
    }
}
if (-not $adminKey) { Write-Host "ADMIN_KEY not found"; exit 1 }

# 当日のセール商品ID
$ids = @()
if (Test-Path $saleFile) {
    $ids += (Get-Content $saleFile -Raw | ConvertFrom-Json | ForEach-Object { $_.product_id })
}
# 前日のセール商品ID（セール終了商品の表示も最新化するため）
if (Test-Path $prevFile) {
    $ids += (Get-Content $prevFile -Raw | ConvertFrom-Json)
}
$ids = $ids | Where-Object { $_ } | Select-Object -Unique
Write-Host "invalidating $($ids.Count) sale products"

if ($ids.Count -gt 0) {
    for ($i = 0; $i -lt $ids.Count; $i += 500) {
        $end = [Math]::Min($i + 499, $ids.Count - 1)
        $chunk = @($ids[$i..$end])
        $body = @{ ids = $chunk } | ConvertTo-Json -Compress
        try {
            $res = Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType 'application/json' `
                   -Headers @{ 'x-admin-key' = $adminKey } -TimeoutSec 60
            Write-Host "deleted: $($res.deleted)"
        } catch {
            Write-Host "error: $_"
        }
    }
}

# 今回のセール商品IDを前日分として保存（次回の差分用）
@($ids) | ConvertTo-Json -Compress | Set-Content $prevFile -Encoding utf8
Write-Host "done"
