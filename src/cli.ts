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
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readClaudeTranscript } from "./adapters/mappers.js";
import { ClaudeTranscriptRefusal } from "./adapters/claude.js";
import type { ClaudeDiagnostic } from "./adapters/claude.js";
import { AdapterDefinitionRefusal } from "./adapters/registry.js";
import type { CoverageReport } from "./adapters/coverage.js";
import { checkpoint, restore, runHook, ContinuityRefusal } from "./continuity.js";
import { payloadHash } from "./core/hash.js";
import { DEFAULT_MAX_BYTES, formatDegradedStates, minimumPackBytes, renderPack } from "./core/pack.js";
import type { AdapterId, DegradedState, PackOptions, Payload, Snapshot } from "./core/types.js";
import { doctor, doctorExitCode, formatDoctorReport } from "./doctor.js";
import type { DoctorReport } from "./doctor.js";
import { EXIT_DEGRADED, EXIT_INTEGRITY_FAILURE, EXIT_OK, EXIT_OPERATIONAL_FAILURE, EXIT_USAGE } from "./exit-codes.js";
import { readManifest, snapshotId } from "./store/manifest.js";
import { sessionPaths } from "./store/paths.js";
import { listSnapshots, shortHash } from "./store/snapshot.js";
import { StoreRefusal } from "./store/types.js";
import type { ManifestSnapshotEntry, SessionPaths, SnapshotReadQuarantined } from "./store/types.js";
import { checkPayloadHash, checkProvenance } from "./store/verify.js";

/** The only adapter the store commands read today; `--adapter` for `doctor` is separate. */
const STORE_ADAPTER: AdapterId = "claude";


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
  /**
   * Tool-call coverage with the per-tool-name histogram of missed calls.
   *
   * Not rendered into the pack or the report: health and counters describe the run, and the
   * report's bytes are published evidence (see `docs/demo/`). It is here for the callers that
   * need it as a value — `doctor --json` is the intended one.
   */
  readonly coverage: CoverageReport;
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
    "  dcompact list --session <id> [--store <dir>] [--json]",
    "  dcompact show --session <id> --snapshot <id> [--store <dir>] [--json]",
    "  dcompact verify --session <id> [--snapshot <id>] [--store <dir>] [--provenance] [--json]",
    "  dcompact doctor --session <id> --store <dir> [--adapter <name>] [--json]",
    "",
    "Commands:",
    "  preview   Map a transcript to normalized events, extract facts, print the pack.",
    "  snapshot  Checkpoint one explicitly named Claude session.",
    "  restore   Merge and render checkpoints for one explicitly named session.",
    "  hook      Fail-open Claude PreCompact/SessionStart bridge over stdin/stdout.",
    "  list      List one session's stored snapshots, oldest first, plus quarantine state.",
    "  show      Print one stored snapshot's envelope, payload summary, and rendered pack.",
    "  verify    Recompute a snapshot's payload hash; --provenance re-checks it against the",
    "            transcript named in its envelope.",
    "  doctor    Report store, manifest, lock, quarantine, and adapter health for one session.",
    "",
    "Options:",
    "  --transcript <path>   Claude Code JSONL transcript to read. Required for preview/snapshot.",
    `  --max-bytes <n>       Pack byte budget. Default ${DEFAULT_MAX_BYTES}. A value below the`,
    "                        mandatory header plus elision notice is refused with the exact",
    "                        minimum for that transcript (reported in the refusal message).",
    "  --max-facts <n>       Maximum number of facts in the pack.",
    "  --include-evidence    Append evidence line numbers to each fact.",
    "  --session <id>        Explicit session id. Required by every command below preview;",
    "                        never guessed, never the most recent (AGENTS invariant 8).",
    "  --store <dir>         Store root. list/show/verify default to the resolved XDG/",
    "                        DCOMPACT_HOME store when omitted; snapshot/restore/hook/doctor",
    "                        require it explicitly.",
    "  --snapshot <id>       A snapshot's short hash or full id, as printed by `list --json`.",
    "                        Required for show; verify checks every snapshot when omitted.",
    "  --provenance          verify only: re-read the transcript and check each fact's evidence.",
    "  --adapter <name>      Adapter id for doctor's session store. Default claude.",
    "  --json                list/show/verify/doctor: print the documented JSON shape instead of text.",
    "  --help, -h            Print this usage.",
    "",
    "Exit codes (CONCEPT §6.2):",
    `  ${EXIT_OK}  success`,
    `  ${EXIT_USAGE}  usage error (unknown command, missing required argument, bad value)`,
    `  ${EXIT_OPERATIONAL_FAILURE}  operational failure: a refusal (a required extraction input`,
    "     is missing, the session/store/snapshot id is invalid, the named snapshot does not",
    "     exist, or the store itself is unavailable), or an unexpected internal error",
    `  ${EXIT_INTEGRITY_FAILURE}  integrity failure: the transcript could not be read, a`,
    "     payload's hash does not match its envelope (quarantined, corrupt, or tampered), or",
    "     provenance is broken",
    `  ${EXIT_DEGRADED}  the command produced usable output under a degraded (CONCEPT §11.2)`,
    "     condition, such as a broken stale lock",
    "",
    "Identity is explicit: no command scans for sessions, snapshots, or stores, and none",
    "ever selects one for you.",
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

