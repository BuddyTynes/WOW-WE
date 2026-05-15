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

$ollamaSource = Join-Path $root "modules\mod-ollama-chat\conf\mod_ollama_chat.conf.dist"
$ollamaTarget = Join-Path $moduleConfigDir "mod_ollama_chat.conf"
if (Test-Path $ollamaSource) {
    Copy-Item -LiteralPath $ollamaSource -Destination $ollamaTarget -Force
    $ollamaValues = [ordered]@{
        "OllamaChat.Enable" = "1"
        "OllamaChat.Url" = "http://wow-llm-bridge:11434/api/generate"
        "OllamaChat.Model" = "gpt-5.3-mini"
        "OllamaChat.EnableWhisperReplies" = "1"
        "OllamaChat.MaxConcurrentQueries" = "1"
        "OllamaChat.NumPredict" = "100"
        "OllamaChat.PlayerReplyChance.Say" = "80"
        "OllamaChat.BotReplyChance.Say" = "8"
        "OllamaChat.PlayerReplyChance.Channel" = "0"
        "OllamaChat.BotReplyChance.Channel" = "0"
        "OllamaChat.PlayerReplyChance.Party" = "90"
        "OllamaChat.BotReplyChance.Party" = "5"
        "OllamaChat.PlayerReplyChance.Guild" = "0"
        "OllamaChat.BotReplyChance.Guild" = "0"
        "OllamaChat.EnableRandomChatter" = "1"
        "OllamaChat.MinRandomInterval" = "75"
        "OllamaChat.MaxRandomInterval" = "180"
        "OllamaChat.RandomChatterMaxBotsPerPlayer" = "1"
        "OllamaChat.RandomChatterBotCommentChance" = "14"
        "OllamaChat.EnableEventChatter" = "1"
        "OllamaChat.EventChatterBotCommentChance" = "70"
        "OllamaChat.EventChatterBotSelfCommentChance" = "25"
        "OllamaChat.EventChatterMaxBotsPerPlayer" = "3"
        "OllamaChat.EventCooldownTime" = "5"
        "OllamaChat.EventTypeDied_Chance" = "100"
        "OllamaChat.EnableGuildRandomAmbientChatter" = "0"
        "OllamaChat.GuildRandomChatterChance" = "0"
        "OllamaChat.EnableGuildEventChatter" = "0"
        "OllamaChat.GuildChatterBotCommentChance" = "0"
        "OllamaChat.GuildChatterMaxBotsPerEvent" = "1"
        "OllamaChat.DisableRepliesInCombat" = "1"
        "OllamaChat.DisableForGuild" = "1"
        "OllamaChat.DisableForCustomChannels" = "1"
    }

    foreach ($key in $ollamaValues.Keys) {
        Set-ConfigValue -Path $ollamaTarget -Key $key -Value $ollamaValues[$key]
    }

    Set-ConfigValue -Path $ollamaTarget -Key "OllamaChat.RandomChatterPromptTemplate" -Value '"You are a Vanilla WoW playerbot. Name: {bot_name}, Level: {bot_level} {bot_class}, {bot_race} {bot_gender}, Faction: {bot_faction}. Location: {bot_area}, Zone: {bot_zone}. Personality: {bot_personality_name}: {bot_personality}. {environment_info} Reply as that character in one short chat line, 4-18 words. No quotes, no markdown, no roleplay narration. Never repeat the prompt. If another bot is being dumb, jab them by name."'
    Set-ConfigValue -Path $ollamaTarget -Key "OllamaChat.RandomChatterPromptVariations" -Value '"Complain about leveling taking forever.|Brag about a pull you barely survived.|Make fun of another bot''s gear or pathing.|Argue about whether Horde or Alliance has worse players.|Say something suspiciously overconfident before probably dying.|Complain about bag space or repair bills.|Call out a nearby guildmate like you know them.|Start a petty argument about loot rolls.|Talk like world chat is watching.|Make a short roast about someone playing badly."'
    Set-ConfigValue -Path $ollamaTarget -Key "OllamaChat.RandomChatterQuestionVariations" -Value '"Ask who is actually carrying this guild.|Ask if anyone else saw that awful pull.|Ask why Cumm is always lost.|Ask why Zartorg talks like he invented rage.|Ask who is going to die next.|Ask if anyone has spare bags.|Ask whether this zone is cursed.|Ask who needs help before they faceplant."'
    Set-ConfigValue -Path $ollamaTarget -Key "OllamaChat.EventChatterPromptTemplate" -Value '"You are {bot_name}, a level {bot_level} {bot_class} in Vanilla WoW. Personality: {bot_personality_name}: {bot_personality}. Event: {actor_name} {event_type} {event_detail}. Reply with one short public chat line. If the event is died or a hardcore death, react like ruthless world chat: short L, rip, skill issue, or a playful roast aimed at {actor_name}. No slurs, no hate, no markdown."'
} else {
    Write-Warning "Could not find $ollamaSource. Run scripts\clone-modules.ps1 first."
}

$hardcoreSource = Join-Path $root "modules\mod-hardcore\conf\hardcore.conf.dist"
$hardcoreTarget = Join-Path $moduleConfigDir "hardcore.conf"
if (Test-Path $hardcoreSource) {
    Copy-Item -LiteralPath $hardcoreSource -Destination $hardcoreTarget -Force
} else {
    Write-Warning "Could not find $hardcoreSource."
}

$llmDirectorSource = Join-Path $root "modules\mod-llm-npc-director\conf\llm_npc_director.conf.dist"
$llmDirectorTarget = Join-Path $moduleConfigDir "llm_npc_director.conf"
if (Test-Path $llmDirectorSource) {
    Copy-Item -LiteralPath $llmDirectorSource -Destination $llmDirectorTarget -Force
} else {
    Write-Warning "Could not find $llmDirectorSource."
}

$playerbotsTarget = Join-Path $moduleConfigDir "playerbots.conf.dist"
if (-not (Test-Path $playerbotsTarget)) {
    $playerbotsTarget = Join-Path $moduleConfigDir "playerbots.conf"
}

if (Test-Path $playerbotsTarget) {
    Set-ConfigValue -Path $playerbotsTarget -Key "AiPlayerbot.LootNeedRollLevel" -Value "1"
}

Write-Host "Host config applied."
