/**
 * Install planning: the value CONCEPT §11.1 requires, not a convenience flag.
 *
 * `planInstall` is the only code path that decides what happens, and it decides it before any
 * byte is written: it reads the target, classifies the managed region, refuses on conflict, and
 * returns the exact post-edit bytes plus the exact list of files that would be touched. `install`
 * then applies that value; `--dry-run` prints it and applies nothing. There is no second path
 * that could write something the plan did not describe.
 *
 * Refusals happen here rather than at write time so that `--dry-run` on a conflicted file is as
 * informative as a real run, and so a refusal can never happen after a backup has been taken.
 */

import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { basename, join, resolve } from "node:path";

import {
  assertSafeCommandToken,
  CLAUDE_AGENT,
  eventGroups,
  hookCommand,
  hooksObject,
  isPlainObject,
  MANAGED_EVENTS,
  managedEntries,
  managedEventFor,
  matchHookGrammar,
  singleCommand,
} from "./claude.js";
import type { HookEntry } from "./claude.js";
import { octalMode, readExistingFile, sha256OfBytes } from "./fs.js";
import { InstallRefusal } from "./refusal.js";

export interface InstallOptions {
  readonly agent: "claude";
  readonly settingsPath: string;
  readonly storeRoot: string;
  /** The executable Claude will invoke; the bare name is the stable default (CONCEPT §7.2). */
  readonly executable?: string;
  readonly now?: () => number;
}

/** What uninstall needs to locate the entry it wrote and to prove it is unchanged. */
export interface ManagedEntryRecord {
  readonly event: string;
  readonly matcher: string;
  readonly command: string;
  readonly entry_index: number;
}

export interface OriginalFileRecord {
  readonly present: boolean;
  /** Backup-relative path of the byte copy, or `null` when the target did not exist. */
  readonly file: string | null;
  readonly sha256: string | null;
  readonly bytes: number | null;
}

/**
 * The install record written beside the backup.
 *
 * It exists so that a later uninstall can decide without guessing: `original.file` restores the
 * pre-install bytes, `managed` recognizes dcompress's own entries in the current file, and
 * `installed.sha256` distinguishes "our file, untouched since install" from "the user edited it"
 * for a target that dcompress created.
 */
export interface InstallRecord {
  readonly record_schema: "dcompress.install/1";
  readonly agent: "claude";
  readonly installed_at: string;
  /** `prepared` until the settings write and its verification both succeed. */
  readonly state: "prepared" | "installed";
  readonly settings_path: string;
  readonly settings_mode: string;
  readonly store_root: string;
  readonly executable: string;
  readonly original: OriginalFileRecord;
  readonly managed: readonly ManagedEntryRecord[];
  readonly installed: { readonly sha256: string; readonly bytes: number } | null;
}

export interface PlannedWrite {
  readonly path: string;
  readonly label: string;
  /** `null` when the size depends on a hash only known after the write (the install record). */
  readonly bytes: number | null;
  readonly mode: string;
  readonly creates: boolean;
}

export interface InstallPlan {
  readonly agent: "claude";
  readonly settingsPath: string;
  readonly storeRoot: string;
  readonly executable: string;
  readonly status: "create" | "append" | "already-installed";
  readonly reads: readonly string[];
  readonly settingsMode: number;
  readonly settingsCreated: boolean;
  readonly originalSha256: string | null;
  readonly originalBytes: number | null;
  readonly backupDir: string | null;
  readonly backupFile: string | null;
  readonly writes: readonly PlannedWrite[];
  /** The managed region the file will carry afterwards, in install order. */
  readonly entries: readonly ManagedEntryRecord[];
  /** Events this run adds; empty when the managed region already matches. */
  readonly additions: readonly string[];
  /** The exact bytes that will be written, or `null` when nothing is written. */
  readonly settingsText: string | null;
  readonly record: InstallRecord;
}

export const RECORD_SCHEMA = "dcompress.install/1";

