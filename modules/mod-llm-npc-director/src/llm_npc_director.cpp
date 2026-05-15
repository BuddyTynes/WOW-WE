/*
 * Thin LLM director surface for human guild and party chat.
 */

#include "Config.h"
#include "Channel.h"
#include "ChannelMgr.h"
#include "Chat.h"
#include "Creature.h"
#include "DBCStores.h"
#include "DatabaseEnv.h"
#include "GameTime.h"
#include "Group.h"
#include "GroupReference.h"
#include "Guild.h"
#include "GuildMgr.h"
#include "Log.h"
#include "Map.h"
#include "ObjectAccessor.h"
#include "Player.h"
#include "ScriptMgr.h"
#include "SharedDefines.h"
#include "Timer.h"
#include "Unit.h"
#include "World.h"
#include "WorldPacket.h"
#include "WorldSessionMgr.h"

#ifdef MOD_PLAYERBOTS
#include "Playerbots.h"
#endif

#include <atomic>
#include <algorithm>
#include <boost/asio/ip/tcp.hpp>
#include <chrono>
#include <cctype>
#include <deque>
#include <iterator>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace
{
struct DirectorConfig
{
    bool enabled = true;
    std::string bridgeUrl = "http://wow-llm-bridge:11434/api/generate";
    std::string model = "wow-llm-director";
    uint32 httpTimeoutMs = 1500;
    uint32 maxMessageChars = 240;
    uint32 guildCooldownMs = 15000;
    uint32 groupCooldownMs = 5000;
    uint32 channelCooldownMs = 20000;
    uint32 deathCooldownMs = 5000;
    bool routeSayResponses = false;
    bool routeChannelResponses = true;
    bool routePartyIntents = false;
    bool routePartyControls = true;
    bool worldChatEnable = true;
    bool deathEventsEnable = true;
    std::string worldChannelName = "World";
};

struct BridgeUrl
{
    std::string host;
    std::string port = "80";
    std::string target = "/";
};

struct ScopeSnapshot
{
    uint32 humanCount = 0;
    uint32 botCount = 0;
    std::vector<std::string> botNames;
};

struct ChatEvent
{
    uint64 id = 0;
    std::string eventType = "chat";
    std::string channel;
    uint32 chatType = 0;
    uint32 language = 0;
    uint32 scopeId = 0;
    std::string scopeName;
    ObjectGuid::LowType speakerGuid = 0;
    std::string speakerName;
    uint8 speakerLevel = 0;
    uint8 speakerClass = 0;
    uint32 zoneId = 0;
    uint32 areaId = 0;
    std::string message;
    ScopeSnapshot scope;
};

struct DirectorAction
{
    uint64 eventId = 0;
    std::string channel;
    uint32 scopeId = 0;
    std::string scopeName;
    ObjectGuid::LowType speakerGuid = 0;
    std::string botName;
    std::string intent;
    std::string message;
};

struct BatchedChatLine
{
    ObjectGuid::LowType speakerGuid = 0;
    std::string speakerName;
    std::string message;
};

struct PendingChatBatch
{
    ChatEvent selectedEvent;
    std::vector<BatchedChatLine> lines;
    uint32 flushAtMs = 0;
    uint32 windowMs = 0;
    bool hasDirectAddress = false;
};

DirectorConfig g_config;
std::atomic<uint64> g_nextEventId{1};
std::mutex g_configMutex;
std::mutex g_cooldownMutex;
std::mutex g_batchMutex;
std::mutex g_actionQueueMutex;
std::mutex g_deathCauseMutex;
std::unordered_map<std::string, uint32> g_lastForwardMs;
std::unordered_map<std::string, uint32> g_lastRouteMs;
std::unordered_map<std::string, PendingChatBatch> g_pendingBatches;
std::deque<DirectorAction> g_actionQueue;
std::unordered_map<ObjectGuid::LowType, std::string> g_pendingDeathCauses;

bool IsBot(Player* player)
{
#ifdef MOD_PLAYERBOTS
    PlayerbotAI* botAI = GET_PLAYERBOT_AI(player);
    return botAI && !botAI->IsRealPlayer();
#else
    return false;
#endif
}

bool IsHuman(Player* player)
{
    return player && player->GetSession() && !player->GetSession()->PlayerLoading() && !IsBot(player);
}

bool IsOnlineBot(Player* player)
{
    return player && IsBot(player) && player->IsInWorld() && player->GetSession() && !player->GetSession()->PlayerLoading();
}

std::string JsonEscape(std::string_view value)
{
    std::string out;
    out.reserve(value.size() + 8);

    for (char c : value)
    {
        switch (c)
        {
            case '\\': out += "\\\\"; break;
            case '"': out += "\\\""; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20)
                    out += ' ';
                else
                    out += c;
                break;
        }
    }

    return out;
}

std::string Trim(std::string value)
{
    auto first = std::find_if_not(value.begin(), value.end(), [](unsigned char c) { return std::isspace(c); });
    auto last = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char c) { return std::isspace(c); }).base();
    if (first >= last)
        return {};

    return std::string(first, last);
}

