param(
    [string]$PidFile = "",
    [int]$MaxMinutes = 360
)
# keep_awake.ps1 - keeps the PC awake while daily_main.bat runs (prevents auto-sleep 0xFF kills).
# Holds SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_AWAYMODE_REQUIRED) on this
# process's thread; the suppression lasts only while this process lives (auto-released on kill/exit).
# Self-terminates after MaxMinutes (default 360 = task ExecutionTimeLimit PT6H) as a safety net.

if ($PidFile) { try { "$PID" | Out-File -FilePath $PidFile -Encoding ascii -Force } catch {} }

$sig = '[DllImport("kernel32.dll", SetLastError=true)] public static extern uint SetThreadExecutionState(uint esFlags);'
# Hex literals like 0x80000041 parse as negative Int32 in PowerShell and fail [uint32] casts; use decimals.
# 0x80000041 = ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_AWAYMODE_REQUIRED ; 0x80000000 = ES_CONTINUOUS (clear)
$ES_KEEP = [uint32]2147483713
$ES_CLEAR = [uint32]2147483648
try {
    $api = Add-Type -MemberDefinition $sig -Name 'PowerUtil' -Namespace 'Win32' -PassThru
    [void]$api::SetThreadExecutionState($ES_KEEP)
} catch {}

Start-Sleep -Seconds ([Math]::Max(1, $MaxMinutes) * 60)

try { [void]$api::SetThreadExecutionState($ES_CLEAR) } catch {}
