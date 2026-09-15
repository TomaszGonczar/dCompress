/**
 * Uninstall planning: the only code path that decides what uninstall does.
 *
 * The install record is the source of truth: it names what was installed, where the pre-install
 * bytes are backed up, and the SHA256 of the file at installation time. By comparing that SHA256
 * against the current file, we can detect whether the user edited the managed region.
 *
 * If the user edited outside the managed region, we remove only the managed entries and keep
 * their edits. If they edited inside it, we refuse with the exact backup path for manual merge.
 *
 * An absent install record means nothing was installed; uninstall is a no-op and exits cleanly.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  eventGroups,
  hooksObject,
  isPlainObject,
  singleCommand,
} from "./claude.js";
import { readExistingFile } from "./fs.js";
import { InstallRefusal } from "./refusal.js";
import type { InstallRecord, ManagedEntryRecord } from "./plan.js";
import { RECORD_SCHEMA } from "./plan.js";

export interface UninstallOptions {
  readonly agent: "claude";
  readonly settingsPath: string;
  readonly storeRoot: string;
}

/** What was found when scanning for install records. */
interface InstallRecordLocation {
  /** The parsed record. */
  readonly record: InstallRecord;
  /** Absolute path to the record file. */
  readonly recordPath: string;
  /** Absolute path to the backup directory containing this record. */
  readonly backupDir: string;
}

export interface PlannedRemoval {
  readonly path: string;
  readonly label: string;
  readonly mode: string;
}

export interface UninstallPlan {
  readonly agent: "claude";
  readonly settingsPath: string;
  readonly storeRoot: string;
  /** No install record found; nothing to uninstall. */
  readonly status: "nothing-installed" | "removals" | "restore";
  /** When status is `removals` or `restore`, the install record that drives the uninstall. */
  readonly record: InstallRecord | null;
  /** When status is `removals` or `restore`, the backup directory path. */
  readonly backupDir: string | null;
  /** Entries to remove from the settings file, in reverse order (so indices stay valid). */
  readonly removals: readonly PlannedRemoval[];
  /** The exact bytes that will be written to the settings file, or null if the file is deleted. */
  readonly settingsText: string | null;
}

/** Locate the install record for this settings path and store. */
function findInstallRecord(settingsPath: string, storeRoot: string): InstallRecordLocation | null {
  const backupsDir = join(storeRoot, "backups");
  if (!existsSync(backupsDir)) return null;

  const backupNames = readdirSync(backupsDir);
  for (const backupName of backupNames) {
    const backupDir = join(backupsDir, backupName);
    const recordPath = join(backupDir, "record.json");
    if (!existsSync(recordPath)) continue;

    let recordText: string;
    let record: unknown;
    try {
      const existing = readExistingFile(recordPath, "install record");
      if (existing === null) continue;
      recordText = existing.text;
      record = JSON.parse(recordText);
    } catch {
      continue;
    }

    if (!isPlainObject(record)) continue;
    if (record.record_schema !== RECORD_SCHEMA) continue;
    if (record.agent !== "claude") continue;
    if (record.settings_path !== settingsPath) continue;
    if (record.store_root !== storeRoot) continue;

    return { record: record as unknown as InstallRecord, recordPath, backupDir };
  }
  return null;
}

/**
 * Verify that the managed region in the current file matches what was installed.
 *
 * If it doesn't match and the user has clearly edited it, refuse with the backup path.
 * If the user edited outside the managed region but left the managed entries intact,
 * that's fine — we can proceed with the uninstall.
 */
/**
 * Check if the managed entries in the current file are unchanged, or if they're already gone.
 *
 * If an entry is missing and can't possibly have been there from install, refuse with the backup
 * path. But if entries are already gone (idempotent case), return false to signal that.
 * Returns true if verification passed (entries unchanged), false if they're already gone.
 */
