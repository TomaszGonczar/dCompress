import { describe, expect, it } from "vitest";
import {
  canonicalize,
  errorSignature,
  mergeFacts,
  normalizeCommand,
  normalizePath,
  sanitizeText,
  sortFacts,
} from "../src/core/canonical.js";
import type { Fact, PathNormalizationOptions } from "../src/core/types.js";

describe("canonicalize", () => {
  it.each([
    ["lone surrogate", "\ud800"],
    ["undefined", undefined],
    ["fraction", 1.5],
    ["infinity", Infinity],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalize(value)).toThrow(TypeError);
  });

  it("normalizes keys and values, sorts by code point, and emits integers literally", () => {
    expect(canonicalize({ "e\u0301": "e\u0301", "\u{1f600}": "é", "\uffff": 1e21 })).toBe(
      '{"é":"é","￿":1000000000000000000000,"😀":"é"}',
    );
  });

  it("rejects NFC key collisions and handles empty containers and negative zero", () => {
    expect(() => canonicalize({ "e\u0301": 1, "é": 2 })).toThrow(TypeError);
    expect(canonicalize({ empty: {}, list: [], zero: -0 })).toBe('{"empty":{},"list":[],"zero":0}');
  });
});

const options: PathNormalizationOptions = {
  cwd: "/repo/work",
  repoRoot: "/repo",
  pathBase: "repo",
  scopeRoots: [
    { root: "/repo", scope: "repo" },
    { root: "/repo/work", scope: "cwd" },
    { root: "/repo/work/granted", scope: "granted" },
  ],
};

describe("path normalization", () => {
  it("gives repo roots precedence over nested cwd/granted roots", () => {
    expect(normalizePath("/repo/work/granted\\a/../b.txt", options)).toEqual({ path: "work/granted/b.txt", scope: "repo" });
    expect(normalizePath("/repo/work/./src/../x.ts", options)).toEqual({ path: "work/x.ts", scope: "repo" });
  });

  it("chooses the longest root within the winning scope", () => {
    const scoped = { ...options, repoRoot: null, scopeRoots: [
      { root: "/repo/work", scope: "cwd" as const },
      { root: "/repo/work/granted", scope: "cwd" as const },
      { root: "/repo", scope: "granted" as const },
    ] };
    expect(normalizePath("/repo/work/granted/a.txt", scoped)).toEqual({ path: "a.txt", scope: "cwd" });
  });

  it("retains external paths only as opaque id and basename, without probing the host", () => {
    expect(normalizePath("/tmp/other/secret.md", options)).toEqual({ path: "627258e9d1ed:secret.md", scope: "external" });
    expect(normalizePath("C:\\Users\\Ada\\outside\\notes.md", options)).toEqual({ path: "1aad9e6f07ff:notes.md", scope: "external" });
  });

  it("preserves URI targets and marks them explicitly", () => {
    expect(normalizePath("xd://host/a/../b?x=1#frag", options)).toEqual({ path: "xd:/a/../b?x=1#frag", scope: "uri" });
    expect(normalizePath("ssh://host/e\u0301?x=1#f", options)).toEqual({ path: "ssh:/é?x=1#f", scope: "uri" });
    expect(() => normalizePath("ssh://host/\ud800", options)).toThrow(TypeError);
  });

  it("redacts file URI hosts through filesystem scoping and strips non-file URI authority", () => {
    const filePath = normalizePath("file:///Users/alice/private/x.md", options);
    expect(filePath).toEqual({ path: "780335bd3c4c:x.md", scope: "external" });
    expect(filePath.path).not.toMatch(/Users|alice|private/);

    const differentLiteral = normalizePath("file://Users/alice/private/x.md", options);
    expect(differentLiteral).toEqual({ path: "b59863beb38c:x.md", scope: "external" });
    expect(differentLiteral.path).not.toBe(filePath.path);

    const backslashLiteral = normalizePath("file:\\Users\\alice\\private\\x.md", options);
    expect(backslashLiteral).toEqual({ path: "75ceee6c1247:x.md", scope: "external" });

    const sshPath = normalizePath("ssh://alice@secret-host/private/x.md", options);
    expect(sshPath).toEqual({ path: "ssh:/private/x.md", scope: "uri" });
    expect(sshPath.path).not.toMatch(/alice|secret-host/);
  });

  it("rejects a target that names only a selected scope root", () => {
    expect(() => normalizePath("/repo", options)).toThrow(TypeError);
    expect(() => normalizePath("file:///repo", options)).toThrow(TypeError);
  });
});

