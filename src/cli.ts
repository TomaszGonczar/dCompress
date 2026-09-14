#!/usr/bin/env node
/**
 * `dcompact` CLI — deterministic preview plus the OG-85 explicit-session continuity slice.
 *
 * `preview` reads one transcript, maps it, extracts facts, and prints the pack. The continuity
 * commands use an explicit session and task-owned store; there is no install or session
 * discovery.
 *
 * Identity rule (AGENTS §"Non-negotiable invariants" 8): a session is never guessed. This
 * command requires an explicit `--transcript <path>`; it does not scan `~/.claude/projects`,
 * does not pick the most recent session, and does not fall back to `--continue`.
 *
 * Streams: the pack goes to stdout and nothing else does; diagnostics, counters, and the
 * payload hash go to stderr. Exit codes are fixed and documented in `usage()`.
 */

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseClaudeTranscript, claudeExtractConfig, ClaudeTranscriptRefusal } from "./adapters/claude.js";
import type { ClaudeDiagnostic } from "./adapters/claude.js";
import { checkpoint, restore, runHook, ContinuityRefusal } from "./continuity.js";
import { extractPayloadWithHealth } from "./core/extract/index.js";
import { payloadHash } from "./core/hash.js";
import { DEFAULT_MAX_BYTES, formatDegradedStates, minimumPackBytes, renderPack } from "./core/pack.js";
import type { DegradedState, PackOptions, Payload } from "./core/types.js";
import { installClaude } from "./install/apply.js";
import { uninstallClaude } from "./install/uninstall-apply.js";
import { InstallRefusal } from "./install/refusal.js";

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_TRANSCRIPT_UNREADABLE = 3;
const EXIT_REFUSED = 4;
const EXIT_INTERNAL = 5;

/** Diagnostics echoed to stderr are capped; the total count is always printed in full. */
const MAX_REPORTED_DIAGNOSTICS = 20;
const DIAGNOSTIC_ORDER: Readonly<Record<string, number>> = {
  "malformed-json": 0,
  "invalid-utf8": 1,
  "unknown-record-type": 2,
  "unknown-content-block": 3,
  "conversational-content-not-text": 4,
  "tool-result-not-text": 5,
  "tool-input-shape": 6,
  "path-unrepresentable": 7,
  "task-result-shape": 8,
  "task-status-unknown": 9,
  "tool-result-without-call": 10,
  "tool-call-without-result": 11,
};

export interface PreviewOptions {
  readonly transcript: string;
  readonly pack: PackOptions;
}

export interface PreviewResult {
  readonly pack: string;
  readonly payload: Payload;
  readonly diagnostics: readonly ClaudeDiagnostic[];
  readonly degraded: readonly DegradedState[];
  readonly report: string;
}

/** A usage-level failure: bad flags, or a transcript that could not be read at all. */
export class UsageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UsageError";
    this.code = code;
  }
}

function usage(): string {
  return [
    "dcompact — deterministic session continuity for coding agents",
    "",
    "Usage:",
    "  dcompact preview --transcript <path> [options]",
    "  dcompact snapshot --session <id> --transcript <path> --store <dir>",
    "  dcompact restore --session <id> --store <dir> [options]",
    "  dcompact hook --event precompact|session-start --store <dir>",
    "  dcompact install --agent claude --store <dir> [--settings <path>] [--dry-run]",
    "  dcompact uninstall --agent claude --store <dir> [--settings <path>] [--dry-run]",
    "",
    "Commands:",
    "  preview   Map a transcript to normalized events, extract facts, print the pack.",
    "  snapshot  Checkpoint one explicitly named Claude session.",
    "  restore   Merge and render checkpoints for one explicitly named session.",
    "  hook      Fail-open Claude PreCompact/SessionStart bridge over stdin/stdout.",
    "  install   Write dcompact's Claude hook entries into a settings file, after copying",
    "            every file it edits to a byte backup under <store>/backups/.",
    "",
    "  uninstall Remove dcompact's Claude hook entries from a settings file, restoring",
    "            byte-identical pre-install files or removing files dcompact created.",
    "Options:",
    "  --transcript <path>   Claude Code JSONL transcript to read. Required.",
    "  --agent <name>        Agent to install for. Only \"claude\" is supported.",
    "  --settings <path>     Claude settings file to edit. Default: $CLAUDE_CONFIG_DIR/settings.json,",
    "                        else ~/.claude/settings.json.",
    "  --store <dir>         dcompact state root; backups are written under <dir>/backups/.",
    "  --command <exec>      Executable Claude runs for a hook. Default: dcompact.",
    "  --dry-run             Print the install plan and write nothing.",
    `  --max-bytes <n>       Pack byte budget. Default ${DEFAULT_MAX_BYTES}. A value below the`,
    "                        mandatory header plus elision notice is refused with the exact",
    "                        minimum for that transcript (reported in the refusal message).",
    "  --max-facts <n>       Maximum number of facts in the pack.",
    "  --include-evidence    Append evidence line numbers to each fact.",
    "  --help, -h            Print this usage.",
    "",
    "Exit codes:",
    `  ${EXIT_OK}  the command succeeded`,
    `  ${EXIT_USAGE}  usage error (unknown command, missing or bad argument)`,
    `  ${EXIT_TRANSCRIPT_UNREADABLE}  the transcript could not be read`,
    `  ${EXIT_REFUSED}  refused: the input or the target configuration cannot be used safely`,
    `  ${EXIT_INTERNAL}  unexpected internal error`,
    "",
    "Identity is explicit: this command never scans for sessions and never selects one.",
  ].join("\n");
}

