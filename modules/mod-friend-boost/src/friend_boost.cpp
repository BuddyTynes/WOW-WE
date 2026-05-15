/*
 * Friend boost GM utilities for small-group catch-up characters.
 */

#include "Chat.h"
#include "CommandScript.h"
#include "Player.h"
#include "PlayerbotAIConfig.h"
#include "PlayerbotFactory.h"
#include "World.h"

#include <algorithm>

using namespace Acore::ChatCommands;

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
