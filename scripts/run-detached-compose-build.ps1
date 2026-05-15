param(
    [string[]]$Services = @("ac-worldserver", "ac-db-import")
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogPath = Join-Path $LogDir "compose-build-$Stamp.log"
$ErrLogPath = Join-Path $LogDir "compose-build-$Stamp.err.log"
$StatusPath = Join-Path $LogDir "compose-build-$Stamp.status.json"

Set-Location $Root

$argsList = @("compose", "build") + $Services

@{
    status = "running"
    started_at = (Get-Date).ToString("o")
    pid = $PID
    cwd = $Root.Path
    log = $LogPath
    err_log = $ErrLogPath
    services = $Services
} | ConvertTo-Json | Set-Content -Encoding UTF8 $StatusPath

"[$(Get-Date -Format o)] Starting detached compose build" | Add-Content -Encoding UTF8 $LogPath
"Command: docker $($argsList -join ' ')" | Add-Content -Encoding UTF8 $LogPath

$process = Start-Process -FilePath "docker.exe" `
    -ArgumentList $argsList `
    -NoNewWindow `
    -RedirectStandardOutput $LogPath `
    -RedirectStandardError $ErrLogPath `
    -Wait `
    -PassThru

$exitCode = $process.ExitCode

@{
    status = if ($exitCode -eq 0) { "succeeded" } else { "failed" }
    exit_code = $exitCode
    finished_at = (Get-Date).ToString("o")
    pid = $PID
    cwd = $Root.Path
    log = $LogPath
    err_log = $ErrLogPath
    services = $Services
} | ConvertTo-Json | Set-Content -Encoding UTF8 $StatusPath

"[$(Get-Date -Format o)] Compose build finished with exit code $exitCode" | Add-Content -Encoding UTF8 $LogPath

exit $exitCode