interface StoreArgs {
  readonly session: string;
  readonly store?: string;
  readonly snapshot?: string;
  readonly provenance: boolean;
  readonly json: boolean;
}

/** Shared by `list`/`show`/`verify`: an explicit `--session`, everything else optional. */
function parseStoreArgs(argv: readonly string[], command: "list" | "show" | "verify"): StoreArgs | "help" {
  let session: string | null = null;
  let store: string | undefined;
  let snapshot: string | undefined;
  let provenance = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return "help";
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--provenance") {
      if (command !== "verify") throw new UsageError("unknown-argument", `Unknown argument: ${JSON.stringify(flag)}`);
      provenance = true;
      continue;
    }
    if (flag === "--session" || flag === "--store" || flag === "--snapshot") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("missing-value", `${flag} requires a value`);
      if (flag === "--session") session = value;
      else if (flag === "--store") store = value;
      else snapshot = value;
      index += 1;
      continue;
    }
    throw new UsageError("unknown-argument", `Unknown argument: ${JSON.stringify(flag)}`);
  }
  if (session === null) throw new UsageError("missing-session", `${command} requires an explicit --session <id>; no session is ever chosen for you.`);
  if (command === "show" && snapshot === undefined) throw new UsageError("missing-snapshot", "show requires an explicit --snapshot <id>.");
  return { session, store, snapshot, provenance, json };
}

interface DoctorArgs {
  readonly session: string;
  readonly adapter: string;
  readonly store: string;
  readonly json: boolean;
  readonly maxBytes?: number;
}

function parseDoctorArgs(argv: readonly string[]): DoctorArgs | "help" {
  let session: string | null = null;
  let adapter = "claude";
  let store: string | null = null;
  let json = false;
  let maxBytes: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return "help";
    if (flag === "--json") {
      json = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === "--session" || flag === "--adapter" || flag === "--store" || flag === "--max-bytes") {
      if (value === undefined) throw new UsageError("missing-value", `${flag} requires a value`);
      if (flag === "--session") session = value;
      else if (flag === "--adapter") adapter = value;
      else if (flag === "--store") store = value;
      else maxBytes = nonNegativeInteger(value, flag);
      index += 1;
      continue;
    }
    throw new UsageError("unknown-argument", `Unknown argument: ${JSON.stringify(flag)}`);
  }
  if (session === null) throw new UsageError("missing-session", "doctor requires an explicit --session <id>; no session is ever chosen for you.");
  if (store === null) throw new UsageError("missing-store", "doctor requires a task-owned --store <dir>; live agent state is never selected.");
  if (store.trim() === "") throw new UsageError("empty-store", "doctor requires a non-empty --store <dir>; pass an explicit disposable path.");
  return { session, adapter, store, json, maxBytes };
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
 * `preview` is the whole mapping path minus process concerns: one explicit read, map, drift
 * check, extract, render. It performs no I/O besides reading the named transcript and the
 * shipped adapter definition, so a test can call it directly and a caller can assert the
 * returned bytes.
 */
