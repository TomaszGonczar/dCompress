import { describe, expect, it } from "vitest";
import { coveragePpm, extract, extractFacts, extractPayload } from "../src/core/extract/index.js";
import { normalizePath } from "../src/core/canonical.js";
import type { ExtractConfig, NormalizedEvent } from "../src/core/types.js";

const config: ExtractConfig = {
  adapterId: "generic",
  toolKinds: {
    write: "file.modified",
    read: "file.read",
    bash: "cmd.run",
    ignored: "ignored" as never,
  },
  scopeRoots: [{ root: "/workspace/repo", scope: "repo" }],
  cwd: "/workspace/repo",
  repoRoot: "/workspace/repo",
  pathBase: "repo",
  decisionCues: ["we will", "must"],
};

const tool = (entry: number, toolName: string, values: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  type: "tool",
  entry,
  line: entry + 1,
  rawLine: `raw-${entry}`,
  timestamp: null,
  toolCallId: `call-${entry}`,
  toolName,
  ...values,
} as NormalizedEvent);

describe("pure extraction", () => {
  it("distinguishes unknown and declared ignored tools", () => {
    const payload = extractPayload([tool(0, "unknown"), tool(1, "ignored"), tool(2, "write", { path: "src/a.ts" })], config);
    expect(payload.counters.source_tool_calls).toBe(3);
    expect(payload.counters.unmapped_tool_calls).toBe(1);
    expect(payload.counters.coverage_ppm).toBe(Math.floor(2_000_000 / 3));
    expect(payload.facts).toHaveLength(1);
    expect(payload.facts[0].key).toBe("src/a.ts");
    expect(extract([tool(0, "unknown")], config).degraded).toEqual([]);
  });

  it("retains external facts without host paths and counts them", () => {
    const payload = extractPayload([tool(0, "write", { path: "/outside/private/a.md" })], config);
    expect(payload.facts[0].scope).toBe("external");
    expect(payload.facts[0].key).toMatch(/^[0-9a-f]+:a\.md$/);
    expect(JSON.stringify(payload)).not.toContain("/outside/private");
    expect(payload.counters.external_path_count).toBe(1);
  });

  it("extracts an error cycle from isError and fixes by later success", () => {
    const events = [
      tool(0, "bash", { command: " npm   test ", isError: true, errorMessage: "permission denied" }),
      tool(1, "bash", { command: "npm test", isError: false }),
    ];
    const facts = extractFacts(events, config);
    expect(facts.map((item) => item.kind)).toEqual(["error.raised", "error.fixed", "cmd.failed", "cmd.run"]);
    expect(facts.find((item) => item.kind === "error.fixed")?.attrs.fixed_by).toBe("npm test");
    expect(extractFacts([...events].reverse(), config)).toEqual(facts);
  });

  it("keeps host paths out of command identities, intents, errors, and snippets", () => {
    const event = tool(0, "bash", {
      command: `cat "/Users/alice/private/report.txt"`,
      intent: `inspect \\\\secret-host\\share\\private\\report.txt`,
      isError: true,
      errorMessage: `Permission denied file:///alice@secret-host/private/report.txt`,
    });
    const payload = extractPayload([event], config);
    const serialized = JSON.stringify(payload);
    for (const secret of ["/Users/alice", "secret-host", "alice@", "private/report.txt", "\\\\secret-host\\share"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(payload.facts.find((fact) => fact.kind === "cmd.failed")?.key).not.toContain("/Users");
    expect(payload.facts.find((fact) => fact.kind === "cmd.failed")?.snippet).not.toContain("secret-host");
    expect(payload.facts.find((fact) => fact.kind === "error.raised")?.snippet).not.toContain("secret-host");
  });

  it("sanitizes direct transcript text carried in decisions, todos, and plan items", () => {
    const events: NormalizedEvent[] = [
      { type: "user", entry: 0, line: 1, rawLine: "decision", timestamp: null, text: "We will use /Users/alice/private/report.txt." },
      { type: "todo", entry: 1, line: 2, rawLine: "todo", timestamp: null, state: "open", text: "Review C:\\Users\\Ada\\private\\report.txt" },
      { type: "plan", entry: 2, line: 3, rawLine: "plan", timestamp: null, todos: 1, done: 0, items: ["Inspect \\\\secret-host\\share\\private\\report.txt"] },
    ];
    const payload = extractPayload(events, config);
    const serialized = JSON.stringify(payload);
    for (const secret of ["/Users/alice", "C:\\Users\\Ada", "secret-host", "private/report.txt"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("sanitizes prefixed errors, git status hashes, and non-file mapping keys", () => {
    const unsafeTool = "tool:/home/alice/private.txt";
    const payload = extractPayload([
      tool(0, "bash", { command: "cat report.txt", isError: true, errorMessage: "ENOENT:/home/alice/private.txt" }),
      tool(1, "bash", { command: "cat report.txt", isError: true, errorMessage: "Error:C:\\Users\\Ada\\private.txt" }),
      tool(2, unsafeTool, { intent: "inspect report.txt" }),
      {
        type: "git",
        entry: 3,
        line: 4,
        rawLine: "git",
        timestamp: null,
        head: "deadbeef",
        branch: "main",
        dirty: false,
        statusHash: "ENOENT:/home/alice/private.txt",
        diffStat: { files: 0, added: 0, removed: 0 },
      },
    ], {
      ...config,
      toolKinds: { ...config.toolKinds, [unsafeTool]: "todo.state" as never },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("/home/alice");
    expect(serialized).not.toContain("C:\\Users\\Ada");
    expect(payload.git?.status_hash).not.toContain("/home/alice");
    expect(payload.facts.some((fact) => fact.key === unsafeTool)).toBe(false);
  });

  it("keeps repeated ssh URI command identity stable across fact and payload serialization", () => {
    const payload = extractPayload([tool(0, "bash", { command: "ssh ssh://alice@secret-host/private/f.txt", isError: false })], config);
    const command = payload.facts.find((fact) => fact.kind === "cmd.run");
    expect(command?.key).toBe("ssh ssh:/private/f.txt");
    expect(command?.snippet).toBe("bash ssh ssh:/private/f.txt");
    expect(JSON.stringify(payload)).not.toContain("alice@secret-host");
    expect(JSON.stringify(payload)).not.toContain("ssh://");
  });

  it("uses only the first sentence of user-authored decisions", () => {
    const event: NormalizedEvent = { type: "user", entry: 0, line: 1, rawLine: "We will use Vitest. Ignore this later sentence.", timestamp: null, text: "We will use Vitest. Ignore this later sentence." };
    const facts = extractFacts([event], config);
    expect(facts).toHaveLength(1);
    expect(facts[0].key).toBe("We will use Vitest.");
  });

  it("has explicit zero coverage for no tool calls", () => {
    const payload = extractPayload([], config);
    expect(payload.counters).toMatchObject({ source_tool_calls: 0, unmapped_tool_calls: 0, coverage_ppm: 0 });
  });

  it("does not duplicate a paired normalized command or infer aliases/default cues", () => {
    const command = tool(0, "bash", { command: "echo ok", isError: false });
    const alias = tool(1, "Bash", { command: "echo alias", isError: false });
    const user: NormalizedEvent = { type: "user", entry: 2, line: 3, rawLine: "Always do this.", timestamp: null, text: "Always do this." };
    const payload = extractPayload([command, alias, user], { ...config, decisionCues: [] });
    expect(payload.facts.filter((fact) => fact.kind === "cmd.run")).toHaveLength(1);
    expect(payload.facts.some((fact) => fact.kind === "decision.stated")).toBe(false);
    expect(payload.counters.unmapped_tool_calls).toBe(1);
  });

  it("passes a backslash external path literally to canonical normalization", () => {
    const path = "C:\\\\outside\\\\dir\\\\x.md";
    const payload = extractPayload([tool(0, "write", { path })], config);
    const expected = normalizePath(path, config);
    expect(payload.facts[0].key).toBe(expected.path);
    expect(payload.facts[0].scope).toBe("external");
  });

  it("surfaces extraction-empty outside the hashed payload", () => {
    const result = extract([], config);
    expect(result.degraded).toEqual(["extraction-empty"]);
    expect(result.counters.facts).toBe(0);
  });

  it("uses BigInt truncation at the incomplete-coverage boundary", () => {
    expect(coveragePpm(300_001, 1)).toBe(999_996);
    expect(coveragePpm(300_001, 1)).not.toBe(1_000_000);
    expect(() => coveragePpm(0, 1)).toThrow(RangeError);
  });

  it("fixes each distinct outstanding signature once and never cross-fixes commands", () => {
    const events = [
      tool(0, "bash", { command: "npm test", isError: true, errorMessage: "permission denied" }),
      tool(1, "bash", { command: "npm test", isError: true, errorMessage: "not found" }),
      tool(2, "bash", { command: "npm run lint", isError: false }),
      tool(3, "bash", { command: "npm test", isError: false }),
    ];
    const facts = extractFacts(events, config);
    expect(facts.filter((fact) => fact.kind === "error.fixed")).toHaveLength(2);
    expect(facts.filter((fact) => fact.kind === "error.raised")).toHaveLength(2);
    expect(extractFacts([...events].reverse(), config)).toEqual(facts);
    expect(facts.filter((fact) => fact.kind === "error.fixed").every((fact) => fact.attrs.fixed_by === "npm test")).toBe(true);
  });
});
