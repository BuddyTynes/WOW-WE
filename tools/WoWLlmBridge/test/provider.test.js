"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { flattenMessages, extractOpenAiText, extractGeminiText, capPrompt, cleanupOutput } = require("../src/provider");

test("flattenMessages preserves role order", () => {
  const result = flattenMessages([
    { role: "system", content: "stay in character" },
    { role: "user", content: "hello" }
  ]);

  assert.equal(result, "system: stay in character\nuser: hello");
});

test("extractOpenAiText reads chat completion text", () => {
  const result = extractOpenAiText({
    choices: [{ message: { content: "zug zug" } }]
  });

  assert.equal(result, "zug zug");
});

test("extractGeminiText reads candidate parts", () => {
  const result = extractGeminiText({
    candidates: [
      {
        content: {
          parts: [{ text: "for the horde" }]
        }
      }
    ]
  });

  assert.equal(result, "for the horde");
});

test("capPrompt keeps the newest bounded prompt text", () => {
  const result = capPrompt("0123456789", { maxPromptChars: 4 });

  assert.equal(result, "6789");
});

test("cleanupOutput strips reasoning and caps text", () => {
  const result = cleanupOutput("<think>secret</think>\ntool_call: nope\nzug zug forever", { maxOutputChars: 7 });

  assert.equal(result, "zug zug");
});
