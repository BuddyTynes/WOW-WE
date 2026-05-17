"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseLegacyDirectorPrompt,
  normalizeLegacyDirectorResponse,
  buildLegacyDirectorPrompt,
  extractLegacyMemories,
  extractLegacyContextMemories,
  extractLegacyWorldEventMemories,
  filterLegacyMemoriesForPrompt,
  buildBurstPrompt,
  normalizeBurstLines,
  parseBurstModel,
  tacticalAnswerFromContext,
  recentAnswerFromContext,
  answerFromMemories
} = require("../src/server");

test("legacy director prompt parser extracts eligible bot names", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "scope_name=Blood Pact",
    "speaker=Arcturas",
    "human_members_online=2",
    "bot_members_online=1",
    "eligible_bots=Krulkik, Lesa",
    "message=anyone want to run RFC?"
  ].join("\n"));

  assert.equal(parsed.channel, "guild");
  assert.deepEqual(parsed.bots, ["Krulkik", "Lesa"]);
  assert.equal(parsed.message, "anyone want to run RFC?");
});

test("legacy director normalizer forces C++ routeable JSON", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Krulkik",
    "message=hello guild"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Krulkik","message":"yo, I am here"}',
    parsed
  ));

  assert.equal(result.intent, "say_only");
  assert.equal(result.bot, "Krulkik");
  assert.equal(result.message, "yo, I am here");
});

test("legacy director normalizer accepts speaker-prefixed model chat", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Cumm",
    "message=Cumm, what is my irl name?"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    "Cumm: Buddy? Seriously? You made me remember that.",
    parsed,
    { knownAnswer: "Your irl name is Buddy.", memories: [{ summary: "Budmight's irl name is Buddy." }] }
  ));

  assert.equal(result.intent, "say_only");
  assert.equal(result.bot, "Cumm");
  assert.equal(result.message, "Buddy? Seriously? You made me remember that.");
});

test("legacy director normalizer suppresses repeated player text", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Krulkik",
    "message=anyone want to run RFC?"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Krulkik","message":"anyone want to run RFC?"}',
    parsed
  ));

  assert.equal(result.intent, "hold");
});

test("legacy director normalizer suppresses repeated bot text", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Cumm",
    "message=Cumm, Zar is dead, stop bringing him up"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Cumm","message":"Spiders again? Seriously, Zar? You wandered off again."}',
    parsed,
    {
      recentChat: [
        { speaker_name: "Cumm", direction: "out", text: "Spiders again? Seriously, Zar? You wandered off again." }
      ]
    }
  ));

  assert.equal(result.intent, "hold");
});

test("legacy director normalizer suppresses fuzzy repeated bot text", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Cumm",
    "message=also who said the boss rotation thing earlier?"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Cumm","message":"Sheep first, then moon. You got it?"}',
    parsed,
    {
      recentChat: [
        { speaker_name: "Cumm", direction: "out", text: "Sheep's the first, then the moon. Don't be a noob." }
      ]
    }
  ));

  assert.equal(result.intent, "hold");
});

test("legacy director normalizer strips overused openings from recent bot chat", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Cumm",
    "message=cumm swing back at zar"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Cumm","message":"Seriously? Zar argues like his keyboard has syrup in it."}',
    parsed,
    {
      recentChat: [
        { speaker_name: "Cumm", direction: "out", text: "Seriously? You're blaming pathing again?" }
      ]
    }
  ));

  assert.equal(result.intent, "say_only");
  assert.equal(result.message, "Zar argues like his keyboard has syrup in it.");
});

test("legacy director normalizer strips lazy stock openings", () => {
  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Cumm","message":"Seriously? That is a new low even for you."}',
    parseLegacyDirectorPrompt([
      "channel=guild",
      "human_members_online=1",
      "bot_members_online=1",
      "eligible_bots=Cumm",
      "message=i ate cereal from a measuring cup"
    ].join("\n")),
    { selectedBot: "Cumm", recentChat: [] }
  ));

  assert.equal(result.intent, "say_only");
  assert.equal(result.message, "That is a new low even for you.");
});

