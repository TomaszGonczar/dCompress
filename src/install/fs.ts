/**
 * Filesystem primitives for the installer.
 *
 * CONCEPT §7.6 step 4 needs an atomic write (temp file + fsync + rename + directory fsync), a
 * preserved file mode, and a symlink refusal. `src/store/fs.ts` is the eventual home for these
 * primitives (v0.1 P3); it does not exist on this branch, so the contract is implemented here.
 * Every write in `src/install/**` routes through `atomicWriteFile` so that the later move is a
 * deletion rather than a rewrite of the installer.
 *
 * Nothing here follows a symlink. A symlinked config file is refused rather than resolved,
 * because the mode and the byte copy would then describe the link, not the file the user reads
 * (invariant 5: reversible install).
 */

import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join } from "node:path";

import { InstallRefusal } from "./refusal.js";

const STATE_DIRECTORY_MODE = 0o700;
const STATE_FILE_MODE = 0o600;

/** Distinguishes concurrent writers' staging files within one process without a clock. */
let stagingCounter = 0;

export const PRIVATE_FILE_MODE: number = STATE_FILE_MODE;

/** `0644`-style text for reports and records; JSON numbers hide the base and invite mistakes. */
export function octalMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

export function sha256OfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Turn a filesystem failure on an explicitly named path into an actionable refusal. */
export function pathRefusal(error: unknown, path: string, label: string): InstallRefusal | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOTDIR" || code === "EISDIR") {
    return new InstallRefusal("path-not-directory", `${label} is not a directory: ${JSON.stringify(path)}`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new InstallRefusal(
      "path-unreadable",
      `Cannot access ${label} ${JSON.stringify(path)}: permission denied; repair its permissions and re-run.`,
    );
  }
  if (code === "EROFS") {
    return new InstallRefusal("path-read-only", `Cannot write ${label} ${JSON.stringify(path)}: the filesystem is read-only.`);
  }
  return null;
}

export interface ExistingFile {
  readonly bytes: Buffer;
  readonly text: string;
  readonly mode: number;
}

/**
 * Read a target file without following symlinks, or report that it does not exist.
 *
 * A missing file is `null` rather than a refusal: CONCEPT §7.6 records absent targets as
 * tombstones and lets the adapter decide whether creating one is safe.
 */
export function readExistingFile(path: string, label: string): ExistingFile | null {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const refusal = pathRefusal(error, path, label);
    if (refusal) throw refusal;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new InstallRefusal(
      "symlink-target",
      `Refusing to edit symlinked ${label} ${JSON.stringify(path)}; dcompress never follows a symlink target. Replace it with a regular file or point --settings at the real file, then re-run.`,
    );
  }
  if (!stat.isFile()) {
    throw new InstallRefusal("not-a-regular-file", `Refusing to edit ${label} ${JSON.stringify(path)}: it is not a regular file.`);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const refusal = pathRefusal(error, path, label);
    if (refusal) throw refusal;
    throw error;
  }
  if (!isUtf8(bytes)) {
    throw new InstallRefusal("not-utf8", `Refusing to edit ${label} ${JSON.stringify(path)}: it is not valid UTF-8, so JSON parsing would be a guess.`);
  }
  return { bytes, text: bytes.toString("utf8"), mode: stat.mode & 0o777 };
}

/** Create exactly one level of private state directory; the parent must already exist. */
export function ensurePrivateDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new InstallRefusal("symlink-state", `Refusing symlinked state directory ${JSON.stringify(path)}`);
    }
    if (!stat.isDirectory()) {
      throw new InstallRefusal("state-not-directory", `State path is not a directory: ${JSON.stringify(path)}`);
    }
  } catch (error) {
    if (error instanceof InstallRefusal) throw error;
    const refusal = pathRefusal(error, path, "state directory");
    if (refusal) throw refusal;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      mkdirSync(path, { mode: STATE_DIRECTORY_MODE });
    } catch (createError) {
      const createRefusal = pathRefusal(createError, path, "state directory");
      if (createRefusal) throw createRefusal;
      throw createError;
    }
  }
  chmodSync(path, STATE_DIRECTORY_MODE);
}

/** Create every missing level of a state root as `0700`, then re-assert the mode. */
export function ensurePrivateDirectoryTree(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new InstallRefusal("symlink-state", `Refusing symlinked state directory ${JSON.stringify(path)}`);
    }
    if (!stat.isDirectory()) {
      throw new InstallRefusal("state-not-directory", `State path is not a directory: ${JSON.stringify(path)}`);
    }
  } catch (error) {
    if (error instanceof InstallRefusal) throw error;
    const refusal = pathRefusal(error, path, "state directory");
    if (refusal) throw refusal;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      mkdirSync(path, { recursive: true, mode: STATE_DIRECTORY_MODE });
    } catch (createError) {
      const createRefusal = pathRefusal(createError, path, "state directory");
      if (createRefusal) throw createRefusal;
      throw createError;
    }
  }
  chmodSync(path, STATE_DIRECTORY_MODE);
}

function fsyncDirectory(directory: string): void {
  let fd: number;
  try {
    fd = openSync(directory, "r");
  } catch (error) {
    // Windows cannot open a directory handle for fsync (EISDIR/EPERM); its rename is atomic
    // within a volume anyway, so this is a portability difference, not a durability regression.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EISDIR" || code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return;
    throw error;
  }
  try {
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw error;
  } finally {
    closeSync(fd);
  }
}

/**
 * Write `bytes` to `path` atomically, with `mode`, or leave the previous file in place.
 *
 * The staging file is created in the target's own directory because `rename` cannot cross a
 * filesystem boundary. `rename` preserves the staging file's mode, but that mode was masked by
 * the process umask at creation, so the mode is re-asserted after the rename rather than
 * assumed (a `0600` settings file must not become `0644` because of the caller's umask).
 */
export function atomicWriteFile(path: string, bytes: string | Uint8Array, mode: number): void {
  const directory = dirname(path);
  stagingCounter += 1;
  const staging = join(directory, `.${basename(path)}.dcompress-${process.pid}-${stagingCounter}`);
  const payload = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  let fd: number;
  try {
    fd = openSync(staging, "wx", mode);
  } catch (error) {
    const refusal = pathRefusal(error, staging, "staging file");
    if (refusal) throw refusal;
    throw error;
  }
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(staging, { force: true });
    const refusal = pathRefusal(error, staging, "staging file");
    if (refusal) throw refusal;
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(staging, path);
  } catch (error) {
    rmSync(staging, { force: true });
    const refusal = pathRefusal(error, path, "target file");
    if (refusal) throw refusal;
    throw error;
  }
  chmodSync(path, mode);
  fsyncDirectory(directory);
}