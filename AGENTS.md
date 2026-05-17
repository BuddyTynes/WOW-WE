# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

AzerothCore is an open-source MMORPG server emulator for World of Warcraft patch 3.3.5a (Wrath of the Lich King). It's a C++ project built with CMake, using MySQL for data storage. Licensed under GNU GPL v2.

## Build Commands

### Configure and build (out-of-source build required)

- Skip building unless explicitly requested.

```bash
# Create build directory and configure
mkdir -p build && cd build
cmake .. -DCMAKE_INSTALL_PREFIX=$HOME/azeroth-server -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DSCRIPTS=static -DMODULES=static

# Build (use appropriate core count)
make -j$(nproc)
make install
```

### Key CMake options

- `SCRIPTS`: none, static, dynamic, minimal-static, minimal-dynamic (default: static)
- `MODULES`: none, static, dynamic (default: static)
- `APPS_BUILD`: none, all, auth-only, world-only (default: all)
- `TOOLS_BUILD`: none, all, db-only, maps-only (default: none)
- `BUILD_TESTING`: Enable unit tests (default: OFF)
- `USE_COREPCH` / `USE_SCRIPTPCH`: Precompiled headers (default: ON)

### Unit tests

```bash
# Configure with testing enabled
cmake .. -DBUILD_TESTING=ON
make -j$(nproc)

# Run tests
./src/test/unit_tests
# or
ctest
```

Tests use Google Test and live in `src/test/`. The test binary links against the `game` library.

## Architecture

### Two server executables
- **authserver** (`src/server/apps/authserver/`): Handles authentication and realm selection (port 3724)
- **worldserver** (`src/server/apps/worldserver/`): Main game server handling all gameplay (port 8085)

### Source layout (`src/`)

- **`src/common/`** - Shared libraries: networking (Asio), cryptography, configuration, logging, threading, collision detection, utilities
- **`src/server/game/`** - Core game logic (~52 subsystems), the heart of the worldserver
- **`src/server/scripts/`** - Content scripts (bosses, spells, commands, instances)
- **`src/server/database/`** - Database abstraction layer and schema updater
- **`src/server/shared/`** - Code shared between auth and world servers (packets, network, realm definitions)
- **`src/test/`** - Unit tests (Google Test)

### Key game subsystems (`src/server/game/`)