test("legacy director normalizer rejects clean banter dodge when asked to swing back", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Cumm",
    "message=both of you swing back harder, this argument is too clean"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Cumm","message":"You are right, Zartorg. Let us get this show on the road."}',
    parsed
  ));

  assert.equal(result.intent, "hold");
});

test("legacy director normalizer rejects likely truncated long lines", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Zartorg",
    "message=my desk has coffee rings on coffee rings"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Zartorg","message":"Ugh, coffee rings? The lack of discipline in this guild is appalling and you would think someone could manage a clean"}',
    parsed
  ));

  assert.equal(result.intent, "hold");
});

test("legacy director normalizer rejects memory-write answer to a question", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "speaker=Budmight",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Cumm",
    "message=what is my irl name?"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Cumm","message":"Got it, I will remember that."}',
    parsed,
    { memories: [] }
  ));

  assert.equal(result.intent, "hold");
});

test("legacy director normalizer allows non-canned model answer for unknown profile question", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "speaker=Budmight",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Cumm",
    "message=Cumm, what is my irl name?"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Cumm","message":"What the hell is your name?"}',
    parsed,
    { memories: [] }
  ));

  assert.equal(result.intent, "say_only");
  assert.equal(result.message, "What the hell is your name?");
});

test("legacy director normalizer allows in-character profile answer from memory", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "speaker=Budmight",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Cumm",
    "message=what is my irl name?"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Cumm","message":"Buddy, obviously. You made us remember it."}',
    parsed,
    { memories: [{ kind: "fact", weight: 9, summary: "Budmight's irl name is Buddy." }] }
  ));

  assert.equal(result.intent, "say_only");
  assert.equal(result.message, "Buddy, obviously. You made us remember it.");
});

test("legacy director does not force acknowledgement when model holds", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "speaker=Budmight",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Cumm",
    "message=Cumm, remember that my irl name is Buddy"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"hold"}',
    parsed,
    { memoryWrite: true, memoryAck: true, memoryWrites: ["mem_1"] }
  ));

  assert.equal(result.intent, "hold");
});

test("legacy director does not acknowledge passive memory writes", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "speaker=Budmight",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Cumm",
    "message=my irl name is Buddy"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"hold"}',
    parsed,
    {
      memoryWrite: true,
      memoryAck: false,
      memoryWrites: ["mem_1"],
      memories: [{ kind: "fact", weight: 8, summary: "Budmight's irl name is Buddy." }]
    }
  ));

  assert.equal(result.intent, "hold");
});

test("legacy director rejects canned memory acknowledgement for normal chat", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "speaker=Budmight",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Cumm",
    "message=my irl name is Buddy"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Cumm","message":"Got it, I will remember that."}',
    parsed,
    { memoryWrite: true, memoryAck: false, memoryWrites: ["mem_1"] }
  ));

  assert.equal(result.intent, "hold");
});

test("legacy director normalizer honors directly addressed bot", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "human_members_online=1",
    "bot_members_online=2",
    "eligible_bots=Cumm, Zartorg",
    "message=Zartorg, tell Cumm the plan"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Cumm","message":"stick to the plan"}',
    parsed
  ));

  assert.equal(result.intent, "say_only");
  assert.equal(result.bot, "Zartorg");
});

