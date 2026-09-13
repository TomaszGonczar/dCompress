import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configFile = fileURLToPath(new URL("../eslint.config.js", import.meta.url));

async function lintCore(source: string) {
  const eslint = new ESLint({ overrideConfigFile: configFile });
  return eslint.lintText(source, { filePath: "src/core/policy-fixture.ts" });
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
  ])("allows non-host lookalikes: %s", async (source) => {
    const [result] = await lintCore(source);
    expect(result.messages.some((message) => message.ruleId === "dcompact/core-purity")).toBe(false);
  });
});
