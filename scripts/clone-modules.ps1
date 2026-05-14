$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$modules = @(
    @{ Name = "mod-playerbots"; Url = "https://github.com/mod-playerbots/mod-playerbots.git"; Commit = "531282e4beb0a5abea6332479f8720518a89b1a2" },
    @{ Name = "mod-ollama-chat"; Url = "https://github.com/DustinHendrickson/mod-ollama-chat.git"; Commit = "8ba5e791f0a84ee04636f0b19b62d3c4aff3dce1" },
    @{ Name = "mod-individual-progression"; Url = "https://github.com/ZhengPeiRu21/mod-individual-progression.git"; Commit = "822b53028853b7e93b6cfce2056b8b9a9ccc3589" },
    @{ Name = "mod-challenge-modes"; Url = "https://github.com/ZhengPeiRu21/mod-challenge-modes.git"; Commit = "1930525b9530d329cb9fe0504a3c9b5b40a12261" },
    @{ Name = "mod-ah-bot-plus"; Url = "https://github.com/NathanHandley/mod-ah-bot.git"; Commit = "1822d96072a5168a775551fa5017ec947c9fbf7b" },
    @{ Name = "mod-aoe-loot"; Url = "https://github.com/azerothcore/mod-aoe-loot.git"; Commit = "2ddf6ff75bdbfee3c81f2c149a07126f1d0bf200" }
)

New-Item -ItemType Directory -Force -Path (Join-Path $root "modules") | Out-Null

foreach ($module in $modules) {
    $path = Join-Path $root "modules\$($module.Name)"
    if (-not (Test-Path $path)) {
        git clone $module.Url $path
    }

    git -C $path fetch --all --tags
    git -C $path checkout $module.Commit
}

Write-Host "Modules cloned and pinned."
