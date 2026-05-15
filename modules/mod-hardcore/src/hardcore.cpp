/*
 * Command-based hardcore mode for small-group runs.
 */

#include "Chat.h"
#include "CommandScript.h"
#include "Config.h"
#include "DBCStores.h"
#include "DatabaseEnv.h"
#include "ObjectGuid.h"
#include "Opcodes.h"
#include "Player.h"
#include "Random.h"
#include "ScriptMgr.h"
#include "SpellMgr.h"
#include "World.h"
#include "WorldPacket.h"
#include "WorldSession.h"
#include "WorldSessionMgr.h"

#ifdef MOD_PLAYERBOTS
#include "Playerbots.h"
#endif

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>
#include <unordered_map>

using namespace Acore::ChatCommands;

namespace
{
enum class HardcoreSource
{
    Player,
    GmBot,
    RandomBot,
    RandomBotRollFailed
};

struct HardcoreState
{
    bool exists = false;
    bool enabled = false;
    bool dead = false;
    std::string source;
};

char const* ToDbSource(HardcoreSource source)
{
    switch (source)
    {
        case HardcoreSource::Player:
            return "player";
        case HardcoreSource::GmBot:
            return "gm_bot";
        case HardcoreSource::RandomBot:
            return "random_bot";
        case HardcoreSource::RandomBotRollFailed:
            return "random_bot_roll_failed";
    }

    return "unknown";
}

class HardcoreMgr
{
public:
    static HardcoreMgr& instance()
    {
        static HardcoreMgr instance;
        return instance;
    }

    void LoadConfig()
    {
        enabled = sConfigMgr->GetOption<bool>("Hardcore.Enable", true);
        auraSpellId = sConfigMgr->GetOption<uint32>("Hardcore.AuraSpellId", 21090);
        randomBotEnable = sConfigMgr->GetOption<bool>("Hardcore.RandomBotEnable", true);
        randomBotChance = std::clamp<uint32>(
            sConfigMgr->GetOption<uint32>("Hardcore.RandomBotChance", 25), 0, 100);
        botCommandSecurity = std::clamp<uint32>(
            sConfigMgr->GetOption<uint32>("Hardcore.BotCommandSecurity", 1),
            uint32(SEC_PLAYER), uint32(SEC_ADMINISTRATOR));
        nameTagEnable = sConfigMgr->GetOption<bool>("Hardcore.NameTag.Enable", true);
        nameTag = sConfigMgr->GetOption<std::string>("Hardcore.NameTag", "<HC>");
        deathAnnouncementEnable =
            sConfigMgr->GetOption<bool>("Hardcore.DeathAnnouncement.Enable", true);
        botDeathLogoutDelayMs =
            sConfigMgr->GetOption<uint32>("Hardcore.BotDeathLogoutDelay", 60) * IN_MILLISECONDS;
    }

    bool IsEnabled() const { return enabled; }
    uint32 GetBotCommandSecurity() const { return botCommandSecurity; }

    HardcoreState GetState(Player const* player)
    {
        return GetState(player->GetGUID().GetCounter());
    }

    HardcoreState GetState(ObjectGuid::LowType guid)
    {
        auto itr = states.find(guid);
        if (itr != states.end())
            return itr->second;

        HardcoreState state;
        QueryResult result = CharacterDatabase.Query(
            "SELECT `enabled`, `dead`, `source` "
            "FROM `mod_hardcore_characters` WHERE `guid` = {}",
            guid);

        if (result)
        {
            Field* fields = result->Fetch();
            state.exists = true;
            state.enabled = fields[0].Get<uint8>() != 0;
            state.dead = fields[1].Get<uint8>() != 0;
            state.source = fields[2].Get<std::string>();
        }

        states[guid] = state;
        return state;
    }

