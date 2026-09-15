import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureSessionDirectories, sessionPaths, storeRoot } from "../src/store/paths.js";
import { refusalFrom, tempRoots } from "./helpers/store.js";

const temp = tempRoots();
afterEach(temp.clean);

describe("store root resolution", () => {
  it("prefers DCOMPACT_HOME over XDG_DATA_HOME over the home-relative default", () => {
    const home = join(temp.next(), "home");

    expect(storeRoot({ DCOMPACT_HOME: join(home, "explicit"), XDG_DATA_HOME: join(home, "xdg"), HOME: home })).toBe(join(home, "explicit"));
    // DCOMPACT_HOME alone is enough: HOME is not consulted, let alone required.
    expect(storeRoot({ DCOMPACT_HOME: join(home, "explicit") })).toBe(join(home, "explicit"));
    expect(storeRoot({ XDG_DATA_HOME: join(home, "xdg"), HOME: home })).toBe(join(home, "xdg", "dcompact"));
    expect(storeRoot({ HOME: home })).toBe(join(home, ".local", "share", "dcompact"));
  });

  it("normalizes a trailing separator instead of keeping two spellings of one root", () => {
    const home = join(temp.next(), "home");

    expect(storeRoot({ HOME: `${home}/` })).toBe(join(home, ".local", "share", "dcompact"));
  });

  it("refuses when no environment variable names a store root", () => {
    const refusal = refusalFrom(() => storeRoot({}));

    expect(refusal.code).toBe("home-unset");
    expect(refusal.message).toContain("DCOMPACT_HOME");
  });

  it.each([
    ["DCOMPACT_HOME", { DCOMPACT_HOME: "relative/dir" }],
    ["XDG_DATA_HOME", { XDG_DATA_HOME: "relative/dir" }],
    ["HOME", { HOME: "relative/dir" }],
  ])("refuses a relative %s rather than resolving it against the working directory", (_variable, env) => {
    expect(refusalFrom(() => storeRoot(env)).code).toBe("relative-store-root");
  });

  it.each([
    ["DCOMPACT_HOME", { DCOMPACT_HOME: "   " }],
    ["XDG_DATA_HOME", { XDG_DATA_HOME: "" }],
    ["HOME", { HOME: " " }],
  ])("refuses an empty or blank %s", (_variable, env) => {
    expect(refusalFrom(() => storeRoot(env)).code).toBe("empty-store-root");
  });

  it("refuses a root with surrounding whitespace instead of trimming it", () => {
    expect(refusalFrom(() => storeRoot({ DCOMPACT_HOME: "/tmp/dcompact " })).code).toBe("invalid-store-root");
  });
});

describe("session directory names", () => {
  it("derives every session path from the store root and the two tokens", () => {
    const root = join(temp.next(), "store");
    const paths = sessionPaths({ adapter: "claude", sessionId: "session-1", root });

    expect(paths.name).toBe("claude-session-1");
    expect(paths.sessions).toBe(join(root, "sessions"));
    expect(paths.session).toBe(join(root, "sessions", "claude-session-1"));
    expect(paths.snapshots).toBe(join(root, "sessions", "claude-session-1", "snapshots"));
    expect(paths.manifest).toBe(join(root, "sessions", "claude-session-1", "manifest.json"));
    expect(paths.lock).toBe(join(root, "sessions", "claude-session-1", "lock"));
  });

  it("refuses session ids that are not bounded tokens, creating nothing", () => {
    const root = temp.next();
    for (const sessionId of ["", "../escape", "a/b", ".hidden", "..", "x".repeat(129), "session 1", "session\n1"]) {
      expect(refusalFrom(() => sessionPaths({ adapter: "claude", sessionId, root })).code).toBe("invalid-session-id");
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses adapter ids that are not bounded tokens, including the separator", () => {
    const root = temp.next();
    for (const adapter of ["", "Claude", "cla ude", "cla-ude", "1claude", "x".repeat(33), "claude/"]) {
      expect(refusalFrom(() => sessionPaths({ adapter, sessionId: "session-1", root })).code).toBe("invalid-adapter-id");
    }
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("private state directories", () => {
  it("refuses a symlinked store root and writes nothing through the link", () => {
    const base = temp.next();
    const real = join(base, "real");
    mkdirSync(real);
    const link = join(base, "link");
    symlinkSync(real, link, "dir");
    const paths = sessionPaths({ adapter: "claude", sessionId: "session-1", root: link });

    expect(refusalFrom(() => ensureSessionDirectories(paths)).code).toBe("symlink-state");
    expect(readdirSync(real)).toEqual([]);
  });

  it("refuses a symlinked sessions directory inside a real root", () => {
    const base = temp.next();
    const root = join(base, "store");
    const elsewhere = join(base, "elsewhere");
    mkdirSync(root);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "sessions"), "dir");
    const paths = sessionPaths({ adapter: "claude", sessionId: "session-1", root });

    expect(refusalFrom(() => ensureSessionDirectories(paths)).code).toBe("symlink-state");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses a session directory occupied by a file", () => {
    const base = temp.next();
    const root = join(base, "store");
    const paths = sessionPaths({ adapter: "claude", sessionId: "session-1", root });
    mkdirSync(paths.sessions, { recursive: true });
    writeFileSync(paths.session, "not a directory");

    expect(refusalFrom(() => ensureSessionDirectories(paths)).code).toBe("state-not-directory");
  });

  it.skipIf(process.platform === "win32")("refuses an unreadable store root with an actionable message", () => {
    const base = temp.next();
    const blocked = join(base, "blocked");
    mkdirSync(blocked);
    chmodSync(blocked, 0o000);
    const paths = sessionPaths({ adapter: "claude", sessionId: "session-1", root: join(blocked, "store") });

    try {
      const refusal = refusalFrom(() => ensureSessionDirectories(paths));
      expect(refusal.code).toBe("state-unreadable");
      expect(refusal.message).toContain("permission denied");
    } finally {
      // Restore before cleanup: the temp root cannot be removed through a 000 directory.
      chmodSync(blocked, 0o700);
    }
  });
});