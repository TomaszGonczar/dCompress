import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { run } from "../src/cli.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dcompact-og65-uninstall-"));
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

function writeSettings(path: string): void {
  writeFileSync(path, `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function backupDirectories(store: string): string[] {
  return readdirSync(join(store, "backups"));
}

/** The single byte backup a fresh install writes. */
function backedUpSettings(store: string): string {
  const [only] = backupDirectories(store);
  if (only === undefined) throw new Error("no backup directory was written");
  return join(store, "backups", only, "original", "settings.json");
}

describe("uninstall --agent claude", () => {
  it("D4 proof: restores byte-identical files when the managed region is untouched", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      const beforeInstall = readFileSync(settings);

      // Install
      const installResult = cli(["install", "--agent", "claude", "--settings", settings, "--store", store]);
      expect(installResult.status).toBe(0);
      const backup = backedUpSettings(store);
      expect(readFileSync(backup).equals(beforeInstall)).toBe(true);

      // Uninstall
      const uninstallResult = cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store]);
      expect(uninstallResult.status).toBe(0);

      // D4: the restored file must be byte-identical to the original, not just JSON-equivalent.
      // This is the critical test: if we round-tripped through JSON, the key order or
      // indentation might differ, and this test would fail.
      const afterUninstall = readFileSync(settings);
      expect(afterUninstall.equals(beforeInstall)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints the plan under --dry-run, writes nothing, and executes that same plan", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      cli(["install", "--agent", "claude", "--settings", settings, "--store", store]);
      const beforeDry = readFileSync(settings);

      const dry = cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store, "--dry-run"]);

      expect(dry.status).toBe(0);
      expect(dry.stderr).toBe("");
      expect(readFileSync(settings).equals(beforeDry)).toBe(true);
      expect(dry.stdout).toContain("dry run (nothing is written)");

      const applied = cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store]);

      expect(applied.status).toBe(0);
      expect(applied.stdout).toContain("applied");
      // The plan is the same except for the status line.
      const dryLines = dry.stdout.split("\n").filter((line) => !line.includes("mode"));
      const appliedLines = applied.stdout.split("\n").filter((line) => !line.includes("mode"));
      expect(dryLines).toEqual(appliedLines);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes only the managed entries and preserves user hooks", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      cli(["install", "--agent", "claude", "--settings", settings, "--store", store]);

      const beforeUninstall = readSettings(settings);
      expect((beforeUninstall.hooks as Record<string, unknown>).PreToolUse).toEqual([USER_HOOK]);
      expect((beforeUninstall.hooks as Record<string, unknown>).PreCompact).toBeDefined();
      expect((beforeUninstall.hooks as Record<string, unknown>).SessionStart).toBeDefined();

      cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store]);

      const afterUninstall = readSettings(settings);
      // User's PreToolUse hook should still exist.
      expect((afterUninstall.hooks as Record<string, unknown>).PreToolUse).toEqual([USER_HOOK]);
      // Managed hooks should be gone.
      expect((afterUninstall.hooks as Record<string, unknown>).PreCompact).toBeUndefined();
      expect((afterUninstall.hooks as Record<string, unknown>).SessionStart).toBeUndefined();
      // User's other settings should be preserved.
      expect(afterUninstall.model).toBe("opus");
      expect(afterUninstall.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes the settings file if it was created by install and all entries are removed", () => {
    const root = tempRoot();
    const settings = join(root, "new-settings.json");
    const store = join(root, "store");
    try {
      // Settings file doesn't exist before install.
      cli(["install", "--agent", "claude", "--settings", settings, "--store", store]);
      expect(existsSync(settings)).toBe(true);

      cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store]);

      // File should be deleted because install created it.
      expect(existsSync(settings)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to uninstall when the managed region was edited by the user", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      cli(["install", "--agent", "claude", "--settings", settings, "--store", store]);
      const backup = backedUpSettings(store);

      // User edits a managed hook entry.
      const parsed = readSettings(settings);
      const hooks = parsed.hooks as Record<string, unknown>;
      const precompact = (hooks.PreCompact as unknown[])[0] as Record<string, unknown>;
      const hooksArray = precompact.hooks as unknown[];
      (hooksArray[0] as Record<string, unknown>).command = "echo edited";
      writeFileSync(settings, `${JSON.stringify(parsed, null, 2)}\n`);

      const result = cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store]);

      // Should refuse.
      expect(result.status).toBe(4); // EXIT_REFUSED
      expect(result.stderr).toContain("Refusing to uninstall");
      expect(result.stderr).toContain("was edited after it was installed");
      expect(result.stderr).toContain(backup);
      // File should not be modified.
      const afterRefusal = readSettings(settings);
      expect((afterRefusal.hooks as Record<string, unknown>).PreCompact).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when a managed entry is removed by the user", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      cli(["install", "--agent", "claude", "--settings", settings, "--store", store]);
      const backup = backedUpSettings(store);

      // User deletes a managed hook entry.
      const parsed = readSettings(settings);
      const hooks = parsed.hooks as Record<string, unknown>;
      (hooks.PreCompact as unknown[]).pop();
      writeFileSync(settings, `${JSON.stringify(parsed, null, 2)}\n`);

      const result = cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store]);

      // Should refuse.
      expect(result.status).toBe(4); // EXIT_REFUSED
      expect(result.stderr).toContain("Refusing to uninstall");
      expect(result.stderr).toContain("entries are missing");
      expect(result.stderr).toContain(backup);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent: uninstalling when nothing is installed reports that cleanly", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      const before = readFileSync(settings);

      const result = cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("nothing-installed");
      expect(readFileSync(settings).equals(before)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("succeeds when run twice (second uninstall is a no-op)", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      cli(["install", "--agent", "claude", "--settings", settings, "--store", store]);

      const first = cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store]);
      expect(first.status).toBe(0);
      const afterFirst = readFileSync(settings);

      const second = cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store]);

      expect(second.status).toBe(0);
      expect(second.stdout).toContain("nothing-installed");
      expect(readFileSync(settings).equals(afterFirst)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves user edits outside the managed region", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      cli(["install", "--agent", "claude", "--settings", settings, "--store", store]);

      // User adds their own unrelated hook in a different event.
      const parsed = readSettings(settings);
      const hooks = parsed.hooks as Record<string, unknown>;
      (hooks as Record<string, unknown>).CustomEvent = [
        {
          matcher: "custom",
          hooks: [{ type: "command", command: "custom-command" }],
        },
      ];
      writeFileSync(settings, `${JSON.stringify(parsed, null, 2)}\n`);

      cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store]);

      const afterUninstall = readSettings(settings);
      // The custom event should still be there.
      expect((afterUninstall.hooks as Record<string, unknown>).CustomEvent).toBeDefined();
      expect(((afterUninstall.hooks as Record<string, unknown>).CustomEvent as unknown[])[0]).toEqual({
        matcher: "custom",
        hooks: [{ type: "command", command: "custom-command" }],
      });
      // But the managed hooks should be gone.
      expect((afterUninstall.hooks as Record<string, unknown>).PreCompact).toBeUndefined();
      expect((afterUninstall.hooks as Record<string, unknown>).SessionStart).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns exit code 0 and cleans up state", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      cli(["install", "--agent", "claude", "--settings", settings, "--store", store]);

      const result = cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store]);

      expect(result.status).toBe(0);
      // The backup directory should remain (for manual recovery if needed).
      expect(backupDirectories(store).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores a file that existed before install when it was deleted after", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      const before = readFileSync(settings);

      cli(["install", "--agent", "claude", "--settings", settings, "--store", store]);
      // Now delete the settings file.
      rmSync(settings);
      expect(existsSync(settings)).toBe(false);

      const result = cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("restore");
      // The file should be restored byte-identically.
      expect(existsSync(settings)).toBe(true);
      expect(readFileSync(settings).equals(before)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles settings files with various modes, preserving the original mode when restoring", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeSettings(settings);
      if (process.platform !== "win32") {
        chmodSync(settings, 0o640);
      }
      const before = readFileSync(settings);
      const beforeMode = statSync(settings).mode;

      cli(["install", "--agent", "claude", "--settings", settings, "--store", store]);
      cli(["uninstall", "--agent", "claude", "--settings", settings, "--store", store]);

      const after = readFileSync(settings);
      expect(after.equals(before)).toBe(true);
      if (process.platform !== "win32") {
        const afterMode = statSync(settings).mode;
        expect(beforeMode).toBe(afterMode);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
