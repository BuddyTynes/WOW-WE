param(
    [string]$ImageTag = "acore/ac-wotlk-worldserver:playerbots-local",
    [int]$BuildJobs = 2
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogPath = Join-Path $LogDir "worldserver-build-$Stamp.log"
$ErrLogPath = Join-Path $LogDir "worldserver-build-$Stamp.err.log"
$StatusPath = Join-Path $LogDir "worldserver-build-$Stamp.status.json"

Set-Location $Root

$argsList = @(
    "buildx", "build",
    "--progress=plain",
    "--target", "worldserver",
    "-t", $ImageTag,
    "--build-arg", "DOCKER_USER=acore",
    "--build-arg", "USER_ID=1000",
    "--build-arg", "GROUP_ID=1000",
    "--build-arg", "APPS_BUILD=world-only",
    "--build-arg", "CTOOLS_BUILD=db-only",
    "--build-arg", "BUILD_JOBS=$BuildJobs",
    "-f", "apps/docker/Dockerfile",
    "."
)

@{
    status = "running"
    started_at = (Get-Date).ToString("o")
    pid = $PID
    cwd = $Root.Path
    log = $LogPath
    err_log = $ErrLogPath
    image_tag = $ImageTag
    build_jobs = $BuildJobs
} | ConvertTo-Json | Set-Content -Encoding UTF8 $StatusPath

"[$(Get-Date -Format o)] Starting detached worldserver build" | Add-Content -Encoding UTF8 $LogPath
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
    image_tag = $ImageTag
    build_jobs = $BuildJobs
} | ConvertTo-Json | Set-Content -Encoding UTF8 $StatusPath

"[$(Get-Date -Format o)] Build finished with exit code $exitCode" | Add-Content -Encoding UTF8 $LogPath

exit $exitCode
