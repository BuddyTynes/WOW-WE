/*
 * Small-group realm quality-of-life helpers.
 */

#include "Chat.h"
#include "CommandScript.h"
#include "Config.h"
#include "DBCStores.h"
#include "Guild.h"
#include "GuildMgr.h"
#include "Log.h"
#include "ObjectAccessor.h"
#include "Player.h"
#include "ScriptMgr.h"
#include "SharedDefines.h"
#include "World.h"
#include "WorldSession.h"

#include <boost/asio/ip/tcp.hpp>

#ifdef MOD_PLAYERBOTS
#include "Playerbots.h"
#endif

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <iterator>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

using namespace Acore::ChatCommands;

namespace
{
constexpr uint32 MaxPrimaryProfessions = 11;

struct BotGuildInviteConfig
{
    bool enabled = true;
    std::string decisionUrl = "http://wow-llm-bridge:11434/api/bot-guild-invite/decision";
    uint32 timeoutMs = 3000;
    uint32 decisionCacheSeconds = 3600;
    std::string fallbackMode = "decline";
    uint32 defaultLikeability = 50;
};

struct BridgeUrl
{
    std::string host;
    std::string port = "80";
    std::string target = "/";
};

struct BotGuildInviteDecision
{
    bool accept = false;
    std::string say;
};

BotGuildInviteConfig g_botGuildInviteConfig;

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

bool IsRealPlayer(Player* player)
{
    if (!player)
        return false;

#ifdef MOD_PLAYERBOTS
    PlayerbotAI* botAI = GET_PLAYERBOT_AI(player);
    return !botAI || botAI->IsRealPlayer();
#else
    return true;
#endif
}

std::string JsonEscape(std::string_view value)
{
    std::string out;
    out.reserve(value.size() + 8);
    for (char c : value)
    {
        switch (c)
        {
            case '\\':
                out += "\\\\";
                break;
            case '"':
                out += "\\\"";
                break;
            case '\n':
                out += "\\n";
                break;
            case '\r':
                out += "\\r";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                out += c;
                break;
        }
    }
    return out;
}

BridgeUrl ParseBridgeUrl(std::string const& rawUrl)
{
    std::string url = rawUrl;
    std::string const prefix = "http://";
    if (url.rfind(prefix, 0) != 0)
        throw std::runtime_error("Only http bridge URLs are supported");

    url.erase(0, prefix.size());
    std::size_t slash = url.find('/');
    std::string hostPort = slash == std::string::npos ? url : url.substr(0, slash);
    BridgeUrl parsed;
    parsed.target = slash == std::string::npos ? "/" : url.substr(slash);

    std::size_t colon = hostPort.rfind(':');
    if (colon != std::string::npos)
    {
        parsed.host = hostPort.substr(0, colon);
        parsed.port = hostPort.substr(colon + 1);
    }
    else
        parsed.host = hostPort;

    if (parsed.host.empty())
        throw std::runtime_error("Bridge URL host is empty");

    return parsed;
}

std::optional<std::string> ExtractJsonStringField(std::string_view json,
    std::string_view key)
{
    std::string pattern = "\"" + std::string(key) + "\"";
    std::size_t pos = json.find(pattern);
    if (pos == std::string_view::npos)
        return std::nullopt;

    pos = json.find(':', pos + pattern.size());
    if (pos == std::string_view::npos)
        return std::nullopt;

    pos = json.find('"', pos + 1);
    if (pos == std::string_view::npos)
        return std::nullopt;

    ++pos;
    std::string out;
    while (pos < json.size())
    {
        char c = json[pos++];
        if (c == '"')
            return out;

        if (c == '\\' && pos < json.size())
        {
            char escaped = json[pos++];
            switch (escaped)
            {
                case 'n':
                    out += '\n';
                    break;
                case 'r':
                    out += '\r';
                    break;
                case 't':
                    out += '\t';
                    break;
                default:
                    out += escaped;
                    break;
            }
        }
        else
            out += c;
    }

    return std::nullopt;
}

uint32 OnlineRealPlayerCount(Guild* guild)
{
    if (!guild)
        return 0;

    uint32 count = 0;
    for (auto const& [guid, player] : ObjectAccessor::GetPlayers())
        if (player && player->GetGuildId() == guild->GetId() && IsRealPlayer(player))
            ++count;

    return count;
}

std::string ClassName(Player const* player)
{
    if (ChrClassesEntry const* classEntry = sChrClassesStore.LookupEntry(player->getClass()))
        return classEntry->name[sWorld->GetDefaultDbcLocale()];

    return "Unknown";
}

std::string RaceName(Player const* player)
{
    if (ChrRacesEntry const* raceEntry = sChrRacesStore.LookupEntry(player->getRace()))
        return raceEntry->name[sWorld->GetDefaultDbcLocale()];

    return "Unknown";
}

std::string BuildBotGuildInviteRequest(Player* inviter, Player* bot,
    Guild* targetGuild, BotGuildInviteConfig const& config)
{
    Guild* currentGuild = bot->GetGuildId()
        ? sGuildMgr->GetGuildById(bot->GetGuildId()) : nullptr;

    std::ostringstream json;
    json
        << "{"
        << "\"cache_ttl_seconds\":" << config.decisionCacheSeconds << ","
        << "\"default_likeability\":" << config.defaultLikeability << ","
        << "\"bot\":{"
        << "\"guid\":" << bot->GetGUID().GetCounter() << ","
        << "\"name\":\"" << JsonEscape(bot->GetName()) << "\","
        << "\"race\":\"" << JsonEscape(RaceName(bot)) << "\","
        << "\"class\":\"" << JsonEscape(ClassName(bot)) << "\","
        << "\"level\":" << uint32(bot->GetLevel()) << ","
        << "\"current_guild_id\":" << bot->GetGuildId() << ","
        << "\"current_guild_name\":\"" << JsonEscape(currentGuild ? currentGuild->GetName() : "") << "\""
        << "},"
        << "\"inviter\":{"
        << "\"guid\":" << inviter->GetGUID().GetCounter() << ","
        << "\"account_id\":" << (inviter->GetSession() ? inviter->GetSession()->GetAccountId() : 0) << ","
        << "\"name\":\"" << JsonEscape(inviter->GetName()) << "\","
        << "\"race\":\"" << JsonEscape(RaceName(inviter)) << "\","
        << "\"class\":\"" << JsonEscape(ClassName(inviter)) << "\","
        << "\"level\":" << uint32(inviter->GetLevel())
        << "},"
        << "\"guild\":{"
        << "\"id\":" << targetGuild->GetId() << ","
        << "\"name\":\"" << JsonEscape(targetGuild->GetName()) << "\","
        << "\"online_real_players\":" << OnlineRealPlayerCount(targetGuild) << ","
        << "\"member_count\":" << targetGuild->GetMemberCount()
        << "}"
        << "}";

    return json.str();
}

BotGuildInviteDecision RequestBotGuildInviteDecision(Player* inviter,
    Player* bot, Guild* targetGuild, BotGuildInviteConfig const& config)
{
    BotGuildInviteDecision decision;
    if (config.fallbackMode == "accept")
        decision.accept = true;

    try
    {
        BridgeUrl url = ParseBridgeUrl(config.decisionUrl);
        std::string body = BuildBotGuildInviteRequest(inviter, bot, targetGuild, config);

        boost::asio::ip::tcp::iostream stream;
        stream.expires_after(std::chrono::milliseconds(config.timeoutMs));
        stream.connect(url.host, url.port);
        if (!stream)
            throw std::runtime_error(stream.error().message());

        stream
            << "POST " << url.target << " HTTP/1.1\r\n"
            << "Host: " << url.host << "\r\n"
            << "User-Agent: mod-small-group-tweaks\r\n"
            << "Content-Type: application/json\r\n"
            << "Content-Length: " << body.size() << "\r\n"
            << "Connection: close\r\n\r\n"
            << body;
        stream.flush();

        std::string httpVersion;
        unsigned int status = 0;
        stream >> httpVersion >> status;
        if (status < 200 || status >= 300)
            throw std::runtime_error(Acore::StringFormat("bridge HTTP {}", status));

        std::string headerLine;
        std::getline(stream, headerLine);
        while (std::getline(stream, headerLine) && headerLine != "\r")
        {
        }

        std::string responseBody((std::istreambuf_iterator<char>(stream)),
            std::istreambuf_iterator<char>());
        std::string value = ExtractJsonStringField(responseBody, "decision").value_or("");
        std::transform(value.begin(), value.end(), value.begin(),
            [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        decision.accept = value == "accept";
        decision.say = ExtractJsonStringField(responseBody, "say").value_or("");
    }
    catch (std::exception const& ex)
    {
        LOG_WARN("module.small-group-tweaks",
            "Bot guild invite bridge decision failed for bot '{}' and inviter '{}': {}",
            bot ? bot->GetName() : "unknown", inviter ? inviter->GetName() : "unknown",
            ex.what());
    }

    return decision;
}

class small_group_tweaks_worldscript : public WorldScript
{
public:
    small_group_tweaks_worldscript()
        : WorldScript("small_group_tweaks_worldscript")
    {
    }

    void OnAfterConfigLoad(bool /*reload*/) override
    {
        BotGuildInviteConfig config;
        config.enabled = sConfigMgr->GetOption<bool>(
            "SmallGroup.BotGuildInvite.Enable", true);
        config.decisionUrl = sConfigMgr->GetOption<std::string>(
            "SmallGroup.BotGuildInvite.DecisionUrl",
            "http://wow-llm-bridge:11434/api/bot-guild-invite/decision");
        config.timeoutMs = sConfigMgr->GetOption<uint32>(
            "SmallGroup.BotGuildInvite.TimeoutMs", 3000);
        config.decisionCacheSeconds = sConfigMgr->GetOption<uint32>(
            "SmallGroup.BotGuildInvite.DecisionCacheSeconds", 3600);
        config.fallbackMode = sConfigMgr->GetOption<std::string>(
            "SmallGroup.BotGuildInvite.FallbackMode", "decline");
        config.defaultLikeability = std::clamp<uint32>(
            sConfigMgr->GetOption<uint32>(
                "SmallGroup.BotGuildInvite.DefaultLikeability", 50),
            0, 100);

        g_botGuildInviteConfig = std::move(config);
    }
};

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

class small_group_tweaks_guildscript : public GuildScript
{
public:
    small_group_tweaks_guildscript()
        : GuildScript("small_group_tweaks_guildscript")
    {
    }

    bool CanInviteMember(Guild* guild, Player* inviter, Player* invitee,
        bool& handled) override
    {
        handled = false;
        if (!guild || !inviter || !invitee || !g_botGuildInviteConfig.enabled)
            return true;

        if (!IsRealPlayer(inviter) || !IsBot(invitee))
            return true;

        WorldSession* session = inviter->GetSession();
        if (!session)
            return true;

        Guild* currentGuild = invitee->GetGuildId()
            ? sGuildMgr->GetGuildById(invitee->GetGuildId()) : nullptr;
        if (currentGuild == guild)
        {
            handled = true;
            ChatHandler(session).PSendSysMessage("{} is already in your guild.",
                invitee->GetName());
            return true;
        }

        if (currentGuild && OnlineRealPlayerCount(currentGuild) > 0)
            return true;

        handled = true;
        BotGuildInviteDecision decision =
            RequestBotGuildInviteDecision(inviter, invitee, guild,
                g_botGuildInviteConfig);

        if (!decision.accept)
        {
            ChatHandler(session).PSendSysMessage("{} declines the guild invite{}{}",
                invitee->GetName(), decision.say.empty() ? "." : ": ",
                decision.say);
            return true;
        }

        if (currentGuild)
            currentGuild->DeleteMember(invitee->GetGUID(), false, false, false);

        if (guild->AddMember(invitee->GetGUID()))
        {
            Guild::SendCommandResult(session, GUILD_COMMAND_INVITE,
                ERR_GUILD_COMMAND_SUCCESS, invitee->GetName());
            ChatHandler(session).PSendSysMessage("{} accepts the guild invite{}{}",
                invitee->GetName(), decision.say.empty() ? "." : ": ",
                decision.say);
        }
        else
        {
            ChatHandler(session).PSendSysMessage(
                "{} accepted, but could not be added to the guild.",
                invitee->GetName());
        }

        return true;
    }
};
}

void Addmod_small_group_tweaksScripts()
{
    new small_group_tweaks_worldscript();
    new small_group_tweaks_playerscript();
    new small_group_tweaks_commandscript();
    new small_group_tweaks_guildscript();
}
