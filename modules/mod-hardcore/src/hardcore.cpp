/*
 * Command-based hardcore mode for small-group runs.
 */

#include "Chat.h"
#include "AccountMgr.h"
#include "CharacterCache.h"
#include "CommandScript.h"
#include "Config.h"
#include "Creature.h"
#include "DBCStores.h"
#include "DatabaseEnv.h"
#include "GameTime.h"
#include "Group.h"
#include "GroupReference.h"
#include "Guild.h"
#include "Log.h"
#include "ObjectAccessor.h"
#include "ObjectGuid.h"
#include "Opcodes.h"
#include "Player.h"
#include "Random.h"
#include "ScriptMgr.h"
#include "SpellAuras.h"
#include "SpellInfo.h"
#include "SpellMgr.h"
#include "Unit.h"
#include "World.h"
#include "WorldPacket.h"
#include "WorldSession.h"
#include "WorldSessionMgr.h"

#ifdef MOD_PLAYERBOTS
#include "Playerbots.h"
#include "RandomPlayerbotFactory.h"
#endif

#include <algorithm>
#include <cctype>
#include <chrono>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

using namespace Acore::ChatCommands;

namespace
{
constexpr uint32 DEFAULT_HARDCORE_AURA_SPELL_ID = 0;
constexpr uint32 LEGACY_UNSAFE_AURA_SPELL_ID = 21090;
constexpr uint32 HARDCORE_AURA_TEST_DURATION_MS = 30 * IN_MILLISECONDS;
constexpr uint32 HARDCORE_PVP_HUNTER_LOCK_MS = 120 * IN_MILLISECONDS;

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
    std::string createdAt;
    std::string deadAt;
    std::string evaluatedAt;
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

char const* GetSpellName(SpellInfo const* spellInfo)
{
    if (!spellInfo)
        return "<missing>";

    char const* name = spellInfo->SpellName[DEFAULT_LOCALE];
    return name && *name ? name : "<unnamed>";
}

char const* GetAuraTypeName(AuraType aura)
{
    switch (aura)
    {
        case SPELL_AURA_NONE:
            return "none";
        case SPELL_AURA_DUMMY:
            return "dummy";
        case SPELL_AURA_MOD_SCALE:
            return "scale";
        case SPELL_AURA_MOD_SCALE_2:
            return "scale_2";
        case SPELL_AURA_TRANSFORM:
            return "transform";
        case SPELL_AURA_MOD_SHAPESHIFT:
            return "shapeshift";
        case SPELL_AURA_MOUNTED:
            return "mounted";
        case SPELL_AURA_MOD_STAT:
            return "stat";
        case SPELL_AURA_MOD_PERCENT_STAT:
            return "percent_stat";
        case SPELL_AURA_MOD_TOTAL_STAT_PERCENTAGE:
            return "total_stat_pct";
        case SPELL_AURA_MOD_INCREASE_SPEED:
            return "speed";
        case SPELL_AURA_MOD_SPEED_ALWAYS:
            return "speed_always";
        case SPELL_AURA_MOD_SPEED_NOT_STACK:
            return "speed_not_stack";
        case SPELL_AURA_MOD_DAMAGE_DONE:
            return "damage_done";
        case SPELL_AURA_MOD_DAMAGE_PERCENT_DONE:
            return "damage_pct_done";
        case SPELL_AURA_PERIODIC_DAMAGE:
            return "periodic_damage";
        case SPELL_AURA_PERIODIC_DAMAGE_PERCENT:
            return "periodic_damage_pct";
        case SPELL_AURA_PERIODIC_HEAL:
            return "periodic_heal";
        case SPELL_AURA_MOD_HEALING:
            return "healing";
        case SPELL_AURA_MOD_HEALING_PCT:
            return "healing_pct";
        case SPELL_AURA_MOD_STEALTH:
            return "stealth";
        case SPELL_AURA_MOD_INVISIBILITY:
            return "invisibility";
        case SPELL_AURA_MOD_FACTION:
            return "faction";
        case SPELL_AURA_MOD_FACTION_REPUTATION_GAIN:
            return "faction_reputation";
        default:
            return "other";
    }
}

bool IsBlockedIndicatorAura(AuraType aura)
{
    switch (aura)
    {
        case SPELL_AURA_MOD_SCALE:
        case SPELL_AURA_MOD_SCALE_2:
        case SPELL_AURA_TRANSFORM:
        case SPELL_AURA_MOD_SHAPESHIFT:
        case SPELL_AURA_MOUNTED:
            return true;
        default:
            return false;
    }
}

bool IsRiskyIndicatorAura(AuraType aura)
{
    switch (aura)
    {
        case SPELL_AURA_MOD_STAT:
        case SPELL_AURA_MOD_PERCENT_STAT:
        case SPELL_AURA_MOD_TOTAL_STAT_PERCENTAGE:
        case SPELL_AURA_MOD_INCREASE_SPEED:
        case SPELL_AURA_MOD_SPEED_ALWAYS:
        case SPELL_AURA_MOD_SPEED_NOT_STACK:
        case SPELL_AURA_MOD_DAMAGE_DONE:
        case SPELL_AURA_MOD_DAMAGE_PERCENT_DONE:
        case SPELL_AURA_PERIODIC_DAMAGE:
        case SPELL_AURA_PERIODIC_DAMAGE_PERCENT:
        case SPELL_AURA_PERIODIC_HEAL:
        case SPELL_AURA_MOD_HEALING:
        case SPELL_AURA_MOD_HEALING_PCT:
        case SPELL_AURA_MOD_STEALTH:
        case SPELL_AURA_MOD_INVISIBILITY:
        case SPELL_AURA_MOD_FACTION:
        case SPELL_AURA_MOD_FACTION_REPUTATION_GAIN:
            return true;
        default:
            return IsBlockedIndicatorAura(aura);
    }
}

bool HasBlockedIndicatorAura(SpellInfo const* spellInfo)
{
    if (!spellInfo)
        return false;

    for (SpellEffectInfo const& effect : spellInfo->GetEffects())
        if (IsBlockedIndicatorAura(effect.ApplyAuraName))
            return true;

    return false;
}

std::vector<std::string> GetIndicatorAuraWarnings(SpellInfo const* spellInfo)
{
    std::vector<std::string> warnings;
    if (!spellInfo)
    {
        warnings.push_back("spell does not exist");
        return warnings;
    }

    for (SpellEffectInfo const& effect : spellInfo->GetEffects())
    {
        if (!effect.IsEffect())
            continue;

        if (!effect.IsAura())
        {
            warnings.push_back(Acore::StringFormat("effect{} is non-aura {}",
                uint32(effect.EffectIndex), effect.Effect));
            continue;
        }

        if (IsRiskyIndicatorAura(effect.ApplyAuraName))
            warnings.push_back(Acore::StringFormat("effect{} aura {} ({})",
                uint32(effect.EffectIndex), uint32(effect.ApplyAuraName),
                GetAuraTypeName(effect.ApplyAuraName)));
    }

    return warnings;
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
        uint32 oldAuraSpellId = auraSpellId;
        enabled = sConfigMgr->GetOption<bool>("Hardcore.Enable", true);
        auraSpellId = sConfigMgr->GetOption<uint32>("Hardcore.AuraSpellId",
            DEFAULT_HARDCORE_AURA_SPELL_ID);
        randomBotEnable = sConfigMgr->GetOption<bool>("Hardcore.RandomBotEnable", true);
        randomBotChance = std::clamp<uint32>(
            sConfigMgr->GetOption<uint32>("Hardcore.RandomBotChance", 100), 0, 100);
        randomBotConvertFailedRolls =
            sConfigMgr->GetOption<bool>("Hardcore.RandomBotConvertFailedRolls", true);
        botCommandSecurity = std::clamp<uint32>(
            sConfigMgr->GetOption<uint32>("Hardcore.BotCommandSecurity", 1),
            uint32(SEC_PLAYER), uint32(SEC_ADMINISTRATOR));
        nameTagEnable = sConfigMgr->GetOption<bool>("Hardcore.NameTag.Enable", true);
        nameTag = sConfigMgr->GetOption<std::string>("Hardcore.NameTag", "<HC>");
        deathAnnouncementEnable =
            sConfigMgr->GetOption<bool>("Hardcore.DeathAnnouncement.Enable", true);
        botDeathLogoutDelayMs =
            sConfigMgr->GetOption<uint32>("Hardcore.BotDeathLogoutDelay", 60) * IN_MILLISECONDS;

        ValidateConfiguredAura();
        if (oldAuraSpellId && oldAuraSpellId != auraSpellId)
            RemoveAuraFromOnlinePlayers(oldAuraSpellId);
    }

