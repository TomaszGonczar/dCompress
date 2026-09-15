import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { run } from "../src/cli.js";
import { applyInstall } from "../src/install/apply.js";
import { planInstall } from "../src/install/plan.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dcompress-og65-refusal-"));
}

function cli(argv: readonly string[]): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  let stdout = "";
  let stderr = "";
  const status = run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { status, stdout, stderr };
}

const UNRELATED_HOOK = { matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] };

function settingsText(hooks: unknown): string {
  return `${JSON.stringify({ model: "opus", hooks }, null, 2)}\n`;
}

/** Install into `settings` and return the two arguments every call re-uses. */
function installArgs(settings: string, store: string): string[] {
  return ["install", "--agent", "claude", "--settings", settings, "--store", store];
}

describe("install refusals", () => {
  it("refuses a symlinked settings file without following it", () => {
    const root = tempRoot();
    const target = join(root, "real-settings.json");
    const link = join(root, "settings.json");
    try {
      writeFileSync(target, settingsText({}));
      const before = readFileSync(target);
      symlinkSync(target, link);

      const refused = cli(installArgs(link, join(root, "store")));

      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain(link);
      expect(refused.stderr).toContain("symlink");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target).equals(before)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an unparseable settings file and leaves it byte-identical", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      const broken = '{ "hooks": { "PreCompact": [ }, "model": "opus" }\n';
      writeFileSync(settings, broken);
      const before = readFileSync(settings);

      const refused = cli(installArgs(settings, store));

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(settings);
      expect(refused.stderr).toContain("not valid JSON");
      expect(readFileSync(settings).equals(before)).toBe(true);
      // The refusal precedes the backup, so a refused install leaves no store behind at all.
      expect(existsSync(store)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a dcompress hook that targets another store, leaving the file unchanged", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      const foreign = {
        matcher: "manual|auto",
        hooks: [{ type: "command", command: `dcompress hook --event precompact --store ${join(root, "other-store")}` }],
      };
      writeFileSync(settings, settingsText({ PreCompact: [foreign] }));
      const before = readFileSync(settings);

      const refused = cli(installArgs(settings, store));

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(settings);
      expect(refused.stderr).toContain("store");
      expect(readFileSync(settings).equals(before)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a managed entry that was hand-edited, leaving the file unchanged", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      expect(cli(installArgs(settings, store)).status).toBe(0);
      const installed = JSON.parse(readFileSync(settings, "utf8")) as { hooks: Record<string, unknown> };
      installed.hooks.PreCompact = [{ matcher: "auto", hooks: [{ type: "command", command: `dcompress hook --event precompact --store ${store}` }] }];
      writeFileSync(settings, `${JSON.stringify(installed, null, 2)}\n`);
      const before = readFileSync(settings);

      const refused = cli(installArgs(settings, store));

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("edited");
      expect(refused.stderr).toContain("PreCompact");
      expect(readFileSync(settings).equals(before)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to apply a plan built before the settings file changed", () => {
    const root = tempRoot();
    const settings = join(root, "settings.json");
    const store = join(root, "store");
    try {
      writeFileSync(settings, settingsText({ PreToolUse: [UNRELATED_HOOK] }));
      const plan = planInstall({ agent: "claude", settingsPath: settings, storeRoot: store });

      writeFileSync(settings, settingsText({ PreToolUse: [UNRELATED_HOOK], Other: [] }));
      const edited = readFileSync(settings);

      expect(() => applyInstall(plan)).toThrowError(/changed after this plan was built/);
      expect(readFileSync(settings).equals(edited)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});