    bool EnableHardcore(Player* player, HardcoreSource source)
    {
        if (!enabled || !player || !player->IsAlive())
            return false;

        ObjectGuid::LowType guid = player->GetGUID().GetCounter();
        CharacterDatabase.Execute(
            "INSERT INTO `mod_hardcore_characters` "
            "(`guid`, `enabled`, `dead`, `source`, `created_at`, `evaluated_at`) "
            "VALUES ({}, 1, 0, '{}', NOW(), NOW()) "
            "ON DUPLICATE KEY UPDATE "
            "`enabled` = 1, `source` = VALUES(`source`), "
            "`evaluated_at` = NOW()",
            guid, ToDbSource(source));

        HardcoreState state;
        state.exists = true;
        state.enabled = true;
        state.dead = false;
        state.source = ToDbSource(source);
        states[guid] = state;

        ApplyAuraState(player);
        RefreshNameTag(player);
        player->SaveToDB(false, false);
        return true;
    }

    void RecordRandomBotRollFailed(Player* player)
    {
        if (!player)
            return;

        ObjectGuid::LowType guid = player->GetGUID().GetCounter();
        CharacterDatabase.Execute(
            "INSERT IGNORE INTO `mod_hardcore_characters` "
            "(`guid`, `enabled`, `dead`, `source`, `created_at`, `evaluated_at`) "
            "VALUES ({}, 0, 0, '{}', NOW(), NOW())",
            guid, ToDbSource(HardcoreSource::RandomBotRollFailed));

        HardcoreState state;
        state.exists = true;
        state.enabled = false;
        state.dead = false;
        state.source = ToDbSource(HardcoreSource::RandomBotRollFailed);
        states[guid] = state;
    }

    bool MarkDead(Player* player)
    {
        if (!enabled || !player)
            return false;

        HardcoreState state = GetState(player);
        if (!state.enabled || state.dead)
            return false;

        ObjectGuid::LowType guid = player->GetGUID().GetCounter();
        CharacterDatabase.Execute(
            "UPDATE `mod_hardcore_characters` "
            "SET `dead` = 1, `dead_at` = COALESCE(`dead_at`, NOW()) "
            "WHERE `guid` = {} AND `enabled` = 1",
            guid);

        state.exists = true;
        state.dead = true;
        states[guid] = state;
        ApplyAuraState(player);
        AnnounceDeath(player);

#ifdef MOD_PLAYERBOTS
        if (sRandomPlayerbotMgr.IsRandomBot(player))
            botLogoutTimers[guid] = botDeathLogoutDelayMs;
#endif

        return true;
    }

    void MaybeEvaluateRandomBot(Player* player)
    {
        if (!enabled || !randomBotEnable || !player)
            return;

        HardcoreState state = GetState(player);
        if (state.exists)
            return;

#ifdef MOD_PLAYERBOTS
        if (!sRandomPlayerbotMgr.IsRandomBot(player))
            return;

        if (urand(1, 100) <= randomBotChance)
            EnableHardcore(player, HardcoreSource::RandomBot);
        else
            RecordRandomBotRollFailed(player);
#endif
    }

    void ApplyAuraState(Player* player)
    {
        if (!player || !auraSpellId)
            return;

        bool shouldHaveAura = false;
        if (enabled && sSpellMgr->GetSpellInfo(auraSpellId))
        {
            HardcoreState state = GetState(player);
            shouldHaveAura = state.enabled && !state.dead && player->IsAlive();
        }

        if (shouldHaveAura)
        {
            if (!player->HasAura(auraSpellId))
                player->AddAura(auraSpellId, player);
        }
        else if (player->HasAura(auraSpellId))
        {
            player->RemoveAura(auraSpellId);
        }
    }

    void CustomizeNameTag(ObjectGuid guid, std::string& name)
    {
        if (!enabled || !nameTagEnable || nameTag.empty() || !guid.IsPlayer())
            return;

        HardcoreState state = GetState(guid.GetCounter());
        if (!state.enabled)
            return;

        std::string suffix = " " + nameTag;
        if (name.size() >= suffix.size() &&
            name.compare(name.size() - suffix.size(), suffix.size(), suffix) == 0)
            return;

        name += suffix;
    }

