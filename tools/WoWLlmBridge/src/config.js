"use strict";

function numberFromEnv(name, fallback, min, max) {
  const value = Number.parseFloat(process.env[name] || "");
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

function loadConfig() {
  return {
    port: Math.trunc(numberFromEnv("WOW_LLM_BRIDGE_PORT", 11434, 1, 65535)),
    provider: (process.env.WOW_LLM_PROVIDER || "openai-compatible").toLowerCase(),
    model: process.env.WOW_LLM_MODEL || "gpt-5.3-mini",
    baseUrl: (process.env.WOW_LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: process.env.WOW_LLM_API_KEY || "",
    timeoutMs: Math.trunc(numberFromEnv("WOW_LLM_TIMEOUT_MS", 20000, 1000, 120000)),
    backendHealthTimeoutMs: Math.trunc(numberFromEnv("WOW_LLM_BACKEND_HEALTH_TIMEOUT_MS", 2000, 250, 30000)),
    maxTokens: Math.trunc(numberFromEnv("WOW_LLM_MAX_TOKENS", 80, 16, 1024)),
    maxPromptChars: Math.trunc(numberFromEnv("WOW_LLM_MAX_PROMPT_CHARS", 8000, 256, 100000)),
    maxOutputChars: Math.trunc(numberFromEnv("WOW_LLM_MAX_OUTPUT_CHARS", 800, 64, 10000)),
    temperature: numberFromEnv("WOW_LLM_TEMPERATURE", 0.8, 0, 2),
    maxConcurrent: Math.trunc(numberFromEnv("WOW_LLM_MAX_CONCURRENT", 1, 1, 1)),
    maxQueueSize: Math.trunc(numberFromEnv("WOW_LLM_MAX_QUEUE_SIZE", 32, 1, 1000)),
    maxQueueAgeMs: Math.trunc(numberFromEnv("WOW_LLM_MAX_QUEUE_AGE_MS", 30000, 1000, 600000)),
    circuitFailureThreshold: Math.trunc(numberFromEnv("WOW_LLM_CIRCUIT_FAILURE_THRESHOLD", 3, 1, 100)),
    circuitCooldownMs: Math.trunc(numberFromEnv("WOW_LLM_CIRCUIT_COOLDOWN_MS", 30000, 1000, 600000)),
    memoryDbPath: process.env.WOW_LLM_MEMORY_DB || "./data/llm_memory.sqlite3",
    maxToolCallsPerEvent: Math.trunc(numberFromEnv("WOW_LLM_MAX_TOOL_CALLS_PER_EVENT", 6, 1, 12)),
    maxToolTimeMs: Math.trunc(numberFromEnv("WOW_LLM_MAX_TOOL_TIME_MS", 2500, 100, 10000)),
    spiceEnable: process.env.WOW_LLM_SPICE_ENABLE !== "0",
    spiceLines: Math.trunc(numberFromEnv("WOW_LLM_SPICE_LINES", 6, 0, 20)),
    spiceExactChance: Math.trunc(numberFromEnv("WOW_LLM_SPICE_EXACT_CHANCE", 15, 0, 100)),
    spiceMinQuality: Math.trunc(numberFromEnv("WOW_LLM_SPICE_MIN_QUALITY", 50, 0, 100)),
    burstMaxLines: Math.trunc(numberFromEnv("WOW_LLM_BURST_MAX_LINES", 8, 1, 12)),
    burstSpiceLines: Math.trunc(numberFromEnv("WOW_LLM_BURST_SPICE_LINES", 10, 0, 20))
  };
}

module.exports = {
  loadConfig
};
