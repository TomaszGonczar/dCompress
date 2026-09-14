/**
 * Store root resolution and the session layout (CONCEPT §6.3, ADR 008).
 *
 * `DCOMPACT_HOME` → `XDG_DATA_HOME/dcompact` → `$HOME/.local/share/dcompact`, on every
 * platform: one layout to document, back up, and delete. The environment is read only here,
 * at the I/O boundary, and never reaches a hashed payload.
 *
 * This module deliberately has no fallback for a missing or unusable root. A guessed location
 * hides a placement mistake, and an ambient value that silently changes where state lands is
 * worse than a refusal that names the variable to set.
 */

import { isAbsolute, join, resolve } from "node:path";

import { ensurePrivateDirectory } from "./fs.js";
import { StoreRefusal, describeValue } from "./types.js";
import type { SessionLocator, SessionPaths, StoreEnvironment } from "./types.js";

/** The XDG data subdirectory; `DCOMPACT_HOME` is the root itself and skips this level. */
const DEFAULT_DATA_DIRECTORY = "dcompact";

const SESSION_ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * `-` is the adapter/session separator in the session directory name, so an adapter id may not
 * contain one; that keeps `sessions/claude-a-b` unambiguous to parse back.
 */
const ADAPTER_ID_TOKEN = /^[a-z][a-z0-9_]{0,31}$/;

function absoluteRoot(value: string, label: string): string {
  if (value.trim() === "") {
    throw new StoreRefusal("empty-store-root", `${label} is set but empty; pass an absolute path or unset it.`);
  }
  if (value !== value.trim()) {
    throw new StoreRefusal("invalid-store-root", `${label} has surrounding whitespace (${describeValue(value)}); pass the plain path.`);
  }
  if (!isAbsolute(value)) {
    throw new StoreRefusal("relative-store-root", `${label} must be an absolute path, received ${describeValue(value)}; a relative root would move with the working directory.`);
  }
  return resolve(value);
}

/** Resolve the store root from the environment, refusing rather than guessing. */
export function storeRoot(env: StoreEnvironment = process.env): string {
  if (env.DCOMPACT_HOME !== undefined) return absoluteRoot(env.DCOMPACT_HOME, "DCOMPACT_HOME");
  if (env.XDG_DATA_HOME !== undefined) return join(absoluteRoot(env.XDG_DATA_HOME, "XDG_DATA_HOME"), DEFAULT_DATA_DIRECTORY);
  if (env.HOME !== undefined) return join(absoluteRoot(env.HOME, "HOME"), ".local", "share", DEFAULT_DATA_DIRECTORY);
  throw new StoreRefusal("home-unset", "Cannot locate the dcompact store: DCOMPACT_HOME, XDG_DATA_HOME, and HOME are all unset. Set DCOMPACT_HOME to an absolute path, or set HOME.");
}

export function validateSessionId(value: string): string {
  if (!SESSION_ID_TOKEN.test(value)) {
    throw new StoreRefusal("invalid-session-id", `Session id ${describeValue(value)} is not a bounded token (1-128 characters, first character a letter or digit, then letters, digits, dot, underscore, or hyphen). Fix the caller's session id; dcompact will not sanitize it into a different session.`);
  }
  return value;
}

export function validateAdapterId(value: string): string {
  if (!ADAPTER_ID_TOKEN.test(value)) {
    throw new StoreRefusal("invalid-adapter-id", `Adapter id ${describeValue(value)} is not a bounded token (1-32 characters, lowercase letter first, then lowercase letters, digits, or underscore). A hyphen is reserved as the adapter/session separator in the session directory name.`);
  }
  return value;
}

/** Derive every path for one explicitly named session; creates nothing. */
export function sessionPaths(locator: SessionLocator): SessionPaths {
  const adapter = validateAdapterId(locator.adapter);
  const sessionId = validateSessionId(locator.sessionId);
  const root = locator.root === undefined ? storeRoot(locator.env) : absoluteRoot(locator.root, "the store root (--store)");
  const name = `${adapter}-${sessionId}`;
  const sessions = join(root, "sessions");
  const session = join(sessions, name);
  return {
    root,
    adapter,
    sessionId,
    name,
    sessions,
    session,
    snapshots: join(session, "snapshots"),
    manifest: join(session, "manifest.json"),
    lock: join(session, "lock"),
  };
}

/**
 * Create the store hierarchy, private (`0700`) and symlink-free at every level dcompact owns.
 *
 * Ancestors above the root are the user's own XDG directories, so only the components the store
 * defines — root, `sessions/`, the session directory, `snapshots/` — are checked and chmodded.
 */
export function ensureSessionDirectories(paths: SessionPaths): void {
  ensurePrivateDirectory(paths.root, "store root");
  ensurePrivateDirectory(paths.sessions, "sessions directory");
  ensurePrivateDirectory(paths.session, `session directory ${JSON.stringify(paths.name)}`);
  ensurePrivateDirectory(paths.snapshots, "snapshot directory");
}