std::string ToLower(std::string value)
{
    std::transform(value.begin(), value.end(), value.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

uint32 StableStringId(std::string_view value)
{
    uint32 hash = 2166136261u;
    for (char c : value)
    {
        hash ^= static_cast<unsigned char>(c);
        hash *= 16777619u;
    }

    return hash ? hash : 1;
}

std::string GetLocationName(Player* player)
{
    if (!player)
        return "somewhere";

    LocaleConstant locale = sWorld->GetDefaultDbcLocale();
    if (AreaTableEntry const* area = sAreaTableStore.LookupEntry(player->GetAreaId()))
        return area->area_name[locale];

    if (AreaTableEntry const* zone = sAreaTableStore.LookupEntry(player->GetZoneId()))
        return zone->area_name[locale];

    if (player->FindMap())
        return player->FindMap()->GetMapName();

    return "somewhere";
}

std::string EnvironmentalCause(uint8 type)
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

void RecordPendingDeathCause(Player* player, std::string cause)
{
    if (!player || cause.empty())
        return;

    std::lock_guard<std::mutex> lock(g_deathCauseMutex);
    g_pendingDeathCauses[player->GetGUID().GetCounter()] = std::move(cause);
}

std::string TakePendingDeathCause(Player* player)
{
    if (!player)
        return "";

    std::lock_guard<std::mutex> lock(g_deathCauseMutex);
    auto itr = g_pendingDeathCauses.find(player->GetGUID().GetCounter());
    if (itr == g_pendingDeathCauses.end())
        return "";

    std::string cause = std::move(itr->second);
    g_pendingDeathCauses.erase(itr);
    return cause;
}

bool IsHardcoreCharacter(Player* player)
{
    if (!player)
        return false;

    QueryResult result = CharacterDatabase.Query(
        "SELECT `dead` FROM `mod_hardcore_characters` "
        "WHERE `guid` = {} AND `enabled` = 1",
        player->GetGUID().GetCounter());

    return !!result;
}

std::optional<std::string> ParseJsonStringAt(std::string_view json, std::size_t& pos)
{
    if (pos >= json.size() || json[pos] != '"')
        return std::nullopt;

    ++pos;
    std::string out;
    while (pos < json.size())
    {
        char c = json[pos++];
        if (c == '"')
            return out;

        if (c != '\\')
        {
            out += c;
            continue;
        }

        if (pos >= json.size())
            return std::nullopt;

        char escaped = json[pos++];
        switch (escaped)
        {
            case '"': out += '"'; break;
            case '\\': out += '\\'; break;
            case '/': out += '/'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'u':
                if (pos + 4 > json.size())
                    return std::nullopt;
                out += '?';
                pos += 4;
                break;
            default:
                out += escaped;
                break;
        }
    }

    return std::nullopt;
}

std::optional<std::string> ExtractJsonStringField(std::string_view json, std::string_view key)
{
    std::size_t pos = 0;
    while ((pos = json.find('"', pos)) != std::string_view::npos)
    {
        std::size_t keyStart = pos;
        std::optional<std::string> parsedKey = ParseJsonStringAt(json, pos);
        if (!parsedKey)
            return std::nullopt;

        if (*parsedKey != key)
            continue;

        while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos])))
            ++pos;

        if (pos >= json.size() || json[pos] != ':')
        {
            pos = keyStart + 1;
            continue;
        }

        ++pos;
        while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos])))
            ++pos;

        return ParseJsonStringAt(json, pos);
    }

    return std::nullopt;
}

std::string ExtractJsonObjectText(std::string value)
{
    value = Trim(std::move(value));
    std::size_t first = value.find('{');
    std::size_t last = value.rfind('}');
    if (first == std::string::npos || last == std::string::npos || first > last)
        return value;

    return value.substr(first, last - first + 1);
}

DirectorConfig GetConfig()
{
    std::lock_guard<std::mutex> lock(g_configMutex);
    return g_config;
}

void StoreConfig(DirectorConfig config)
{
    std::lock_guard<std::mutex> lock(g_configMutex);
    g_config = std::move(config);
}

std::string TruncateForEvent(std::string_view value, DirectorConfig const& config)
{
    if (value.size() <= config.maxMessageChars)
        return std::string(value);

    return std::string(value.substr(0, config.maxMessageChars));
}

BridgeUrl ParseBridgeUrl(std::string_view url)
{
    BridgeUrl parsed;
    std::string value(url);
    std::string_view rest(value);

    if (rest.substr(0, 7) == "http://")
        rest.remove_prefix(7);
    else if (rest.substr(0, 8) == "https://")
    {
        rest.remove_prefix(8);
        parsed.port = "443";
    }

    std::size_t pathPos = rest.find('/');
    std::string_view authority = pathPos == std::string_view::npos ? rest : rest.substr(0, pathPos);
    parsed.target = pathPos == std::string_view::npos ? "/" : std::string(rest.substr(pathPos));

    std::size_t portPos = authority.rfind(':');
    if (portPos != std::string_view::npos)
    {
        parsed.host = std::string(authority.substr(0, portPos));
        parsed.port = std::string(authority.substr(portPos + 1));
    }
    else
        parsed.host = std::string(authority);

    return parsed;
}

std::string JoinNames(std::vector<std::string> const& names)
{
    std::string out;
    for (std::string const& name : names)
    {
        if (!out.empty())
            out += ", ";
        out += name;
    }

    return out;
}