test("legacy director extracts simple durable player facts", () => {
  const parsed = parseLegacyDirectorPrompt([
    "speaker=Buddy",
    "message=remember that my favorite mount is the kodo"
  ].join("\n"));

  const memories = extractLegacyMemories(parsed);

  assert.equal(memories.length, 2);
  assert.match(memories[0].summary, /Buddy asked me to remember/);
  assert.match(memories[1].summary, /Buddy's favorite mount is the kodo/);
});

test("legacy director ignores transient false-positive facts", () => {
  const parsed = parseLegacyDirectorPrompt([
    "speaker=Buddy",
    "message=my target is skull and I am out of mana right now"
  ].join("\n"));

  assert.deepEqual(extractLegacyMemories(parsed), []);
});

test("legacy director stores passive durable facts silently", () => {
  const parsed = parseLegacyDirectorPrompt([
    "speaker=Buddy",
    "message=my irl name is Buddy"
  ].join("\n"));

  const memories = extractLegacyMemories(parsed);

  assert.equal(memories.length, 1);
  assert.equal(memories[0].acknowledge, false);
  assert.match(memories[0].summary, /Buddy's irl name is Buddy/);
});

test("legacy director stores and answers sleep schedule facts", () => {
  const parsed = parseLegacyDirectorPrompt([
    "speaker=Arcturas",
    "message=my sleep schedule is midnight snack at 1am then pretending 6am is a personality trait"
  ].join("\n"));
  const memories = extractLegacyMemories(parsed);

  assert.equal(memories.length, 1);
  assert.match(memories[0].summary, /sleep schedule is midnight snack/);
  assert.match(answerFromMemories({
    speaker: "Arcturas",
    message: "what was my sleep schedule thing from earlier?"
  }, { memories }), /midnight snack at 1am/);
});

test("legacy director avoids stale tactical answers for non-tactical memory questions", () => {
  const answer = tacticalAnswerFromContext({
    speaker: "Arcturas",
    message: "cumm what was my sleep schedule thing from earlier, short version",
    bots: ["Cumm", "Zartorg"]
  }, [
    { direction: "in", speaker_name: "Arcturas", text: "skull first x second diamond fear moon sheep" }
  ]);

  assert.equal(answer, "");
});

test("legacy director stores casual durable snack facts", () => {
  const parsed = parseLegacyDirectorPrompt([
    "speaker=Buddy",
    "message=my gas station snack is sour worms and blue gatorade"
  ].join("\n"));

  const memories = extractLegacyMemories(parsed);

  assert.equal(memories.length, 1);
  assert.equal(memories[0].acknowledge, false);
  assert.match(memories[0].summary, /Buddy's gas station snack is sour worms and blue gatorade/);
});

test("legacy director forces tactical answer when model holds", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "speaker=Buddy",
    "human_members_online=1",
    "bot_members_online=2",
    "eligible_bots=Cumm, Zartorg",
    "message=star sap moon sheep skull runner x healer, cumm call the first two kills"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"hold"}',
    parsed,
    {
      selectedBot: "Cumm",
      tacticalAnswer: "Skull dies first, then X. Moon stays sheeped. Star stays sapped."
    }
  ));

  assert.equal(result.intent, "say_only");
  assert.equal(result.bot, "Cumm");
  assert.match(result.message, /Skull dies first, then X/);
  assert.match(result.message, /Star stays sapped/);
});

test("legacy director forces purple fear caller answer", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "speaker=Ethan",
    "human_members_online=1",
    "bot_members_online=2",
    "eligible_bots=Cumm, Zartorg",
    "message=who said purple fear spam again"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"hold"}',
    parsed,
    {
      selectedBot: "Zartorg",
      tacticalAnswer: "Buddy called purple fear spam. Purple gets fear spam."
    }
  ));

  assert.equal(result.intent, "say_only");
  assert.match(result.message, /Buddy called purple fear spam/);
  assert.match(result.message, /Purple gets fear spam/);
});

test("legacy director extracts corrections as instructions", () => {
  const parsed = parseLegacyDirectorPrompt([
    "speaker=Buddy",
    "message=Cumm Zar is dead stop bringing up Zar"
  ].join("\n"));

  const memories = extractLegacyMemories(parsed);

  assert.ok(memories.some((memory) => memory.kind === "instruction" && /Zar is dead/.test(memory.summary)));
  assert.ok(memories.some((memory) => memory.kind === "instruction" && /stop bringing up Zar/i.test(memory.summary)));
});

test("legacy director does not extract question memories", () => {
  const parsed = parseLegacyDirectorPrompt([
    "speaker=Budmight",
    "message=do you remember that my irl name?"
  ].join("\n"));

  assert.deepEqual(extractLegacyMemories(parsed), []);
});

