import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isolatedEnv, parseReadme, UsageError } from "../scripts/clean-clone-check.mjs";

const gate = fileURLToPath(new URL("../scripts/clean-clone-check.mjs", import.meta.url));

interface Report {
  readonly ok: boolean;
  readonly command: string;
  readonly transcript: string;
  readonly clonedHead: string;
  readonly expected: { readonly bytes: number; readonly hash: string };
  readonly actual: { readonly bytes: number; readonly hash: string | null };
  readonly mismatches: readonly string[];
}

/**
 * The full gate clones this repository, runs `npm ci` and `npm run build` from scratch, and
 * runs the CLI, so it is genuinely slow relative to the rest of the suite. There is no existing
 * opt-in-slow-test convention in this repository (the one other subprocess-building test,
 * `packaging > runs the compiled entry through a bin symlink`, also just takes a generous
 * per-test timeout rather than being gated behind an environment flag), so this test follows the
 * same pattern and runs by default.
 */
describe("clean-clone reproduction gate", () => {
  it(
    "reproduces the README's documented command, byte count, and payload hash from a fresh clone",
    () => {
      const result = spawnSync(process.execPath, [gate, "--json"], { encoding: "utf8" });

      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as Report;
      expect(report.mismatches).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.actual.bytes).toBe(report.expected.bytes);
      expect(report.actual.hash).toBe(report.expected.hash);
      // The clone must be a real commit of this repository, not a placeholder value.
      expect(report.clonedHead).toMatch(/^[0-9a-f]{40}$/);
    },
    120_000,
  );

  it("leaves no clone directory behind on success", () => {
    // The gate's own contract is "clean up the temporary clone"; a leaked directory under the
    // OS temp root is exactly the kind of side effect that a byte-comparison assertion would
    // never catch, so it is checked directly against the filesystem.
    const before = spawnSync("bash", ["-c", "ls -d \"${TMPDIR:-/tmp}\"/dcompress-clean-clone-* 2>/dev/null | wc -l"], { encoding: "utf8" });
    const result = spawnSync(process.execPath, [gate, "--json"], { encoding: "utf8" });
    const after = spawnSync("bash", ["-c", "ls -d \"${TMPDIR:-/tmp}\"/dcompress-clean-clone-* 2>/dev/null | wc -l"], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(after.stdout.trim()).toBe(before.stdout.trim());
  }, 120_000);
});

describe("parseReadme", () => {
  const validSection = [
    "## Try it in 60 seconds",
    "",
    "```sh",
    "git clone https://example.com/dcompress.git",
    "cd dcompress",
    "npm ci",
    "npm run build",
    "node dist/cli.js preview --transcript test/fixtures/claude/slice-0001/transcript.jsonl",
    "```",
    "",
    "Expected stdout — a Markdown pack, 42 bytes for this fixture:",
    "",
    "```text",
    "## dcompress context [dcompress:abc]",
    "```",
    "",
    "and on stderr:",
    "",
    "```text",
    "payload hash: sha256:abc123",
    "```",
  ].join("\n");

  it("extracts the documented command, fixture, byte count, and hash", () => {
    const claim = parseReadme(validSection);

    expect(claim.setupCommands).toEqual(["npm ci", "npm run build"]);
    expect(claim.finalArgv).toEqual(["node", "dist/cli.js", "preview", "--transcript", "test/fixtures/claude/slice-0001/transcript.jsonl"]);
    expect(claim.transcript).toBe("test/fixtures/claude/slice-0001/transcript.jsonl");
    expect(claim.expectedBytes).toBe(42);
    expect(claim.expectedStdoutPrefix).toBe("## dcompress context [dcompress:abc]\n");
    expect(claim.expectedHash).toBe("sha256:abc123");
  });

  it("throws a usage error when the 60-second section is missing", () => {
    expect(() => parseReadme("# dcompress\n\nNo quickstart here.\n")).toThrow(UsageError);
  });

  it("throws a usage error when the documented command block has no node invocation", () => {
    const broken = validSection.replace("node dist/cli.js preview --transcript test/fixtures/claude/slice-0001/transcript.jsonl", "echo done");
    expect(() => parseReadme(broken)).toThrow(UsageError);
  });

  it("throws a usage error when no byte count is claimed", () => {
    const broken = validSection.replace("Expected stdout — a Markdown pack, 42 bytes for this fixture:", "Expected stdout:");
    expect(() => parseReadme(broken)).toThrow(UsageError);
  });

  it("throws a usage error when no payload hash is quoted", () => {
    const broken = validSection.replace("payload hash: sha256:abc123", "no hash here");
    expect(() => parseReadme(broken)).toThrow(UsageError);
  });
});

describe("isolatedEnv", () => {
  it("strips NODE_PATH, INIT_CWD, and npm_* so the clone cannot inherit the developer checkout's module resolution", () => {
    const env = isolatedEnv({
      NODE_PATH: "/opt/dev-checkout/node_modules",
      INIT_CWD: "/opt/dev-checkout",
      npm_config_registry: "https://example.com",
      npm_package_name: "dcompress",
      PATH: "/usr/bin",
      HOME: "/opt/tester-home",
    });

    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/opt/tester-home" });
  });
});