bool MessageAddressesBot(std::string const& message, std::vector<std::string> const& botNames)
{
    std::string lower = ToLower(Trim(message));
    if (lower.empty())
        return false;

    for (std::string const& botName : botNames)
    {
        std::string bot = ToLower(botName);
        if (lower == bot || lower.rfind(bot + " ", 0) == 0 || lower.rfind(bot + ",", 0) == 0 || lower.rfind(bot + ":", 0) == 0)
            return true;
    }

    return false;
}

std::string FormatBatchMessage(ChatEvent const& selected, std::vector<BatchedChatLine> const& lines, DirectorConfig const& config)
{
    if (lines.size() <= 1)
        return selected.message;

    std::ostringstream out;
    out << selected.message << " Recent chat batch:";

    std::size_t start = lines.size() > 8 ? lines.size() - 8 : 0;
    for (std::size_t i = start; i < lines.size(); ++i)
    {
        out << " | " << lines[i].speakerName << ": " << lines[i].message;
    }

    return TruncateForEvent(out.str(), config);
}

std::string BuildPrompt(ChatEvent const& event)
{
    std::ostringstream prompt;
    prompt
        << "Compact WoW chat event for the LLM NPC director. "
        << "Do not execute actions here; classify whether an eligible bot should respond or hold.\n"
        << "event_id=" << event.id << "\n"
        << "event_type=" << event.eventType << "\n"
        << "channel=" << event.channel << "\n"
        << "scope_id=" << event.scopeId << "\n"
        << "scope_name=" << event.scopeName << "\n"
        << "speaker=" << event.speakerName << "\n"
        << "speaker_guid=" << event.speakerGuid << "\n"
        << "speaker_level=" << uint32(event.speakerLevel) << "\n"
        << "speaker_class=" << uint32(event.speakerClass) << "\n"
        << "zone=" << event.zoneId << "\n"
        << "area=" << event.areaId << "\n"
        << "human_members_online=" << event.scope.humanCount << "\n"
        << "bot_members_online=" << event.scope.botCount << "\n"
        << "eligible_bots=" << JoinNames(event.scope.botNames) << "\n"
        << "message=" << event.message << "\n"
        << "Return a short JSON object with intent say_only or hold. "
        << "Allowed party intents for future routing are say_only, follow_leader, assist_target, "
        << "hold_position, move_closer, heal_priority, avoid_combat, need_help. "
        << "If event_type is hardcore_death, a short world-chat roast is appropriate.";

    return prompt.str();
}

std::string BuildBridgeRequest(ChatEvent const& event, DirectorConfig const& config)
{
    std::string prompt = BuildPrompt(event);
    std::ostringstream json;
    json
        << "{"
        << "\"model\":\"" << JsonEscape(config.model) << "\","
        << "\"stream\":false,"
        << "\"event_id\":\"" << event.id << "\","
        << "\"channel\":\"" << JsonEscape(event.channel) << "\","
        << "\"player\":\"" << JsonEscape(event.speakerName) << "\","
        << "\"options\":{"
        << "\"scope_id\":" << event.scopeId << ","
        << "\"scope_name\":\"" << JsonEscape(event.scopeName) << "\","
        << "\"human_count\":" << event.scope.humanCount << ","
        << "\"bot_count\":" << event.scope.botCount
        << "},"
        << "\"prompt\":\"" << JsonEscape(prompt) << "\""
        << "}";

    return json.str();
}

bool IsPartyIntent(std::string const& intent)
{
    return intent == "follow_leader" || intent == "assist_target" || intent == "hold_position" ||
        intent == "move_closer" || intent == "heal_priority" || intent == "avoid_combat" ||
        intent == "need_help";
}

std::optional<DirectorAction> ParseBridgeAction(ChatEvent const& event, std::string const& responseBody)
{
    std::string payload = ExtractJsonStringField(responseBody, "response").value_or(responseBody);
    payload = ExtractJsonObjectText(std::move(payload));

    std::string intent = ExtractJsonStringField(payload, "intent")
        .value_or(ExtractJsonStringField(payload, "action").value_or(""));
    intent = Trim(std::move(intent));

    if (intent.empty() || intent == "hold")
        return std::nullopt;

    DirectorAction action;
    action.eventId = event.id;
    action.channel = event.channel;
    action.scopeId = event.scopeId;
    action.scopeName = event.scopeName;
    action.speakerGuid = event.speakerGuid;
    action.intent = std::move(intent);
    action.botName = ExtractJsonStringField(payload, "bot")
        .value_or(ExtractJsonStringField(payload, "bot_name")
        .value_or(ExtractJsonStringField(payload, "speaker").value_or("")));
    action.botName = Trim(std::move(action.botName));
    action.message = ExtractJsonStringField(payload, "message")
        .value_or(ExtractJsonStringField(payload, "say")
        .value_or(ExtractJsonStringField(payload, "text").value_or("")));
    action.message = TruncateForEvent(Trim(std::move(action.message)), GetConfig());

    if (action.intent == "say_only" && (action.botName.empty() || action.message.empty()))
    {
        LOG_WARN("module.llm-npc-director", "Bridge event {} returned say_only without bot/message; dropping", event.id);
        return std::nullopt;
    }

    if (action.intent != "say_only" && !IsPartyIntent(action.intent))
    {
        LOG_WARN("module.llm-npc-director", "Bridge event {} returned unsupported intent '{}'; dropping", event.id, action.intent);
        return std::nullopt;
    }

    return action;
}