test("legacy director prompt blocks trivia assistant behavior", () => {
  const prompt = buildLegacyDirectorPrompt({
    channel: "guild",
    scopeName: "Blood Pact",
    speaker: "Arcturas",
    bots: ["Krulkik"],
    message: "hello"
  }, {
    memories: [{ summary: "Arcturas's favorite color is blue." }],
    recentChat: [{ speaker_name: "Arcturas", text: "what is my favorite color?" }]
  });

  assert.match(prompt, /Do not ask trivia questions/);
  assert.match(prompt, /Never repeat/);
  assert.match(prompt, /final message= line is the message you are answering now/);
  assert.match(prompt, /If the latest message changes topic/);
  assert.match(prompt, /favorite color is blue/);
  assert.doesNotMatch(prompt, /KNOWN_ANSWER=/);
  assert.match(prompt, /authoritative short-term memory/);
  assert.match(prompt, /Return only minified JSON/);
  assert.match(prompt, /Do not write say_only\|hold/);
});

test("legacy director prompt includes named short-term chat context", () => {
  const prompt = buildLegacyDirectorPrompt({
    channel: "guild",
    scopeName: "WeCameWithBrokenTeeth",
    speaker: "Arcturas",
    bots: ["Cumm", "Zartorg"],
    message: "what was dumb about what zartorg said?"
  }, {
    recentChat: [
      { speaker_name: "Cumm", direction: "out", text: "Zartorg marked the wrong target again." },
      { speaker_name: "Zartorg", direction: "out", text: "The next pull requires discipline, not Cumm's nonsense." },
      { speaker_name: "Arcturas", direction: "in", text: "what was dumb about what zartorg said?" }
    ],
    recentContextHint: "Context clues for the player's current message:\nZartorg: The next pull requires discipline, not Cumm's nonsense."
  });

  assert.match(prompt, /Cumm: Zartorg marked the wrong target again/);
  assert.match(prompt, /Zartorg: The next pull requires discipline/);
  assert.match(prompt, /Context clues/);
});

test("legacy director answers own recent life detail with singular/plural context", () => {
  const prompt = buildLegacyDirectorPrompt({
    channel: "guild",
    scopeName: "WeCameWithBrokenTeeth",
    speaker: "Arcturas",
    bots: ["Cumm", "Zartorg"],
    message: "cumm did you catch the sock problem or are we only judging tacos"
  }, {
    selectedBot: "Cumm",
    contextAnswer: "Arcturas said \"i have laundry in the dryer and zero clean socks this is elite planning\". Answer that recent detail first.",
    recentChat: [
      { speaker_name: "Arcturas", direction: "in", text: "i have laundry in the dryer and zero clean socks this is elite planning" },
      { speaker_name: "David", direction: "in", text: "i ate gas station tacos and now every pull feels like a medical decision" }
    ]
  });

  assert.match(prompt, /CONTEXT_ANSWER=Arcturas said/);
  assert.match(prompt, /zero clean socks/);
});

test("legacy director prefers speaker's own recent detail when asking about my problem", () => {
  const answer = recentAnswerFromContext({
    speaker: "Arcturas",
    bots: ["Cumm", "Zartorg"],
    message: "zar did you catch my laundry tool problem or are we bullying joes cup cereal"
  }, [
    { speaker_name: "Arcturas", direction: "in", text: "i found a screwdriver in the laundry and now the whole house feels suspicious" },
    { speaker_name: "Joe", direction: "in", text: "i ate cereal out of a measuring cup because every bowl vanished" }
  ]);

  assert.match(answer, /screwdriver in the laundry/);
  assert.doesNotMatch(answer, /Joe/);
});

test("legacy director gives safe practical advice before selling important items", () => {
  const answer = recentAnswerFromContext({
    speaker: "Arcturas",
    bots: ["Cumm", "Zartorg"],
    message: "cumm one useful line before i sell something important and blame the auction house"
  }, [
    { speaker_name: "Arcturas", direction: "in", text: "my bank alt is full and every bag slot is a tiny personal insult" }
  ]);

  assert.match(answer, /Do not sell anything important/);
  assert.match(answer, /dump gray junk/);
});

