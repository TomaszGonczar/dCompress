/**
 * Claude's settings shape, and the exact rule that decides which hook entries are dcompress's.
 *
 * JSON has no comment syntax, so the managed region cannot be a text marker without corrupting
 * the file (ADR 005 explicitly rejects an untracked appended snippet). dcompress may not invent
 * one either: an unknown top-level settings key, or an extra field inside a hook group, is
 * unverified against Claude's schema, and a key Claude rejects would break the agent —
 * invariant 5 (reversible install) and invariant 6 (a hook never fails its host) both forbid
 * guessing there.
 *
 * The managed region is therefore **structural and content-defined**: for each event dcompress
 * owns, its managed entries are the elements of `hooks.<Event>[]` whose single command handler
 * carries the dcompress hook invocation grammar, `<executable> hook --event <event> --store
 * <path>`. The executable spelling is deliberately outside the fingerprint (`dcompress`,
 * `node …/cli.js`, `bun …/cli.ts` are all recognized), so an entry installed from a development
 * checkout is still recognized as dcompress's. The store path is inside it, because one settings
 * file carries hooks for exactly one store.
 *
 * The consequence is what makes this safe rather than clever: an entry that carries that grammar
 * but is not byte-for-byte the entry dcompress would install is a **refusal**, never a silent
 * append, because a hand-edited or foreign dcompress hook left in place would fire alongside
 * ours. Entries that do not carry the grammar are foreign by construction and are never touched —
 * a user hook with the same matcher runs beside dcompress's, which is Claude's own semantics.
 */

import { InstallRefusal } from "./refusal.js";

export const CLAUDE_AGENT = "claude";

export interface ManagedEvent {
  /** Claude's hook event key in `hooks`. */
  readonly event: string;
  /** Claude's matcher for that event; `|` is the separator this CLI version accepts. */
  readonly matcher: string;
  /** The value of `--event` the installed command passes to `dcompress hook`. */
  readonly hookEvent: "precompact" | "session-start";
}

/**
 * The events dcompress installs, and only the ones the hook bridge can act on.
 *
 * `PreCompact` is the pre-drop snapshot point (CONCEPT §7.1) and `SessionStart` with
 * `resume|compact|startup` is the only injection point Claude offers (CONCEPT §8), so both must
 * be present for the install to be worth anything. `PostCompact`, `SessionEnd`, and `Stop` are
 * *not* installed: the bridge has no handler for them, and a hook that cannot act is a silent
 * no-op in the user's config rather than a feature.
 */
export const MANAGED_EVENTS: readonly ManagedEvent[] = [
  { event: "PreCompact", matcher: "manual|auto", hookEvent: "precompact" },
  { event: "SessionStart", matcher: "resume|compact|startup", hookEvent: "session-start" },
];

/**
 * A command string is executed by Claude as a shell command, so a value that a shell would
 * reinterpret is refused instead of quoted: dcompress refuses to be the tool that wrote an
 * injection into a config file (CONCEPT §9, "never interpolates file content into a shell").
 */
const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9._+/-]+$/;

export function assertSafeCommandToken(kind: string, value: string, flag: string): void {
  if (value === "" || !SAFE_COMMAND_TOKEN.test(value)) {
    throw new InstallRefusal(
      "unsafe-command-token",
      `Refusing ${kind} ${JSON.stringify(value)}: it is written into the hook command Claude executes, so it must match ${SAFE_COMMAND_TOKEN.source}. Re-run with ${flag} naming a path without spaces, quotes, or shell metacharacters.`,
    );
  }
}

/**
 * The command dcompress installs for one event. Built from a validated executable and store path
 * only: no timestamp, no version, no cwd. Codex records trust against the handler's current hash
 * (CONCEPT §7.2), and any per-install variation would silently disable the hook there; the same
 * discipline applies here so an upgrade does not require a re-install.
 */
export function hookCommand(executable: string, managed: ManagedEvent, storeRoot: string): string {
  return `${executable} hook --event ${managed.hookEvent} --store ${storeRoot}`;
}