    void RefreshNameTag(Player* player)
    {
        if (!player || !nameTagEnable)
            return;

        ObjectGuid guid = player->GetGUID();
        WorldSessionMgr::SessionMap const& sessions = sWorldSessionMgr->GetAllSessions();
        for (WorldSessionMgr::SessionMap::const_iterator itr = sessions.begin();
             itr != sessions.end(); ++itr)
        {
            if (WorldSession* session = itr->second)
                session->SendNameQueryOpcode(guid);
        }
    }

    void AnnounceDeath(Player* player)
    {
        if (!deathAnnouncementEnable || !player)
            return;

        std::string message = Acore::StringFormat(
            "<HC> {} died at level {} in {}.", player->GetName(),
            player->GetLevel(), GetLocationName(player));

        sWorldSessionMgr->SendServerMessage(SERVER_MSG_STRING, message);

        WorldPacket notification(SMSG_NOTIFICATION, message.size() + 1);
        notification << message;
        sWorldSessionMgr->SendGlobalMessage(&notification);
    }

    std::string GetLocationName(Player* player) const
    {
        LocaleConstant locale = sWorld->GetDefaultDbcLocale();
        if (AreaTableEntry const* area = sAreaTableStore.LookupEntry(player->GetAreaId()))
            return area->area_name[locale];

        if (AreaTableEntry const* zone = sAreaTableStore.LookupEntry(player->GetZoneId()))
            return zone->area_name[locale];

        if (player->FindMap())
            return player->FindMap()->GetMapName();

        return "an unknown place";
    }

    void EnforceDeadState(Player* player)
    {
        if (!enabled || !player)
            return;

        HardcoreState state = GetState(player);
        if (!state.enabled || !state.dead)
            return;

        ApplyAuraState(player);
        if (player->IsAlive())
            player->KillPlayer();

        if (!player->HasPlayerFlag(PLAYER_FLAGS_GHOST) && player->IsInWorld())
        {
            player->BuildPlayerRepop();
            player->RepopAtGraveyard();
        }

#ifdef MOD_PLAYERBOTS
        if (sRandomPlayerbotMgr.IsRandomBot(player))
        {
            ObjectGuid::LowType guid = player->GetGUID().GetCounter();
            if (!botLogoutTimers.contains(guid))
                botLogoutTimers[guid] = botDeathLogoutDelayMs;
            return;
        }
#endif
    }

    bool CanResurrect(Player* player)
    {
        if (!enabled || !player)
            return true;

        HardcoreState state = GetState(player);
        return !state.enabled || !state.dead;
    }

    void UpdateDeadBotLogouts(uint32 diff)
    {
        if (!enabled)
            return;

#ifdef MOD_PLAYERBOTS
        for (auto itr = botLogoutTimers.begin(); itr != botLogoutTimers.end();)
        {
            ObjectGuid::LowType guid = itr->first;
            HardcoreState state = GetState(guid);
            if (!state.enabled || !state.dead)
            {
                itr = botLogoutTimers.erase(itr);
                continue;
            }

            if (itr->second > diff)
            {
                itr->second -= diff;
                ++itr;
                continue;
            }

            itr = botLogoutTimers.erase(itr);

            ObjectGuid botGuid = ObjectGuid::Create<HighGuid::Player>(guid);
            Player* bot = sRandomPlayerbotMgr.GetPlayerBot(botGuid);
            if (!bot || !sRandomPlayerbotMgr.IsRandomBot(bot))
                continue;

            sRandomPlayerbotMgr.OnPlayerLoginError(guid);
            sRandomPlayerbotMgr.LogoutPlayerBot(botGuid);
        }
#endif
    }

    void OnLogout(Player const* player)
    {
        if (!player)
            return;

        ObjectGuid::LowType guid = player->GetGUID().GetCounter();
        auraTimers.erase(guid);
        botLogoutTimers.erase(guid);
    }