test("legacy director forces useful context answer over weak model joke", () => {
  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Cumm","message":"Double click it, or I am blaming David."}',
    parseLegacyDirectorPrompt([
      "channel=guild",
      "human_members_online=1",
      "bot_members_online=1",
      "eligible_bots=Cumm",
      "message=cumm one useful line before i blame the mouse the bags and maybe david"
    ].join("\n")),
    {
      selectedBot: "Cumm",
      contextAnswer: "The mouse is double-clicking; swap it or raise debounce before blaming the game."
    }
  ));

  assert.equal(result.intent, "say_only");
  assert.match(result.message, /mouse is double-clicking|swap it|debounce/i);
  assert.doesNotMatch(result.message, /blaming David/i);
});

test("legacy director holds movement claims for action hook lane", () => {
  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Cumm","message":"Just get here already."}',
    parseLegacyDirectorPrompt([
      "channel=guild",
      "human_members_online=1",
      "bot_members_online=1",
      "eligible_bots=Cumm",
      "message=cumm come here after this pull, and be honest if movement is busted"
    ].join("\n")),
    { selectedBot: "Cumm" }
  ));

  assert.equal(result.intent, "hold");
  assert.doesNotMatch(result.message || "", /Movement hook is not wired yet|Just get here/i);
});

test("legacy director prompt includes known answer for model-voiced memory recall", () => {
  const prompt = buildLegacyDirectorPrompt({
    channel: "guild",
    scopeName: "WeCameWithBrokenTeeth",
    speaker: "Budmight",
    bots: ["Cumm", "Zartorg"],
    message: "Cumm, what is my irl name?"
  }, {
    selectedBot: "Cumm",
    knownAnswer: "Your irl name is Buddy.",
    memories: [{ summary: "Budmight's irl name is Buddy." }],
    recentChat: []
  });

  assert.match(prompt, /KNOWN_ANSWER=Your irl name is Buddy/);
  assert.match(prompt, /answer that fact in your own voice/);
});

test("legacy director extracts relationship memory from recent bot callout", () => {
  const parsed = {
    speaker: "Arcturas",
    bots: ["Cumm", "Zartorg"],
    message: "Zartorg was right about that pull"
  };
  const memories = extractLegacyContextMemories(parsed, [
    { speaker_name: "Cumm", direction: "out", text: "pull now, planning is for cowards" },
    { speaker_name: "Zartorg", direction: "out", text: "wait for mana or we wipe again" }
  ]);

  assert.equal(memories.length, 1);
  assert.match(memories[0].summary, /Arcturas reacted to Zartorg/);
  assert.match(memories[0].summary, /wait for mana/);
});

test("legacy director skips relationship memory for ordinary help requests", () => {
  const parsed = {
    speaker: "Arcturas",
    bots: ["Cumm", "Zartorg"],
    message: "cumm give me one useful line before i blame the router too"
  };
  const memories = extractLegacyContextMemories(parsed, [
    { speaker_name: "Cumm", direction: "out", text: "The router is cursed and so are your bags." }
  ]);

  assert.deepEqual(memories, []);
});

test("legacy director skips relationship memory for profile questions", () => {
  const parsed = {
    speaker: "Budmight",
    bots: ["Cumm", "Zartorg"],
    message: "Cumm, what is my irl name?"
  };
  const memories = extractLegacyContextMemories(parsed, [
    { speaker_name: "Cumm", direction: "out", text: "Got it, I'll remember that." }
  ]);

  assert.deepEqual(memories, []);
});

test("legacy director stores world death events as system memory", () => {
  const memories = extractLegacyWorldEventMemories({
    eventType: "hardcore_death",
    channel: "world",
    scopeName: "World",
    message: "<HC> Gragnok died at level 9 in Durotar."
  });

  assert.equal(memories.length, 1);
  assert.equal(memories[0].kind, "system_note");
  assert.match(memories[0].summary, /Gragnok died/);
});