export function preview(options: PreviewOptions): PreviewResult {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(options.transcript);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError("transcript-unreadable", `Cannot read transcript ${JSON.stringify(options.transcript)}: ${reason}`);
  }

  const read = readClaudeTranscript(bytes);
  const { parse, payload, degraded, coverage } = read;

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

  return { pack, payload, diagnostics: parse.diagnostics, degraded, coverage, report: `${lines.join("\n")}\n` };
}

function resolveSession(args: StoreArgs): SessionPaths {
  return sessionPaths({ adapter: STORE_ADAPTER, sessionId: args.session, root: args.store });
}

/** SCHEMA §2: the manifest id, the full hash, and its short display form are all valid input. */
function matchesSnapshotQuery(entry: Pick<ManifestSnapshotEntry, "id" | "hash">, query: string): boolean {
  return entry.id === query || entry.hash === query || shortHash(entry.hash) === query;
}

/**
 * A quarantined file's `path` is the name `writeSnapshot` derived before it was tampered with,
 * so the short hash it embeds is still the query surface a user saw from `list`. A file placed
 * under a name that never followed that convention (there is no envelope left to derive one
 * from) falls back to its bare filename.
 */
function quarantineQueryId(entry: SnapshotReadQuarantined): string {
  return /-([0-9a-f]{12})\.json$/.exec(basename(entry.path))?.[1] ?? basename(entry.path).replace(/\.json$/, "");
}

function describeQuarantine(entry: SnapshotReadQuarantined): Record<string, unknown> {
  return { id: quarantineQueryId(entry), path: entry.path, quarantinePath: entry.quarantinePath, code: entry.code, reason: entry.reason };
}

function notFoundRefusal(session: SessionPaths, query: string): StoreRefusal {
  return new StoreRefusal("snapshot-not-found", `No snapshot ${JSON.stringify(query)} in session ${JSON.stringify(session.name)}. Run "dcompact list --session ${session.sessionId}" to see what exists.`);
}

function runList(args: StoreArgs, io: CliIo): number {
  const session = resolveSession(args);
  const listed = listSnapshots(session);
  const manifestRead = readManifest(session, listed.entries);
  const entries = manifestRead.manifest.snapshots;

  if (args.json) {
    io.stdout(`${JSON.stringify({
      session: session.name,
      store: session.root,
      manifest: { path: manifestRead.path, rebuilt: manifestRead.rebuilt, reason: manifestRead.reason },
      snapshots: entries.map((entry) => ({ id: entry.id, hash: entry.hash, short: shortHash(entry.hash), created_at: entry.created_at, facts: entry.facts, degraded: entry.degraded, pinned: entry.pinned })),
      quarantined: listed.quarantined.map(describeQuarantine),
    })}\n`);
    return EXIT_OK;
  }

  const lines: string[] = [];
  lines.push(`session: ${session.name}`);
  lines.push(`store: ${session.root}`);
  lines.push(`manifest: ${manifestRead.path}${manifestRead.rebuilt ? ` (rebuilt: ${manifestRead.reason})` : ""}`);
  if (entries.length === 0) {
    lines.push("snapshots: none");
  } else {
    lines.push(`snapshots: ${entries.length}`);
    for (const entry of entries) {
      lines.push(`  ${shortHash(entry.hash)}  ${entry.created_at}  facts=${entry.facts}  degraded=${entry.degraded.length > 0 ? entry.degraded.join(",") : "none"}  pinned=${entry.pinned ? "yes" : "no"}`);
    }
  }
  if (listed.quarantined.length === 0) {
    lines.push("quarantined: none");
  } else {
    lines.push(`quarantined: ${listed.quarantined.length}`);
    for (const entry of listed.quarantined) lines.push(`  ${quarantineQueryId(entry)}  code=${entry.code}  reason=${entry.reason}`);
  }
  io.stdout(`${lines.join("\n")}\n`);
  return EXIT_OK;
}