    bool ShouldCheckAura(Player const* player, uint32 diff)
    {
        ObjectGuid::LowType guid = player->GetGUID().GetCounter();
        uint32& timer = auraTimers[guid];
        timer += diff;
        if (timer < 30000)
            return false;

        timer = 0;
        return true;
    }

private:
    bool enabled = true;
    uint32 auraSpellId = 21090;
    bool randomBotEnable = true;
    uint32 randomBotChance = 25;
    uint32 botCommandSecurity = SEC_MODERATOR;
    bool nameTagEnable = true;
    std::string nameTag = "<HC>";
    bool deathAnnouncementEnable = true;
    uint32 botDeathLogoutDelayMs = 60000;
    std::unordered_map<ObjectGuid::LowType, HardcoreState> states;
    std::unordered_map<ObjectGuid::LowType, uint32> auraTimers;
    std::unordered_map<ObjectGuid::LowType, uint32> botLogoutTimers;
};

#define sHardcore HardcoreMgr::instance()

std::string ToLower(std::string_view value)
{
    std::string out(value);
    std::transform(out.begin(), out.end(), out.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}

std::string_view Trim(std::string_view value)
{
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.front())))
        value.remove_prefix(1);

    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back())))
        value.remove_suffix(1);

    return value;
}

bool IsConfirm(std::string_view value)
{
    return ToLower(Trim(value)) == "confirm";
}

void SendStatus(ChatHandler* handler, Player* player)
{
    HardcoreState state = sHardcore.GetState(player);
    if (!sHardcore.IsEnabled())
    {
        handler->PSendSysMessage("Hardcore mode is disabled.");
        return;
    }

    if (!state.exists || !state.enabled)
    {
        handler->PSendSysMessage(
            "You are not hardcore. Use .hardcore enable confirm to opt in.");
        return;
    }

    if (state.dead)
    {
        handler->PSendSysMessage("You are a dead hardcore character.");
        return;
    }

    handler->PSendSysMessage("You are playing a hardcore character.");
}

class hardcore_worldscript : public WorldScript
{
public:
    hardcore_worldscript() : WorldScript("hardcore_worldscript") { }

    void OnAfterConfigLoad(bool /*reload*/) override
    {
        sHardcore.LoadConfig();
    }

    void OnUpdate(uint32 diff) override
    {
        sHardcore.UpdateDeadBotLogouts(diff);
    }
};

class hardcore_playerscript : public PlayerScript
{
public:
    hardcore_playerscript() : PlayerScript("hardcore_playerscript") { }

    void OnPlayerLogin(Player* player) override
    {
        sHardcore.MaybeEvaluateRandomBot(player);
        sHardcore.EnforceDeadState(player);
        sHardcore.ApplyAuraState(player);
    }

    void OnPlayerLogout(Player* player) override
    {
        sHardcore.OnLogout(player);
    }

    void OnPlayerMapChanged(Player* player) override
    {
        sHardcore.MaybeEvaluateRandomBot(player);
        sHardcore.ApplyAuraState(player);
    }

    void OnPlayerAfterUpdate(Player* player, uint32 diff) override
    {
        if (!sHardcore.ShouldCheckAura(player, diff))
            return;

        sHardcore.MaybeEvaluateRandomBot(player);
        sHardcore.EnforceDeadState(player);
        sHardcore.ApplyAuraState(player);
    }

    void OnPlayerJustDied(Player* player) override
    {
        sHardcore.MarkDead(player);
    }

    void OnPlayerReleasedGhost(Player* player) override
    {
        sHardcore.MarkDead(player);
        sHardcore.EnforceDeadState(player);
    }

    void OnPlayerResurrect(Player* player, float /*restorePercent*/,
        bool& /*applySickness*/) override
    {
        sHardcore.EnforceDeadState(player);
    }