describe("facts", () => {
  const fact = (entry: number, line: number, attrs: Fact["attrs"], snippet = ""): Fact => ({
    kind: "file.modified",
    key: "a.ts",
    at: { entry, ts: null },
    attrs,
    evidence: [{ line, sha256: `${line}` }],
    snippet,
    unbacked: false,
  });

  it("sorts by schema priority, kind, key, entry, and evidence line", () => {
    const first = fact(2, 20, { edits: 1 });
    const second = { ...fact(1, 10, { edits: 1 }), kind: "file.modified" as const, key: "b.ts" };
    expect(sortFacts([{ ...first, kind: "note", key: "n" } as Fact, second, first]).map((item) => item.key)).toEqual(["a.ts", "b.ts", "n"]);
  });

  it("merges numeric/array attrs, evidence, earliest at/snippet, and latest scalar", () => {
    const first = fact(2, 20, { edits: 1, tools: ["z", "a"], failed: false }, "first");
    const second = fact(2, 10, { edits: 2, tools: ["a", "b"], failed: true }, "second");
    const laterMissing = fact(3, 30, { edits: 4 }, "later");
    expect(mergeFacts([first, second, laterMissing])).toEqual([
      {
        ...first,
        at: { entry: 2, ts: null },
        attrs: { edits: 7, failed: false, tools: ["a", "b", "z"] },
        evidence: [{ line: 10, sha256: "10" }, { line: 20, sha256: "20" }, { line: 30, sha256: "30" }],
        snippet: "second",
      },
    ]);
  });
});

describe("text normalization", () => {
  it("sanitizes embedded POSIX, Windows, UNC, file-URI, and authority paths", () => {
    const samples = [
      `cat "/Users/alice/private/My File.txt"`,
      `type C:\\Users\\Ada\\private\\notes.txt`,
      `copy \\\\secret-host\\share\\private\\notes.txt`,
      `cat file://alice@secret-host/private/report.txt`,
      `cat ~/private/report.txt`,
      `scp alice@secret-host:/private/report.txt .`,
      `ssh://alice@secret-host/private/report.txt`,
    ];
    for (const sample of samples) {
      const safe = sanitizeText(sample, options);
      expect(safe).not.toBeNull();
      expect(safe).not.toContain("/Users/alice");
      expect(safe).not.toContain("C:\\Users\\Ada");
      expect(safe).not.toContain("secret-host");
      expect(safe).not.toContain("alice@");
    }
    expect(sanitizeText("ssh://alice@secret-host/private/report.txt", options)).toBe("ssh:/private/report.txt");
  });

  it("treats a colon as a path boundary in prefixed diagnostics", () => {
    expect(sanitizeText("ENOENT:/home/alice/private.txt", options)).not.toContain("/home/alice");
    expect(sanitizeText("Error:C:\\Users\\Ada\\private.txt", options)).not.toContain("C:\\Users\\Ada");
  });

  it("is composition-safe for already-canonical non-file URI text", () => {
    const safe = sanitizeText("ssh://alice@secret-host/private/f.txt", options);
    expect(safe).toBe("ssh:/private/f.txt");
    expect(sanitizeText(safe as string, options)).toBe(safe);
    expect(sanitizeText("host:/private/file", options)).toBeNull();
  });

  it("normalizes commands and truncates at a word boundary", () => {
    expect(normalizeCommand("  printf\t'hello world'  ")).toBe("printf 'hello world'");
    expect(normalizeCommand("\u001b[31m echo hi \u001b[0m")).toBe("echo hi");
    expect(normalizeCommand(" ")).toBeNull();
    const long = normalizeCommand(`${"word ".repeat(200)}tail`);
    expect(long).not.toBeNull();
    expect(Array.from(long as string).length).toBeLessThanOrEqual(512);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("classifies and redacts volatile error details", () => {
    expect(errorSignature("Permission denied /Users/alice/project/file.txt at line 42:17")).toBe("permission:Permission denied <path> at line N:N");
    expect(errorSignature("connection refused request 12345 deadbeefcafebabe", "connection")).toBe("connection:connection refused request N <hex>");
  });

  it("redacts every host-path shape in fallback normalization and preserves canonical URI text", () => {
    const messages = [
      "failed /secret",
      "failed /Users/alice/private/file.txt",
      "failed ~alice/private/file.txt",
      "failed C:\\Users\\Ada\\private\\file.txt",
      "failed \\\\secret-host\\share\\private\\file.txt",
    ];
    for (const message of messages) expect(errorSignature(message, "unknown")).toBe("unknown:failed <path>");
    expect(errorSignature("failed ENOENT:/secret", "unknown")).toBe("unknown:failed <path>");
    expect(errorSignature("failed ssh://alice@secret-host/private/file.txt", "unknown")).toBe("unknown:failed ssh:/private/file.txt");
    expect(errorSignature("failed ssh:/private/file.txt", "unknown")).toBe("unknown:failed ssh:/private/file.txt");
  });
});
