"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseLegacyDirectorPrompt,
  normalizeLegacyDirectorResponse,
  buildLegacyDirectorPrompt,
  extractLegacyMemories,
  extractLegacyContextMemories,
  extractLegacyWorldEventMemories
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

  assert.equal(result.intent, "say_only");
  assert.notEqual(result.message.toLowerCase(), "anyone want to run rfc?");
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

  assert.equal(result.intent, "say_only");
  assert.equal(result.bot, "Cumm");
  assert.match(result.message, /Dropping it/);
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

  assert.equal(result.intent, "say_only");
  assert.equal(result.message, "I don't know that yet.");
});

test("legacy director normalizer overrides model dodge for profile question", () => {
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

  assert.equal(result.message, "I don't know that yet.");
});

test("legacy director normalizer answers simple profile question from memory", () => {
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
    { memories: [{ kind: "fact", weight: 9, summary: "Budmight's irl name is Buddy." }] }
  ));

  assert.equal(result.intent, "say_only");
  assert.equal(result.message, "Your irl name is Buddy.");
});

test("legacy director acknowledges memory write even when model holds", () => {
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
    { memoryWrite: true, memoryWrites: ["mem_1"] }
  ));

  assert.equal(result.intent, "say_only");
  assert.equal(result.bot, "Cumm");
  assert.equal(result.message, "Got it, I'll remember that.");
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
  assert.match(prompt, /favorite color is blue/);
  assert.match(prompt, /authoritative short-term memory/);
  assert.match(prompt, /Return only minified JSON/);
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
