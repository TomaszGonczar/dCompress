/**
 * A real store writer in its own process, for the two things a test cannot prove in-process: that
 * a writer killed mid-write leaves no half-written snapshot, and that two processes writing one
 * session at once leave a store that is still coherent.
 *
 * `writeSnapshot` is therefore the shipped writer and nothing else. The arguments arrive as one
 * JSON object so a test can add a field without this file growing an argv grammar.
 */

import { existsSync, writeFileSync } from "node:fs";

import { systemClock } from "../../src/core/clock.js";
import { acquireLock } from "../../src/store/lock.js";
import { sessionPaths } from "../../src/store/paths.js";
import { writeSnapshot } from "../../src/store/snapshot.js";
import { makeSnapshot } from "./store.js";

interface ChildOptions {
  readonly root: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly text: string;
  /** Bytes appended to the snippet; a payload size cannot travel through argv. */
  readonly padBytes?: number;
  /** Hold the session lock across the write, the way the snapshot path does. */
  readonly lock?: boolean;
  /** Create this file to announce readiness, then wait for `await`. */
  readonly ready?: string;
  readonly await?: string;
}

/** How long the handshake may take before the child reports failure instead of waiting forever. */
const BARRIER_TIMEOUT_MS = 20_000;

/**
 * Start both writers from the same instant, so the race is between the writers rather than between
 * the two `spawn` calls. This is a handshake on a file that a peer really creates, not a pause.
 */
async function meetPeer(options: ChildOptions): Promise<void> {
  if (options.ready === undefined || options.await === undefined) return;
  writeFileSync(options.ready, "");
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!existsSync(options.await)) {
    if (Date.now() > deadline) throw new Error(`peer ${options.await} did not appear within ${BARRIER_TIMEOUT_MS} ms`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function main(): Promise<void> {
  const [mode, encoded] = process.argv.slice(2);
  if (mode === undefined || encoded === undefined) throw new Error("usage: store-child.js <mode> <json-options>");
  const options = JSON.parse(encoded) as ChildOptions;
  const text = options.padBytes === undefined ? options.text : `${options.text}${"x".repeat(options.padBytes)}`;
  const session = sessionPaths({ adapter: "claude", sessionId: options.sessionId, root: options.root });
  const snapshot = makeSnapshot({ createdAt: options.createdAt, text, sessionId: options.sessionId });
  await meetPeer(options);

  if (mode === "concurrent") {
    const lock = acquireLock({ session, clock: systemClock });
    const written = writeSnapshot({ session, snapshot });
    const released = lock.release();
    process.stdout.write(`${JSON.stringify({ held: lock.held, waited_ms: lock.waited_ms, respected: lock.respected, broken: lock.broken, released, path: written.path })}\n`);
    return;
  }

  if (mode === "crash") {
    // A real writer claims the session before it writes; `crash` can be told to do the same, and
    // then be killed holding it, which is what the lock's crash-safety case needs.
    if (options.lock === true) acquireLock({ session, clock: systemClock });
    writeSnapshot({ session, snapshot });
    // Reaching this line means the parent's kill landed after the rename, so the crash this mode
    // exists to produce did not happen; the parent fails on the missing evidence instead of here.
    process.stdout.write(`${JSON.stringify({ completed: true })}\n`);
    return;
  }

  throw new Error(`unknown mode ${mode}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});