"use strict";

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") {
      const timeoutError = new Error(`request timed out after ${timeoutMs}ms`);
      timeoutError.code = "REQUEST_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function flattenMessages(messages, fallbackPrompt) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return String(fallbackPrompt || "");
  }

  return messages
    .map((message) => {
      const role = message && message.role ? message.role : "user";
      const content = message && message.content ? message.content : "";
      return `${role}: ${content}`;
    })
    .join("\n");
}

function extractOpenAiText(payload) {
  if (payload && typeof payload.output_text === "string") {
    return payload.output_text;
  }

  if (payload && Array.isArray(payload.choices) && payload.choices[0]) {
    const message = payload.choices[0].message;
    if (message && typeof message.content === "string") {
      return message.content;
    }
    if (typeof payload.choices[0].text === "string") {
      return payload.choices[0].text;
    }
  }

  return "";
}

function capPrompt(prompt, config) {
  const text = String(prompt || "");
  if (text.length <= config.maxPromptChars) {
    return text;
  }

  return text.slice(text.length - config.maxPromptChars);
}

function cleanupOutput(text, config) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(tool|tool_call|assistant to=|analysis:)/i.test(line))
    .join("\n")
    .trim()
    .slice(0, config.maxOutputChars);
}

function extractGeminiText(payload) {
  const parts = payload &&
    Array.isArray(payload.candidates) &&
    payload.candidates[0] &&
    payload.candidates[0].content &&
    Array.isArray(payload.candidates[0].content.parts)
    ? payload.candidates[0].content.parts
    : [];

  return parts
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

async function callOpenAiCompatible(prompt, config) {
  const response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: capPrompt(prompt, config) }],
      max_tokens: config.maxTokens,
      temperature: config.temperature
    })
  }, config.timeoutMs);

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error && payload.error.message ? payload.error.message : `HTTP ${response.status}`;
    throw new Error(detail);
  }

  return cleanupOutput(extractOpenAiText(payload), config);
}

async function callGemini(prompt, config) {
  const response = await fetchWithTimeout(
    `${config.baseUrl}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: capPrompt(prompt, config) }] }],
        generationConfig: {
          maxOutputTokens: config.maxTokens,
          temperature: config.temperature
        }
      })
    },
    config.timeoutMs
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error && payload.error.message ? payload.error.message : `HTTP ${response.status}`;
    throw new Error(detail);
  }

  return cleanupOutput(extractGeminiText(payload), config);
}

async function complete(prompt, config) {
  if (!config.apiKey) {
    throw new Error("WOW_LLM_API_KEY is not set");
  }

  if (config.provider === "gemini") {
    return await callGemini(prompt, config);
  }
  if (config.provider === "openai-compatible") {
    return await callOpenAiCompatible(prompt, config);
  }

  throw new Error(`Unsupported WOW_LLM_PROVIDER: ${config.provider}`);
}

async function checkBackend(config) {
  if (config.provider !== "openai-compatible") {
    return { ok: true, provider: config.provider, checked: false };
  }

  const response = await fetchWithTimeout(`${config.baseUrl}/models`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json"
    }
  }, config.backendHealthTimeoutMs);

  return { ok: response.ok, status: response.status, provider: config.provider, checked: true };
}

class CircuitBreaker {
  constructor(config) {
    this.config = config;
    this.failures = 0;
    this.openedAt = 0;
    this.lastError = "";
  }

  beforeRequest() {
    if (!this.isOpen()) {
      return;
    }

    const error = new Error("llm backend circuit breaker is open");
    error.code = "CIRCUIT_OPEN";
    throw error;
  }

  recordSuccess() {
    this.failures = 0;
    this.openedAt = 0;
    this.lastError = "";
  }

  recordFailure(error) {
    this.failures++;
    this.lastError = error && error.message ? error.message : "unknown error";
    if (this.failures >= this.config.circuitFailureThreshold) {
      this.openedAt = Date.now();
    }
  }

  isOpen() {
    if (!this.openedAt) {
      return false;
    }

    if (Date.now() - this.openedAt > this.config.circuitCooldownMs) {
      this.openedAt = 0;
      this.failures = 0;
      return false;
    }

    return true;
  }

  stats() {
    return {
      open: this.isOpen(),
      failures: this.failures,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      cooldownMs: this.config.circuitCooldownMs,
      lastError: this.lastError
    };
  }
}

module.exports = {
  complete,
  capPrompt,
  cleanupOutput,
  checkBackend,
  CircuitBreaker,
  flattenMessages,
  extractOpenAiText,
  extractGeminiText
};