interface ContinuityArgs {
  readonly session: string;
  readonly transcript?: string;
  readonly store: string;
  readonly pack: PackOptions;
}

function parseContinuityArgs(argv: readonly string[], command: "snapshot" | "restore"): ContinuityArgs | "help" {
  let session: string | null = null;
  let transcript: string | undefined;
  let store: string | null = null;
  const pack: { maxBytes?: number; maxFacts?: number; includeEvidence?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return "help";
    const value = argv[index + 1];
    if (flag === "--session" || flag === "--transcript" || flag === "--store" || flag === "--max-bytes" || flag === "--max-facts") {
      if (value === undefined) throw new UsageError("missing-value", `${flag} requires a value`);
      if (flag === "--session") session = value;
      else if (flag === "--transcript") transcript = value;
      else if (flag === "--store") store = value;
      else if (flag === "--max-bytes") pack.maxBytes = nonNegativeInteger(value, flag);
      else pack.maxFacts = nonNegativeInteger(value, flag);
      index += 1;
      continue;
    }
    if (flag === "--include-evidence") {
      pack.includeEvidence = true;
      continue;
    }
    throw new UsageError("unknown-argument", `Unknown argument: ${JSON.stringify(flag)}`);
  }
  if (session === null) throw new UsageError("missing-session", `${command} requires an explicit --session <id>; no session is ever chosen for you.`);
  if (store === null) throw new UsageError("missing-store", `${command} requires a task-owned --store <dir>; live agent state is never selected.`);
  if (store.trim() === "") throw new UsageError("empty-store", `${command} requires a non-empty --store <dir>; pass an explicit disposable path.`);
  if (command === "snapshot" && transcript === undefined) throw new UsageError("missing-transcript", "snapshot requires an explicit --transcript <path>");
  return { session, transcript, store, pack };
}

function parseHookArgs(argv: readonly string[]): { readonly event: "precompact" | "session-start"; readonly store: string } | "help" {
  let event: "precompact" | "session-start" | null = null;
  let store: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return "help";
    const value = argv[index + 1];
    if (flag === "--event" || flag === "--store") {
      if (value === undefined) throw new UsageError("missing-value", `${flag} requires a value`);
      if (flag === "--store") store = value;
      else if (value === "precompact" || value === "session-start") event = value;
      else throw new UsageError("invalid-event", "--event must be precompact or session-start");
      index += 1;
      continue;
    }
    throw new UsageError("unknown-argument", `Unknown argument: ${JSON.stringify(flag)}`);
  }
  if (event === null) throw new UsageError("missing-event", "hook requires --event precompact|session-start");
  if (store === null) throw new UsageError("missing-store", "hook requires a task-owned --store <dir>; live agent state is never selected.");
  return { event, store };
}

