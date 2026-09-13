import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configFile = fileURLToPath(new URL("../eslint.config.js", import.meta.url));

async function lintCore(source: string, filePath = "src/core/policy-fixture.ts") {
  const eslint = new ESLint({ overrideConfigFile: configFile });
  return eslint.lintText(source, { filePath });
}

describe("src/core dependency policy", () => {
  it.each([
    'import http from "node:http";',
    'export { readFile } from "node:fs/promises";',
    'const client = require("undici");',
    'const client = require("undici", { purpose: "test" });',
    'import process from "process";',
    'import process from "node:process";',
    'export { default as process } from "node:process/promises";',
    'const host = require("process", { purpose: "test" });',
    'const host = await import("node:process", { with: { type: "json" } });',
    'const client = await import("axios");',
    'const client = await import("node:net", { with: { type: "json" } });',
    "const env = process.env;",
    "const cwd = process.cwd();",
    'const env = process["env"];',
    "const host = process; host.env;",
    "const { env } = process;",
    "const host = globalThis.process; host.env;",
    'const host = globalThis["process"]; host.env;',
    "const global = globalThis; global.process.env;",
    "const { process: host } = globalThis; host.env;",
    'const { ["process"]: host } = globalThis; host.env;',
    'const load = require; load("node:fs");',
    'const global = globalThis; const load = global.require; load("node:fs");',
    'const { require: load } = globalThis; load("node:fs");',
    'const { ["require"]: load } = globalThis; load("node:fs");',
    'let load; load = require; load("node:fs");',
    'let load; load = globalThis.require; load("node:fs");',
    'let load; ({ require: load } = globalThis); load("node:fs");',
    'let load; ({ ["require"]: load } = globalThis); load("node:fs");',
  ])("rejects %s", async (source) => {
    const [result] = await lintCore(source);
    expect(result.messages.some((message) => message.ruleId === "dcompact/core-purity")).toBe(true);
  });

  it("allows pure core code", async () => {
    const [result] = await lintCore("export const answer: number = 42;");
    expect(result.messages.some((message) => message.ruleId === "dcompact/core-purity")).toBe(false);
  });

  it.each([
    "const process = { env: { TEST: true } }; process.env;",
    "const globalThis = { process: { env: { TEST: true } } }; globalThis.process;",
    "const value = { process: 42 }; value.process;",
    'const require = (name: string) => name; require("process", "local");',
    'const require = (name: string) => name; const load = require; load("node:fs");',
    'const globalThis = { require: (name: string) => name }; const load = globalThis.require; load("node:fs");',
    "const Date = { now: () => 1 }; Date.now();",
    "const Date = { now: () => 1 }; const { now } = Date; now();",
    "const globalThis = { Date: { now: () => 1 } }; const { now } = globalThis.Date; now();",
    "const Date = () => 1; Date();",
    "const Date = class {}; new Date();",
    'const require = (name: string) => name; require("./clock.js");',
  ])("allows non-host lookalikes: %s", async (source) => {
    const [result] = await lintCore(source);
    expect(result.messages.filter((message) => message.ruleId?.startsWith("dcompact/"))).toEqual([]);
  });

  it("allows Date.now only in the clock boundary module", async () => {
    const [result] = await lintCore("export const now = Date.now();", "src/core/clock.ts");
    expect(result.messages.some((message) => message.ruleId === "dcompact/clock-boundary")).toBe(false);
  });

  it.each([
    "const now = Date.now();",
    'const now = Date["now"]();',
    "Date();",
    "new Date();",
    "const host = globalThis; host.Date.now();",
    "const Alias = Date; Alias.now();",
    "const { Date: Alias } = globalThis; Alias.now();",
    'const { ["Date"]: Alias } = globalThis; Alias.now();',
    "const { Date } = globalThis; Date.now();",
    'const host = globalThis; host["Date"].now();',
    "const { now } = Date; now();",
    "const { now: current } = globalThis.Date; current();",
    'const { ["now"]: current } = Date; current();',
    "const { now = fallback } = Date; now();",
    "let now; ({ now } = Date); now();",
    'let current; ({ ["now"]: current } = globalThis.Date); current();',
  ])("rejects host clock reads outside the clock boundary module: %s", async (source) => {
    const [result] = await lintCore(source);
    expect(result.messages.some((message) => message.ruleId === "dcompact/clock-boundary")).toBe(true);
  });

  it.each([
    'import { systemClock } from "./clock.js";',
    'export * from "./clock.js";',
    'export { systemClock } from "./clock.js";',
    'await import("./clock.js");',
    'require("./clock.js");',
    'const load = require; load("./clock.js");',
  ])("rejects canonical.ts loading the clock boundary: %s", async (source) => {
    const [result] = await lintCore(source, "src/core/canonical.ts");
    expect(result.messages.some((message) => message.ruleId === "dcompact/clock-boundary")).toBe(true);
  });
});