function runShow(args: StoreArgs, io: CliIo): number {
  const session = resolveSession(args);
  const query = args.snapshot as string;
  const listed = listSnapshots(session);
  const found = listed.snapshots.find((snapshot) => matchesSnapshotQuery({ id: snapshotId(snapshot.envelope.created_at, snapshot.envelope.hash), hash: snapshot.envelope.hash }, query));
  if (found === undefined) {
    const quarantined = listed.quarantined.find((entry) => quarantineQueryId(entry) === query);
    if (quarantined !== undefined) {
      throw new StoreRefusal("snapshot-quarantined", `Snapshot ${JSON.stringify(query)} is quarantined (${quarantined.code}: ${quarantined.reason}); inspect ${JSON.stringify(quarantined.quarantinePath)} to repair it.`);
    }
    throw notFoundRefusal(session, query);
  }

  const { envelope, payload } = found;
  const pack = renderPack(payload, { degraded: envelope.degraded });
  if (args.json) {
    io.stdout(`${JSON.stringify({ id: shortHash(envelope.hash), envelope, payload, pack })}\n`);
    return EXIT_OK;
  }

  const lines: string[] = [];
  lines.push(`snapshot ${shortHash(envelope.hash)} (${envelope.created_at})`);
  lines.push(`envelope: adapter=${envelope.adapter} session=${envelope.session_id ?? "<absent>"} schema=${envelope.schema_version} canonicalization=${envelope.canonicalization} extractor=${envelope.extractor_version}`);
  lines.push(`  hash=${envelope.hash}`);
  lines.push(`  transcript=${envelope.transcript_path ?? "<absent>"} bytes=${envelope.transcript_bytes} lines=${envelope.transcript_lines} mtime=${envelope.transcript_mtime ?? "<absent>"}`);
  lines.push(`  degraded=${envelope.degraded.length > 0 ? envelope.degraded.join(",") : "none"}`);
  lines.push(`payload: facts=${payload.counters.facts} path_base=${payload.path_base} coverage=${payload.counters.coverage_ppm}ppm unmapped=${payload.counters.unmapped_tool_calls} external=${payload.counters.external_path_count}`);
  lines.push(`  by_kind: ${Object.entries(payload.counters.by_kind).map(([kind, count]) => `${kind}=${count}`).join(", ") || "none"}`);
  lines.push(`  git: ${payload.git === null ? "absent" : `head=${payload.git.head} branch=${payload.git.branch} dirty=${payload.git.dirty}`}`);
  lines.push(`  plan: ${payload.plan === null ? "absent" : `todos=${payload.plan.todos} done=${payload.plan.done}`}`);
  lines.push("--- pack ---");
  lines.push(pack);
  io.stdout(`${lines.join("\n")}\n`);
  return EXIT_OK;
}