test("legacy director makes dead hardcore bot complain instead of self-roast", () => {
  const normalized = JSON.parse(normalizeLegacyDirectorResponse(JSON.stringify({
    intent: "say_only",
    bot: "Gragnok",
    message: "rip me l bozo"
  }), {
    eventType: "hardcore_death",
    channel: "world",
    humanCount: 1,
    botCount: 1,
    bots: ["Gragnok"],
    speaker: "Gragnok",
    deathCharacter: "Gragnok",
    deathCause: "fell to their death",
    deathLocation: "Durotar",
    message: "<HC> Gragnok died at level 9 in Durotar, fell to their death."
  }, {
    selectedBot: "Gragnok"
  }));

  assert.equal(normalized.intent, "say_only");
  assert.match(normalized.message, /I just died/i);
  assert.match(normalized.message, /Durotar/);
  assert.doesNotMatch(normalized.message, /bozo|rip/i);
});

test("legacy director strips practical helper labels from forced recent answers", () => {
  const parsed = {
    humanCount: 1,
    botCount: 1,
    bots: ["Zartorg"],
    message: "zartorg give me one useful line before i delete spoons"
  };
  const normalized = JSON.parse(normalizeLegacyDirectorResponse(JSON.stringify({ intent: "hold" }), parsed, {
    selectedBot: "Zartorg",
    contextAnswer: "Bags are full; vendor gray junk before the next pull. Answer that practical bit first."
  }));

  assert.equal(normalized.intent, "say_only");
  assert.match(normalized.message, /Bags are full; vendor gray junk/);
  assert.doesNotMatch(normalized.message, /Answer that practical bit first/);
});

test("legacy director tactical answers respect one-slice requests", () => {
  const recentChat = [
    {
      direction: "in",
      speaker_name: "Buddy",
      text: "skull first x second moon sheep star sap purple fear, cumm call only first kill"
    }
  ];

  assert.equal(tacticalAnswerFromContext({
    speaker: "Buddy",
    message: "cumm call only first kill",
    bots: ["Cumm", "Zartorg"]
  }, recentChat), "Skull dies first.");

  assert.equal(tacticalAnswerFromContext({
    speaker: "Buddy",
    message: "who called star sap and dont recap the whole bible",
    bots: ["Cumm", "Zartorg"]
  }, recentChat), "Buddy called star sap.");

  const noLecture = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Zartorg","message":"It was Arcturas. And frankly, the theatrics are exhausting."}',
    parseLegacyDirectorPrompt([
      "channel=guild",
      "human_members_online=1",
      "bot_members_online=1",
      "eligible_bots=Zartorg",
      "message=who called star sap no lecture no packet dump"
    ].join("\n")),
    {
      selectedBot: "Zartorg",
      tacticalAnswer: "Arcturas called star sap."
    }
  ));
  assert.equal(noLecture.message, "Arcturas called star sap.");

  assert.equal(tacticalAnswerFromContext({
    speaker: "Buddy",
    message: "moon sheep star sap skull first x second, cumm only say who gets sheeped",
    bots: ["Cumm", "Zartorg"]
  }, recentChat), "Moon gets sheeped.");

  assert.equal(tacticalAnswerFromContext({
    speaker: "Buddy",
    message: "skull first x second diamond fear moon sheep, cumm only tell me the fear target",
    bots: ["Cumm", "Zartorg"]
  }, recentChat), "Diamond gets feared.");

  assert.equal(tacticalAnswerFromContext({
    speaker: "Jason",
    message: "who said skull first no full TED talk",
    bots: ["Cumm", "Zartorg"]
  }, recentChat), "Buddy called skull first.");

  assert.equal(tacticalAnswerFromContext({
    speaker: "Buddy",
    message: "if x starts freecasting what do we do, just that slice",
    bots: ["Cumm", "Zartorg"]
  }, recentChat), "If X healer freecasts, swap to or interrupt X; otherwise skull first, then X.");

  assert.equal(tacticalAnswerFromContext({
    speaker: "Buddy",
    message: "cumm come to me after this pull and dont pretend you did it if hooks are busted",
    bots: ["Cumm", "Zartorg"]
  }, recentChat), "");

  assert.equal(tacticalAnswerFromContext({
    speaker: "Buddy",
    message: "did you hear the coffee crime or the shoe thing",
    bots: ["Cumm", "Zartorg"]
  }, [
    { direction: "out", speaker_name: "Zartorg", text: "A dungeon run deserves better than recycled coffee." }
  ]), "");
});