/** One Claude hook group: a matcher and its single command handler. */
export interface HookEntry {
  readonly matcher: string;
  readonly hooks: readonly { readonly type: "command"; readonly command: string }[];
}

export function hookEntry(managed: ManagedEvent, command: string): HookEntry {
  return { matcher: managed.matcher, hooks: [{ type: "command", command }] };
}

const MANAGED_BY_EVENT: Record<string, ManagedEvent> = Object.fromEntries(
  MANAGED_EVENTS.map((managed) => [managed.event, managed]),
);

export function managedEventFor(event: string): ManagedEvent | undefined {
  return MANAGED_BY_EVENT[event];
}

/**
 * The complete managed region dcompress installs for one store, keyed by Claude event.
 *
 * Both the planner and the post-write verification compare against this single value, so
 * "what dcompress installs" has exactly one definition.
 */
export function managedEntries(executable: string, storeRoot: string): Record<string, HookEntry> {
  return Object.fromEntries(
    MANAGED_EVENTS.map((managed) => [managed.event, hookEntry(managed, hookCommand(executable, managed, storeRoot))]),
  );
}

/** The dcompress hook grammar, matched against a handler command. */
const HOOK_GRAMMAR = /(?:^|\s)hook\s+--event\s+(\S+)\s+--store\s+("[^"]*"|\S+)(?=\s|$)/;

export interface HookGrammarMatch {
  readonly hookEvent: string;
  readonly store: string;
}

/** First narrowing step for every value read out of a parsed settings file. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function matchHookGrammar(command: string): HookGrammarMatch | null {
  const match = HOOK_GRAMMAR.exec(command);
  if (match === null) return null;
  const hookEvent = match[1];
  const store = match[2];
  if (hookEvent === undefined || store === undefined) return null;
  return { hookEvent, store: store.replace(/^"|"$/g, "") };
}

/**
 * The command of a group's single command handler, or `null` when the group is not that shape.
 *
 * Only this exact shape is eligible to be dcompress's: a group with several handlers, or a
 * non-command handler, is not something dcompress writes, so it stays foreign and untouched.
 */
export function singleCommand(group: unknown): string | null {
  if (!isPlainObject(group) || !("hooks" in group)) return null;
  const handlers = group.hooks;
  if (!Array.isArray(handlers) || handlers.length !== 1) return null;
  const handler: unknown = handlers[0];
  if (!isPlainObject(handler) || !("type" in handler) || !("command" in handler)) return null;
  if (handler.type !== "command" || typeof handler.command !== "string") return null;
  return handler.command;
}

/**
 * Read `hooks` as a plain object, refusing a shape dcompress cannot scope an edit to.
 *
 * A document with no `hooks` key gets one, attached to the document: the planner mutates the
 * object this returns, and a detached copy would render a settings file with no entries at all
 * (which the post-write verification would then refuse, one step too late to be useful).
 */
export function hooksObject(document: Record<string, unknown>, settingsPath: string): Record<string, unknown> {
  const hooks = document.hooks;
  if (hooks === undefined) {
    const created: Record<string, unknown> = {};
    document.hooks = created;
    return created;
  }
  if (!isPlainObject(hooks)) {
    throw new InstallRefusal(
      "hooks-not-object",
      `Refusing to edit ${JSON.stringify(settingsPath)}: its "hooks" value is not a JSON object, so dcompress cannot locate a managed region without rewriting the user's structure. Repair the file in place (keep the file; do not reinstall over it) or move it aside and re-run.`,
    );
  }
  return hooks;
}

/** Read `hooks.<event>` as an array of groups, refusing anything else. */
export function eventGroups(hooks: Record<string, unknown>, event: string, settingsPath: string): unknown[] {
  const groups = hooks[event];
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) {
    throw new InstallRefusal(
      "event-hooks-not-array",
      `Refusing to edit ${JSON.stringify(settingsPath)}: "hooks.${event}" is not a JSON array, which is the shape Claude requires. Repair that entry in place, then re-run install.`,
    );
  }
  return groups;
}