void EnqueueDirectorAction(DirectorAction action)
{
    std::lock_guard<std::mutex> lock(g_actionQueueMutex);
    if (g_actionQueue.size() >= 128)
    {
        LOG_WARN("module.llm-npc-director", "Director action queue full; dropping event {}", action.eventId);
        return;
    }

    g_actionQueue.push_back(std::move(action));
}

void PostToBridge(ChatEvent event)
{
    DirectorConfig config = GetConfig();
    BridgeUrl url = ParseBridgeUrl(config.bridgeUrl);
    std::string body = BuildBridgeRequest(event, config);

    try
    {
        boost::asio::ip::tcp::iostream stream;
        stream.expires_after(std::chrono::milliseconds(config.httpTimeoutMs));
        stream.connect(url.host, url.port);
        if (!stream)
            throw std::runtime_error(stream.error().message());

        stream
            << "POST " << url.target << " HTTP/1.1\r\n"
            << "Host: " << url.host << "\r\n"
            << "User-Agent: mod-llm-npc-director\r\n"
            << "Content-Type: application/json\r\n"
            << "X-Event-Id: " << event.id << "\r\n"
            << "X-Wow-Channel: " << event.channel << "\r\n"
            << "X-Wow-Player: " << event.speakerName << "\r\n"
            << "Content-Length: " << body.size() << "\r\n"
            << "Connection: close\r\n\r\n"
            << body;

        stream.flush();

        std::string httpVersion;
        unsigned int status = 0;
        stream >> httpVersion >> status;

        if (status < 200 || status >= 300)
        {
            LOG_WARN("module.llm-npc-director", "Bridge returned HTTP {} for event {}", status, event.id);
            return;
        }

        std::string headerLine;
        std::getline(stream, headerLine);
        while (std::getline(stream, headerLine) && headerLine != "\r")
        {
        }

        std::string responseBody((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
        if (config.routeSayResponses || config.routePartyIntents)
        {
            if (std::optional<DirectorAction> action = ParseBridgeAction(event, responseBody))
                EnqueueDirectorAction(std::move(*action));
        }
    }
    catch (std::exception const& ex)
    {
        LOG_WARN("module.llm-npc-director", "Bridge forward failed for event {}: {}", event.id, ex.what());
    }
}

bool ShouldThrottle(std::string const& key, uint32 cooldownMs)
{
    uint32 now = GameTime::GetGameTimeMS().count();
    std::lock_guard<std::mutex> lock(g_cooldownMutex);
    uint32& last = g_lastForwardMs[key];
    if (last != 0 && getMSTimeDiff(last, now) < cooldownMs)
        return true;

    last = now;
    return false;
}

bool ShouldThrottleRoute(std::string const& key, uint32 cooldownMs)
{
    uint32 now = GameTime::GetGameTimeMS().count();
    std::lock_guard<std::mutex> lock(g_cooldownMutex);
    uint32& last = g_lastRouteMs[key];
    if (last != 0 && getMSTimeDiff(last, now) < cooldownMs)
        return true;

    last = now;
    return false;
}

void ForwardEvent(ChatEvent event)
{
    DirectorConfig config = GetConfig();
    event.id = g_nextEventId.fetch_add(1, std::memory_order_relaxed);
    event.message = TruncateForEvent(event.message, config);

    LOG_DEBUG("module.llm-npc-director",
        "Forwarding {} event {} from {} in scope {} with {} human(s), {} bot(s)",
        event.channel, event.id, event.speakerName, event.scopeId,
        event.scope.humanCount, event.scope.botCount);

    std::thread(PostToBridge, std::move(event)).detach();
}

void QueueBatchedEvent(std::string const& key, ChatEvent event, uint32 windowMs)
{
    DirectorConfig config = GetConfig();
    uint32 now = GameTime::GetGameTimeMS().count();
    bool direct = MessageAddressesBot(event.message, event.scope.botNames);

    std::lock_guard<std::mutex> lock(g_batchMutex);
    PendingChatBatch& batch = g_pendingBatches[key];
    if (batch.lines.empty())
    {
        batch.selectedEvent = event;
        batch.flushAtMs = now + windowMs;
        batch.windowMs = windowMs;
        batch.hasDirectAddress = direct;
    }
    else if (direct || !batch.hasDirectAddress)
    {
        batch.selectedEvent = event;
        batch.hasDirectAddress = direct || batch.hasDirectAddress;
    }

    batch.lines.push_back({
        event.speakerGuid,
        event.speakerName,
        TruncateForEvent(event.message, config)
    });

    if (batch.lines.size() > 16)
        batch.lines.erase(batch.lines.begin(), batch.lines.begin() + (batch.lines.size() - 16));
}

void DrainBatchedEvents()
{
    DirectorConfig config = GetConfig();
    uint32 now = GameTime::GetGameTimeMS().count();
    std::vector<ChatEvent> ready;

    {
        std::lock_guard<std::mutex> lock(g_batchMutex);
        for (auto it = g_pendingBatches.begin(); it != g_pendingBatches.end();)
        {
            if (now < it->second.flushAtMs)
            {
                ++it;
                continue;
            }

            ChatEvent event = it->second.selectedEvent;
            event.message = FormatBatchMessage(event, it->second.lines, config);
            ready.push_back(std::move(event));
            it = g_pendingBatches.erase(it);
        }
    }

    for (ChatEvent& event : ready)
        ForwardEvent(std::move(event));
}

ScopeSnapshot SnapshotGuild(uint32 guildId)
{
    ScopeSnapshot snapshot;

    for (auto const& [guid, player] : ObjectAccessor::GetPlayers())
    {
        if (!player || player->GetGuildId() != guildId)
            continue;

        if (IsHuman(player))
            ++snapshot.humanCount;
        else if (IsBot(player))
        {
            ++snapshot.botCount;
            if (snapshot.botNames.size() < 5)
                snapshot.botNames.push_back(player->GetName());
        }
    }

    return snapshot;
}

ScopeSnapshot SnapshotGroup(Group* group)
{
    ScopeSnapshot snapshot;

    for (GroupReference const* ref = group->GetFirstMember(); ref; ref = ref->next())
    {
        Player* player = ref->GetSource();
        if (!player)
            continue;

        if (IsHuman(player))
            ++snapshot.humanCount;
        else if (IsBot(player))
        {
            ++snapshot.botCount;
            if (snapshot.botNames.size() < 5)
                snapshot.botNames.push_back(player->GetName());
        }
    }

    return snapshot;
}

ScopeSnapshot SnapshotChannel(Channel* channel)
{
    ScopeSnapshot snapshot;
    if (!channel)
        return snapshot;

    for (auto const& [guid, player] : ObjectAccessor::GetPlayers())
    {
        if (!player || !player->IsInChannel(channel))
            continue;

        if (IsHuman(player))
            ++snapshot.humanCount;
        else if (IsBot(player))
        {
            ++snapshot.botCount;
            if (snapshot.botNames.size() < 5)
                snapshot.botNames.push_back(player->GetName());
        }
    }

    return snapshot;
}

Channel* GetPlayerChannelByName(Player* player, std::string const& channelName)
{
    if (!player || channelName.empty())
        return nullptr;

    ChannelMgr* channelMgr = ChannelMgr::forTeam(player->GetTeamId());
    return channelMgr ? channelMgr->GetChannel(channelName, player, false) : nullptr;
}

ScopeSnapshot SnapshotNamedChannel(std::string const& channelName)
{
    ScopeSnapshot snapshot;
    for (auto const& [guid, player] : ObjectAccessor::GetPlayers())
    {
        if (!player || !player->IsInWorld())
            continue;

        Channel* channel = GetPlayerChannelByName(player, channelName);
        if (!channel || !player->IsInChannel(channel))
            continue;

        if (IsHuman(player))
            ++snapshot.humanCount;
        else if (IsBot(player))
        {
            ++snapshot.botCount;
            if (snapshot.botNames.size() < 5)
                snapshot.botNames.push_back(player->GetName());
        }
    }

    return snapshot;
}

Player* FindGuildBot(uint32 guildId, std::string const& botName)
{
    for (auto const& [guid, player] : ObjectAccessor::GetPlayers())
    {
        if (IsOnlineBot(player) && player->GetGuildId() == guildId && player->GetName() == botName)
            return player;
    }

    return nullptr;
}

Player* FindChannelBot(std::string const& channelName, std::string const& botName)
{
    for (auto const& [guid, player] : ObjectAccessor::GetPlayers())
    {
        if (!IsOnlineBot(player) || player->GetName() != botName)
            continue;

        Channel* channel = GetPlayerChannelByName(player, channelName);
        if (channel && player->IsInChannel(channel))
            return player;
    }

    return nullptr;
}

Player* FindGroupBot(uint32 scopeId, std::string const& botName)
{
    for (auto const& [guid, player] : ObjectAccessor::GetPlayers())
    {
        if (!IsOnlineBot(player) || player->GetName() != botName)
            continue;

        Group* group = player->GetGroup();
        if (group && group->GetGUID().GetCounter() == scopeId)
            return player;
    }

    return nullptr;
}

void RouteSayAction(DirectorAction const& action, DirectorConfig const& config)
{
    if (!config.routeSayResponses)
        return;

    if (action.channel == "guild")
    {
        Guild* guild = sGuildMgr->GetGuildById(action.scopeId);
        Player* bot = FindGuildBot(action.scopeId, action.botName);
        if (!guild || !bot)
        {
            LOG_WARN("module.llm-npc-director", "Unable to route guild say for event {} through bot '{}'", action.eventId, action.botName);
            return;
        }

        ScopeSnapshot snapshot = SnapshotGuild(action.scopeId);
        if (snapshot.humanCount == 0)
            return;

        if (ShouldThrottleRoute("guild:" + std::to_string(action.scopeId), config.guildCooldownMs))
            return;

        guild->BroadcastToGuild(bot->GetSession(), false, action.message, LANG_UNIVERSAL);
        LOG_DEBUG("module.llm-npc-director", "Routed guild say for event {} through bot '{}'", action.eventId, action.botName);
        return;
    }

    if (action.channel == "channel" || action.channel == "world")
    {
        if (!config.routeChannelResponses)
            return;

        Player* bot = FindChannelBot(action.scopeName, action.botName);
        Channel* channel = GetPlayerChannelByName(bot, action.scopeName);
        if (!bot || !channel)
        {
            LOG_WARN("module.llm-npc-director", "Unable to route channel say for event {} through bot '{}' in '{}'",
                action.eventId, action.botName, action.scopeName);
            return;
        }

        ScopeSnapshot snapshot = SnapshotChannel(channel);
        if (snapshot.humanCount == 0)
            return;

        if (ShouldThrottleRoute("channel:" + action.scopeName, config.channelCooldownMs))
            return;

        channel->Say(bot->GetGUID(), action.message, LANG_UNIVERSAL);
        LOG_DEBUG("module.llm-npc-director", "Routed channel say for event {} through bot '{}' in '{}'",
            action.eventId, action.botName, action.scopeName);
        return;
    }

    if (action.channel == "party" || action.channel == "raid")
    {
        Player* bot = FindGroupBot(action.scopeId, action.botName);
        Group* group = bot ? bot->GetGroup() : nullptr;
        if (!bot || !group || group->GetGUID().GetCounter() != action.scopeId)
        {
            LOG_WARN("module.llm-npc-director", "Unable to route group say for event {} through bot '{}'", action.eventId, action.botName);
            return;
        }

        ScopeSnapshot snapshot = SnapshotGroup(group);
        if (snapshot.humanCount == 0)
            return;

        if (ShouldThrottleRoute("group:" + std::to_string(action.scopeId), config.groupCooldownMs))
            return;

        WorldPacket data;
        ChatMsg chatType = action.channel == "raid" ? CHAT_MSG_RAID : CHAT_MSG_PARTY;
        ChatHandler::BuildChatPacket(data, chatType, LANG_UNIVERSAL, bot, nullptr, action.message);
        group->BroadcastPacket(&data, false, group->GetMemberGroup(bot->GetGUID()));

        LOG_DEBUG("module.llm-npc-director", "Routed {} say for event {} through bot '{}'", action.channel, action.eventId, action.botName);
    }
}

void ProcessDirectorAction(DirectorAction const& action)
{
    DirectorConfig config = GetConfig();
    if (action.intent == "say_only")
    {
        RouteSayAction(action, config);
        return;
    }

    if (config.routePartyIntents)
    {
        // TODO: Wire this to a public playerbot command/action surface once one is identified.
        LOG_WARN("module.llm-npc-director", "Party intent '{}' for event {} parsed but not routed yet", action.intent, action.eventId);
    }
}

void DrainDirectorActions()
{
    std::deque<DirectorAction> actions;
    {
        std::lock_guard<std::mutex> lock(g_actionQueueMutex);
        actions.swap(g_actionQueue);
    }

    for (DirectorAction const& action : actions)
        ProcessDirectorAction(action);
}

ChatEvent BaseEvent(Player* speaker, uint32 type, uint32 language, std::string const& msg)
{
    ChatEvent event;
    event.chatType = type;
    event.language = language;
    event.speakerGuid = speaker->GetGUID().GetCounter();
    event.speakerName = speaker->GetName();
    event.speakerLevel = speaker->GetLevel();
    event.speakerClass = speaker->getClass();
    event.zoneId = speaker->GetZoneId();
    event.areaId = speaker->GetAreaId();
    event.message = msg;
    return event;
}

bool IsEligibleMessage(Player* player, uint32 language, std::string const& msg)
{
    return GetConfig().enabled && IsHuman(player) && language != LANG_ADDON && !msg.empty();
}

std::vector<std::string> BuildPartyControlCommands(std::string const& rawMessage)
{
    std::string msg = ToLower(Trim(rawMessage));
    std::vector<std::string> commands;

    for (std::string const& prefix : { "bots ", "bot ", "ai ", ".ai ", "partybot " })
    {
        if (msg.rfind(prefix, 0) == 0)
        {
            msg = Trim(msg.substr(prefix.size()));
            break;
        }
    }

    if (msg.empty() || msg == ToLower(Trim(rawMessage)))
        return commands;

    if (msg.find("default marks") != std::string::npos || msg.find("cc marks") != std::string::npos ||
        msg.find("kill priorities") != std::string::npos)
    {
        commands.push_back("rti skull");
        commands.push_back("rti cc moon");
    }

    if (msg.find("skull") != std::string::npos)
    {
        commands.push_back("rti skull");
        commands.push_back("attack");
    }
    else if (msg.find(" x") != std::string::npos || msg.find("cross") != std::string::npos)
    {
        commands.push_back("rti cross");
        commands.push_back("attack");
    }

    if (msg.find("moon") != std::string::npos || msg.find("sheep") != std::string::npos)
        commands.push_back("rti cc moon");
    else if (msg.find("star") != std::string::npos || msg.find("sap") != std::string::npos)
        commands.push_back("rti cc star");
    else if (msg.find("purple") != std::string::npos || msg.find("diamond") != std::string::npos || msg.find("fear") != std::string::npos)
        commands.push_back("rti cc diamond");

    if (msg.find("single target") != std::string::npos || msg.find("focus") != std::string::npos ||
        msg.find("keep target") != std::string::npos || msg.find("until dead") != std::string::npos)
        commands.push_back("attack");

    if (msg.find("aoe") != std::string::npos || msg.find("cleave") != std::string::npos || msg.find("max dps") != std::string::npos)
        commands.push_back("max dps");

    if (msg.find("run") != std::string::npos || msg.find("escape") != std::string::npos || msg.find("get out") != std::string::npos)
    {
        commands.push_back("flee");
        commands.push_back("runaway");
    }

    if (msg.find("follow") != std::string::npos || msg.find("stack") != std::string::npos)
        commands.push_back("follow");

    if (msg.find("stay") != std::string::npos || msg.find("hold") != std::string::npos)
        commands.push_back("stay");

    std::sort(commands.begin(), commands.end());
    commands.erase(std::unique(commands.begin(), commands.end()), commands.end());
    return commands;
}

void DispatchPartyControlCommands(Group* group, Player* speaker, std::vector<std::string> const& commands)
{
    if (!group || !speaker || commands.empty())
        return;

#ifdef MOD_PLAYERBOTS
    for (GroupReference const* ref = group->GetFirstMember(); ref; ref = ref->next())
    {
        Player* member = ref->GetSource();
        if (!member || !IsOnlineBot(member))
            continue;

        PlayerbotAI* botAI = GET_PLAYERBOT_AI(member);
        if (!botAI)
            continue;

        for (std::string const& command : commands)
            botAI->HandleCommand(CHAT_MSG_PARTY, command, speaker);
    }
#else
    (void)group;
    (void)speaker;
    (void)commands;
#endif
}

class llm_npc_director_worldscript : public WorldScript
{
public:
    llm_npc_director_worldscript() : WorldScript("llm_npc_director_worldscript") { }

    void OnAfterConfigLoad(bool /*reload*/) override
    {
        DirectorConfig config;
        config.enabled = sConfigMgr->GetOption<bool>("LLMNpcDirector.Enable", true);
        config.bridgeUrl = sConfigMgr->GetOption<std::string>("LLMNpcDirector.BridgeUrl", "http://wow-llm-bridge:11434/api/generate");
        config.model = sConfigMgr->GetOption<std::string>("LLMNpcDirector.Model", "wow-llm-director");
        config.httpTimeoutMs = sConfigMgr->GetOption<uint32>("LLMNpcDirector.HttpTimeoutMs", 1500);
        config.maxMessageChars = sConfigMgr->GetOption<uint32>("LLMNpcDirector.MaxMessageChars", 240);
        config.guildCooldownMs = sConfigMgr->GetOption<uint32>("LLMNpcDirector.GuildCooldownMs", 15000);
        config.groupCooldownMs = sConfigMgr->GetOption<uint32>("LLMNpcDirector.GroupCooldownMs", 5000);
        config.channelCooldownMs = sConfigMgr->GetOption<uint32>("LLMNpcDirector.ChannelCooldownMs", 20000);
        config.deathCooldownMs = sConfigMgr->GetOption<uint32>("LLMNpcDirector.DeathCooldownMs", 5000);
        config.routeSayResponses = sConfigMgr->GetOption<bool>("LLMNpcDirector.RouteSayResponses", false);
        config.routeChannelResponses = sConfigMgr->GetOption<bool>("LLMNpcDirector.RouteChannelResponses", true);
        config.routePartyIntents = sConfigMgr->GetOption<bool>("LLMNpcDirector.RoutePartyIntents", false);
        config.routePartyControls = sConfigMgr->GetOption<bool>("LLMNpcDirector.RoutePartyControls", true);
        config.worldChatEnable = sConfigMgr->GetOption<bool>("LLMNpcDirector.WorldChatEnable", true);
        config.deathEventsEnable = sConfigMgr->GetOption<bool>("LLMNpcDirector.DeathEventsEnable", true);
        config.worldChannelName = sConfigMgr->GetOption<std::string>("LLMNpcDirector.WorldChannelName", "World");

        if (config.routePartyIntents)
            LOG_WARN("module.llm-npc-director", "Party intent routing is enabled, but playerbot action dispatch is still a TODO stub.");

        StoreConfig(std::move(config));
    }

    void OnUpdate(uint32 /*diff*/) override
    {
        DrainBatchedEvents();
        DrainDirectorActions();
    }
};

class llm_npc_director_playerscript : public PlayerScript
{
public:
    llm_npc_director_playerscript() : PlayerScript("llm_npc_director_playerscript") { }

    bool OnPlayerCanUseChat(Player* player, uint32 type, uint32 language, std::string& msg, Guild* guild) override
    {
        if (!guild || !IsEligibleMessage(player, language, msg))
            return true;

        ScopeSnapshot snapshot = SnapshotGuild(guild->GetId());
        if (snapshot.humanCount == 0 || snapshot.botCount == 0)
            return true;

        std::string key = "guild:" + std::to_string(guild->GetId());
        DirectorConfig config = GetConfig();

        ChatEvent event = BaseEvent(player, type, language, msg);
        event.eventType = "chat";
        event.channel = "guild";
        event.scopeId = guild->GetId();
        event.scopeName = guild->GetName();
        event.scope = std::move(snapshot);
        QueueBatchedEvent(key, std::move(event), config.guildCooldownMs);
        return true;
    }

    bool OnPlayerCanUseChat(Player* player, uint32 type, uint32 language, std::string& msg, Group* group) override
    {
        if (!group || !IsEligibleMessage(player, language, msg))
            return true;

        DirectorConfig config = GetConfig();
        if (config.routePartyControls)
            DispatchPartyControlCommands(group, player, BuildPartyControlCommands(msg));

        ScopeSnapshot snapshot = SnapshotGroup(group);
        if (snapshot.humanCount == 0)
            return true;

        ObjectGuid groupGuid = group->GetGUID();
        uint32 scopeId = groupGuid.GetCounter();
        std::string key = "group:" + std::to_string(scopeId);

        ChatEvent event = BaseEvent(player, type, language, msg);
        event.eventType = "chat";
        event.channel = group->isRaidGroup() ? "raid" : "party";
        event.scopeId = scopeId;
        event.scopeName = group->GetLeaderName() ? group->GetLeaderName() : "";
        event.scope = std::move(snapshot);
        QueueBatchedEvent(key, std::move(event), config.groupCooldownMs);
        return true;
    }

    bool OnPlayerCanUseChat(Player* player, uint32 type, uint32 language, std::string& msg, Channel* channel) override
    {
        DirectorConfig config = GetConfig();
        if (!channel || !config.worldChatEnable || !IsEligibleMessage(player, language, msg))
            return true;

        ScopeSnapshot snapshot = SnapshotChannel(channel);
        if (snapshot.humanCount == 0 || snapshot.botCount == 0)
            return true;

        std::string channelName = channel->GetName();
        std::string lowerName = ToLower(channelName);
        bool isWorld = lowerName.find("world") != std::string::npos || lowerName.find("lookingforgroup") != std::string::npos;
        uint32 scopeId = channel->GetChannelId();
        if (!scopeId)
            scopeId = channel->GetChannelDBId();
        if (!scopeId)
            scopeId = StableStringId(channelName);

        std::string key = "channel:" + channelName;

        ChatEvent event = BaseEvent(player, type, language, msg);
        event.eventType = "world_chat";
        event.channel = isWorld ? "world" : "channel";
        event.scopeId = scopeId;
        event.scopeName = channelName;
        event.scope = std::move(snapshot);
        QueueBatchedEvent(key, std::move(event), config.channelCooldownMs);
        return true;
    }

    void OnPlayerJustDied(Player* player) override
    {
        DirectorConfig config = GetConfig();
        if (!config.enabled || !config.deathEventsEnable || !player || !IsHardcoreCharacter(player))
            return;

        ScopeSnapshot snapshot = SnapshotNamedChannel(config.worldChannelName);
        if (snapshot.humanCount == 0 || snapshot.botCount == 0)
            return;

        if (ShouldThrottle("death:" + std::string(player->GetName()), config.deathCooldownMs))
            return;

        std::string cause = TakePendingDeathCause(player);
        std::string deathMessage = cause.empty()
            ? Acore::StringFormat("<HC> {} died at level {} in {}.",
                player->GetName(), player->GetLevel(), GetLocationName(player))
            : Acore::StringFormat("<HC> {} died at level {} in {}, {}.",
                player->GetName(), player->GetLevel(), GetLocationName(player), cause);

        ChatEvent event = BaseEvent(player, CHAT_MSG_CHANNEL, LANG_UNIVERSAL,
            deathMessage);
        event.eventType = "hardcore_death";
        event.channel = "world";
        event.scopeId = StableStringId(config.worldChannelName);
        event.scopeName = config.worldChannelName;
        event.scope = std::move(snapshot);
        ForwardEvent(std::move(event));
    }

    void OnPlayerEnvironmentalDamage(Player* player, uint8 type, uint32 damage) override
    {
        if (!player || damage < player->GetHealth())
            return;

        RecordPendingDeathCause(player, EnvironmentalCause(type));
    }
};

class llm_npc_director_unitscript : public UnitScript
{
public:
    llm_npc_director_unitscript() : UnitScript("llm_npc_director_unitscript") { }

    void OnDamage(Unit* attacker, Unit* victim, uint32& damage) override
    {
        if (!attacker || !victim || attacker == victim || damage < victim->GetHealth())
            return;

        Player* player = victim->ToPlayer();
        if (!player)
            return;

        if (Player* killerPlayer = attacker->GetCharmerOrOwnerPlayerOrPlayerItself())
        {
            if (killerPlayer != player)
                RecordPendingDeathCause(player,
                    Acore::StringFormat("killed by {}", killerPlayer->GetName()));
            return;
        }

        if (Creature* creature = attacker->ToCreature())
            RecordPendingDeathCause(player,
                Acore::StringFormat("killed by {}", creature->GetName()));
    }
};
}

void Addmod_llm_npc_directorScripts()
{
    new llm_npc_director_worldscript();
    new llm_npc_director_playerscript();
    new llm_npc_director_unitscript();
}
