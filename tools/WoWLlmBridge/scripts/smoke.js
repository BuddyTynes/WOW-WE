"use strict";

const http = require("node:http");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBridge } = require("../src/server");

function listen(server, port = 0) {
  server.listen(port);
  return once(server, "listening").then(() => server.address().port);
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function percentile(values, pct) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))];
}

async function main() {
  let backendHealthy = true;
  let backendActive = 0;
  let backendMaxActive = 0;
  const malformedEvery = Number.parseInt(process.env.SMOKE_MALFORMED_EVERY || "9", 10);

  const backend = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(backendHealthy ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      backendActive++;
      backendMaxActive = Math.max(backendMaxActive, backendActive);
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          backendActive--;
        }
      };
      req.on("aborted", release);

      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      await once(req, "end").catch(() => {});
      if (released) {
        return;
      }

      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const prompt = body.messages[0].content;
      const id = Number((prompt.match(/event (\d+)/) || [0, 0])[1]);
      await new Promise((resolve) => setTimeout(resolve, id % 7 === 0 ? 180 : 30));
      if (released) {
        return;
      }

      if (!backendHealthy || id % 17 === 0) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "simulated backend unavailable" } }));
        release();
        return;
      }

      const content = malformedEvery > 0 && id % malformedEvery === 0
        ? "<think>hidden chain</think>\ntool_call: debug\nstill here"
        : `guild reply ${id}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      release();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const backendPort = await listen(backend);
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "wow-llm-smoke-"));
  const bridge = createBridge({
    port: 0,
    provider: "openai-compatible",
    model: "smoke-model",
    baseUrl: `http://127.0.0.1:${backendPort}/v1`,
    apiKey: "local",
    timeoutMs: 120,
    backendHealthTimeoutMs: 100,
    maxTokens: 64,
    maxPromptChars: 512,
    maxOutputChars: 80,
    temperature: 0.1,
    maxConcurrent: 1,
    maxQueueSize: 64,
    maxQueueAgeMs: 250,
    circuitFailureThreshold: 8,
    circuitCooldownMs: 500,
    memoryDbPath: path.join(memoryDir, "memory.sqlite3"),
    maxToolCallsPerEvent: 6,
    maxToolTimeMs: 2500
  });
  const bridgePort = await listen(bridge.server);

  const durationMs = Number.parseInt(process.env.SMOKE_DURATION_MS || "10000", 10);
  const started = Date.now();
  const latencies = [];
  let sent = 0;
  let success = 0;
  let failed = 0;
  let cleanedMalformed = 0;
  const promptSizes = [];
  const outputSizes = [];

  async function sendEvent(id) {
    const channel = id % 3 === 0 ? "party" : "guild";
    const prompt = `event ${id} ${channel} Buddy asks bot-${id % 4} to respond. ${"x".repeat(id % 200)}`;
    promptSizes.push(prompt.length);
    const start = Date.now();
    const response = await fetch(`http://127.0.0.1:${bridgePort}/api/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-event-id": `smoke-${id}`,
        "x-wow-channel": channel,
        "x-wow-bot": `bot-${id % 4}`,
        "x-wow-player": `player-${id % 5}`
      },
      body: JSON.stringify({ prompt, stream: false })
    });
    latencies.push(Date.now() - start);
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      success++;
      const text = body.response || "";
      outputSizes.push(text.length);
      if (text === "still here") {
        cleanedMalformed++;
      }
    } else {
      failed++;
    }
  }

  const inFlight = new Set();
  while (Date.now() - started < durationMs) {
    sent++;
    const promise = sendEvent(sent).finally(() => inFlight.delete(promise));
    inFlight.add(promise);
    if (sent === 20) {
      backendHealthy = false;
      setTimeout(() => {
        backendHealthy = true;
      }, 500);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  await Promise.allSettled(inFlight);

  const health = await fetch(`http://127.0.0.1:${bridgePort}/health?probe=1`).then((res) => res.json());
  const metrics = {
    durationMs,
    sent,
    success,
    failed,
    timeoutOrBackendFailures: failed,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    maxQueueDepth: health.queue.maxDepth,
    queue: health.queue,
    backend: health.backend,
    backendMaxActive,
    promptSizeRange: [Math.min(...promptSizes), Math.max(...promptSizes)],
    outputSizeRange: [Math.min(...outputSizes), Math.max(...outputSizes)],
    cleanedMalformed,
    memoryWritesSimulated: sent,
    memoryRetrievalsSimulated: sent,
    staleDropped: health.queue.staleDropped
  };

  console.log(JSON.stringify(metrics, null, 2));

  await close(bridge.server);
  await close(backend);

  if (health.queue.maxActive > 1) {
    throw new Error(`bridge concurrency exceeded 1: ${health.queue.maxActive}`);
  }
  if (success === 0) {
    throw new Error("smoke test had no successful requests");
  }
  if (!health.backend.ok) {
    throw new Error("backend health did not recover");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
