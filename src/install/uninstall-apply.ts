/**
 * Applying an uninstall plan — the only code in the uninstaller that writes.
 *
 * `uninstall-plan.ts` decides; this module executes that decision and adds nothing to it.
 * The strategy is: if the file was present at install time, restore it byte-identically from
 * the backup. If it was created by install, delete it. Otherwise, write the edited version
 * with managed entries removed.
 */

import { rmSync } from "node:fs";

import { atomicWriteFile, readExistingFile } from "./fs.js";
import { planUninstall, renderUninstallPlan } from "./uninstall-plan.js";
import type { UninstallOptions, UninstallPlan } from "./uninstall-plan.js";
import { InstallRefusal } from "./refusal.js";

export interface UninstallRunOptions extends UninstallOptions {
  readonly dryRun?: boolean;
}

export interface UninstallOutcome {
  /** The plan the run executed, or would have executed under `--dry-run`. */
  readonly plan: UninstallPlan;
  /** The plan as text; the same value under `--dry-run` and on a real run. */
  readonly report: string;
  /** False under `--dry-run`, and false when nothing was installed. */
  readonly applied: boolean;
}

/**
 * One uninstall, from plan to report. `--dry-run` returns the plan without touching anything, and
 * because the plan is the only decision path, what it prints is what a real run executes.
 */
export function uninstallClaude(options: UninstallRunOptions): UninstallOutcome {
  const plan = planUninstall(options);
  if (options.dryRun === true) {
    return { plan, report: renderUninstallPlan(plan, "dry-run"), applied: false };
  }
  applyUninstall(plan);
  return { plan, report: renderUninstallPlan(plan, "applied"), applied: plan.status !== "nothing-installed" };
}

/** Execute the plan's writes, or report that there is nothing to execute. */
export function applyUninstall(plan: UninstallPlan): void {
  if (plan.status === "nothing-installed") return;

  if (plan.status === "restore") {
    // The file was present at install time, so we restore the backup.
    if (plan.record === null) {
      throw new InstallRefusal("plan-incomplete", "Refusing to uninstall: the plan is marked restore but has no record.");
    }
    if (plan.backupDir === null) {
      throw new InstallRefusal("plan-incomplete", "Refusing to uninstall: the plan is marked restore but has no backup directory.");
    }
    if (plan.record.original.file === null) {
      throw new InstallRefusal(
        "plan-incomplete",
        "Refusing to uninstall: the record says the file existed but has no backup location.",
      );
    }
    const backupPath = `${plan.backupDir}/${plan.record.original.file}`;
    const backupFile = readExistingFile(backupPath, "byte backup");
    if (backupFile === null) {
      throw new InstallRefusal(
        "backup-missing",
        `Refusing to uninstall: the byte backup at ${JSON.stringify(backupPath)} does not exist. The file is unchanged. Re-check the record.`,
      );
    }
    // Restore the exact bytes and the original mode from the install record.
    const originalMode = parseInt(plan.record.settings_mode, 8);
    atomicWriteFile(plan.settingsPath, backupFile.bytes, originalMode);
    return;
  }

  // plan.status === "removals": we write the edited version with managed entries removed.
  if (plan.settingsText === null) {
    throw new InstallRefusal("plan-incomplete", "Refusing to uninstall: the plan carries no settings text.");
  }

  if (plan.settingsText === "") {
    // The document is now empty after removing all entries. Delete the file.
    try {
      rmSync(plan.settingsPath, { force: true });
    } catch (error) {
      throw new InstallRefusal(
        "delete-failed",
        `Refusing to uninstall: could not delete empty settings file at ${JSON.stringify(plan.settingsPath)}. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    // Write the edited settings file, preserving the original mode from the record.
    const originalMode = plan.record ? parseInt(plan.record.settings_mode, 8) : 0o600;
    atomicWriteFile(plan.settingsPath, plan.settingsText, originalMode);
  }
}
