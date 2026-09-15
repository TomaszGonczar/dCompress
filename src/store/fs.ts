/**
 * Filesystem primitives for the store: private directories, symlink refusal, and atomic writes.
 *
 * These are the only places in `src/store/` that touch the filesystem directly, so the
 * durability and permissions rules are stated once instead of per caller.
 */

import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname } from "node:path";

import { StoreRefusal } from "./types.js";

export function errnoCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : null;
}

/** Translate filesystem failures on explicitly named state into user-actionable refusals. */
export function stateRefusal(error: unknown, path: string, label: string, kind: "directory" | "file" = "directory"): StoreRefusal | null {
  switch (errnoCode(error)) {
    case "ENOTDIR":
      return new StoreRefusal("state-not-directory", `Refusing ${label} ${JSON.stringify(path)}: a path component is not a directory; move it aside and retry.`);
    case "EISDIR":
      return new StoreRefusal("state-not-directory", kind === "file"
        ? `Refusing ${label} ${JSON.stringify(path)}: a directory sits where a state file is required; move it aside and retry.`
        : `Refusing ${label} ${JSON.stringify(path)}: it is not a directory; move it aside and retry.`);
    case "EACCES":
    case "EPERM":
      return new StoreRefusal("state-unreadable", `Cannot access ${label} ${JSON.stringify(path)}: permission denied; repair its permissions and retry.`);
    default:
      return null;
  }
}

function wrap(error: unknown, path: string, label: string, kind: "directory" | "file" = "directory"): never {
  throw stateRefusal(error, path, label, kind) ?? error;
}

/** `lstat`, with `ENOENT` as `null`. Never follows a link, so callers can see one. */
export function lstatOrNull(path: string, label: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    wrap(error, path, label);
  }
}

/** `readFileSync` with `ENOENT` as `null`; every other failure is the caller's to act on. */
export function readFileOrNull(path: string, label: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    wrap(error, path, label, "file");
  }
}

/**
 * A link is refused rather than followed: it can be repointed after any check, and following
 * one would move writes outside the private state boundary the caller consented to.
 */
export function refuseSymlinkedPath(path: string, label: string): void {
  const stat = lstatOrNull(path, label);
  if (stat === null) return;
  if (stat.isSymbolicLink()) {
    throw new StoreRefusal("symlink-state", `Refusing symlinked ${label} ${JSON.stringify(path)}: replace the link with a real path and retry.`);
  }
}

/** Create a state directory if needed, then assert and enforce its private mode. */
export function ensurePrivateDirectory(path: string, label: string): void {
  let stat = lstatOrNull(path, label);
  if (stat === null) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch (error) {
      wrap(error, path, label);
    }
    stat = lstatOrNull(path, label);
    if (stat === null) throw new StoreRefusal("state-unavailable", `Cannot create ${label} ${JSON.stringify(path)}; create it manually and retry.`);
  }
  if (stat.isSymbolicLink()) {
    throw new StoreRefusal("symlink-state", `Refusing symlinked ${label} ${JSON.stringify(path)}: replace the link with a real path and retry.`);
  }
  if (!stat.isDirectory()) {
    throw new StoreRefusal("state-not-directory", `Refusing ${label} ${JSON.stringify(path)}: it exists and is not a directory; move it aside and retry.`);
  }
  try {
    chmodSync(path, 0o700);
  } catch (error) {
    wrap(error, path, label);
  }
}

/** Node error codes that mean "this platform cannot fsync a directory". */
const DIRECTORY_FSYNC_UNSUPPORTED: Record<string, true> = { EPERM: true, EISDIR: true, EINVAL: true, ENOTSUP: true, ENOSYS: true };

/**
 * Persist the directory entry the rename just created. Windows cannot open a directory for
 * fsync at all; there the guarantee degrades to the rename being atomic, which NTFS already
 * provides, so an unsupported-directory-fsync error is not a store failure.
 */
function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    const code = errnoCode(error);
    if (code === null || DIRECTORY_FSYNC_UNSUPPORTED[code] !== true) wrap(error, path, "state directory");
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The fsync outcome is the reportable one; a failing close cannot add information.
      }
    }
  }
}

/**
 * Write `contents` so that the final name only ever refers to complete bytes: exclusive create
 * of a sibling temp file, fsync its bytes, rename into place, then fsync the directory.
 */
export function writeFileAtomic(path: string, contents: string): void {
  refuseSymlinkedPath(path, "state file");
  const temp = `${path}.tmp-${process.pid}`;
  try {
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The umask can only narrow the requested mode, never widen it; chmod makes 0600 exact.
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // A leftover temp file is inert: listings ignore anything that is not a `.json` snapshot.
    }
    wrap(error, path, "state file", "file");
  }
  fsyncDirectory(dirname(path));
}

/**
 * Create `path` with `contents`, or report that the name is taken — never both, and never
 * partially.
 *
 * The bytes land in a sibling temp file first and are published with `link()`, which fails with
 * `EEXIST` rather than overwriting. Exclusive creation and complete content therefore happen in
 * one step: a second writer cannot observe a lock file that is empty because its owner is still
 * writing it.
 */
export function createExclusiveFile(path: string, contents: string): boolean {
  const temp = `${path}.tmp-${process.pid}`;
  let created = false;
  try {
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, 0o600);
    try {
      linkSync(temp, path);
      created = true;
    } catch (error) {
      // A held name is an ordinary outcome here, not a failure: the caller decides what the
      // existing file means before it tries again.
      if (errnoCode(error) !== "EEXIST") throw error;
    }
  } catch (error) {
    wrap(error, path, "state file", "file");
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The temp name is inert: nothing reads state except by its final name.
    }
  }
  if (created) fsyncDirectory(dirname(path));
  return created;
}

/** Remove a state file; one that another writer already removed is not this caller's failure. */
export function removeStateFile(path: string, label: string): void {
  try {
    rmSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    wrap(error, path, label, "file");
  }
}

/**
 * `<path><suffix>`, then `<path><suffix>.1` … up to `limit`; `null` when every name is taken.
 *
 * Evidence kept beside the file it came from stays findable, and the bound keeps a repeating
 * failure from filling the directory with numbered copies of itself.
 */
export function freeSiblingPath(path: string, suffix: string, limit: number, label: string): string | null {
  if (lstatOrNull(`${path}${suffix}`, label) === null) return `${path}${suffix}`;
  for (let index = 1; index <= limit; index += 1) {
    const candidate = `${path}${suffix}.${index}`;
    if (lstatOrNull(candidate, label) === null) return candidate;
  }
  return null;
}

/**
 * Move a state file aside under a free numbered sibling name, keeping its bytes for inspection,
 * and report where they went.
 *
 * `null` means the bytes are gone: either another writer moved or removed the file first, or no
 * name was free beside it. The caller asked for the path to be clear, and clearing it is the
 * part that must not fail — a store that cannot make progress is worse than one that lost
 * evidence it had nowhere to file.
 */
export function preserveStateFile(path: string, suffix: string, limit: number, label: string): string | null {
  const target = freeSiblingPath(path, suffix, limit, label);
  if (target === null) {
    removeStateFile(path, label);
    return null;
  }
  try {
    renameSync(path, target);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    wrap(error, path, label, "file");
  }
  fsyncDirectory(dirname(path));
  return target;
}