# Module Manifest

This server is the `mod-playerbots/azerothcore-wotlk` fork plus local modules under `modules`.

The module directories are ignored by upstream `.gitignore`, so clone them after cloning this repo.

```powershell
cd C:\Users\Buddy\Documents\wow-ai-server\azerothcore-wotlk
git clone https://github.com/mod-playerbots/mod-playerbots.git modules/mod-playerbots
git clone https://github.com/DustinHendrickson/mod-ollama-chat.git modules/mod-ollama-chat
git clone https://github.com/ZhengPeiRu21/mod-individual-progression.git modules/mod-individual-progression
git clone https://github.com/NathanHandley/mod-ah-bot.git modules/mod-ah-bot-plus
git clone https://github.com/azerothcore/mod-aoe-loot.git modules/mod-aoe-loot
```

Current tested commits:

```text
mod-playerbots             531282e4beb0a5abea6332479f8720518a89b1a2
mod-ollama-chat            8ba5e791f0a84ee04636f0b19b62d3c4aff3dce1
mod-individual-progression 822b53028853b7e93b6cfce2056b8b9a9ccc3589
mod-ah-bot-plus            1822d96072a5168a775551fa5017ec947c9fbf7b
mod-aoe-loot               2ddf6ff75bdbfee3c81f2c149a07126f1d0bf200
```

Pin exact versions with:

```powershell
git -C modules/mod-playerbots checkout 531282e4beb0a5abea6332479f8720518a89b1a2
git -C modules/mod-ollama-chat checkout 8ba5e791f0a84ee04636f0b19b62d3c4aff3dce1
git -C modules/mod-individual-progression checkout 822b53028853b7e93b6cfce2056b8b9a9ccc3589
git -C modules/mod-ah-bot-plus checkout 1822d96072a5168a775551fa5017ec947c9fbf7b
git -C modules/mod-aoe-loot checkout 2ddf6ff75bdbfee3c81f2c149a07126f1d0bf200
```

## Active Gameplay Choices

Current host config is intended to be:

```text
Playerbots: 250 random bots
XP: 1.2x
Progression: Vanilla phase 1
Hardcore: command opt-in, with 25% random playerbot opt-in
Small-group tweaks: .online real-player list and all primary profession slots
AOE loot: enabled
Auction House bot: enabled, healthy stock target
LLM whispers: enabled through wow-llm-bridge
LLM NPC director: forwards human-guild and party chat events to wow-llm-bridge
Name profanity/strict-name checks: disabled
Cross-faction: guild invites, friend status, and whispers enabled
```

The runtime module config files live under:

```text
env/dist/etc/modules
```

Important files:

```text
mod_ahbot.conf
mod_aoe_loot.conf
mod_ollama_chat.conf
individualProgression.conf
hardcore.conf
llm_npc_director.conf
playerbots.conf
```

`mod_ahbot.conf` must remain based on the full `mod_ahbot.conf.dist`; a tiny override-only file caused empty listing-proportion errors and no auctions.

`mod-friend-boost`, `mod-hardcore`, `mod-small-group-tweaks`, and
`mod-llm-npc-director` are repo-owned modules. Keep custom module work in
repo-owned modules so the cloned third-party modules can be updated or shared
without carrying local patches.
