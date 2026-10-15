# Drawbridge dev tunnel: keeps https://drawbridge.moatit.dev -> 127.0.0.1:8095 up.
# Started at logon by the scheduled task "Drawbridge Dev Tunnel" (see deploy/local/README-tunnel.md).
# Restarts cloudflared whenever it exits. One instance only (mutex).

$ErrorActionPreference = 'Continue'
$exe    = 'C:\Users\alisj\cloudflared.exe'
$config = Join-Path $PSScriptRoot 'cloudflared-config.yml'
$logDir = Join-Path $env:LOCALAPPDATA 'drawbridge'
$log    = Join-Path $logDir 'tunnel.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$mutex = New-Object System.Threading.Mutex($false, 'Global\DrawbridgeDevTunnel')
if (-not $mutex.WaitOne(0)) { exit 0 }   # already running

while ($true) {
    # Keep the log small: roll at ~5 MB
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) { Move-Item -Force $log "$log.1" }
    Add-Content -Path $log -Value "$(Get-Date -Format o) starting cloudflared"
    & $exe tunnel --config $config run drawbridge-dev 2>&1 | ForEach-Object { "$_" } | Out-File -FilePath $log -Append -Encoding utf8
    Add-Content -Path $log -Value "$(Get-Date -Format o) cloudflared exited ($LASTEXITCODE); restarting in 5s"
    Start-Sleep -Seconds 5
}