function runVerify(args: StoreArgs, io: CliIo): number {
  const session = resolveSession(args);
  const listed = listSnapshots(session);
  let usable: readonly Snapshot[] = listed.snapshots;
  let quarantined: readonly SnapshotReadQuarantined[] = listed.quarantined;

  if (args.snapshot !== undefined) {
    const match = usable.find((snapshot) => matchesSnapshotQuery({ id: snapshotId(snapshot.envelope.created_at, snapshot.envelope.hash), hash: snapshot.envelope.hash }, args.snapshot as string));
    if (match !== undefined) {
      usable = [match];
      quarantined = [];
    } else {
      const quarantinedMatch = quarantined.find((entry) => quarantineQueryId(entry) === args.snapshot);
      if (quarantinedMatch === undefined) throw notFoundRefusal(session, args.snapshot);
      usable = [];
      quarantined = [quarantinedMatch];
    }
  }

  const checked = usable.map((snapshot) => {
    const hash = checkPayloadHash(snapshot);
    const provenance = args.provenance ? checkProvenance(snapshot) : null;
    return { id: shortHash(snapshot.envelope.hash), hash, provenance };
  });
  // Corruption already surfaced by `readSnapshot` as a quarantine (CONCEPT §11.3 "Corrupt
  // snapshot"); a hash re-check here can only ever confirm what let the file into `usable` in
  // the first place. Either source failing is the same integrity contract.
  const integrityOk = quarantined.length === 0 && checked.every((entry) => entry.hash.ok);

  if (args.json) {
    io.stdout(`${JSON.stringify({
      session: session.name,
      store: session.root,
      checked,
      quarantined: quarantined.map(describeQuarantine),
      integrityOk,
    })}\n`);
    return integrityOk ? EXIT_OK : EXIT_INTEGRITY_FAILURE;
  }

  const lines: string[] = [];
  lines.push(`session: ${session.name}`);
  lines.push(checked.length === 0 ? "checked: none" : `checked: ${checked.length}`);
  for (const entry of checked) {
    lines.push(`  ${entry.id}  hash=${entry.hash.ok ? "ok" : `MISMATCH (expected ${entry.hash.expected}, computed ${entry.hash.computed})`}`);
    if (entry.provenance !== null) {
      const { counts, transcriptReadable, transcriptPath } = entry.provenance;
      lines.push(`    provenance: transcript=${transcriptPath ?? "<absent>"} readable=${transcriptReadable} backed=${counts.backed} drifted=${counts.drifted} unbacked=${counts.unbacked}`);
    }
  }
  if (quarantined.length === 0) {
    lines.push("quarantined: none");
  } else {
    lines.push(`quarantined: ${quarantined.length}`);
    for (const entry of quarantined) lines.push(`  ${quarantineQueryId(entry)}  code=${entry.code}  reason=${entry.reason}`);
  }
  lines.push(`integrity: ${integrityOk ? "ok" : "FAILED"}`);
  io.stdout(`${lines.join("\n")}\n`);
  return integrityOk ? EXIT_OK : EXIT_INTEGRITY_FAILURE;
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
  if (command !== "preview" && command !== "snapshot" && command !== "restore" && command !== "hook" && command !== "list" && command !== "show" && command !== "verify" && command !== "doctor") {
    io.stderr(`Unknown command: ${JSON.stringify(command)}\n\n${usage()}\n`);
    return EXIT_USAGE;
  }

  try {
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
    if (command === "list" || command === "show" || command === "verify") {
      const parsed = parseStoreArgs(argv.slice(1), command);
      if (parsed === "help") {
        io.stdout(`${usage()}\n`);
        return EXIT_OK;
      }
      if (command === "list") return runList(parsed, io);
      if (command === "show") return runShow(parsed, io);
      return runVerify(parsed, io);
    }
    if (command === "doctor") {
      const parsed = parseDoctorArgs(argv.slice(1));
      if (parsed === "help") {
        io.stdout(`${usage()}\n`);
        return EXIT_OK;
      }
      let report: DoctorReport;
      try {
        report = doctor({ adapter: parsed.adapter, sessionId: parsed.session, root: parsed.store, maxBytes: parsed.maxBytes });
      } catch (error) {
        // `doctor()` only throws for a malformed session/adapter id or store path (pure
        // validation, no I/O); every store-availability failure is already a field in its
        // report. That is a usage mistake, not a reduced-mode store.
        if (error instanceof StoreRefusal) throw new UsageError(error.code, error.message);
        throw error;
      }
      io.stdout(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatDoctorReport(report)}\n`);
      return doctorExitCode(report);
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
      if (error.code === "transcript-unreadable") return EXIT_INTEGRITY_FAILURE;
      io.stderr(`\n${usage()}\n`);
      return EXIT_USAGE;
    }
    // Both refusals are configuration a user can repair — a transcript that cannot supply a
    // required extraction input, or an adapter definition that cannot be read — so they name the
    // problem instead of printing a stack.
    if (error instanceof ClaudeTranscriptRefusal || error instanceof AdapterDefinitionRefusal) {
      io.stderr(`Refusing to preview: ${error.message}\n`);
      return EXIT_OPERATIONAL_FAILURE;
    }
    if (error instanceof ContinuityRefusal) {
      io.stderr(`Refusing continuity operation: ${error.message}\n`);
      // CONCEPT §6.2: an unreadable transcript is an integrity failure regardless of which
      // command tried to read it, not a generic refusal.
      return error.code === "transcript-unreadable" ? EXIT_INTEGRITY_FAILURE : EXIT_OPERATIONAL_FAILURE;
    }
    if (error instanceof StoreRefusal) {
      io.stderr(`Refusing store operation: ${error.message}\n`);
      // A quarantined snapshot is corruption CONCEPT §11.3 already detected on read; asking to
      // `show`/`verify` it specifically surfaces that as the same integrity failure, not a
      // generic refusal, so both codes report the same class of problem the same way.
      return error.code === "snapshot-quarantined" ? EXIT_INTEGRITY_FAILURE : EXIT_OPERATIONAL_FAILURE;
    }
    const reason = error instanceof Error ? (error.stack ?? error.message) : String(error);
    io.stderr(`Internal error: ${reason}\n`);
    return EXIT_OPERATIONAL_FAILURE;
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
