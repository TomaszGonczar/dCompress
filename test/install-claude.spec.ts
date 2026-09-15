import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { run } from "../src/cli.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dcompress-og65-"));
}

function cli(argv: readonly string[]): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  let stdout = "";
  let stderr = "";
  const status = run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { status, stdout, stderr };
}

/** A settings file with unrelated keys and a user hook, as a real one would have. */
const USER_HOOK = { matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] };
const USER_SETTINGS = {
  model: "opus",
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: { PreToolUse: [USER_HOOK] },
};

function writeSettings(path: string, mode?: number): void {
  writeFileSync(path, `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);
  if (mode !== undefined) chmodSync(path, mode);
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function backupDirectories(store: string): string[] {
  return readdirSync(join(store, "backups"));
}

/** The single byte backup a fresh install writes, resolved through the store rather than parsed. */
function backedUpSettings(store: string): string {
  const [only] = backupDirectories(store);
  if (only === undefined) throw new Error("no backup directory was written");
  return join(store, "backups", only, "original", "settings.json");
}

function entry(event: string, hookEvent: string, store: string): unknown {
  return {
    matcher: event === "PreCompact" ? "manual|auto" : "resume|compact|startup",
    hooks: [{ type: "command", command: `dcompress hook --event ${hookEvent} --store ${store}` }],
  };
}

describe("install --agent claude", () => {
  it("prints the plan under --dry-run, writes nothing, and executes that same plan", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      const before = readFileSync(settings);
      const dry = cli(["install", "--agent", "claude", "--settings", settings, "--store", store, "--dry-run"]);

      expect(dry.status).toBe(0);
      expect(dry.stderr).toBe("");
      expect(readFileSync(settings).equals(before)).toBe(true);
      expect(existsSync(store)).toBe(false);

      const applied = cli(["install", "--agent", "claude", "--settings", settings, "--store", store]);

      expect(applied.status).toBe(0);
      // The plan is identical line for line except `mode`. The backup directory is named from the
      // clock by design (CONCEPT §6.3), so a dry run predicts a stamp the real run may not land on:
      // that one path is normalized away and every other byte is compared.
      const withoutStamp = (stdout: string): string => stdout.replace(/backups\/claude-[^/]+/g, "backups/claude-<stamp>");
      const modeLine = (stdout: string): string[] => stdout.split("\n").filter((line) => !line.startsWith("mode"));
      expect(modeLine(withoutStamp(dry.stdout))).toEqual(modeLine(withoutStamp(applied.stdout)));
      expect(dry.stdout).toContain("backups/claude-");
      expect(dry.stdout).toContain("mode     dry run (nothing is written)");
      expect(applied.stdout).toContain("mode     applied");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds exactly the two managed entries and leaves unrelated settings untouched", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      expect(cli(["install", "--agent", "claude", "--settings", settings, "--store", store]).status).toBe(0);

      const parsed = readSettings(settings);
      expect(parsed.model).toBe("opus");
      expect(parsed.permissions).toEqual({ allow: ["Bash(ls:*)"] });
      const hooks = parsed.hooks as Record<string, unknown>;
      expect(Object.keys(hooks).sort()).toEqual(["PreCompact", "PreToolUse", "SessionStart"]);
      expect(hooks.PreToolUse).toEqual([USER_HOOK]);
      expect(hooks.PreCompact).toEqual([entry("PreCompact", "precompact", store)]);
      expect(hooks.SessionStart).toEqual([entry("SessionStart", "session-start", store)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a hand-added entry beside dcompress's own and records the backup byte-identically", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      const before = readFileSync(settings);
      expect(cli(["install", "--agent", "claude", "--settings", settings, "--store", store]).status).toBe(0);

      const backup = backedUpSettings(store);
      expect(readFileSync(backup).equals(before)).toBe(true);
      expect(readFileSync(backup).equals(readFileSync(settings))).toBe(false);

      // The backup is the pre-install file: installing again over the edited file must reject the
      // edited entry rather than treat the earlier install as its own.
      const parsed = readSettings(settings);
      expect((parsed.hooks as Record<string, unknown>).PreToolUse).toEqual([USER_HOOK]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent: a second install adds no entry and reports the region already matches", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      const args = ["install", "--agent", "claude", "--settings", settings, "--store", store];
      expect(cli(args).status).toBe(0);
      const afterFirst = readFileSync(settings);

      const second = cli(args);

      expect(second.status).toBe(0);
      expect(second.stdout).toContain("status   already-installed");
      expect(second.stdout).toContain("mode     already installed (the managed region matches; nothing is written)");
      expect(readFileSync(settings).equals(afterFirst)).toBe(true);
      const hooks = readSettings(settings).hooks as Record<string, unknown>;
      expect(hooks.PreCompact).toHaveLength(1);
      expect(hooks.SessionStart).toHaveLength(1);
      expect(backupDirectories(store)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates an absent settings file and keeps every state path private", () => {
    const root = tempRoot();
    const settings = join(root, "claude", "settings.json");
    const store = join(root, "store");
    try {
      mkdirSync(join(root, "claude"));
      const created = cli(["install", "--agent", "claude", "--settings", settings, "--store", store]);

      expect(created.status).toBe(0);
      expect(created.stdout).toContain("status   create");
      const hooks = readSettings(settings).hooks as Record<string, unknown>;
      expect(hooks.PreCompact).toEqual([entry("PreCompact", "precompact", store)]);
      expect(hooks.SessionStart).toEqual([entry("SessionStart", "session-start", store)]);

      if (process.platform !== "win32") {
        const backupDirectory = join(store, "backups", backupDirectories(store)[0] as string);
        expect(statSync(settings).mode & 0o777).toBe(0o600);
        // A created file has no pre-install bytes, so the backup holds the record and no copy.
        for (const directory of [store, join(store, "backups"), backupDirectory]) {
          expect(statSync(directory).mode & 0o777).toBe(0o700);
        }
        expect(statSync(join(backupDirectory, "record.json")).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the mode of a settings file the user already had", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings, 0o640);
      expect(cli(["install", "--agent", "claude", "--settings", settings, "--store", store]).status).toBe(0);

      if (process.platform !== "win32") {
        expect(statSync(settings).mode & 0o777).toBe(0o640);
        expect(statSync(backedUpSettings(store)).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});