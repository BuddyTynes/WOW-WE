#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseElvuiChat, sha256 } = require("./src/elvui-parser");

const root = __dirname;
const defaultInput = path.join(root, "unparsed logs");
const defaultParsed = path.join(root, "parsed logs");
const defaultSeed = path.resolve(root, "..", "WoWLlmBridge", "seeds", "spice_chat_pool.seed.jsonl");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listLuaFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith(".lua"))
    .sort((a, b) => a.localeCompare(b));
}

function copyParsedFile(source, parsedDir) {
  const target = path.join(parsedDir, path.basename(source));
  if (!fs.existsSync(target)) {
    fs.copyFileSync(source, target);
  }
}

function main() {
  const inputDir = path.resolve(argValue("--input", defaultInput));
  const parsedDir = path.resolve(argValue("--parsed", defaultParsed));
  const seedPath = path.resolve(argValue("--out", defaultSeed));
  const files = listLuaFiles(inputDir);
  const byHash = new Map();
  const summary = {
    files: files.length,
    copied: 0,
    parsedRecords: 0,
    keptRecords: 0,
    rejected: {}
  };

  ensureDir(parsedDir);
  ensureDir(path.dirname(seedPath));

  for (const file of files) {
    const fullPath = path.join(inputDir, file);
    const text = fs.readFileSync(fullPath, "utf8");
    const sourceFileHash = sha256(file);
    const parsed = parseElvuiChat(text, { sourceFile: file, sourceFileHash });
    summary.parsedRecords += parsed.records.length;
    for (const [reason, count] of Object.entries(parsed.rejected)) {
      summary.rejected[reason] = (summary.rejected[reason] || 0) + count;
    }
    for (const record of parsed.records) {
      const current = byHash.get(record.line_hash);
      if (!current || record.quality_score > current.quality_score) {
        byHash.set(record.line_hash, record);
      }
    }
    copyParsedFile(fullPath, parsedDir);
    summary.copied++;
  }

  const records = [...byHash.values()]
    .sort((a, b) => b.quality_score - a.quality_score || a.line_hash.localeCompare(b.line_hash));
  const output = records.map((record) => JSON.stringify(record)).join("\n");
  fs.writeFileSync(seedPath, output ? `${output}\n` : "", "utf8");
  summary.keptRecords = records.length;
  summary.seed = seedPath;
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main();
}