function nonNegativeInteger(raw: string, flag: string): number {
  if (!/^[0-9]{1,15}$/.test(raw)) {
    throw new UsageError("invalid-number", `${flag} requires a non-negative integer, received: ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

interface InstallArgs {
  readonly agent: "claude";
  readonly settingsPath: string;
  readonly storeRoot: string;
  readonly executable?: string;
  readonly dryRun: boolean;
}

/**
 * Claude's user settings file. `CLAUDE_CONFIG_DIR` relocates the whole Claude data directory
 * including settings (ADAPTER-SPEC §2), so it is honoured rather than assumed absent.
 */
function defaultClaudeSettingsPath(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const configDir = configured !== undefined && configured.trim() !== "" ? configured : join(homedir(), ".claude");
  return join(configDir, "settings.json");
}

function parseInstallArgs(argv: readonly string[]): InstallArgs | "help" {
  let agent: string | null = null;
  let settings: string | null = null;
  let store: string | null = null;
  let executable: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return "help";
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === "--agent" || flag === "--settings" || flag === "--store" || flag === "--command") {
      if (value === undefined) throw new UsageError("missing-value", `${flag} requires a value`);
      if (flag === "--agent") agent = value;
      else if (flag === "--settings") settings = value;
      else if (flag === "--store") store = value;
      else executable = value;
      index += 1;
      continue;
    }
    throw new UsageError("unknown-argument", `Unknown argument: ${JSON.stringify(flag)}`);
  }
  if (agent === null) throw new UsageError("missing-agent", 'install requires --agent <name>; only "claude" is supported.');
  if (agent !== "claude") {
    throw new UsageError("unsupported-agent", `install supports agent "claude" only; received ${JSON.stringify(agent)}.`);
  }
  if (store === null || store.trim() === "") {
    throw new UsageError("missing-store", "install requires a non-empty task-owned --store <dir>; live agent state is never selected.");
  }
  if (settings !== null && settings.trim() === "") {
    throw new UsageError("empty-settings", "install requires a non-empty --settings <path>; omit the flag for the default Claude user settings file.");
  }
  return { agent, settingsPath: settings ?? defaultClaudeSettingsPath(), storeRoot: store, executable, dryRun };
}

function parseUninstallArgs(argv: readonly string[]): InstallArgs | "help" {
  let agent: string | null = null;
  let settings: string | null = null;
  let store: string | null = null;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return "help";
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === "--agent" || flag === "--settings" || flag === "--store") {
      if (value === undefined) throw new UsageError("missing-value", `${flag} requires a value`);
      if (flag === "--agent") agent = value;
      else if (flag === "--settings") settings = value;
      else store = value;
      index += 1;
      continue;
    }
    throw new UsageError("unknown-argument", `Unknown argument: ${JSON.stringify(flag)}`);
  }
  if (agent === null) throw new UsageError("missing-agent", 'uninstall requires --agent <name>; only "claude" is supported.');
  if (agent !== "claude") {
    throw new UsageError("unsupported-agent", `uninstall supports agent "claude" only; received ${JSON.stringify(agent)}.`);
  }
  if (store === null || store.trim() === "") {
    throw new UsageError("missing-store", "uninstall requires a non-empty task-owned --store <dir>; live agent state is never selected.");
  }
  if (settings !== null && settings.trim() === "") {
    throw new UsageError("empty-settings", "uninstall requires a non-empty --settings <path>; omit the flag for the default Claude user settings file.");
  }
  return { agent, settingsPath: settings ?? defaultClaudeSettingsPath(), storeRoot: store, dryRun };
}

export function parsePreviewArgs(argv: readonly string[]): PreviewOptions | "help" {
  let transcript: string | null = null;
  const pack: { maxBytes?: number; maxFacts?: number; includeEvidence?: boolean } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return "help";
    if (flag === "--transcript") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("missing-value", "--transcript requires a path");
      transcript = value;
      index += 1;
      continue;
    }
    if (flag === "--max-bytes") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("missing-value", "--max-bytes requires a value");
      pack.maxBytes = nonNegativeInteger(value, "--max-bytes");
      index += 1;
      continue;
    }
    if (flag === "--max-facts") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("missing-value", "--max-facts requires a value");
      pack.maxFacts = nonNegativeInteger(value, "--max-facts");
      index += 1;
      continue;
    }
    if (flag === "--include-evidence") {
      pack.includeEvidence = true;
      continue;
    }
    throw new UsageError("unknown-argument", `Unknown argument: ${JSON.stringify(flag)}`);
  }

  if (transcript === null) {
    throw new UsageError(
      "missing-transcript",
      "preview requires an explicit --transcript <path>; no session is ever chosen for you.",
    );
  }
  return { transcript, pack };
}

/** Physical lines under the same LF rule the mapper uses, for reporting only. */
function physicalLineCount(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? lines + 1 : lines;
}

/**
 * `preview` is the whole mapping path minus process concerns: one explicit read, map, extract,
 * render. It performs no I/O besides reading the named transcript, so a test can call it
 * directly and a caller can assert the returned bytes.
 */
export function preview(options: PreviewOptions): PreviewResult {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(options.transcript);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError("transcript-unreadable", `Cannot read transcript ${JSON.stringify(options.transcript)}: ${reason}`);
  }

  const parse = parseClaudeTranscript(bytes);
  const config = claudeExtractConfig(parse);
  const { payload, degraded: extractionHealth } = extractPayloadWithHealth(parse.events, config);
  // Health is the union of parser drift and core's own degraded states, in a fixed order so the
  // header text is deterministic. It is display metadata only: it never enters the payload.
  const degraded: DegradedState[] = [...new Set<DegradedState>([
    ...(parse.diagnostics.length > 0 ? (["schema-drift"] as const) : []),
    ...extractionHealth,
  ])].sort();

  // A budget below the floor cannot hold the mandatory header and elision notice. That is a bad
  // value on the command line, not an internal failure: refuse with the exact minimum instead of
  // letting `renderPack`'s RangeError reach the generic internal-error branch and print a stack.
  const minimum = minimumPackBytes(payload, { degraded });
  if (options.pack.maxBytes !== undefined && options.pack.maxBytes < minimum) {
    throw new UsageError(
      "max-bytes-too-small",
      `--max-bytes must be at least ${minimum} for this transcript (the mandatory header plus the elision notice); received ${options.pack.maxBytes}. Pass --max-bytes ${minimum} or omit the flag for the default ${DEFAULT_MAX_BYTES}.`,
    );
  }

  const pack = renderPack(payload, {
    maxBytes: options.pack.maxBytes,
    maxFacts: options.pack.maxFacts,
    includeEvidence: options.pack.includeEvidence,
    degraded,
  });

  const lines: string[] = [];
  lines.push(`transcript: ${options.transcript}`);
  lines.push(`bytes: ${bytes.byteLength} | physical lines: ${physicalLineCount(bytes)}`);
  lines.push(
    `session: ${parse.session.sessionId ?? "<absent>"} | cwd: ${parse.session.cwd ?? "<absent>"} | cli: ${parse.session.version ?? "<absent>"}`,
  );
  lines.push(
    `records: conversation=${parse.recordCount} recognized=${parse.conversationRecords} | tool calls=${parse.toolCalls} results=${parse.toolResults}`,
  );
  lines.push(`tools: ${parse.toolNames.join(", ") || "<none>"}`);
  lines.push(
    `facts: ${payload.counters.facts} | tool calls: ${payload.counters.source_tool_calls} | unmapped: ${payload.counters.unmapped_tool_calls} | coverage: ${payload.counters.coverage_ppm} ppm | path_base: ${payload.path_base}`,
  );
  lines.push(`health: ${formatDegradedStates(degraded)}`);
  lines.push(`payload hash: ${payloadHash(payload)}`);
  if (parse.diagnostics.length === 0) {
    lines.push("diagnostics: 0");
  } else {
    const sorted = [...parse.diagnostics].sort(
      (left, right) =>
        (DIAGNOSTIC_ORDER[left.code] ?? Number.MAX_SAFE_INTEGER) - (DIAGNOSTIC_ORDER[right.code] ?? Number.MAX_SAFE_INTEGER) ||
        left.line - right.line ||
        left.code.localeCompare(right.code) ||
        left.detail.localeCompare(right.detail),
    );
    lines.push(`diagnostics: ${parse.diagnostics.length}`);
    for (const diagnostic of sorted.slice(0, MAX_REPORTED_DIAGNOSTICS)) {
      lines.push(`  line ${diagnostic.line}: ${diagnostic.code} (${diagnostic.detail})`);
    }
    if (sorted.length > MAX_REPORTED_DIAGNOSTICS) {
      lines.push(`  … ${sorted.length - MAX_REPORTED_DIAGNOSTICS} more`);
    }
  }

  return { pack, payload, diagnostics: parse.diagnostics, degraded, report: `${lines.join("\n")}\n` };
}

/** Output sinks, injected so a test can assert the exact streams without spawning a process. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly stdin?: () => string;
}

const processIo: CliIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

let hookPipeProtectionInstalled = false;

/** Installed only for hook commands: a closed Claude pipe is a fail-open hook outcome. */
function protectHookPipes(): void {
  if (hookPipeProtectionInstalled) return;
  // Hook output is best-effort: any stream failure, including platform-specific closed-pipe
  // errors, must not turn an otherwise fail-open hook into a non-zero process exit.
  const ignoreStreamError = (): void => undefined;
  process.stdout.on("error", ignoreStreamError);
  process.stderr.on("error", ignoreStreamError);
  hookPipeProtectionInstalled = true;
}

export function run(argv: readonly string[], io: CliIo = processIo): number {
  const command = argv[0];
  if (command === undefined) {
    io.stderr(`${usage()}\n`);
    return EXIT_USAGE;
  }
  if (command === "--help" || command === "-h") {
    io.stdout(`${usage()}\n`);
    return EXIT_OK;
  }
  // Keep the pre-continuity CLI's unknown-command behaviour for a bare `snapshot` invocation;
  // the real continuity command is only selected once its explicit identity/options are present.
  if (command === "snapshot" && argv.length === 1) {
    io.stderr(`Unknown command: ${JSON.stringify(command)}\n\n${usage()}\n`);
    return EXIT_USAGE;
  }
  if (command !== "preview" && command !== "snapshot" && command !== "restore" && command !== "hook" && command !== "install" && command !== "uninstall") {
    io.stderr(`Unknown command: ${JSON.stringify(command)}\n\n${usage()}\n`);
    return EXIT_USAGE;
  }

  try {
    if (command === "install") {
      const parsed = parseInstallArgs(argv.slice(1));
      if (parsed === "help") {
        io.stdout(`${usage()}\n`);
        return EXIT_OK;
      }
      io.stdout(installClaude(parsed).report);
      return EXIT_OK;
    }
    if (command === "uninstall") {
      const parsed = parseUninstallArgs(argv.slice(1));
      if (parsed === "help") {
        io.stdout(`${usage()}\n`);
        return EXIT_OK;
      }
      io.stdout(uninstallClaude(parsed).report);
      return EXIT_OK;
    }
    if (command === "snapshot" || command === "restore") {
      const parsed = parseContinuityArgs(argv.slice(1), command);
      if (parsed === "help") {
        io.stdout(`${usage()}\n`);
        return EXIT_OK;
      }
      if (command === "snapshot") {
        const result = checkpoint({ root: parsed.store, sessionId: parsed.session, transcriptPath: parsed.transcript as string });
        io.stdout(`${JSON.stringify({ path: result.path, created: result.created, hash: result.snapshot.envelope.hash })}\n`);
      } else {
        const result = restore({ root: parsed.store, sessionId: parsed.session, ...parsed.pack });
        io.stdout(result.pack);
      }
      return EXIT_OK;
    }
    if (command === "hook") {
      protectHookPipes();
      let parsed: ReturnType<typeof parseHookArgs>;
      try {
        parsed = parseHookArgs(argv.slice(1));
      } catch {
        // Hook configuration mistakes are fail-open too: never block Claude on exit 2.
        io.stdout("{}\n");
        return EXIT_OK;
      }
      if (parsed === "help") {
        io.stdout(`${usage()}\n`);
        return EXIT_OK;
      }
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(io.stdin?.() ?? readFileSync(0, "utf8")) as Record<string, unknown>;
      } catch {
        // A malformed hook payload must not become a non-zero Claude hook exit.
        io.stdout("{}\n");
        return EXIT_OK;
      }
      io.stdout(`${runHook(input, parsed.event, { root: parsed.store })}\n`);
      return EXIT_OK;
    }
    const parsed = parsePreviewArgs(argv.slice(1));
    if (parsed === "help") {
      io.stdout(`${usage()}\n`);
      return EXIT_OK;
    }
    const result = preview(parsed);
    io.stdout(result.pack);
    io.stderr(result.report);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n`);
      if (error.code === "transcript-unreadable") return EXIT_TRANSCRIPT_UNREADABLE;
      io.stderr(`\n${usage()}\n`);
      return EXIT_USAGE;
    }
    if (error instanceof ClaudeTranscriptRefusal) {
      io.stderr(`Refusing to preview: ${error.message}\n`);
      return EXIT_REFUSED;
    }
    if (error instanceof ContinuityRefusal) {
      io.stderr(`Refusing continuity operation: ${error.message}\n`);
      return EXIT_REFUSED;
    }
    if (error instanceof InstallRefusal) {
      io.stderr(`Refusing install: ${error.message}\n`);
      return EXIT_REFUSED;
    }
    const reason = error instanceof Error ? (error.stack ?? error.message) : String(error);
    io.stderr(`Internal error: ${reason}\n`);
    return EXIT_INTERNAL;
  }
}

/**
 * True only when this file is the process entry point.
 *
 * A package-manager bin is a symlink (and on macOS `/tmp` is itself a symlink to
 * `/private/tmp`), so comparing `import.meta.url` to `process.argv[1]` directly would refuse to
 * run the installed command. Both sides are resolved through `realpathSync` before comparing;
 * a failure to resolve leaves the path as given, which is the conservative answer.
 */
function isDirectExecution(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  const entry = pathToFileURL(invoked).href;
  if (entry === import.meta.url) return true;
  try {
    return pathToFileURL(realpathSync(invoked)).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
}

// Executable entry point only when run directly, so tests can import `preview` and `run`.
if (isDirectExecution()) {
  process.exitCode = run(process.argv.slice(2));
}
