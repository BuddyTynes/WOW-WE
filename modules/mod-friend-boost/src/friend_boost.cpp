/*
 * Friend boost GM utilities for small-group catch-up characters.
 */

#include "Chat.h"
#include "CommandScript.h"
#include "DBCEnums.h"
#include "Player.h"
#include "PlayerbotAIConfig.h"
#include "PlayerbotFactory.h"
#include "SharedDefines.h"
#include "World.h"

#include <algorithm>
#include <array>
#include <utility>
#include <vector>

using namespace Acore::ChatCommands;

namespace
{
struct ProfessionPair
{
    uint16 first;
    uint16 second;
};

uint32 GetStarterSpell(uint16 skillId)
{
    static constexpr std::array<std::pair<uint16, uint32>, 14> spells = {{
        {SKILL_ALCHEMY, 2259},
        {SKILL_BLACKSMITHING, 2018},
        {SKILL_COOKING, 2550},
        {SKILL_ENCHANTING, 7411},
        {SKILL_ENGINEERING, 4036},
        {SKILL_FIRST_AID, 3273},
        {SKILL_FISHING, 7620},
        {SKILL_HERBALISM, 2366},
        {SKILL_INSCRIPTION, 45357},
        {SKILL_JEWELCRAFTING, 25229},
        {SKILL_LEATHERWORKING, 2108},
        {SKILL_MINING, 2575},
        {SKILL_SKINNING, 8613},
        {SKILL_TAILORING, 3908}
    }};

    for (auto const& [professionSkill, starterSpell] : spells)
        if (professionSkill == skillId)
            return starterSpell;

    return 0;
}

ProfessionPair GetClassProfessionPair(Player const* player)
{
    switch (player->getClass())
    {
        case CLASS_WARRIOR:
        case CLASS_PALADIN:
        case CLASS_DEATH_KNIGHT:
            return {SKILL_MINING, SKILL_BLACKSMITHING};
        case CLASS_HUNTER:
        case CLASS_ROGUE:
        case CLASS_DRUID:
            return {SKILL_SKINNING, SKILL_LEATHERWORKING};
        case CLASS_SHAMAN:
            return {SKILL_HERBALISM, SKILL_ALCHEMY};
        case CLASS_PRIEST:
        case CLASS_MAGE:
        case CLASS_WARLOCK:
        default:
            return {SKILL_TAILORING, SKILL_ENCHANTING};
    }
}

void LearnProfession(Player* player, uint16 skillId, uint32 level)
{
    if (uint32 starterSpell = GetStarterSpell(skillId); starterSpell && !player->HasSpell(starterSpell))
        player->learnSpell(starterSpell, false);

    uint32 maxValue = std::min<uint32>(level * 5, 450);
    uint16 step = player->GetSkillValue(skillId) ? player->GetSkillStep(skillId) : 1;
    player->SetSkill(skillId, step, maxValue, maxValue);
}

void InitBoostProfessions(Player* player, uint32 level)
{
    std::vector<uint16> skills = {SKILL_FIRST_AID, SKILL_FISHING, SKILL_COOKING};
    ProfessionPair pair = GetClassProfessionPair(player);
    uint32 maxPrimary = std::min<uint32>(2, sWorld->getIntConfig(CONFIG_MAX_PRIMARY_TRADE_SKILL));

    if (maxPrimary >= 1)
        skills.push_back(pair.first);
    if (maxPrimary >= 2)
        skills.push_back(pair.second);

    for (uint16 skillId : skills)
        LearnProfession(player, skillId, level);
}

}

class friend_boost_commandscript : public CommandScript
{
public:
    friend_boost_commandscript() : CommandScript("friend_boost_commandscript") { }

    ChatCommandTable GetCommands() const override
    {
        static ChatCommandTable commandTable =
        {
            { "boost", HandleBoostCommand, SEC_GAMEMASTER, Console::No }
        };

        return commandTable;
    }

    static bool HandleBoostCommand(ChatHandler* handler, Optional<PlayerIdentifier> target, uint8 level)
    {
        if (!target)
            target = PlayerIdentifier::FromTargetOrSelf(handler);

        if (!target || !target->IsConnected())
        {
            handler->PSendSysMessage("Usage: .boost [player] <level>. Target must be online.");
            return false;
        }

        Player* player = target->GetConnectedPlayer();
        if (handler->HasLowerSecurity(player))
            return false;

        uint32 maxLevel = std::min<uint32>(sWorld->getIntConfig(CONFIG_MAX_PLAYER_LEVEL), DEFAULT_MAX_LEVEL);
        if (level < 1 || level > maxLevel)
        {
            handler->PSendSysMessage("Boost level must be between 1 and {}.", maxLevel);
            return false;
        }

        player->CombatStop(true);
        if (player->isDead())
            player->ResurrectPlayer(1.0f, false);

        player->GiveLevel(level);
        player->InitTalentForLevel();
        player->SetUInt32Value(PLAYER_XP, 0);
        player->InitStatsForLevel(true);
        player->LearnDefaultSkills();

        PlayerbotFactory factory(player, level, ITEM_QUALITY_RARE, 0);
        factory.InitSkills();
        InitBoostProfessions(player, level);
        factory.InitClassSpells();
        factory.InitAvailableSpells();
        factory.InitSpecialSpells();
        factory.InitTalentsTree(false, true, true);
        factory.InitMounts();
        factory.InitBags(false);

        float previousGearLoweringChance = sPlayerbotAIConfig.randomGearLoweringChance;
        sPlayerbotAIConfig.randomGearLoweringChance = 0.90f;
        factory.InitEquipment(false, false);
        sPlayerbotAIConfig.randomGearLoweringChance = previousGearLoweringChance;

        factory.InitAmmo();
        factory.InitFood();
        factory.InitPotions();
        factory.InitReagents();
        factory.InitConsumables();
        factory.InitGlyphs();
        factory.InitPet();
        factory.InitPetTalents();
        factory.InitKeyring();
        factory.InitReputation();

        if (player->GetLevel() >= sPlayerbotAIConfig.minEnchantingBotLevel)
            factory.ApplyEnchantAndGemsNew(false);

        uint64 const starterMoney = uint64(level) * 10000;
        if (player->GetMoney() < starterMoney)
            player->SetMoney(starterMoney);

        player->DurabilityRepairAll(false, 1.0f, false);
        player->SetHealth(player->GetMaxHealth());
        player->SetPower(POWER_MANA, player->GetMaxPower(POWER_MANA));
        player->SaveToDB(false, false);

        handler->PSendSysMessage(
            "Boosted {} to level {} with generated catch-up gear, skills, spells, consumables, bags, mounts, and talents.",
            handler->playerLink(*target), level);

        if (handler->needReportToTarget(player))
            ChatHandler(player->GetSession()).PSendSysMessage(
                "{} boosted you to level {} and prepared your gear and supplies.",
                handler->GetNameLink(), level);

        return true;
    }
};

void Addmod_friend_boostScripts()
{
    new friend_boost_commandscript();
}
