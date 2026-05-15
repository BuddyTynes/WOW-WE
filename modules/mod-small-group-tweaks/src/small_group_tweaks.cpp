/*
 * Small-group realm quality-of-life helpers.
 */

#include "Chat.h"
#include "CommandScript.h"
#include "DBCStores.h"
#include "ObjectAccessor.h"
#include "Player.h"
#include "ScriptMgr.h"
#include "SharedDefines.h"
#include "World.h"

#ifdef MOD_PLAYERBOTS
#include "Playerbots.h"
#endif

#include <algorithm>
#include <array>
#include <string>
#include <vector>

using namespace Acore::ChatCommands;

namespace
{
constexpr uint32 MaxPrimaryProfessions = 11;

std::array<uint16, MaxPrimaryProfessions> const PrimaryProfessionSkills = {
    SKILL_ALCHEMY,
    SKILL_BLACKSMITHING,
    SKILL_ENCHANTING,
    SKILL_ENGINEERING,
    SKILL_HERBALISM,
    SKILL_INSCRIPTION,
    SKILL_JEWELCRAFTING,
    SKILL_LEATHERWORKING,
    SKILL_MINING,
    SKILL_SKINNING,
    SKILL_TAILORING
};

bool IsBot(Player* player)
{
#ifdef MOD_PLAYERBOTS
    PlayerbotAI* botAI = GET_PLAYERBOT_AI(player);
    return botAI && !botAI->IsRealPlayer();
#else
    return false;
#endif
}

std::string GetClassName(Player const* player)
{
    if (ChrClassesEntry const* classEntry = sChrClassesStore.LookupEntry(player->getClass()))
        return classEntry->name[sWorld->GetDefaultDbcLocale()];

    return "Unknown";
}

std::string GetZoneName(Player const* player)
{
    if (AreaTableEntry const* area = sAreaTableStore.LookupEntry(player->GetZoneId()))
        return area->area_name[sWorld->GetDefaultDbcLocale()];

    return "Unknown";
}

uint32 CountLearnedPrimaryProfessions(Player const* player)
{
    uint32 count = 0;
    for (uint16 skillId : PrimaryProfessionSkills)
        if (player->GetSkillValue(skillId) > 0)
            ++count;

    return count;
}

void NormalizePrimaryProfessionSlots(Player* player)
{
    if (!player)
        return;

    uint32 learned = std::min<uint32>(CountLearnedPrimaryProfessions(player),
        MaxPrimaryProfessions);
    player->SetFreePrimaryProfessions(MaxPrimaryProfessions - learned);
}

struct OnlinePlayerInfo
{
    std::string name;
    uint8 level = 0;
    std::string className;
    std::string zoneName;
};

class small_group_tweaks_playerscript : public PlayerScript
{
public:
    small_group_tweaks_playerscript()
        : PlayerScript("small_group_tweaks_playerscript")
    {
    }

    void OnPlayerLogin(Player* player) override
    {
        NormalizePrimaryProfessionSlots(player);
    }
};

class small_group_tweaks_commandscript : public CommandScript
{
public:
    small_group_tweaks_commandscript()
        : CommandScript("small_group_tweaks_commandscript")
    {
    }

    ChatCommandTable GetCommands() const override
    {
        static ChatCommandTable commandTable =
        {
            { "online", HandleOnlineCommand, SEC_PLAYER, Console::No }
        };

        return commandTable;
    }

    static bool HandleOnlineCommand(ChatHandler* handler)
    {
        Player* requester = handler->GetPlayer();
        if (!requester)
            return false;

        std::vector<OnlinePlayerInfo> players;
        for (auto const& [guid, player] : ObjectAccessor::GetPlayers())
        {
            if (!player || !player->GetSession() ||
                player->GetSession()->PlayerLoading() || IsBot(player))
                continue;

            if (player != requester && !player->IsVisibleGloballyFor(requester))
                continue;

            OnlinePlayerInfo info;
            info.name = player->GetName();
            info.level = player->GetLevel();
            info.className = GetClassName(player);
            info.zoneName = GetZoneName(player);
            players.push_back(info);
        }

        std::sort(players.begin(), players.end(),
            [](OnlinePlayerInfo const& left, OnlinePlayerInfo const& right)
            {
                return left.name < right.name;
            });

        handler->PSendSysMessage("Online real players: {}", players.size());
        if (players.empty())
            return true;

        std::string line;
        for (OnlinePlayerInfo const& player : players)
        {
            std::string entry = Acore::StringFormat("{} - {} {} ({})",
                player.name, player.level, player.className, player.zoneName);

            if (!line.empty() && line.size() + entry.size() + 2 > 220)
            {
                handler->PSendSysMessage("{}", line);
                line.clear();
            }

            if (!line.empty())
                line += "; ";

            line += entry;
        }

        if (!line.empty())
            handler->PSendSysMessage("{}", line);

        return true;
    }
};
}

void Addmod_small_group_tweaksScripts()
{
    new small_group_tweaks_playerscript();
    new small_group_tweaks_commandscript();
}
