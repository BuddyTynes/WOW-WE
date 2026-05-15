"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const FIELD_SEPARATOR = "\u001f";
const ROW_SEPARATOR = "\u001e";

function sqlLiteral(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return "NULL";
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function bindParams(sql, params = []) {
  let index = 0;
  const bound = sql.replace(/\?/g, () => {
    if (index >= params.length) {
      throw new Error("missing SQL parameter");
    }
    return sqlLiteral(params[index++]);
  });
  if (index !== params.length) {
    throw new Error("too many SQL parameters");
  }
  return bound;
}

function splitRows(output) {
  return String(output || "")
    .split(ROW_SEPARATOR)
    .map((row) => row.replace(/\r?\n$/, ""))
    .filter(Boolean);
}

class SqliteCliDatabase {
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
  }

  async open() {
    await fs.promises.mkdir(path.dirname(this.dbPath), { recursive: true });
    await this.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  runSql(sql, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      execFile(
        "sqlite3",
        ["-batch", "-header", "-separator", FIELD_SEPARATOR, "-newline", ROW_SEPARATOR, this.dbPath, sql],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            error.message = stderr ? `${error.message}: ${stderr.trim()}` : error.message;
            reject(error);
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  async exec(sql) {
    await this.runSql(sql);
  }

  async query(sql, params = []) {
    const output = await this.runSql(`PRAGMA foreign_keys = ON;\n${bindParams(sql, params)}`);
    const rows = splitRows(output);
    if (rows.length === 0) {
      return [];
    }
    const headers = rows[0].split(FIELD_SEPARATOR);
    return rows.slice(1).map((row) => {
      const values = row.split(FIELD_SEPARATOR);
      const result = {};
      headers.forEach((header, index) => {
        result[header] = values[index] === undefined || values[index] === "" ? null : values[index];
      });
      return result;
    });
  }

  async get(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows[0] || null;
  }
}

module.exports = {
  SqliteCliDatabase,
  sqlLiteral
};
