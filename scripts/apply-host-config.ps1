$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
    Copy-Item ".env.example" ".env"
}

if (-not (Test-Path "docker-compose.override.yml") -and (Test-Path "docker-compose.override.example.yml")) {
    Copy-Item "docker-compose.override.example.yml" "docker-compose.override.yml"
}

$moduleConfigDir = Join-Path $root "env\dist\etc\modules"
New-Item -ItemType Directory -Force -Path $moduleConfigDir | Out-Null

$staleChallengeConfig = Join-Path $moduleConfigDir "challenge_modes.conf"
if (Test-Path $staleChallengeConfig) {
    Remove-Item -LiteralPath $staleChallengeConfig -Force
}

function Set-ConfigValue {
    param(
        [string]$Path,
        [string]$Key,
        [string]$Value
    )

    $text = Get-Content -LiteralPath $Path -Raw
    $pattern = "(?m)^" + [regex]::Escape($Key) + "\s*=.*$"
    if ($text -match $pattern) {
        $text = [regex]::Replace($text, $pattern, "$Key = $Value")
    } else {
        $text += "`r`n$Key = $Value`r`n"
    }
    Set-Content -LiteralPath $Path -Value $text -NoNewline
}

function Set-ComposeEnvironmentValue {
    param(
        [string]$Path,
        [string]$Key,
        [string]$Value
    )

    if (-not (Test-Path $Path)) {
        return
    }

    $text = Get-Content -LiteralPath $Path -Raw
    $line = "      $Key`: `"$Value`""
    $pattern = "(?m)^\s{6}" + [regex]::Escape($Key) + "\s*:.*$"

    if ($text -match $pattern) {
        $text = [regex]::Replace($text, $pattern, $line)
    } elseif ($text -match "(?m)^\s{6}AC_ALLOW_TWO_SIDE_INTERACTION_AUCTION\s*:.*\r?\n") {
        $insertAfter = [regex]"(?m)^(\s{6}AC_ALLOW_TWO_SIDE_INTERACTION_AUCTION\s*:.*\r?\n)"
        $text = $insertAfter.Replace($text, "`${1}$line`r`n", 1)
    } else {
        $text += "`r`n$line`r`n"
    }

    Set-Content -LiteralPath $Path -Value $text -NoNewline
}

$worldConfigDir = Join-Path $root "env\dist\etc"
$worldConfig = Join-Path $worldConfigDir "worldserver.conf"
$worldConfigDist = Join-Path $worldConfigDir "worldserver.conf.dist"
if (-not (Test-Path $worldConfig) -and (Test-Path $worldConfigDist)) {
    Copy-Item -LiteralPath $worldConfigDist -Destination $worldConfig
}

if (Test-Path $worldConfig) {
    $worldValues = [ordered]@{
        "AllowTwoSide.Interaction.Guild" = "1"
        "AllowTwoSide.Interaction.Group" = "1"
        "AllowTwoSide.WhoList" = "1"
        "AllowTwoSide.AddFriend" = "1"
        "MaxPrimaryTradeSkill" = "11"
    }

    foreach ($key in $worldValues.Keys) {
        Set-ConfigValue -Path $worldConfig -Key $key -Value $worldValues[$key]
    }
}

$composeOverride = Join-Path $root "docker-compose.override.yml"
$composeValues = [ordered]@{
    "AC_ALLOW_TWO_SIDE_INTERACTION_GUILD" = "1"
    "AC_ALLOW_TWO_SIDE_INTERACTION_GROUP" = "1"
    "AC_ALLOW_TWO_SIDE_WHO_LIST" = "1"
    "AC_ALLOW_TWO_SIDE_ADD_FRIEND" = "1"
    "AC_MAX_PRIMARY_TRADE_SKILL" = "11"
}

foreach ($key in $composeValues.Keys) {
    Set-ComposeEnvironmentValue -Path $composeOverride -Key $key -Value $composeValues[$key]
}