    bool OnPlayerCanResurrect(Player* player) override
    {
        return sHardcore.CanResurrect(player);
    }

    void OnPlayerCustomizeNameQuery(ObjectGuid guid, std::string& name) override
    {
        sHardcore.CustomizeNameTag(guid, name);
    }
};

class hardcore_commandscript : public CommandScript
{
public:
    hardcore_commandscript() : CommandScript("hardcore_commandscript") { }

    ChatCommandTable GetCommands() const override
    {
        static ChatCommandTable hardcoreCommandTable =
        {
            { "enable", HandleEnableCommand, SEC_PLAYER, Console::No },
            { "status", HandleStatusCommand, SEC_PLAYER, Console::No },
            { "bot", HandleBotCommand, SEC_PLAYER, Console::No },
            { "", HandleStatusCommand, SEC_PLAYER, Console::No }
        };

        static ChatCommandTable commandTable =
        {
            { "hardcore", hardcoreCommandTable }
        };

        return commandTable;
    }

    static bool HandleStatusCommand(ChatHandler* handler)
    {
        if (Player* player = handler->GetPlayer())
            SendStatus(handler, player);

        return true;
    }

    static bool HandleEnableCommand(ChatHandler* handler, Tail args)
    {
        Player* player = handler->GetPlayer();
        if (!player)
            return false;

        if (!sHardcore.IsEnabled())
        {
            handler->PSendSysMessage("Hardcore mode is disabled.");
            return true;
        }

        if (!IsConfirm(args))
        {
            handler->PSendSysMessage(
                "This is permanent. Use .hardcore enable confirm to opt in.");
            return true;
        }

        HardcoreState state = sHardcore.GetState(player);
        if (state.enabled)
        {
            SendStatus(handler, player);
            return true;
        }

        if (!player->IsAlive())
        {
            handler->PSendSysMessage("You must be alive to opt into hardcore.");
            return true;
        }

        if (sHardcore.EnableHardcore(player, HardcoreSource::Player))
            handler->PSendSysMessage("Hardcore mode enabled. Good luck.");
        else
            handler->PSendSysMessage("Could not enable hardcore mode.");

        return true;
    }

    static bool HandleBotCommand(ChatHandler* handler,
        PlayerIdentifier target, Tail args)
    {
        if (!sHardcore.IsEnabled())
        {
            handler->PSendSysMessage("Hardcore mode is disabled.");
            return true;
        }

        WorldSession* session = handler->GetSession();
        if (!session ||
            session->GetSecurity() < sHardcore.GetBotCommandSecurity())
        {
            handler->PSendSysMessage(
                "You do not have permission to mark bots as hardcore.");
            return true;
        }

        if (!IsConfirm(args))
        {
            handler->PSendSysMessage(
                "Usage: .hardcore bot <botName> confirm");
            return true;
        }

        if (!target.IsConnected())
        {
            handler->PSendSysMessage("Target bot must be online.");
            return true;
        }

        Player* bot = target.GetConnectedPlayer();
#ifdef MOD_PLAYERBOTS
        PlayerbotAI* botAI = GET_PLAYERBOT_AI(bot);
        if (!botAI || botAI->IsRealPlayer())
        {
            handler->PSendSysMessage(
                ".hardcore bot can only target online playerbots.");
            return true;
        }
#else
        handler->PSendSysMessage("Playerbots are not available in this build.");
        return true;
#endif

        if (!bot->IsAlive())
        {
            handler->PSendSysMessage("The bot must be alive.");
            return true;
        }

        if (sHardcore.EnableHardcore(bot, HardcoreSource::GmBot))
            handler->PSendSysMessage("{} is now hardcore.", bot->GetName());
        else
            handler->PSendSysMessage("Could not mark {} as hardcore.",
                bot->GetName());

        return true;
    }
};
}

void Addmod_hardcoreScripts()
{
    new hardcore_worldscript();
    new hardcore_playerscript();
    new hardcore_commandscript();
}