test("legacy director filters unrelated durable memories out of non-profile chatter", () => {
  const filtered = filterLegacyMemoriesForPrompt({
    message: "cumm quit sounding HR approved and swing back at zartorg",
    bots: ["Cumm", "Zartorg"]
  }, [
    { kind: "preference", summary: "Arcturas's panic dinner is microwave rice with bbq sauce." },
    { kind: "relationship", summary: "Arcturas said Zartorg has clipboard energy and panics around string cheese." }
  ]);

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].kind, "relationship");
  assert.doesNotMatch(filtered.map((memory) => memory.summary).join("\n"), /microwave rice/);
});

test("director burst prompt asks for death pile-on roasts", () => {
  const prompt = buildBurstPrompt({
    burst_type: "death_pile_on",
    requested_count: 4,
    eligible_bots: ["Bork", "Zan", "Miri", "Laz"],
    death_character: "Finian",
    death_cause: "fell to their death",
    death_location: "The Barrens",
    death_level: 14
  }, {
    eligibleBots: ["Bork", "Zan", "Miri", "Laz"],
    requestedCount: 4,
    spiceLines: [{ message: "cute you thought we were getting an event", channel_type: "world", allow_exact: true }]
  });

  assert.match(prompt, /L bozo/);
  assert.match(prompt, /Pick 4 different bots/);
  assert.match(prompt, /fell to their death/);
});

test("director burst normalizer accepts unique valid bot lines", () => {
  const raw = "{\"lines\":[{\"bot\":\"Bork\",\"message\":\"L bozo\",\"delay_ms\":1000},{\"bot\":\"Zan\",\"message\":\"rip gravity got another one\",\"delay_ms\":2000}]}";
  const lines = parseBurstModel(raw);
  const normalized = normalizeBurstLines(lines, {
    burst_type: "death_pile_on",
    death_character: "Finian"
  }, {
    eligibleBots: ["Bork", "Zan", "Miri"],
    requestedCount: 3,
    recentChat: []
  });

  assert.equal(normalized.accepted.length, 2);
  assert.equal(normalized.accepted[0].message, "L bozo");
  assert.equal(normalized.rejected.length, 0);
});

test("director burst normalizer rejects duplicate, invalid, command, and dead bot lines", () => {
  const normalized = normalizeBurstLines([
    { bot: "Finian", message: "L bozo" },
    { bot: "Bork", message: ".boost me 80" },
    { bot: "Nope", message: "rip" },
    { bot: "Zan", message: "same old line" },
    { bot: "Miri", message: "skill issue" },
    { bot: "Miri", message: "second try" }
  ], {
    burst_type: "death_pile_on",
    death_character: "Finian"
  }, {
    eligibleBots: ["Finian", "Bork", "Zan", "Miri"],
    requestedCount: 4,
    recentChat: [{ text: "same old line" }]
  });

  assert.deepEqual(normalized.accepted.map((line) => line.bot), ["Miri"]);
  assert.ok(normalized.rejected.some((line) => line.reason === "dead_bot_in_pile_on"));
  assert.ok(normalized.rejected.some((line) => line.reason === "command_like"));
  assert.ok(normalized.rejected.some((line) => line.reason === "invalid_bot"));
  assert.ok(normalized.rejected.some((line) => line.reason === "recent_repeat"));
  assert.ok(normalized.rejected.some((line) => line.reason === "duplicate_bot"));
});
