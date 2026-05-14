$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$env:DOCKER_BUILDKIT = "1"

$statusFile = Join-Path $root "overnight-mod-build.status.log"
$worldLog = Join-Path $root "overnight-worldserver-build.log"
$worldErr = Join-Path $root "overnight-worldserver-build.err.log"
$dbLog = Join-Path $root "overnight-dbimport-build.log"
$dbErr = Join-Path $root "overnight-dbimport-build.err.log"
$setupLog = Join-Path $root "overnight-setup-restart.log"

function Write-Status {
    param([string]$Message)
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$stamp $Message" | Tee-Object -FilePath $statusFile -Append
}

function Run-Logged {
    param(
        [string]$Label,
        [scriptblock]$Command,
        [string]$StdOut,
        [string]$StdErr
    )

    Write-Status "START $Label"
    & $Command > $StdOut 2> $StdErr
    if ($LASTEXITCODE -ne 0) {
        Write-Status "FAIL $Label exit=$LASTEXITCODE"
        throw "$Label failed with exit code $LASTEXITCODE"
    }
    Write-Status "DONE $Label"
}

Write-Status "Nightly module build started"
Write-Status "Stopping world/auth to free CPU and RAM during build"
docker compose stop ac-worldserver ac-authserver | Tee-Object -FilePath $setupLog -Append

Run-Logged "worldserver image build" {
    docker buildx build --progress=plain --target worldserver `
        -t acore/ac-wotlk-worldserver:playerbots-local `
        --build-arg DOCKER_USER=acore `
        --build-arg USER_ID=1000 `
        --build-arg GROUP_ID=1000 `
        --build-arg APPS_BUILD=world-only `
        --build-arg CTOOLS_BUILD=db-only `
        --build-arg BUILD_JOBS=2 `
        -f apps/docker/Dockerfile .
} $worldLog $worldErr

Run-Logged "db-import image build" {
    docker buildx build --progress=plain --target db-import `
        -t acore/ac-wotlk-db-import:playerbots-local `
        --build-arg DOCKER_USER=acore `
        --build-arg USER_ID=1000 `
        --build-arg GROUP_ID=1000 `
        --build-arg APPS_BUILD=world-only `
        --build-arg CTOOLS_BUILD=db-only `
        --build-arg BUILD_JOBS=2 `
        -f apps/docker/Dockerfile .
} $dbLog $dbErr

Write-Status "Running DB import for new module SQL"
docker compose --profile setup up -d --no-build ac-db-import | Tee-Object -FilePath $setupLog -Append

$deadline = (Get-Date).AddMinutes(30)
do {
    Start-Sleep -Seconds 10
    $state = docker inspect -f "{{.State.Status}} {{.State.ExitCode}}" ac-db-import 2>$null
    Write-Status "ac-db-import state: $state"
    if ($state -match "^exited\s+0$") {
        break
    }
    if ($state -match "^exited\s+") {
        docker compose logs --tail=200 ac-db-import | Tee-Object -FilePath $setupLog -Append
        throw "ac-db-import exited unsuccessfully: $state"
    }
} until ((Get-Date) -gt $deadline)

if ((Get-Date) -gt $deadline) {
    docker compose logs --tail=200 ac-db-import | Tee-Object -FilePath $setupLog -Append
    throw "Timed out waiting for ac-db-import"
}

Write-Status "Starting runtime services"
docker compose up -d --no-build --force-recreate ac-authserver ac-worldserver | Tee-Object -FilePath $setupLog -Append

Write-Status "Verifying ports"
$authOk = (Test-NetConnection -ComputerName 127.0.0.1 -Port 3724).TcpTestSucceeded
$worldOk = (Test-NetConnection -ComputerName 127.0.0.1 -Port 8085).TcpTestSucceeded
Write-Status "Port 3724 auth=$authOk"
Write-Status "Port 8085 world=$worldOk"

docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | Tee-Object -FilePath $setupLog -Append
Write-Status "Nightly module build finished"