- **Entities/** - Core game objects: `Player`, `Creature`, `Unit`, `Item`, `GameObject`
- **Spells/** - Spell mechanics, aura system, spell effects
- **Maps/** - Map management, grid system, instancing
- **Handlers/** - Client packet handlers (one file per system: `MovementHandler.cpp`, `SpellHandler.cpp`, etc.). These are methods on `WorldSession`
- **AI/** - Creature AI framework
- **Scripting/** - Script system with typed base classes (`ScriptObject` subclasses: `CreatureScript`, `SpellScript`, `InstanceMapScript`, `GameObjectScript`, `CommandScript`, etc.)
- **Server/** - `WorldSession` (per-player connection), `World` (global state), opcode definitions

### Scripting system

Scripts follow a registration pattern:
1. Define a class inheriting from `SpellScript`, `CreatureScript`, etc.
2. Implement an `AddSC_*()` function that calls `RegisterSpellScript(ClassName)` (or similar)
3. The `AddSC_*()` is declared and called from the regional `*_script_loader.cpp`
4. Script loaders per region: `spells_script_loader.cpp`, `eastern_kingdoms_script_loader.cpp`, `northrend_script_loader.cpp`, etc.
5. Spell script files are organized by class: `spell_dk.cpp`, `spell_mage.cpp`, `spell_generic.cpp`, etc.

### Three databases
- **acore_auth** - Accounts, realm list, bans (`data/sql/base/db_auth/`)
- **acore_characters** - Character data, inventories, progress (`data/sql/base/db_characters/`)
- **acore_world** - Game content: creatures, items, quests, spells, loot (`data/sql/base/db_world/`)

- SQL updates go in `data/sql/updates/pending_*` with separate subdirectories per database until pull request is merged. Pending SQL files are assigned random names.
- SQL updates go in `data/sql/updates/` with separate subdirectories per database after their pull request is merged.
- SQL files outside the `data/sql/updates/pending_*` folders should never be updated.

### Module system

External modules are loaded from the `modules/` directory. Each module is a subdirectory with its own `CMakeLists.txt`. Disable specific modules with `-DDISABLED_AC_MODULES="mod1;mod2"`. Module skeleton: https://github.com/azerothcore/skeleton-module/

The modules cloned into `modules/` are usually upstream/external repositories
and are ignored by the top-level repo. Do not make project-specific feature
changes directly inside cloned modules unless explicitly asked. For shareable
local behavior, create a new repo-owned companion module such as
`modules/mod-friend-boost` or `modules/mod-hardcore` and add a narrow
`.gitignore` exception for it. This
keeps upstream modules clean so they can be updated or recloned across machines
without losing project changes.

### LLM bridge and chat-pool setup

The repo-owned LLM bridge lives in `tools/WoWLlmBridge`. Keep runtime state
local: do not commit `tools/WoWLlmBridge/.env`, `tools/WoWLlmBridge/data`, or
the runtime SQLite database.

For `modules/mod-hardcore`, treat the `<HC>` name-query tag as the current
primary visible hardcore marker. `Hardcore.AuraSpellId` defaults to `0` until a
harmless built-in spell is found that reliably appears as a normal unit-frame
buff. Do not switch the default back to spell `21090`; it can scale characters
and is blocked by module diagnostics. Use `.hardcore aura status` and
`.hardcore aura test <spellId>` in game only when auditioning replacement
client-known marker spells. If the name tag format is changed or disabled,
document that players should clear the WoW client `Cache` folder because stale
name-query data can interfere with slash commands, friends, guild invites, and
playerbot commands.
The core target-name normalization hook intentionally lets modules strip that
display tag from client-supplied social/action targets while leaving character
creation and rename validation strict. Keep `/who` and shift-click who lookups
covered by this normalization too; the client may include the visible `<HC>`
tag in the who packet fields.

`mod-small-group-tweaks` owns small-realm behavior for `.online`, all-primary
profession slots, tool-gated Mining/Skinning/Fishing startup skills, automatic
delayed `World` channel rejoin, and LLM-mediated playerbot guild
invite/charter decisions. The startup gathering skills should not grant tools,
and Herbalism should stay trainer-driven unless the product intent changes.
Keep playerbot behavior overrides in repo-owned config/setup files or companion
modules, not in the cloned `mod-playerbots` repository.
If the `World` channel appears readable but the client cannot send to its
numbered slash channel, prefer resyncing the client join state with the normal
channel join packet over hidden server-only membership. Manual `/join World`
should always repair the client-side channel number.

`mod-llm-npc-director` should keep bot-origin chat from feeding back into the
director by default. Multi-bot World arguments and hardcore death pile-ons are
intentional queued director bursts, not general bot-to-bot replies.

Hardcore random-bot death replacement must create one replacement character,
not rerun `RandomPlayerbotFactory::CreateRandomBots()`. The bulk factory is a
startup/setup path and repeated runtime calls can append duplicate account IDs
to the playerbot config cache and inflate the available character pool.

The Spice of Life chat pool is portable through the tracked seed file at
`tools/WoWLlmBridge/seeds/spice_chat_pool.seed.jsonl`. Raw ElvUI exports in
`tools/ChatLogPool/unparsed logs` and copied files in
`tools/ChatLogPool/parsed logs` are local-only and ignored. If new raw logs are
provided, run:

```powershell
node .\tools\ChatLogPool\import-chat-logs.js
```

Commit the regenerated seed and parser/docs changes, not the raw or parsed log
files. Keep `SETUP.md` updated with any operator steps required for another
machine to rebuild and run the bridge.

Local llama.cpp binaries and GGUF models live under ignored `tools/local-llm`.
Use `scripts/start-local-llm.ps1` to run the local backend on port 8088. Keep
that script and `SETUP.md` aligned when llama.cpp flags change; the current
Windows build expects `--flash-attn on`, and this host uses `--cache-ram 0` to
avoid unstable background starts from the default prompt cache.

### Dependencies

Bundled in `deps/`: boost, MySQL client, OpenSSL, zlib, recastnavigation (pathfinding), g3dlite (geometry), fmt, argon2, jemalloc, and others.

## Commit Message Format

Uses Conventional Commits:
```
Type(Scope/Subscope): Short description (max 50 chars)
```

- **Types**: feat, fix, refactor, style, docs, test, chore
- **Scopes**: Core (C++ changes), DB (SQL changes)
- **Examples**: `fix(Core/Spells): Fix damage calculation for Fireball`, `fix(DB/SAI): Missing spell to NPC Hogger`

## Code Style

- 4-space indentation for C++ (no tabs)
- 2-space indentation for JSON, YAML, shell scripts
- UTF-8 encoding, LF line endings
- Max 80 character line length
- No braces around single-line statements
- Use {} to parse variables into output instead of %u etc.
- CI enforces code style checks and compiles with `-Werror`

## PR Requirements

- AI tool usage must be disclosed in PRs
- In-game testing expected
- Changes to generic code require regression testing of related systems
