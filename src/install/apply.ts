/**
 * Applying an install plan — the only code in the installer that writes.
 *
 * `plan.ts` decides; this module executes that decision and adds nothing to it. Two orderings are
 * deliberate. The byte backup is written before the settings file, so the restore copy always
 * exists before the file it describes changes. The install record is written twice — `prepared`
 * before the settings write, `installed` after that write verifies — so a crash in between leaves
 * a record that says the install is incomplete instead of a settings file that looks installed
 * (CONCEPT §11.3 "install corruption"; ADR 005 leaves completion of an interrupted install to an
 * explicit repair).
 *
 * A post-write verification failure is a refusal, not a rollback. The report names the byte backup
 * to restore from and the record stays `prepared`, which is what makes the failure visible. A
 * silent second write of the user's file would be the "clever repair" ADR 005 rejects.
 */

import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";

import {
  eventGroups,
  hooksObject,
  isPlainObject,
  managedEntries,
} from "./claude.js";
import { atomicWriteFile, ensurePrivateDirectory, ensurePrivateDirectoryTree, PRIVATE_FILE_MODE, readExistingFile, sha256OfBytes } from "./fs.js";
import { planInstall, renderPlan } from "./plan.js";
import type { InstallOptions, InstallPlan, InstallRecord } from "./plan.js";
import { InstallRefusal } from "./refusal.js";

export interface InstallRunOptions extends InstallOptions {
  readonly dryRun?: boolean;
}

export interface InstallOutcome {
  /** The plan the run executed, or would have executed under `--dry-run`. */
  readonly plan: InstallPlan;
  /** The plan as text; the same value under `--dry-run` and on a real run. */
  readonly report: string;
  /** False under `--dry-run`, and false when the managed region already matched. */
  readonly applied: boolean;
}

/**
 * One install, from plan to report. `--dry-run` returns the plan without touching anything, and
 * because the plan is the only decision path, what it prints is what a real run executes.
 */
export function installClaude(options: InstallRunOptions): InstallOutcome {
  const plan = planInstall(options);
  if (options.dryRun === true) {
    return { plan, report: renderPlan(plan, "dry-run"), applied: false };
  }
  applyInstall(plan);
  return { plan, report: renderPlan(plan, "applied"), applied: plan.status !== "already-installed" };
}

/** Execute the plan's writes, or report that there is nothing to execute. */
export function applyInstall(plan: InstallPlan): void {
  if (plan.status === "already-installed") return;

  // The plan names the bytes it was built from. Re-reading here keeps the byte backup exact for
  // the file that is actually edited: a plan produced by `--dry-run`, or one held while the user
  // edited the file, must not be applied to bytes it never saw.
  const existing = readExistingFile(plan.settingsPath, "settings file");
  const currentSha256 = existing === null ? null : sha256OfBytes(existing.bytes);
  if (currentSha256 !== plan.originalSha256) {
    throw new InstallRefusal(
      "settings-changed-since-plan",
      `Refusing to install: ${JSON.stringify(plan.settingsPath)} changed after this plan was built (planned ${plan.originalSha256 ?? "an absent file"}, found ${currentSha256 ?? "an absent file"}). Nothing was written. Re-run install to plan against the file as it is now.`,
    );
  }
  if (plan.backupDir === null || plan.settingsText === null) {
    throw new InstallRefusal(
      "plan-incomplete",
      `Refusing to install: the plan for ${JSON.stringify(plan.settingsPath)} carries no backup directory or no rendered settings. Nothing was written. Re-run install.`,
    );
  }

  ensurePrivateDirectoryTree(plan.storeRoot);
  ensurePrivateDirectory(join(plan.storeRoot, "backups"));
  ensurePrivateDirectory(plan.backupDir);
  if (plan.backupFile !== null && existing !== null) {
    ensurePrivateDirectory(dirname(plan.backupFile));
    atomicWriteFile(plan.backupFile, existing.bytes, PRIVATE_FILE_MODE);
  }

  writeRecord(plan, "prepared", null);

  const settingsBytes = Buffer.from(plan.settingsText, "utf8");
  atomicWriteFile(plan.settingsPath, settingsBytes, plan.settingsMode);

  verifyWrittenSettings(plan);

  writeRecord(plan, "installed", { sha256: sha256OfBytes(settingsBytes), bytes: settingsBytes.byteLength });
}

function writeRecord(plan: InstallPlan, state: "prepared" | "installed", installed: InstallRecord["installed"]): void {
  if (plan.backupDir === null) throw new InstallRefusal("plan-incomplete", "Refusing to install: the plan carries no backup directory to record into.");
  const record: InstallRecord = { ...plan.record, state, installed };
  atomicWriteFile(join(plan.backupDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`, PRIVATE_FILE_MODE);
}

/**
 * Re-read and re-parse what was written, and assert the managed region is exactly the planned one.
 *
 * This is CONCEPT §7.6 step 5: a write dcompress cannot read back as its own managed region is a
 * failed install even when the write "succeeded".
 */
function verifyWrittenSettings(plan: InstallPlan): void {
  const settings = plan.settingsPath;
  const recovery =
    plan.backupFile === null
      ? `Nothing else was written; remove ${JSON.stringify(settings)} and re-run install.`
      : `The pre-install bytes are at ${JSON.stringify(plan.backupFile)}; restore that file and re-run install.`;
  const written = readExistingFile(settings, "settings file");
  if (written === null || written.text !== plan.settingsText) {
    throw new InstallRefusal(
      "verify-bytes",
      `Refusing to report success: ${JSON.stringify(settings)} does not read back as the bytes dcompress just wrote. ${recovery}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(written.text);
  } catch (error) {
    throw new InstallRefusal(
      "verify-parse",
      `Refusing to report success: ${JSON.stringify(settings)} is not valid JSON after the write (${error instanceof Error ? error.message : String(error)}). ${recovery}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new InstallRefusal("verify-parse", `Refusing to report success: ${JSON.stringify(settings)} does not parse back to a JSON object. ${recovery}`);
  }

  const expected = managedEntries(plan.executable, plan.storeRoot);
  const hooks = hooksObject(parsed, settings);
  for (const entry of plan.entries) {
    const wanted = expected[entry.event];
    const groups = eventGroups(hooks, entry.event, settings);
    if (wanted === undefined || !isDeepStrictEqual(groups[entry.entry_index], wanted)) {
      throw new InstallRefusal(
        "verify-managed-region",
        `Refusing to report success: hooks.${entry.event}[${entry.entry_index}] in ${JSON.stringify(settings)} is not the entry dcompress wrote. ${recovery}`,
      );
    }
  }
}