function verifyManagedRegionUnchanged(
  currentDocument: Record<string, unknown>,
  record: InstallRecord,
  settingsPath: string,
  backupFile: string | null,
): boolean {
  const hooks = hooksObject(currentDocument, settingsPath);

  // Track how many entries we find to detect the idempotent case (all already gone).
  let foundCount = 0;
  for (const entry of record.managed) {
    const groups = eventGroups(hooks, entry.event, settingsPath);
    const group = groups[entry.entry_index];

    if (group === undefined) {
      // Entry is missing. This could be:
      // 1. Already uninstalled (idempotent case, all entries are missing)
      // 2. User removed one but not others (partial edit, refuse)
      // 3. User moved it (refuse)
      continue;
    }

    foundCount += 1;
    const command = singleCommand(group);
    if (command === null) {
      const recovery =
        backupFile === null
          ? "Restore or recreate that entry to match the original, then try again."
          : `The pre-install bytes are at ${JSON.stringify(backupFile)}.`;
      throw new InstallRefusal(
        "managed-entry-corrupted",
        `Refusing to uninstall: hooks.${entry.event}[${entry.entry_index}] in ${JSON.stringify(settingsPath)} is not a single-command group. ${recovery}`,
      );
    }

    if (command !== entry.command) {
      const recovery =
        backupFile === null
          ? "Restore that entry to match the original, then try again."
          : `The pre-install bytes are at ${JSON.stringify(backupFile)}.`;
      throw new InstallRefusal(
        "managed-entry-edited",
        `Refusing to uninstall: the dcompress entry at hooks.${entry.event}[${entry.entry_index}] in ${JSON.stringify(settingsPath)} was edited after it was installed. ${recovery}`,
      );
    }
  }

  // If we found no entries at all, the uninstall already happened (idempotent).
  if (foundCount === 0) {
    return false;
  }

  // If we found some but not all entries, it's a partial removal by user (refuse).
  if (foundCount < record.managed.length) {
    const recovery =
      backupFile === null
        ? "Restore or recreate the missing entries to match the original, then try again."
        : `The pre-install bytes are at ${JSON.stringify(backupFile)}.`;
    throw new InstallRefusal(
      "managed-entry-removed",
      `Refusing to uninstall: some dcompress entries are missing from ${JSON.stringify(settingsPath)}. ${recovery}`,
    );
  }

  // All entries found and unchanged.
  return true;
}

/**
 * Create the post-removal settings text by removing the managed entries in reverse order.
 *
 * We remove in reverse order so earlier indices don't become invalid as we remove.
 * If all entries in an event's group are removed and the result is an empty array,
 * we delete that key entirely. If the hooks object becomes empty, we delete it too.
 */
function removeEntries(
  document: Record<string, unknown>,
  entries: readonly ManagedEntryRecord[],
  settingsPath: string,
): { text: string; removals: PlannedRemoval[] } {
  // Deep clone the document so we don't mutate the original during inspection.
  const result = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  const removals: PlannedRemoval[] = [];

  // Collect entries to remove, grouped by event and sorted in reverse order.
  const byEvent = new Map<string, number[]>();
  for (const entry of entries) {
    if (!byEvent.has(entry.event)) {
      byEvent.set(entry.event, []);
    }
    byEvent.get(entry.event)!.push(entry.entry_index);
  }

  // Sort each event's indices in descending order so removal doesn't shift remaining indices.
  for (const indices of byEvent.values()) {
    indices.sort((a, b) => b - a);
  }

  // Remove entries in descending order per event.
  const hooks = hooksObject(result, settingsPath);
  for (const [event, indices] of byEvent) {
    const groups = eventGroups(hooks, event, settingsPath);
    for (const index of indices) {
      groups.splice(index, 1);
      removals.push({ path: `hooks.${event}[${index}]`, label: "managed hook entry", mode: "N/A" });
    }

    // If the event group is now empty, delete it.
    if (groups.length === 0) {
      delete hooks[event];
    }
  }

  // If hooks is empty after removal, delete it.
  if (Object.keys(hooks).length === 0) {
    delete result.hooks;
  }

  const originalText =
    Object.keys(result).length === 0 ? "" : `${JSON.stringify(result, null, 2)}\n`;

  return { text: originalText, removals };
}