    bool IsEnabled() const { return enabled; }
    uint32 GetBotCommandSecurity() const { return botCommandSecurity; }
    uint32 GetAuraSpellId() const { return auraSpellId; }

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
            "SELECT `enabled`, `dead`, `source`, `created_at`, `dead_at`, "
            "`evaluated_at` "
            "FROM `mod_hardcore_characters` WHERE `guid` = {}",
            guid);

        if (result)
        {
            Field* fields = result->Fetch();
            state.exists = true;
            state.enabled = fields[0].Get<uint8>() != 0;
            state.dead = fields[1].Get<uint8>() != 0;
            state.source = fields[2].Get<std::string>();
            state.createdAt = fields[3].IsNull() ? "" : fields[3].Get<std::string>();
            state.deadAt = fields[4].IsNull() ? "" : fields[4].Get<std::string>();
            state.evaluatedAt = fields[5].IsNull() ? "" : fields[5].Get<std::string>();
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
        state.createdAt.clear();
        state.deadAt.clear();
        state.evaluatedAt.clear();
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
        state.createdAt.clear();
        state.deadAt.clear();
        state.evaluatedAt.clear();
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
        state.deadAt.clear();
        states[guid] = state;
        ApplyAuraState(player);
        std::string cause = TakePendingDeathCause(guid);
        AnnounceDeath(player, cause);

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
        {
            if (randomBotConvertFailedRolls && !state.enabled &&
                state.source == ToDbSource(HardcoreSource::RandomBotRollFailed))
                EnableHardcore(player, HardcoreSource::RandomBot);
            return;
        }

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
        if (!player)
            return;

        if (player->HasAura(LEGACY_UNSAFE_AURA_SPELL_ID))
            player->RemoveAura(LEGACY_UNSAFE_AURA_SPELL_ID);

        if (!auraSpellId)
            return;

        bool shouldHaveAura = false;
        SpellInfo const* auraSpell = sSpellMgr->GetSpellInfo(auraSpellId);
        if (enabled && auraSpell && !HasBlockedIndicatorAura(auraSpell))
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

    void RefreshAurasForOnlinePlayers()
    {
        for (auto const& pair : ObjectAccessor::GetPlayers())
        {
            Player* player = pair.second;
            if (player)
                ApplyAuraState(player);
        }
    }

    void SendAuraStatus(ChatHandler* handler)
    {
        if (!handler)
            return;

        SpellInfo const* spellInfo = sSpellMgr->GetSpellInfo(auraSpellId);
        if (!auraSpellId)
        {
            handler->PSendSysMessage("Hardcore aura spell is disabled.");
            return;
        }

        handler->PSendSysMessage("Hardcore aura spell: {} ({})",
            auraSpellId, GetSpellName(spellInfo));

        std::vector<std::string> warnings = GetIndicatorAuraWarnings(spellInfo);
        if (warnings.empty())
        {
            handler->PSendSysMessage(
                "No obvious server-side indicator risks were detected.");
            return;
        }

        for (std::string const& warning : warnings)
            handler->PSendSysMessage("Aura warning: {}", warning);

        if (spellInfo && HasBlockedIndicatorAura(spellInfo))
            handler->PSendSysMessage(
                "This aura is blocked for permanent hardcore use.");
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

    void NormalizeTargetName(std::string& name)
    {
        if (!enabled || nameTag.empty() || name.empty())
            return;

        std::string suffix = " " + nameTag;
        if (name.size() >= suffix.size() &&
            name.compare(name.size() - suffix.size(), suffix.size(), suffix) == 0)
            name.erase(name.size() - suffix.size());
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
        AnnounceDeath(player, "");
    }

    void AnnounceDeath(Player* player, std::string const& cause)
    {
        if (!deathAnnouncementEnable || !player)
            return;

        std::string faction = player->GetTeamId() == TEAM_ALLIANCE ? "Alliance" :
            player->GetTeamId() == TEAM_HORDE ? "Horde" : "Neutral";
        std::string guild = "guildless";
        if (Guild* playerGuild = player->GetGuild())
            guild = Acore::StringFormat("guild {}", playerGuild->GetName());

        std::string message;
        if (cause.empty())
            message = Acore::StringFormat("<HC> {} ({}, {}) died at level {} in {}.",
                player->GetName(), faction, guild, player->GetLevel(),
                GetLocationName(player));
        else
            message = Acore::StringFormat("<HC> {} ({}, {}) died at level {} in {}, {}.",
                player->GetName(), faction, guild, player->GetLevel(),
                GetLocationName(player), cause);

        sWorldSessionMgr->SendServerMessage(SERVER_MSG_STRING, message);

        WorldPacket notification(SMSG_NOTIFICATION, message.size() + 1);
        notification << message;
        sWorldSessionMgr->SendGlobalMessage(&notification);
    }

    void RecordPendingDeathCause(Player* player, std::string cause)
    {
        if (!enabled || !player || cause.empty())
            return;

        pendingDeathCauses[player->GetGUID().GetCounter()] = std::move(cause);
    }

    std::string TakePendingDeathCause(ObjectGuid::LowType guid)
    {
        auto itr = pendingDeathCauses.find(guid);
        if (itr == pendingDeathCauses.end())
            return "";

        std::string cause = std::move(itr->second);
        pendingDeathCauses.erase(itr);
        return cause;
    }

    std::string EnvironmentalCause(uint8 type) const
    {
        switch (type)
        {
            case DAMAGE_EXHAUSTED:
                return "died of fatigue";
            case DAMAGE_DROWNING:
                return "drowned";
            case DAMAGE_FALL:
                return "fell to their death";
            case DAMAGE_LAVA:
                return "burned in lava";
            case DAMAGE_SLIME:
                return "died in slime";
            case DAMAGE_FIRE:
                return "burned to death";
            case DAMAGE_FALL_TO_VOID:
                return "fell into the void";
            default:
                return "died to environmental damage";
        }
    }

    uint32 EnableAllOnlineRandomBots()
    {
        uint32 enabledCount = 0;
#ifdef MOD_PLAYERBOTS
        for (auto const& [guid, player] : ObjectAccessor::GetPlayers())
        {
            if (!player || !player->IsAlive() || !sRandomPlayerbotMgr.IsRandomBot(player))
                continue;

            if (EnableHardcore(player, HardcoreSource::RandomBot))
                ++enabledCount;
        }
#endif
        return enabledCount;
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

    bool IsHardcoreAlive(Player const* player)
    {
        if (!enabled || !player)
            return false;

        HardcoreState state = GetState(player->GetGUID().GetCounter());
        return state.enabled && !state.dead;
    }

    ObjectGuid::LowType GetProtectedHardcoreGroupKey(Player* victim)
    {
        if (!victim)
            return 0;

        Group* group = victim->GetGroup();
        if (!group)
            return IsHardcoreAlive(victim) ? victim->GetGUID().GetCounter() : 0;

        for (GroupReference const* ref = group->GetFirstMember(); ref;
             ref = ref->next())
        {
            Player* member = ref->GetSource();
            if (member && IsHardcoreAlive(member))
                return group->GetGUID().GetCounter();
        }

        return 0;
    }

    bool AllowRandomBotPvpDamage(Player* attacker, Player* victim)
    {
        if (!enabled || !attacker || !victim)
            return true;

#ifdef MOD_PLAYERBOTS
        if (!sRandomPlayerbotMgr.IsRandomBot(attacker))
            return true;
#else
        return true;
#endif

        ObjectGuid::LowType groupKey = GetProtectedHardcoreGroupKey(victim);
        if (!groupKey)
            return true;

        uint32 now = GameTime::GetGameTimeMS().count();
        for (auto itr = pvpHunterLocks.begin(); itr != pvpHunterLocks.end();)
        {
            if (itr->second.expiresAtMs <= now)
                itr = pvpHunterLocks.erase(itr);
            else
                ++itr;
        }

        ObjectGuid::LowType attackerGuid = attacker->GetGUID().GetCounter();
        PvpHunterLock& lock = pvpHunterLocks[groupKey];
        if (!lock.attackerGuid || lock.attackerGuid == attackerGuid)
        {
            lock.attackerGuid = attackerGuid;
            lock.expiresAtMs = now + HARDCORE_PVP_HUNTER_LOCK_MS;
            return true;
        }

        attacker->AttackStop();
        attacker->CombatStop(true);

        LOG_DEBUG("module.hardcore",
            "Prevented extra random bot '{}' from hunting protected HC group {}.",
            attacker->GetName(), groupKey);
        return false;
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

            DeleteDeadRandomBot(bot);
        }
#endif
    }

    void DeleteHardcoreRow(ObjectGuid::LowType guid)
    {
        CharacterDatabase.Execute(
            "DELETE FROM `mod_hardcore_characters` WHERE `guid` = {}", guid);
        states.erase(guid);
        auraTimers.erase(guid);
        botLogoutTimers.erase(guid);
        pendingDeathCauses.erase(guid);
    }

#ifdef MOD_PLAYERBOTS
    bool CreateSingleReplacementRandomBot(uint32 accountId)
    {
        if (!accountId)
            return false;

        while (CharacterDatabase.QueueSize())
            std::this_thread::sleep_for(std::chrono::milliseconds(100));

        if (AccountMgr::GetCharactersCount(accountId) >= 10)
        {
            LOG_WARN("module.hardcore",
                "Cannot create one replacement random bot for account {}: "
                "account still has 10 characters.",
                accountId);
            return false;
        }

        std::vector<uint8> classes;
        for (uint8 cls = CLASS_WARRIOR; cls < MAX_CLASSES; ++cls)
        {
            if (!((1 << (cls - 1)) & CLASSMASK_ALL_PLAYABLE) ||
                !sChrClassesStore.LookupEntry(cls))
                continue;

            if ((1 << (cls - 1)) &
                sWorld->getIntConfig(CONFIG_CHARACTER_CREATING_DISABLED_CLASSMASK))
                continue;

            if (cls == CLASS_DEATH_KNIGHT)
                continue;

            classes.push_back(cls);
        }

        if (classes.empty())
        {
            LOG_ERROR("module.hardcore",
                "Cannot create one replacement random bot: no playable classes are available.");
            return false;
        }

        std::unordered_map<RandomPlayerbotFactory::NameRaceAndGender,
            std::vector<std::string>> nameCache;
        RandomPlayerbotFactory factory;
        WorldSession* session = new WorldSession(accountId, "", 0x0, nullptr,
            SEC_PLAYER, EXPANSION_WRATH_OF_THE_LICH_KING, time_t(0), LOCALE_enUS,
            0, false, false, 0, true);

        Player* replacement = nullptr;
        for (uint8 attempt = 0; attempt < classes.size() && !replacement; ++attempt)
        {
            uint32 index = urand(0, classes.size() - 1);
            uint8 cls = classes[index];
            classes.erase(classes.begin() + index);
            replacement = factory.CreateRandomBot(session, cls, nameCache);
        }

        if (!replacement)
        {
            delete session;
            LOG_ERROR("module.hardcore",
                "Failed to create one replacement random bot for account {}.",
                accountId);
            return false;
        }

        ObjectGuid guid = replacement->GetGUID();
        std::string name = replacement->GetName();
        replacement->SaveToDB(true, false);
        sCharacterCache->AddCharacterCacheEntry(guid, accountId, name,
            replacement->getGender(), replacement->getRace(),
            replacement->getClass(), replacement->GetLevel());
        replacement->CleanupsBeforeDelete();
        delete replacement;
        delete session;

        while (CharacterDatabase.QueueSize())
            std::this_thread::sleep_for(std::chrono::milliseconds(100));

        LOG_INFO("module.hardcore",
            "Created one replacement random bot '{}' ({}) for account {}.",
            name, guid.GetCounter(), accountId);
        return true;
    }

    void DeleteDeadRandomBot(Player* bot)
    {
        if (!bot)
            return;

        ObjectGuid guid = bot->GetGUID();
        ObjectGuid::LowType lowGuid = guid.GetCounter();
        uint32 accountId = bot->GetSession()
            ? bot->GetSession()->GetAccountId()
            : sCharacterCache->GetCharacterAccountIdByGuid(guid);
        std::string name = bot->GetName();

        LOG_INFO("module.hardcore",
            "Deleting dead hardcore random bot '{}' ({}) after logout delay; "
            "creating one same-account replacement only.",
            name, lowGuid);

        sRandomPlayerbotMgr.OnPlayerLoginError(lowGuid);
        sRandomPlayerbotMgr.Remove(bot);
        DeleteHardcoreRow(lowGuid);
        Player::DeleteFromDB(lowGuid, accountId, true, true);

        if (!CreateSingleReplacementRandomBot(accountId))
            LOG_WARN("module.hardcore",
                "Deleted dead hardcore random bot '{}' but did not create a replacement.",
                name);
    }
#endif

    void OnLogout(Player const* player)
    {
        if (!player)
            return;

        ObjectGuid::LowType guid = player->GetGUID().GetCounter();
        auraTimers.erase(guid);
        botLogoutTimers.erase(guid);
        pendingDeathCauses.erase(guid);
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
    void ValidateConfiguredAura()
    {
        if (!auraSpellId)
            return;

        SpellInfo const* spellInfo = sSpellMgr->GetSpellInfo(auraSpellId);
        std::vector<std::string> warnings = GetIndicatorAuraWarnings(spellInfo);

        if (warnings.empty())
            return;

        for (std::string const& warning : warnings)
            LOG_WARN("module.hardcore",
                "Hardcore.AuraSpellId {} ({}) warning: {}",
                auraSpellId, GetSpellName(spellInfo), warning);

        if (spellInfo && HasBlockedIndicatorAura(spellInfo))
            LOG_WARN("module.hardcore",
                "Hardcore.AuraSpellId {} is blocked for permanent use. "
                "Use .hardcore aura test <spellId> to find a safer marker.",
                auraSpellId);
    }

    void RemoveAuraFromOnlinePlayers(uint32 spellId)
    {
        for (auto const& pair : ObjectAccessor::GetPlayers())
        {
            Player* player = pair.second;
            if (player && player->HasAura(spellId))
                player->RemoveAura(spellId);
        }
    }

    bool enabled = true;
    uint32 auraSpellId = DEFAULT_HARDCORE_AURA_SPELL_ID;
    bool randomBotEnable = true;
    uint32 randomBotChance = 25;
    bool randomBotConvertFailedRolls = false;
    uint32 botCommandSecurity = SEC_MODERATOR;
    bool nameTagEnable = false;
    std::string nameTag = "<HC>";
    bool deathAnnouncementEnable = true;
    uint32 botDeathLogoutDelayMs = 60000;
    struct PvpHunterLock
    {
        ObjectGuid::LowType attackerGuid = 0;
        uint32 expiresAtMs = 0;
    };
    std::unordered_map<ObjectGuid::LowType, HardcoreState> states;
    std::unordered_map<ObjectGuid::LowType, uint32> auraTimers;
    std::unordered_map<ObjectGuid::LowType, uint32> botLogoutTimers;
    std::unordered_map<ObjectGuid::LowType, std::string> pendingDeathCauses;
    std::unordered_map<ObjectGuid::LowType, PvpHunterLock> pvpHunterLocks;
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

bool CanUseAuraDiagnostics(ChatHandler* handler)
{
    if (!handler)
        return false;

    WorldSession* session = handler->GetSession();
    if (session && session->GetSecurity() >= sHardcore.GetBotCommandSecurity())
        return true;

    handler->PSendSysMessage(
        "You do not have permission to use hardcore aura diagnostics.");
    return false;
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

    void OnPlayerEnvironmentalDamage(Player* player, uint8 type, uint32 damage) override
    {
        if (!player || damage < player->GetHealth())
            return;

        sHardcore.RecordPendingDeathCause(player, sHardcore.EnvironmentalCause(type));
    }

    void OnPlayerCustomizeNameQuery(ObjectGuid guid, std::string& name) override
    {
        sHardcore.CustomizeNameTag(guid, name);
    }

    void OnPlayerNormalizeTargetName(std::string& name) override
    {
        sHardcore.NormalizeTargetName(name);
    }
};

class hardcore_unitscript : public UnitScript
{
public:
    hardcore_unitscript() : UnitScript("hardcore_unitscript") { }

    void OnDamage(Unit* attacker, Unit* victim, uint32& damage) override
    {
        if (!attacker || !victim || attacker == victim)
            return;

        Player* player = victim->ToPlayer();
        if (!player)
            return;

        if (Player* killerPlayer = attacker->GetCharmerOrOwnerPlayerOrPlayerItself())
        {
            if (killerPlayer != player &&
                !sHardcore.AllowRandomBotPvpDamage(killerPlayer, player))
            {
                damage = 0;
                return;
            }

            if (damage < victim->GetHealth())
                return;

            if (killerPlayer != player)
                sHardcore.RecordPendingDeathCause(player,
                    Acore::StringFormat("killed by {}", killerPlayer->GetName()));
            return;
        }

        if (damage < victim->GetHealth())
            return;

        if (Creature* creature = attacker->ToCreature())
            sHardcore.RecordPendingDeathCause(player,
                Acore::StringFormat("killed by {}", creature->GetName()));
    }
};

class hardcore_commandscript : public CommandScript
{
public:
    hardcore_commandscript() : CommandScript("hardcore_commandscript") { }

    ChatCommandTable GetCommands() const override
    {
        static ChatCommandTable hardcoreAuraCommandTable =
        {
            { "refresh", HandleAuraRefreshCommand, SEC_PLAYER, Console::No },
            { "status", HandleAuraStatusCommand, SEC_PLAYER, Console::No },
            { "test", HandleAuraTestCommand, SEC_PLAYER, Console::No },
            { "", HandleAuraStatusCommand, SEC_PLAYER, Console::No }
        };

        static ChatCommandTable hardcoreBotsCommandTable =
        {
            { "enableall", HandleBotsEnableAllCommand, SEC_PLAYER, Console::No }
        };

        static ChatCommandTable hardcoreCommandTable =
        {
            { "enable", HandleEnableCommand, SEC_PLAYER, Console::No },
            { "status", HandleStatusCommand, SEC_PLAYER, Console::No },
            { "lookup", HandleLookupCommand, SEC_PLAYER, Console::No },
            { "aura", hardcoreAuraCommandTable },
            { "bot", HandleBotCommand, SEC_PLAYER, Console::No },
            { "bots", hardcoreBotsCommandTable },
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

    static bool HandleLookupCommand(ChatHandler* handler, PlayerIdentifier target)
    {
        HardcoreState state = sHardcore.GetState(target.GetGUID().GetCounter());

        if (!state.exists || !state.enabled)
        {
            handler->PSendSysMessage("{} is not hardcore.", target.GetName());
            return true;
        }

        handler->PSendSysMessage("{} is hardcore and {}. Source: {}.",
            target.GetName(), state.dead ? "dead" : "alive", state.source);

        if (!state.createdAt.empty())
            handler->PSendSysMessage("Created: {}", state.createdAt);
        if (!state.evaluatedAt.empty())
            handler->PSendSysMessage("Evaluated: {}", state.evaluatedAt);
        if (!state.deadAt.empty())
            handler->PSendSysMessage("Died: {}", state.deadAt);

        return true;
    }

    static bool HandleAuraStatusCommand(ChatHandler* handler)
    {
        if (!CanUseAuraDiagnostics(handler))
            return true;

        sHardcore.SendAuraStatus(handler);
        return true;
    }

    static bool HandleAuraRefreshCommand(ChatHandler* handler)
    {
        if (!CanUseAuraDiagnostics(handler))
            return true;

        sHardcore.RefreshAurasForOnlinePlayers();
        handler->PSendSysMessage("Refreshed hardcore auras for online players.");
        return true;
    }

    static bool HandleAuraTestCommand(ChatHandler* handler, uint32 spellId)
    {
        if (!CanUseAuraDiagnostics(handler))
            return true;

        SpellInfo const* spellInfo = sSpellMgr->GetSpellInfo(spellId);
        if (!spellInfo)
        {
            handler->PSendSysMessage("Spell {} does not exist.", spellId);
            return true;
        }

        if (!SpellMgr::IsSpellValid(spellInfo))
        {
            handler->PSendSysMessage("Spell {} ({}) is broken.",
                spellId, GetSpellName(spellInfo));
            return true;
        }

        Unit* target = handler->getSelectedUnit();
        if (!target)
            target = handler->GetPlayer();

        if (!target)
        {
            handler->PSendSysMessage("Select a unit or run this in game.");
            return true;
        }

        if (Aura* aura = target->AddAura(spellId, target))
        {
            aura->SetMaxDuration(HARDCORE_AURA_TEST_DURATION_MS);
            aura->SetDuration(HARDCORE_AURA_TEST_DURATION_MS);
            handler->PSendSysMessage(
                "Applied {} ({}) to {} for 30 seconds.",
                spellId, GetSpellName(spellInfo), target->GetName());
        }
        else
        {
            handler->PSendSysMessage("Could not apply {} ({}) to {}.",
                spellId, GetSpellName(spellInfo), target->GetName());
        }

        std::vector<std::string> warnings = GetIndicatorAuraWarnings(spellInfo);
        for (std::string const& warning : warnings)
            handler->PSendSysMessage("Aura warning: {}", warning);

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

    static bool HandleBotsEnableAllCommand(ChatHandler* handler, Tail args)
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
                "Usage: .hardcore bots enableall confirm");
            return true;
        }

#ifdef MOD_PLAYERBOTS
        uint32 count = sHardcore.EnableAllOnlineRandomBots();
        handler->PSendSysMessage("Marked {} online random bots as hardcore.",
            count);
#else
        handler->PSendSysMessage("Playerbots are not available in this build.");
#endif

        return true;
    }
};
}

void Addmod_hardcoreScripts()
{
    new hardcore_worldscript();
    new hardcore_playerscript();
    new hardcore_unitscript();
    new hardcore_commandscript();
}