function timestamp(now: () => number): string {
  // Colons are legal in POSIX filenames but not on Windows, and this name becomes a directory.
  return new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

/**
 * A timestamped backup directory, suffixed when the same second is used twice.
 *
 * Two installs in the same second must not share a directory: the second would overwrite the
 * first's byte copy, and that copy is the only thing that makes uninstall byte-exact.
 */
function backupDirectory(root: string, agent: string, stamp: string): string {
  const base = `${agent}-${stamp}`;
  for (let attempt = 1; attempt <= 99; attempt += 1) {
    const name = attempt === 1 ? base : `${base}-${attempt}`;
    if (!existsSync(join(root, "backups", name))) return name;
  }
  throw new InstallRefusal(
    "backup-name-exhausted",
    `Refusing to install: 99 backups already exist for ${JSON.stringify(base)} under ${JSON.stringify(root)}. Remove old backup directories for this agent, then re-run.`,
  );
}

/**
 * Classify dcompress's managed region, refusing anything dcompress cannot prove is its own.
 *
 * The refusal classes here are the ways a JSON managed region goes wrong, and each one names the
 * file and the offending entry. The return value is the index of dcompress's own entry per event,
 * which is all the planner needs to keep an entry in place instead of appending a second one.
 */
function scanManagedRegion(
  hooks: Record<string, unknown>,
  settingsPath: string,
  storeRoot: string,
  expected: Record<string, HookEntry | undefined>,
): ReadonlyMap<string, number> {
  // Every event's shape is read before any entry is classified, so a malformed hooks.<Event>
  // anywhere in the file is refused even when that event is not one dcompress manages.
  const matchedIndices = new Map<string, number>();
  for (const event of Object.keys(hooks)) {
    const groups = eventGroups(hooks, event, settingsPath);
    groups.forEach((group, index) => {
      const command = singleCommand(group);
      if (command === null) return;
      const grammar = matchHookGrammar(command);
      if (grammar === null) return;
      if (grammar.store !== storeRoot) {
        throw new InstallRefusal(
          "managed-region-foreign-store",
          `Refusing to edit ${JSON.stringify(settingsPath)}: hooks.${event}[${index}] already contains a dcompress hook command targeting store ${JSON.stringify(grammar.store)}, and this install writes hooks for ${JSON.stringify(storeRoot)}. One settings file carries hooks for one store: remove that entry (or uninstall the install that wrote it), then re-run.`,
        );
      }
      if (grammar.hookEvent !== managedEventFor(event)?.hookEvent) {
        throw new InstallRefusal(
          "managed-entry-moved",
          `Refusing to edit ${JSON.stringify(settingsPath)}: hooks.${event}[${index}] is a dcompress ${JSON.stringify(grammar.hookEvent)} hook sitting under the ${JSON.stringify(event)} event. dcompress never writes that pairing, so the entry was moved by hand; restore the file from its backup or fix the entry, then re-run.`,
        );
      }
      const wanted = expected[event];
      if (wanted === undefined) return;
      if (!isDeepStrictEqual(group, wanted)) {
        throw new InstallRefusal(
          "managed-region-edited",
          `Refusing to edit ${JSON.stringify(settingsPath)}: the dcompress entry at hooks.${event}[${index}] was edited after it was installed (it reads ${JSON.stringify(group)}). dcompress will not overwrite a hand edit: restore the file from the recorded backup, or delete that entry and re-run install.`,
        );
      }
      if (matchedIndices.has(event)) {
        throw new InstallRefusal(
          "managed-entry-duplicate",
          `Refusing to edit ${JSON.stringify(settingsPath)}: hooks.${event} contains the same dcompress entry at index ${matchedIndices.get(event)} and index ${index}. Installing again would leave both firing; remove one, then re-run.`,
        );
      }
      matchedIndices.set(event, index);
    });
  }
  return matchedIndices;
}

export function planInstall(options: InstallOptions): InstallPlan {
  const settingsPath = resolve(options.settingsPath);
  const storeRoot = resolve(options.storeRoot);
  const executable = options.executable ?? "dcompress";
  const now = options.now ?? Date.now;
  assertSafeCommandToken("hook executable", executable, "--command");
  assertSafeCommandToken("state root", storeRoot, "--store");

  const existing = readExistingFile(settingsPath, "settings file");
  const expected: Record<string, HookEntry | undefined> = managedEntries(executable, storeRoot);

  let document: Record<string, unknown> = {};
  let settingsCreated = true;
  let previousText = "";
  if (existing !== null) {
    settingsCreated = false;
    previousText = existing.text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing.text);
    } catch (error) {
      throw new InstallRefusal(
        "unparseable-settings",
        `Refusing to edit ${JSON.stringify(settingsPath)}: it is not valid JSON (${error instanceof Error ? error.message : String(error)}). The file is unchanged; repair or move it aside, then re-run.`,
      );
    }
    if (!isPlainObject(parsed)) {
      throw new InstallRefusal(
        "settings-not-object",
        `Refusing to edit ${JSON.stringify(settingsPath)}: its JSON root is not an object, which is the shape Claude settings require. The file is unchanged; repair it, then re-run.`,
      );
    }
    document = parsed;
  }

  const hooks = hooksObject(document, settingsPath);
  const matchedIndices = scanManagedRegion(hooks, settingsPath, storeRoot, expected);

  const additions: string[] = [];
  const entries: ManagedEntryRecord[] = [];
  for (const managed of MANAGED_EVENTS) {
    const wanted = expected[managed.event];
    if (wanted === undefined) continue;
    // Re-read through a local so the `Array.isArray` narrowing applies: the planner only ever
    // extends an existing group list, never reorders or rewrites one.
    const current = hooks[managed.event];
    const groups: unknown[] = Array.isArray(current) ? current : [];
    if (!matchedIndices.has(managed.event)) {
      groups.push(wanted);
      hooks[managed.event] = groups;
      additions.push(managed.event);
    }
    entries.push({
      event: managed.event,
      matcher: managed.matcher,
      command: hookCommand(executable, managed, storeRoot),
      entry_index: matchedIndices.get(managed.event) ?? groups.length - 1,
    });
  }

  const status: InstallPlan["status"] = settingsCreated ? "create" : additions.length > 0 ? "append" : "already-installed";
  const settingsMode = existing === null ? 0o600 : existing.mode;
  const settingsText =
    status === "already-installed"
      ? null
      : // JSON formatting is not preserved (ADR 005 scopes byte-exact restoration to the backup);
          // the trailing newline is, because a file that had one should keep one.
          `${JSON.stringify(document, null, 2)}${settingsCreated || previousText.endsWith("\n") ? "\n" : ""}`;

  const stamp = timestamp(now);
  const backupName = status === "already-installed" ? null : backupDirectory(storeRoot, CLAUDE_AGENT, stamp);
  const backupDir = backupName === null ? null : join(storeRoot, "backups", backupName);
  const backupFile = backupDir === null || existing === null ? null : join(backupDir, "original", basename(settingsPath));
  const originalSha256 = existing === null ? null : sha256OfBytes(existing.bytes);

  const writes: PlannedWrite[] = [];
  if (status !== "already-installed" && backupDir !== null) {
    if (backupFile !== null && existing !== null) {
      writes.push({ path: backupFile, label: "byte backup", bytes: existing.bytes.byteLength, mode: octalMode(0o600), creates: true });
    }
    // Written twice: `prepared` before the settings write and `installed` after verification, so
    // an interrupted install leaves evidence instead of a file that looks complete.
    writes.push({ path: join(backupDir, "record.json"), label: "install record (prepared, then installed)", bytes: null, mode: octalMode(0o600), creates: true });
    writes.push({
      path: settingsPath,
      label: "settings file",
      bytes: settingsText === null ? 0 : Buffer.byteLength(settingsText, "utf8"),
      mode: octalMode(settingsMode),
      creates: settingsCreated,
    });
  }

  return {
    agent: CLAUDE_AGENT,
    settingsPath,
    storeRoot,
    executable,
    status,
    reads: [settingsPath],
    settingsMode,
    settingsCreated,
    originalSha256,
    originalBytes: existing === null ? null : existing.bytes.byteLength,
    backupDir,
    backupFile,
    writes,
    entries,
    additions,
    settingsText,
    record: {
      record_schema: RECORD_SCHEMA,
      agent: CLAUDE_AGENT,
      installed_at: stamp,
      state: "prepared",
      settings_path: settingsPath,
      settings_mode: octalMode(settingsMode),
      store_root: storeRoot,
      executable,
      original: {
        present: existing !== null,
        file: backupFile === null ? null : `original/${basename(settingsPath)}`,
        sha256: originalSha256,
        bytes: existing === null ? null : existing.bytes.byteLength,
      },
      managed: entries,
      installed: null,
    },
  };
}

