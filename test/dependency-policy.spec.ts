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
    'const client = await import("axios");',
    "const home = process.env.HOME;",
  ])("rejects %s", async (source) => {
    const [result] = await lintCore(source);
    expect(result.messages.some((message) => message.ruleId === "dcompact/core-purity")).toBe(true);
  });

  it("allows pure core code", async () => {
    const [result] = await lintCore("export const answer: number = 42;");
    expect(result.messages.some((message) => message.ruleId === "dcompact/core-purity")).toBe(false);
  });
});
