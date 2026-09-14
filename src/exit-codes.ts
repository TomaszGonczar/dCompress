/**
 * CONCEPT §6.2 — the CLI's exit-code contract.
 *
 * One vocabulary, shared by every command (`preview`, `snapshot`, `restore`, `hook`, `list`,
 * `show`, `verify`, `doctor`, `install`, `uninstall`). A command chooses among these five
 * codes; it never invents a sixth. Precedence, where more than one applies to the same
 * outcome, is worse-state-wins: integrity failure over degraded, operational failure over
 * degraded, usage error is checked before the command runs at all.
 */

/** The command did what it was asked. */
export const EXIT_OK = 0;

/**
 * The command could not complete: a refusal, an unavailable store, a transcript that cannot
 * supply a required extraction input, or any other unexpected internal error. Distinct from a
 * usage error — the invocation itself was well-formed.
 */
export const EXIT_OPERATIONAL_FAILURE = 1;

/** Bad flags, a missing required argument, or an unknown command. */
export const EXIT_USAGE = 2;

/**
 * Integrity failure: the transcript could not be read, a payload's hash does not match its
 * envelope (quarantined, corrupt, or tampered), or provenance is broken.
 */
export const EXIT_INTEGRITY_FAILURE = 3;

/** The command produced usable output, but under a degraded (CONCEPT §11.2) condition. */
export const EXIT_DEGRADED = 4;