/** The plan as text. Both `--dry-run` and a real run print this same value. */
export function renderPlan(plan: InstallPlan, mode: "dry-run" | "applied"): string {
  const lines: string[] = [];
  // The outcome of the run is one line of its own, so `--dry-run` and a real run print the same
  // plan for the same inputs and a caller can diff the two without stripping a suffix.
  const outcome =
    mode === "dry-run"
      ? "dry run (nothing is written)"
      : plan.status === "already-installed"
        ? "already installed (the managed region matches; nothing is written)"
        : "applied";
  lines.push(`install plan — agent ${plan.agent}`);
  lines.push(`status   ${plan.status}`);
  lines.push(`mode     ${outcome}`);
  lines.push(`settings ${plan.settingsPath}`);
  lines.push(`store    ${plan.storeRoot}`);
  const settingsAction =
    plan.status === "already-installed"
      ? "managed region already matches; no write"
      : `${plan.settingsCreated ? "create" : "edit"} (mode ${octalMode(plan.settingsMode)})`;
  lines.push(`  ${settingsAction}`);
  lines.push(plan.backupFile === null ? "backup   none (nothing is edited)" : `backup   ${plan.backupFile} (${plan.originalBytes ?? 0} bytes, ${plan.originalSha256 ?? "absent"})`);
  lines.push("reads");
  for (const path of plan.reads) lines.push(`  ${path}`);
  lines.push(plan.writes.length === 0 ? "writes\n  none" : "writes");
  for (const write of plan.writes) {
    const size = write.bytes === null ? "size after write" : `${write.bytes} bytes`;
    lines.push(`  ${write.path} (${write.creates ? "create" : "replace"}, mode ${write.mode}, ${size})`);
  }
  lines.push(`hook entries (${plan.entries.length})`);
  for (const entry of plan.entries) {
    const state = plan.additions.includes(entry.event) && plan.status !== "already-installed" ? "add" : "keep";
    lines.push(`  ${state} ${entry.event} matcher ${JSON.stringify(entry.matcher)} → ${entry.command}`);
  }
  return `${lines.join("\n")}\n`;
}