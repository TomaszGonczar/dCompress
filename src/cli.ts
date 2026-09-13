#!/usr/bin/env node
/**
 * `dcompact` CLI — OG-61 P6a thin slice.
 *
 * The only command in this slice is `preview`: read one transcript, map it, extract, print the
 * pack. There is no store, no hook, no install, and no session discovery — those are P6b.
 *
 * Identity rule (AGENTS §"Non-negotiable invariants" 8): a session is never guessed. This
 * command requires an explicit `--transcript <path>`; it does not scan `~/.claude/projects`,
 * does not pick the most recent session, and does not fall back to `--continue`.
 *
 * Streams: the pack goes to stdout and nothing else does; diagnostics, counters, and the
 * payload hash go to stderr. Exit codes are fixed and documented in `usage()`.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseClaudeTranscript, claudeExtractConfig, ClaudeTranscriptRefusal } from "./adapters/claude.js";
import type { ClaudeDiagnostic } from "./adapters/claude.js";
import { extractPayloadWithHealth } from "./core/extract/index.js";
import { payloadHash } from "./core/hash.js";
import { formatDegradedStates, renderPack } from "./core/pack.js";
import type { DegradedState, PackOptions, Payload } from "./core/types.js";

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
    "",
    "Commands:",
    "  preview   Map a transcript to normalized events, extract facts, print the pack.",
    "",
    "Options:",
    "  --transcript <path>   Claude Code JSONL transcript to read. Required.",
    "  --max-bytes <n>       Pack byte budget. Default 16384.",
    "  --max-facts <n>       Maximum number of facts in the pack.",
    "  --include-evidence    Append evidence line numbers to each fact.",
    "  --help, -h            Print this usage.",
    "",
    "Exit codes:",
    `  ${EXIT_OK}  pack written to stdout`,
    `  ${EXIT_USAGE}  usage error (unknown command, missing --transcript, bad value)`,
    `  ${EXIT_TRANSCRIPT_UNREADABLE}  the transcript could not be read`,
    `  ${EXIT_REFUSED}  the transcript cannot supply a required extraction input`,
    `  ${EXIT_INTERNAL}  unexpected internal error`,
    "",
    "Identity is explicit: this command never scans for sessions and never selects one.",
    "Session selection (`--session <id>`) arrives with the P6b integration.",
  ].join("\n");
}

function nonNegativeInteger(raw: string, flag: string): number {
  if (!/^[0-9]{1,15}$/.test(raw)) {
    throw new UsageError("invalid-number", `${flag} requires a non-negative integer, received: ${JSON.stringify(raw)}`);
  }
  return Number(raw);
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
}

const processIo: CliIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

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
  if (command !== "preview") {
    io.stderr(`Unknown command: ${JSON.stringify(command)}\n\n${usage()}\n`);
    return EXIT_USAGE;
  }

  try {
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
