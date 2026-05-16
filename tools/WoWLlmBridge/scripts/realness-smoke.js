"use strict";

const assert = require("node:assert/strict");
const {
  parseLegacyDirectorPrompt,
  normalizeLegacyDirectorResponse,
  buildLegacyDirectorPrompt,
  extractLegacyMemories
} = require("../src/server");

function parsed(lines) {
  return parseLegacyDirectorPrompt([
    "channel=guild",
    "scope_name=WeCameWithBrokenTeeth",
    "speaker=Arcturas",
    "speaker_guid=42",
    "human_members_online=2",
    "bot_members_online=2",
    "eligible_bots=Cumm, Zartorg",
    ...lines
  ].join("\n"));
}

function action(raw, event, context = {}) {
  return JSON.parse(normalizeLegacyDirectorResponse(raw, event, context));
}

function assertNotAssistantLike(text) {
  assert.doesNotMatch(text, /\b(as an ai|i can assist|how can i help|i'll remember that|got it,? i'll remember|got it,? i will remember)\b/i);
}

function assertGuildLine(text) {
  assert.ok(text.length >= 8, `too short: ${text}`);
  assert.ok(text.length <= 180, `too long: ${text}`);
  assertNotAssistantLike(text);
  assert.doesNotMatch(text, /^(yes|no|okay|ok)$/i);
}

const passiveFact = parsed(["message=my irl name is Buddy"]);
const passiveMemories = extractLegacyMemories(passiveFact);
assert.equal(passiveMemories.length, 1);
assert.equal(passiveMemories[0].acknowledge, false);
assert.equal(action(
  '{"intent":"hold"}',
  passiveFact,
  { selectedBot: "Cumm", memoryWrite: true, memoryAck: false, memoryWrites: ["mem_1"], memories: passiveMemories }
).intent, "hold");

const fakeAck = action(
  '{"intent":"say_only","bot":"Cumm","message":"Got it, I will remember that."}',
  passiveFact,
  { selectedBot: "Cumm", memoryWrite: true, memoryAck: false, memoryWrites: ["mem_1"], memories: passiveMemories }
);
assert.equal(fakeAck.intent, "hold");

const cummMove = action(
  "{\"intent\":\"say_only\",\"bot\":\"Cumm\",\"message\":\"Movement hook still ain't wired, I'd just path into a wall.\"}",
  parsed(["message=Cumm come to me"]),
  { selectedBot: "Cumm" }
);
assertGuildLine(cummMove.message);
assert.match(cummMove.message, /movement|wired|path/i);

const zartorgMove = action(
  '{"intent":"say_only","bot":"Zartorg","message":"Movement command is not wired yet; mark skull while we wait."}',
  parsed(["message=Zartorg come to me"]),
  { selectedBot: "Zartorg" }
);
assertGuildLine(zartorgMove.message);
assert.match(zartorgMove.message, /movement|hook|order|command/i);
assert.notEqual(cummMove.message, zartorgMove.message);

const contextPrompt = buildLegacyDirectorPrompt(parsed([
  "message=what was dumb about what zartorg said?"
]), {
  selectedBot: "Cumm",
  guildBots: ["Zartorg"],
  recentChat: [
    { speaker_name: "Zartorg", direction: "out", text: "Wait for mana or this pull turns into another corpse run." },
    { speaker_name: "Cumm", direction: "out", text: "Mana is just a suggestion." }
  ],
  memories: [
    { summary: "Arcturas's irl name is Buddy." },
    { summary: "Cumm and Zartorg argue about pull timing." }
  ],
  recentContextHint: "Context clues for the player's current message:\nZartorg: Wait for mana or this pull turns into another corpse run."
});

assert.match(contextPrompt, /Voice rule/);
assert.match(contextPrompt, /authoritative short-term memory/);
assert.match(contextPrompt, /Zartorg: Wait for mana/);
assert.match(contextPrompt, /Cumm and Zartorg argue/);

const recallPrompt = buildLegacyDirectorPrompt(parsed([
  "message=Cumm, what is my irl name?"
]), {
  selectedBot: "Cumm",
  knownAnswer: "Your irl name is Buddy.",
  memories: [{ summary: "Codexsmoke's irl name is Buddy." }],
  recentChat: []
});
assert.match(recallPrompt, /KNOWN_ANSWER=Your irl name is Buddy/);
assert.match(recallPrompt, /own voice/);

const repeated = action(
  '{"intent":"say_only","bot":"Cumm","message":"Mana is just a suggestion."}',
  parsed(["message=Cumm what did Zartorg say before that?"]),
  {
    selectedBot: "Cumm",
    recentChat: [
      { speaker_name: "Cumm", direction: "out", text: "Mana is just a suggestion." }
    ],
    memoryCount: 1
  }
);
assert.equal(repeated.intent, "hold");

console.log(JSON.stringify({
  ok: true,
  cases: 7,
  examples: {
    fakeAck: fakeAck.intent,
    cummMove: cummMove.message,
    zartorgMove: zartorgMove.message,
    repeated: repeated.intent
  }
}, null, 2));
