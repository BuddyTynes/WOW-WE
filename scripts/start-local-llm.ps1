param(
  [int]$Port = 8088,
  [string]$ModelPath = "",
  [switch]$Stop
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LlamaDir = Join-Path $RepoRoot "tools\local-llm\llama.cpp"
$ServerExe = Join-Path $LlamaDir "llama-server.exe"
$DefaultModelPath = Join-Path $RepoRoot "tools\local-llm\models\gemma-3n-E2B-it-Q4_K_M.gguf"
$LogPath = Join-Path $RepoRoot "tools\local-llm\llama-server-runtime.log"

if ($Stop) {
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  return
}

if (-not $ModelPath) {
  $ModelPath = $DefaultModelPath
}

if (-not (Test-Path $ServerExe)) {
  throw "llama-server.exe was not found at $ServerExe"
}

if (-not (Test-Path $ModelPath)) {
  throw "Model file was not found at $ModelPath"
}

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $process = Get-Process -Id $existing.OwningProcess -ErrorAction SilentlyContinue
  Write-Host "llama-server is already listening on port $Port with process id $($process.Id)."
  return
}

$resolvedModel = (Resolve-Path $ModelPath).Path
$args = @(
  "--host 0.0.0.0",
  "--port $Port",
  "--model `"$resolvedModel`"",
  "--ctx-size 4096",
  "--n-gpu-layers 99",
  "--batch-size 512",
  "--ubatch-size 128",
  "--flash-attn on",
  "--cache-ram 0",
  "--log-file `"$LogPath`""
) -join " "

$process = Start-Process `
  -FilePath $ServerExe `
  -ArgumentList $args `
  -WorkingDirectory $LlamaDir `
  -WindowStyle Hidden `
  -PassThru

Start-Sleep -Seconds 20
$portOpen = (Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded

if (-not $portOpen) {
  throw "llama-server process $($process.Id) started, but port $Port is not reachable. Check $LogPath"
}

Write-Host "llama-server started on port $Port with process id $($process.Id)."
Write-Host "Log: $LogPath"