$ahbotSource = Join-Path $root "modules\mod-ah-bot-plus\conf\mod_ahbot.conf.dist"
$ahbotTarget = Join-Path $moduleConfigDir "mod_ahbot.conf"
if (Test-Path $ahbotSource) {
    Copy-Item -LiteralPath $ahbotSource -Destination $ahbotTarget -Force
    $ahbotValues = [ordered]@{
        "AuctionHouseBot.EnableSeller" = "true"
        "AuctionHouseBot.GUIDs" = "1010"
        "AuctionHouseBot.MinutesBetweenSellCycle" = "1"
        "AuctionHouseBot.MinutesBetweenBuyCycle" = "2:5"
        "AuctionHouseBot.ItemsPerCycle" = "500"
        "AuctionHouseBot.ListingExpireTimeInSecondsMin" = "28800"
        "AuctionHouseBot.ListingExpireTimeInSecondsMax" = "172800"
        "AuctionHouseBot.AdvancedListingRules.UseDropRates.Enabled" = "true"
        "AuctionHouseBot.Alliance.MinItems" = "15000"
        "AuctionHouseBot.Alliance.MaxItems" = "15000"
        "AuctionHouseBot.Horde.MinItems" = "15000"
        "AuctionHouseBot.Horde.MaxItems" = "15000"
        "AuctionHouseBot.Neutral.MinItems" = "30000"
        "AuctionHouseBot.Neutral.MaxItems" = "30000"
        "AuctionHouseBot.Buyer.Enabled" = "true"
        "AuctionHouseBot.Buyer.BuyCandidatesPerBuyCycle" = "2:8"
        "AuctionHouseBot.Buyer.AcceptablePriceModifier" = "1.15"
        "AuctionHouseBot.Buyer.PreventOverpayingForVendorItems" = "true"
        "AuctionHouseBot.Buyer.BidAgainstPlayers" = "true"
    }

    foreach ($key in $ahbotValues.Keys) {
        Set-ConfigValue -Path $ahbotTarget -Key $key -Value $ahbotValues[$key]
    }
} else {
    Write-Warning "Could not find $ahbotSource. Run scripts\clone-modules.ps1 first."
}

@"
[worldserver]
AOELoot.Enable = 1
AOELoot.Message = 1
AOELoot.Range = 70.0
AOELoot.Group = 1
"@ | Set-Content -LiteralPath (Join-Path $moduleConfigDir "mod_aoe_loot.conf") -NoNewline

@"
[worldserver]
OllamaChat.Enable = 1
OllamaChat.Url = http://wow-llm-bridge:11434/api/generate
OllamaChat.Model = gpt-5.3-mini
OllamaChat.EnableWhisperReplies = 1
OllamaChat.MaxConcurrentQueries = 2
OllamaChat.NumPredict = 80
OllamaChat.PlayerReplyChance.Say = 80
OllamaChat.BotReplyChance.Say = 5
OllamaChat.PlayerReplyChance.Channel = 40
OllamaChat.BotReplyChance.Channel = 1
OllamaChat.PlayerReplyChance.Party = 90
OllamaChat.BotReplyChance.Party = 5
OllamaChat.PlayerReplyChance.Guild = 60
OllamaChat.BotReplyChance.Guild = 2
OllamaChat.EnableRandomChatter = 1
OllamaChat.MinRandomInterval = 120
OllamaChat.MaxRandomInterval = 300
OllamaChat.RandomChatterMaxBotsPerPlayer = 1
OllamaChat.EventChatterMaxBotsPerPlayer = 1
OllamaChat.DisableRepliesInCombat = 1
"@ | Set-Content -LiteralPath (Join-Path $moduleConfigDir "mod_ollama_chat.conf") -NoNewline

$hardcoreSource = Join-Path $root "modules\mod-hardcore\conf\hardcore.conf.dist"
$hardcoreTarget = Join-Path $moduleConfigDir "hardcore.conf"
if (Test-Path $hardcoreSource) {
    Copy-Item -LiteralPath $hardcoreSource -Destination $hardcoreTarget -Force
} else {
    Write-Warning "Could not find $hardcoreSource."
}

Write-Host "Host config applied."
