import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { run } from "../src/cli.js";

const fixture = join(process.cwd(), "test", "fixtures", "claude", "slice-0001", "transcript.jsonl");

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dcompress-og85-cli-"));
}

function io(stdin = ""): { readonly stdout: string[]; readonly stderr: string[]; readonly stdin: () => string; } {
  return { stdout: [], stderr: [], stdin: () => stdin };
}

describe("continuity CLI", () => {
  it("snapshots and restores one explicit session", () => {
    const root = tempRoot();
    try {
      const snapshotIo = io();
      expect(run(["snapshot", "--session", "fixture-session-0001", "--transcript", fixture, "--store", root], {
        stdout: (text) => snapshotIo.stdout.push(text),
        stderr: (text) => snapshotIo.stderr.push(text),
      })).toBe(0);
      expect(JSON.parse(snapshotIo.stdout.join(""))).toMatchObject({ created: true });

      const restoreIo = io();
      expect(run(["restore", "--session", "fixture-session-0001", "--store", root], {
        stdout: (text) => restoreIo.stdout.push(text),
        stderr: (text) => restoreIo.stderr.push(text),
      })).toBe(0);
      expect(restoreIo.stdout.join("")).toContain("## dcompress context [dcompress:");
      expect(restoreIo.stderr).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bridges precompact and session-start hooks", () => {
    const root = tempRoot();
    const input = JSON.stringify({ session_id: "fixture-session-0001", transcript_path: fixture, source: "compact" });
    try {
      const precompactIo = io(input);
      expect(run(["hook", "--event", "precompact", "--store", root], {
        stdout: (text) => precompactIo.stdout.push(text),
        stderr: (text) => precompactIo.stderr.push(text),
        stdin: precompactIo.stdin,
      })).toBe(0);
      expect(precompactIo.stdout.join("")).toBe("{}\n");

      const sessionStartIo = io(input);
      expect(run(["hook", "--event", "session-start", "--store", root], {
        stdout: (text) => sessionStartIo.stdout.push(text),
        stderr: (text) => sessionStartIo.stderr.push(text),
        stdin: sessionStartIo.stdin,
      })).toBe(0);
      expect(sessionStartIo.stdout.join("")).toContain("additionalContext");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails open on malformed hook stdin", () => {
    const root = tempRoot();
    try {
      const output = io("{not-json");
      expect(run(["hook", "--event", "session-start", "--store", root], {
        stdout: (text) => output.stdout.push(text),
        stderr: (text) => output.stderr.push(text),
        stdin: output.stdin,
      })).toBe(0);
      expect(output.stdout.join("")).toBe("{}\n");
      expect(output.stderr).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps hook argument/configuration errors fail-open and gives restore budget refusals a next step", () => {
    const root = tempRoot();
    try {
      const call = (argv: string[], output: ReturnType<typeof io>): number => run(argv, {
        stdout: (text) => output.stdout.push(text),
        stderr: (text) => output.stderr.push(text),
        stdin: output.stdin,
      });
      const malformed = io("{}");
      expect(call(["hook", "--event", "precompact", "--stor", root], malformed)).toBe(0);
      expect(malformed.stdout.join("")).toBe("{}\n");
      const missing = io("{}");
      expect(call(["hook", "--event", "precompact"], missing)).toBe(0);
      expect(missing.stdout.join("")).toBe("{}\n");
      const emptyStore = io("");
      expect(call(["snapshot", "--session", "fixture-session-0001", "--transcript", fixture, "--store", ""], emptyStore)).toBe(2);

      const snapshot = io();
      expect(call(["snapshot", "--session", "fixture-session-0001", "--transcript", fixture, "--store", root], snapshot)).toBe(0);
      const restoreIo = io();
      expect(call(["restore", "--session", "fixture-session-0001", "--store", root, "--max-bytes", "0"], restoreIo)).toBe(1);
      expect(restoreIo.stderr.join("")).toContain("Pass --max-bytes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps unreadable/non-directory state paths to exit 1 without an internal stack", () => {
    const root = tempRoot();
    try {
      const statePath = join(root, "state");
      writeFileSync(statePath, "not a directory");
      const output = io();
      const status = run(["restore", "--session", "fixture-session-0001", "--store", statePath], {
        stdout: (text) => output.stdout.push(text),
        stderr: (text) => output.stderr.push(text),
      });
      expect(status).toBe(1);
      expect(output.stderr.join("")).toContain("State path is not a directory");
      expect(output.stderr.join("")).not.toContain("Internal error");

      const hook = io("{}");
      expect(run(["hook", "--event", "session-start", "--store", statePath], {
        stdout: (text) => hook.stdout.push(text),
        stderr: (text) => hook.stderr.push(text),
        stdin: hook.stdin,
      })).toBe(0);
      expect(hook.stdout.join("")).toBe("{}\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps hook commands at exit 0 when stdout and stderr are closed", () => {
    const root = tempRoot();
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((() => {
      process.stdout.emit("error", Object.assign(new Error("closed stdout"), { code: "EPIPE" }));
      return true;
    }) as typeof process.stdout.write);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((() => {
      process.stderr.emit("error", Object.assign(new Error("closed stderr"), { code: "EPIPE" }));
      return true;
    }) as typeof process.stderr.write);
    try {
      expect(run(["hook", "--event", "session-start", "--store", root], {
        stdout: (text) => void process.stdout.write(text),
        stderr: (text) => void process.stderr.write(text),
        stdin: () => "{}",
      })).toBe(0);
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