export function planUninstall(options: UninstallOptions): UninstallPlan {
  const settingsPath = resolve(options.settingsPath);
  const storeRoot = resolve(options.storeRoot);

  const recordLocation = findInstallRecord(settingsPath, storeRoot);
  if (recordLocation === null) {
    return {
      agent: "claude",
      settingsPath,
      storeRoot,
      status: "nothing-installed",
      record: null,
      backupDir: null,
      removals: [],
      settingsText: null,
    };
  }

  const { record, backupDir } = recordLocation;

  // Read the current settings file.
  const existing = readExistingFile(settingsPath, "settings file");
  let currentDocument: Record<string, unknown> = {};
  let currentText = "";
  if (existing !== null) {
    currentText = existing.text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(currentText);
    } catch (error) {
      throw new InstallRefusal(
        "unparseable-settings",
        `Refusing to uninstall: ${JSON.stringify(settingsPath)} is not valid JSON (${error instanceof Error ? error.message : String(error)}). The file is unchanged. Repair it or move it aside, then re-run.`,
      );
    }
    if (!isPlainObject(parsed)) {
      throw new InstallRefusal(
        "settings-not-object",
        `Refusing to uninstall: ${JSON.stringify(settingsPath)} does not parse to a JSON object. The file is unchanged.`,
      );
    }
    currentDocument = parsed;
  } else if (record.original.present) {
    // The settings file was present at install time but is now missing. Restore it.
    if (record.original.file === null) {
      throw new InstallRefusal(
        "plan-incomplete",
        `Refusing to uninstall: the install record says the file existed but has no backup location. The file is unchanged. Re-check the record at ${JSON.stringify(recordLocation.recordPath)}.`,
      );
    }
    // We'll restore the full file in the apply phase.
    return {
      agent: "claude",
      settingsPath,
      storeRoot,
      status: "restore",
      record,
      backupDir,
      removals: [],
      settingsText: null, // Signal to restore from backup.
    };
  } else {
    // The file didn't exist at install and doesn't exist now. Nothing to do.
    return {
      agent: "claude",
      settingsPath,
      storeRoot,
      status: "nothing-installed",
      record,
      backupDir,
      removals: [],
      settingsText: null,
    };
  }

  // Verify the managed region hasn't been edited by the user. If entries are already gone,
  // treat it as idempotent (nothing to uninstall).
  const backupFile = record.original.file === null ? null : join(backupDir, record.original.file);
  const entriesStillPresent = verifyManagedRegionUnchanged(currentDocument, record, settingsPath, backupFile);
  if (!entriesStillPresent) {
    // Entries are already gone, uninstall already happened.
    return {
      agent: "claude",
      settingsPath,
      storeRoot,
      status: "nothing-installed",
      record,
      backupDir,
      removals: [],
      settingsText: null,
    };
  }

  // Remove the managed entries.
  const { text, removals } = removeEntries(currentDocument, record.managed, settingsPath);

  // If we end up with the exact same text, it's a no-op (nothing to remove).
  if (text === currentText) {
    return {
      agent: "claude",
      settingsPath,
      storeRoot,
      status: "nothing-installed",
      record,
      backupDir,
      removals: [],
      settingsText: null,
    };
  }

  return {
    agent: "claude",
    settingsPath,
    storeRoot,
    status: "removals",
    record,
    backupDir,
    removals,
    settingsText: text,
  };
}

/** The plan as text. Both `--dry-run` and a real run print this same value. */
export function renderUninstallPlan(plan: UninstallPlan, mode: "dry-run" | "applied"): string {
  const lines: string[] = [];
  const outcome = mode === "dry-run" ? "dry run (nothing is written)" : "applied";
  lines.push(`uninstall plan — agent ${plan.agent}`);
  lines.push(`status   ${plan.status}`);
  lines.push(`mode     ${outcome}`);
  lines.push(`settings ${plan.settingsPath}`);
  lines.push(`store    ${plan.storeRoot}`);

  if (plan.status === "nothing-installed") {
    lines.push("nothing to uninstall");
  } else if (plan.status === "restore") {
    if (plan.record?.original.file) {
      lines.push(`restore  from backup ${join(plan.backupDir ?? "", plan.record.original.file)}`);
    } else {
      lines.push("delete   settings file (was created by install)");
    }
  } else {
    lines.push(`edit     remove ${plan.removals.length} managed ${plan.removals.length === 1 ? "entry" : "entries"}`);
    for (const removal of plan.removals) {
      lines.push(`  ${removal.path}`);
    }
    if (plan.settingsText === "") {
      lines.push("result   empty document (all hooks removed)");
    }
  }

  return `${lines.join("\n")}\n`;
}
