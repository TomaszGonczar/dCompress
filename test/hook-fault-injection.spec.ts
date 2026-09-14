import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const fixture = join(process.cwd(), "test", "fixtures", "claude", "slice-0001", "transcript.jsonl");
const nodeExe = process.execPath;
const hookExe = join(process.cwd(), "dist", "cli.js");

interface HookProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the hook command as a child process and capture output.
 * Resolves the exit code and output streams independently of error state.
 */
function runHookProcess(args: string[], stdin: string): HookProcessResult {
  try {
    const stdout = execFileSync(nodeExe, [hookExe, ...args], {
      input: stdin,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error: unknown) {
    if (error instanceof Error && "status" in error) {
      const { status, stdout = "", stderr = "" } = error as Record<string, unknown>;
      return {
        exitCode: typeof status === "number" ? status : 1,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
      };
    }
    throw error;
  }
}

/**
 * Assert standard hook failure properties: exit 0, valid JSON output, no unhandled exceptions.
 */
function assertHookFailOpen(result: HookProcessResult, description: string): void {
  expect(result.exitCode, `${description}: exit code should be 0 (fail-open)`).toBe(0);
  expect(result.stderr, `${description}: stderr should not contain Internal error`).not.toContain("Internal error");
  expect(result.stderr, `${description}: stderr should not contain stack trace`).not.toMatch(/\s(at |TypeError|Error:)/);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    expect(result.stdout, `${description}: stdout must be valid JSON`).toBe("should fail to parse");
    return;
  }
  expect(typeof parsed, `${description}: stdout JSON must be an object`).toBe("object");
}

describe("hook fault injection", () => {
  describe("stdin faults", () => {
    it("accepts empty stdin", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const result = runHookProcess(["hook", "--event", "session-start", "--store", root], "");
        assertHookFailOpen(result, "empty stdin");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails open on malformed JSON stdin", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const result = runHookProcess(["hook", "--event", "session-start", "--store", root], "{not-json");
        assertHookFailOpen(result, "malformed JSON");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails open on JSON of wrong shape", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const result = runHookProcess(["hook", "--event", "precompact", "--store", root], JSON.stringify({ wrong: "shape" }));
        assertHookFailOpen(result, "wrong JSON shape");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails open on JSON with wrong types", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const result = runHookProcess(
          ["hook", "--event", "precompact", "--store", root],
          JSON.stringify({ session_id: 123, transcript_path: "/path" }),
        );
        assertHookFailOpen(result, "JSON with wrong types");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails open on truncated JSON", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const result = runHookProcess(["hook", "--event", "precompact", "--store", root], '{"session_id": "test", "transcript_path": "/path"');
        assertHookFailOpen(result, "truncated JSON");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("transcript path faults", () => {
    it("fails open when transcript path does not exist", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: "/nonexistent/transcript.jsonl",
        });
        const result = runHookProcess(["hook", "--event", "precompact", "--store", root], input);
        assertHookFailOpen(result, "nonexistent transcript");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails open when transcript path is a directory", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: root,
        });
        const result = runHookProcess(["hook", "--event", "precompact", "--store", root], input);
        assertHookFailOpen(result, "transcript is directory");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails open when transcript path is a symlink", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const linkPath = join(root, "link");
        const targetPath = join(root, "target");
        writeFileSync(targetPath, "");
        symlinkSync(targetPath, linkPath);

        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: linkPath,
        });
        const result = runHookProcess(["hook", "--event", "precompact", "--store", root], input);
        assertHookFailOpen(result, "transcript is symlink");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails open when transcript is unreadable", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const transcriptPath = join(root, "unreadable.jsonl");
        writeFileSync(transcriptPath, "");
        chmodSync(transcriptPath, 0o000);

        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: transcriptPath,
        });
        const result = runHookProcess(["hook", "--event", "precompact", "--store", root], input);
        assertHookFailOpen(result, "unreadable transcript");
        expect(result.stdout.trim()).toBe("{}");

        chmodSync(transcriptPath, 0o644);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("store root faults", () => {
    it("fails open when store root is a file", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const filePath = join(root, "store-file");
        writeFileSync(filePath, "not a directory");

        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: fixture,
        });
        const result = runHookProcess(["hook", "--event", "precompact", "--store", filePath], input);
        assertHookFailOpen(result, "store root is file");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails open when store root is a symlink", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const realDir = join(root, "real-store");
        const linkPath = join(root, "link-store");
        mkdirSync(realDir);
        writeFileSync(join(realDir, ".placeholder"), "");
        symlinkSync(realDir, linkPath);

        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: fixture,
        });
        const result = runHookProcess(["hook", "--event", "precompact", "--store", linkPath], input);
        assertHookFailOpen(result, "store root is symlink");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails open when store root is unwritable", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const storeDir = join(root, "store");
        mkdirSync(storeDir);
        writeFileSync(join(storeDir, ".placeholder"), "");
        chmodSync(storeDir, 0o555);

        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: fixture,
        });
        const result = runHookProcess(["hook", "--event", "precompact", "--store", storeDir], input);
        assertHookFailOpen(result, "store root unwritable");
        expect(result.stdout.trim()).toBe("{}");

        chmodSync(storeDir, 0o755);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("transcript content faults", () => {
    it("fails open on empty transcript", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const transcriptPath = join(root, "empty.jsonl");
        writeFileSync(transcriptPath, "");

        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: transcriptPath,
        });
        const result = runHookProcess(["hook", "--event", "precompact", "--store", root], input);
        assertHookFailOpen(result, "empty transcript");
        expect(JSON.parse(result.stdout.trim())).toBeDefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails open on malformed transcript JSON", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const transcriptPath = join(root, "malformed.jsonl");
        writeFileSync(transcriptPath, '{"not valid json}\n');

        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: transcriptPath,
        });
        const result = runHookProcess(["hook", "--event", "precompact", "--store", root], input);
        assertHookFailOpen(result, "malformed transcript");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails open on transcript with wrong shape", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const transcriptPath = join(root, "wrong-shape.jsonl");
        writeFileSync(transcriptPath, '{"wrong":"shape"}\n');

        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: transcriptPath,
        });
        const result = runHookProcess(["hook", "--event", "precompact", "--store", root], input);
        assertHookFailOpen(result, "transcript wrong shape");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("pathological input", () => {
    it("returns within a few hundred milliseconds on the committed fixture", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: fixture,
        });
        const startTime = Date.now();
        const result = runHookProcess(["hook", "--event", "precompact", "--store", root], input);
        const elapsedMs = Date.now() - startTime;

        assertHookFailOpen(result, "normal operation");
        expect(elapsedMs, `Hook took ${elapsedMs}ms, should be under ~350ms`).toBeLessThan(350);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("stays fail-open on a transcript large enough to dominate the hook's work", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const transcriptPath = join(root, "large.jsonl");
        const entries: string[] = [];
        for (let i = 0; i < 5000; i++) {
          entries.push(
            JSON.stringify({
              type: "message",
              message: {
                role: "user",
                content: [{ type: "text", text: `Line ${i}: ${"x".repeat(100)}` }],
              },
              uuid: `uuid-${i}`,
              parentUuid: i === 0 ? null : `uuid-${i - 1}`,
              timestamp: 1000000 + i * 1000,
              cwd: "/repo",
              sessionId: "test-session",
              gitBranch: "main",
              version: "0.0.0",
            }),
          );
        }
        writeFileSync(transcriptPath, entries.join("\n"));

        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: transcriptPath,
        });
        const result = runHookProcess(["hook", "--event", "precompact", "--store", root], input);
        assertHookFailOpen(result, "large transcript");
        expect(result.exitCode).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("hook commands under normal conditions", () => {
    it("precompact hook succeeds and returns empty object", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: fixture,
        });
        const result = runHookProcess(["hook", "--event", "precompact", "--store", root], input);
        assertHookFailOpen(result, "precompact");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("session-start hook succeeds and returns context when snapshot exists", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const precompactInput = JSON.stringify({
          session_id: "test-session",
          transcript_path: fixture,
        });
        runHookProcess(["hook", "--event", "precompact", "--store", root], precompactInput);

        const sessionStartInput = JSON.stringify({
          session_id: "test-session",
          transcript_path: fixture,
          source: "resume",
        });
        const result = runHookProcess(["hook", "--event", "session-start", "--store", root], sessionStartInput);
        assertHookFailOpen(result, "session-start");
        const output = JSON.parse(result.stdout.trim());
        expect(output).toBeDefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("hook configuration errors", () => {
    it("fails open on missing --event argument", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: fixture,
        });
        const result = runHookProcess(["hook", "--store", root], input);
        assertHookFailOpen(result, "missing --event");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails open on invalid --event value", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: fixture,
        });
        const result = runHookProcess(["hook", "--event", "invalid", "--store", root], input);
        assertHookFailOpen(result, "invalid --event");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails open on missing --store argument", () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-hook-fault-"));
      try {
        const input = JSON.stringify({
          session_id: "test-session",
          transcript_path: fixture,
        });
        const result = runHookProcess(["hook", "--event", "precompact"], input);
        assertHookFailOpen(result, "missing --store");
        expect(result.stdout.trim()).toBe("{}");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
