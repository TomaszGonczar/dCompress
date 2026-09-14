/**
 * Claude Code transcript adapter — OG-61 P6a thin slice.
 *
 * Scope: map the JSONL transcript Claude Code writes under
 * `~/.claude/projects/<slug>/<session>.jsonl` to `NormalizedEvent[]`, and declare the
 * extraction inputs (`ExtractConfig`) those events are extracted with.
 *
 * Deliberately absent (P6b owns them): the adapter registry, `adapters/claude.json`, hook
 * installation, store wiring, session discovery. This module never probes the filesystem and
 * never reads the clock: every value it emits comes from the transcript bytes. Transcript
 * content is untrusted data; nothing here is executed, evaluated, or interpolated into a
 * shell.
 *
 * Mapping decisions, all keyed to names observed on Claude Code 2.1.238 (ADAPTER-SPEC §2):
 *
 * | `tool_use.name` | tool kind | note |
 * |---|---|---|
 * | `Bash`   | `command`       | failure comes from the paired result's `is_error`, never an exit code |
 * | `Read`   | `file.read`     | |
 * | `Write`  | `file.modified` | `file.created` is not inferred: a `Write` result does not prove the file was absent |
 * | `Edit`   | `file.modified` | |
 * | `TaskCreate` / `TaskUpdate` | `todo` | the fact is emitted from the paired result; no result, no todo |
 * | every other exact observed non-MCP name | `ignored` | decided, and counted as covered |
 * | `mcp__<server>__<tool>` | `ignored` | documented Claude MCP naming, prefix rule |
 * | a name that was never observed | absent from the map | counted by core as `unmapped_tool_calls` |
 *
 * A name is never mapped speculatively: an unrecognized name must lower `coverage_ppm`, which
 * is the signal that the vocabulary has drifted. A recognized call whose result never arrived is
 * emitted with `resultObserved: false`, so it still counts toward coverage while producing no
 * effect fact — the transcript does not show what the call did.
 */

import { normalizePath } from "../core/canonical.js";
import { splitPhysicalLines } from "../core/hash.js";
import type {
  ExtractConfig,
  NormalizedEvent,
  NormalizedEventSource,
  NormalizedTodoEvent,
  NormalizedToolEvent,
  NormalizedUserEvent,
  PathNormalizationOptions,
  ScopeRoot,
  ToolKind,
} from "../core/types.js";

export const CLAUDE_ADAPTER_ID = "claude" as const;

/** Version of the CLI whose transcript shapes were measured; recorded, never inferred. */
export const CLAUDE_OBSERVED_VERSION = "2.1.238";

/**
 * Provisional decision lexicon for the thin slice. SCHEMA §5.6 makes the lexicon data with a
 * versioned hash stored in the envelope; P6b moves this to `adapters/lexicon.json` and hashes
 * it. Kept here so P6a adds no new configuration file.
 */
export const CLAUDE_DECISION_CUES: readonly string[] = Object.freeze([
  "we will",
  "we must",
  "must",
  "always",
  "never",
  "don't",
  "do not",
  "instead",
]);

/**
 * Claude tool names that are recognized and deliberately produce no fact.
 *
 * This is exactly the non-MCP vocabulary measured in P4 (ADAPTER-SPEC §2) minus the names mapped
 * to a fact kind below, so the set is a decision about observed tools, not a catch-all. Mapping
 * any of these to a kind would invent meaning the transcript does not carry. Names that were
 * never observed are deliberately absent: they must surface as `unmapped_tool_calls` drift
 * rather than be absorbed by a guess.
 */
const IGNORED_TOOL_NAMES: readonly string[] = Object.freeze([
  "AskUserQuestion",
  "ToolSearch",
  "Agent",
  "WebFetch",
  "ListAgents",
  "Artifact",
  "TaskList",
  "Skill",
  "ScheduleWakeup",
  "ExitPlanMode",
]);

/**
 * Exact observed tool names mapped to a tool kind. The table covers the full non-MCP vocabulary
 * in ADAPTER-SPEC §2: each name is either given the fact kind its semantics justify or is
 * explicitly listed as ignored. A name absent from both tables is an unmapped call, counted by
 * core, which is the signal that the agent's vocabulary has drifted.
 */
export const CLAUDE_TOOL_KINDS: Readonly<Record<string, ToolKind>> = Object.freeze({
  Bash: "command",
  Read: "file.read",
  Write: "file.modified",
  Edit: "file.modified",
  // Task tools carry their state in the paired result, not in the call, and are emitted as
  // `todo` events by the mapper.
  TaskCreate: "todo",
  TaskUpdate: "todo",
  ...Object.fromEntries(IGNORED_TOOL_NAMES.map((name) => [name, "ignored" as ToolKind])),
});

/** Claude names MCP tools `mcp__<server>__<tool>`; the server set is unbounded, so match a prefix. */
const MCP_TOOL_PREFIX = "mcp__";

/**
 * Top-level record types that are recognized and carry no extractable fact for this slice.
 * Anything outside this table plus the conversation types below is `schema-drift`.
 */
const NON_CONVERSATIONAL_RECORD_TYPES: Readonly<Record<string, true>> = {
  attachment: true,
  "queue-operation": true,
  mode: true,
  "permission-mode": true,
  "last-prompt": true,
  "custom-title": true,
  "ai-title": true,
  "file-history-snapshot": true,
  "file-history-delta": true,
  "atis-latch": true,
  "summary": true,
  "compact-boundary": true,
};

const CONVERSATION_RECORD_TYPES: Readonly<Record<string, true>> = {
  user: true,
  assistant: true,
  system: true,
};

/**
 * Claude writes the compaction boundary as a `system` record without a `message` object. Its
 * summary is transcript data, not a user turn: recognizing the boundary here prevents the
 * parser from reporting a false `conversational-content-not-text` diagnostic while keeping the
 * summary body out of normalized events and the hashed payload.
 */
function isCompactBoundaryRecord(record: JsonObject): boolean {
  return record.type === "system" && record.subtype === "compact_boundary" && isObject(record.compactMetadata);
}

/**
 * The summary immediately after a boundary is a user-shaped record marked for transcript-only
 * display. It is intentionally recognized and skipped rather than treated as user prose: the
 * summary is not a deterministic fact source and must never enter the payload through a decision
 * cue or snippet.
 */
function isCompactSummaryRecord(record: JsonObject): boolean {
  if ((record.type !== "user" && record.type !== "assistant") || record.isCompactSummary !== true) return false;
  const message = record.message;
  return isObject(message) && Object.prototype.hasOwnProperty.call(message, "content");
}

export type ClaudeDiagnosticCode =
  | "invalid-utf8"
  | "malformed-json"
  | "unknown-record-type"
  | "unknown-content-block"
  | "conversational-content-not-text"
  | "tool-result-without-call"
  | "tool-call-without-result"
  | "tool-result-not-text"
  | "tool-input-shape"
  | "path-unrepresentable"
  | "task-result-shape"
  | "task-status-unknown";

/**
 * A skipped or repaired input, reported so the caller can mark the snapshot degraded.
 * `detail` never contains transcript prose: it is a bounded adapter-vocabulary token.
 */
export interface ClaudeDiagnostic {
  readonly line: number;
  readonly code: ClaudeDiagnosticCode;
  readonly detail: string;
}

export interface ClaudeSession {
  readonly sessionId: string | null;
  readonly cwd: string | null;
  readonly version: string | null;
}

export interface ClaudeParseResult {
  /** Normalized events in physical line order; `entry` is the 0-based record index. */
  readonly events: NormalizedEvent[];
  readonly diagnostics: ClaudeDiagnostic[];
  readonly session: ClaudeSession;
  /** Every `tool_use.name` observed, sorted and deduplicated. */
  readonly toolNames: string[];
  /** Conversation records (`user`/`assistant`/`system`), regardless of content, including compact metadata. */
  readonly recordCount: number;
  /** Conversation records carrying at least one recognized content block. */
  readonly conversationRecords: number;
  readonly toolCalls: number;
  readonly toolResults: number;
}

/** Raised when the transcript cannot supply a required extraction input. Refusal, never a guess. */
export class ClaudeTranscriptRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ClaudeTranscriptRefusal";
    this.code = code;
  }
}

interface JsonObject {
  readonly [key: string]: unknown;
}

interface PhysicalLine {
  readonly line: number;
  readonly bytes: Uint8Array;
  readonly parsed: JsonObject | null;
}

interface PendingCall {
  readonly id: string;
  readonly name: string;
  readonly line: number;
  readonly entry: number;
  readonly timestamp: string | null;
  readonly input: JsonObject | null;
}

interface PairedResult {
  readonly line: number;
  readonly isError: boolean;
  readonly text: string;
  readonly result: JsonObject | string | null;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Control characters that must not reach display text; they become spaces, not facts. */
// eslint-disable-next-line no-control-regex
const CONTROL_WHITESPACE = /[\u0000-\u001f\u007f]+/g;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow to a string without throwing; used at every transcript boundary. */
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * A token safe to echo into a diagnostic: recognizable shape, bounded, and never free prose.
 * Unknown record types are attacker-influenced data, so anything else becomes `"<other>"`.
 */
function safeToken(value: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "<other>";
}

function blockText(block: JsonObject): string | null {
  const content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (!isObject(item)) return null;
    const text = asString(item.text);
    if (text === null) return null;
    parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Task tool ids are strings in the observed payloads (`"1"`); accept a numeric form too rather
 * than dropping the todo, but reject anything that is not a plain small integer.
 */
function taskItemId(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : asString(value);
  if (text === null || !/^[0-9]{1,15}$/.test(text)) return null;
  return Number(text);
}

function taskStatusState(status: string): "open" | "done" | null {
  if (status === "completed") return "done";
  if (status === "pending" || status === "in_progress") return "open";
  return null;
}

/**
 * Map Claude JSONL bytes to normalized events.
 *
 * Pairing is by `tool_use.id` ↔ `tool_result.tool_use_id`, never by line adjacency; results
 * are physically separated from their calls by `attachment` records in real transcripts.
 * Evidence line numbers are 1-based physical lines and `rawLine` is the exact line bytes, so
 * `lineHash` reflects the bytes on disk rather than a re-serialization.
 */
export function parseClaudeTranscript(bytes: Uint8Array): ClaudeParseResult {
  const diagnostics: ClaudeDiagnostic[] = [];
  const physical: PhysicalLine[] = splitPhysicalLines(bytes).map((lineBytes, index) => {
    const line = index + 1;
    let decoded: string;
    try {
      decoded = textDecoder.decode(lineBytes);
    } catch {
      diagnostics.push({ line, code: "invalid-utf8", detail: "utf8" });
      return { line, bytes: lineBytes, parsed: null };
    }
    try {
      const value: unknown = JSON.parse(decoded);
      if (!isObject(value)) {
        diagnostics.push({ line, code: "unknown-record-type", detail: "<other>" });
        return { line, bytes: lineBytes, parsed: null };
      }
      return { line, bytes: lineBytes, parsed: value };
    } catch {
      diagnostics.push({ line, code: "malformed-json", detail: "json" });
      return { line, bytes: lineBytes, parsed: null };
    }
  });

  const calls = new Map<string, PendingCall>();
  const results = new Map<string, PairedResult>();
  const toolNames = new Set<string>();
  let sessionId: string | null = null;
  let sessionCwd: string | null = null;
  let sessionVersion: string | null = null;
  let recordCount = 0;
  let conversationRecords = 0;

  for (const { line, parsed } of physical) {
    if (parsed === null) continue;
    const type = asString(parsed.type);
    if (type === null) {
      diagnostics.push({ line, code: "unknown-record-type", detail: "<other>" });
      continue;
    }
    const compactBoundary = isCompactBoundaryRecord(parsed);
    const compactSummary = isCompactSummaryRecord(parsed);
    if (compactBoundary || compactSummary) {
      // Compact metadata is intentionally skipped as an event, but it is still a valid source
      // of session extraction inputs. Identity is read only after the shape has been recognized;
      // malformed/unknown records must never become a guessed session.
      recordCount += 1;
      if (sessionId === null) sessionId = asString(parsed.sessionId);
      if (sessionCwd === null) sessionCwd = asString(parsed.cwd);
      if (sessionVersion === null) sessionVersion = asString(parsed.version);
      continue;
    }
    // A compact-boundary or compact-summary candidate with an invalid shape is still surfaced
    // as drift, but cannot contribute identity. Keep the existing diagnostic detail stable.
    if (type === "system" && parsed.subtype === "compact_boundary") {
      recordCount += 1;
      diagnostics.push({ line, code: "conversational-content-not-text", detail: type });
      continue;
    }
    if ((type === "user" || type === "assistant") && parsed.isCompactSummary === true) {
      recordCount += 1;
      diagnostics.push({ line, code: "conversational-content-not-text", detail: type });
      continue;
    }
    if (NON_CONVERSATIONAL_RECORD_TYPES[type] === true) continue;
    if (CONVERSATION_RECORD_TYPES[type] !== true) {
      diagnostics.push({ line, code: "unknown-record-type", detail: safeToken(type) });
      continue;
    }
    recordCount += 1;
    if (sessionId === null) sessionId = asString(parsed.sessionId);
    if (sessionCwd === null) sessionCwd = asString(parsed.cwd);
    if (sessionVersion === null) sessionVersion = asString(parsed.version);

    const message = parsed.message;
    if (!isObject(message)) {
      diagnostics.push({ line, code: "conversational-content-not-text", detail: type });
      continue;
    }
    const content = message.content;
    if (!Array.isArray(content)) continue;
    const toolUseResult = parsed.toolUseResult;
    let recognizedBlocks = 0;
    for (const block of content) {
      if (!isObject(block)) {
        diagnostics.push({ line, code: "unknown-content-block", detail: "<other>" });
        continue;
      }
      const blockType = asString(block.type);
      if (blockType === "tool_use") {
        const id = asString(block.id);
        const name = asString(block.name);
        if (id === null || name === null) {
          diagnostics.push({ line, code: "tool-input-shape", detail: "tool_use" });
          continue;
        }
        recognizedBlocks += 1;
        toolNames.add(name);
        if (calls.has(id)) {
          diagnostics.push({ line, code: "tool-input-shape", detail: "duplicate-call-id" });
          continue;
        }
        calls.set(id, {
          id,
          name,
          line,
          entry: line - 1,
          timestamp: asString(parsed.timestamp),
          input: isObject(block.input) ? block.input : null,
        });
        continue;
      }
      if (blockType === "tool_result") {
        const id = asString(block.tool_use_id);
        if (id === null) {
          diagnostics.push({ line, code: "unknown-content-block", detail: "tool_result" });
          continue;
        }
        recognizedBlocks += 1;
        const text = blockText(block);
        if (text === null) diagnostics.push({ line, code: "tool-result-not-text", detail: "content" });
        if (results.has(id)) {
          diagnostics.push({ line, code: "tool-input-shape", detail: "duplicate-result-id" });
          continue;
        }
        results.set(id, {
          line,
          // Only an explicit `true` is a failure: real success records omit the field entirely.
          isError: block.is_error === true,
          text: text ?? "",
          result: isObject(toolUseResult) ? toolUseResult : asString(toolUseResult),
        });
        continue;
      }
      if (blockType === "thinking" || blockType === "text" || blockType === "redacted_thinking") {
        recognizedBlocks += 1;
        continue;
      }
      diagnostics.push({ line, code: "unknown-content-block", detail: safeToken(blockType ?? "") });
    }
    if (recognizedBlocks > 0) conversationRecords += 1;
  }

  const events: NormalizedEvent[] = [];
  const consumedResults = new Set<string>();
  // Pass-two bookkeeping: `emittedCallIds` refuses a repeated `tool_use` id, so a malformed
  // duplicate becomes one event and one diagnostic instead of two events sharing a call id.
  const emittedCallIds = new Set<string>();
  const reportedUnmatched = new Set<string>();
  // Paths are validated before they leave the adapter, but they are NOT rewritten: scope and
  // relative form are core's decision (SCHEMA §5.2), and a path flattened here would arrive at
  // the extractor already in-scope, silently losing the `external` scope signal. The check
  // exists only because a path that is exactly the scope root has no relative key and makes
  // core throw; catching it keeps that a reported diagnostic instead of an internal error.
  const pathOptions: PathNormalizationOptions = {
    cwd: sessionCwd ?? "",
    repoRoot: null,
    scopeRoots: [],
    pathBase: "cwd",
  };
  const representablePath = (value: string): boolean => {
    if (sessionCwd === null) return true;
    try {
      normalizePath(value, pathOptions);
      return true;
    } catch {
      return false;
    }
  };

  for (const { line, bytes: rawLine, parsed } of physical) {
    if (parsed === null || CONVERSATION_RECORD_TYPES[asString(parsed.type) ?? ""] !== true) continue;
    if (isCompactBoundaryRecord(parsed) || isCompactSummaryRecord(parsed)) continue;
    const message = parsed.message;
    if (!isObject(message)) continue;
    const entry = line - 1;
    const timestamp = asString(parsed.timestamp);
    const content = message.content;
    const isUserRecord = asString(parsed.type) === "user";

    if (!Array.isArray(content)) {
      const text = asString(content);
      if (isUserRecord && text !== null && text.trim().length > 0) {
        events.push({ type: "user", entry, line, rawLine, timestamp, text });
      }
      continue;
    }

    for (const block of content) {
      if (!isObject(block)) continue;
      const blockType = asString(block.type);

      if (blockType === "text" && isUserRecord) {
        const text = asString(block.text);
        if (text !== null && text.trim().length > 0) {
          const event: NormalizedUserEvent = { type: "user", entry, line, rawLine, timestamp, text };
          events.push(event);
        }
        continue;
      }

      if (blockType !== "tool_use") continue;
      const id = asString(block.id);
      if (id === null) continue;
      // A repeated `tool_use` id is a malformed transcript, already reported during the scan.
      // Emitting it again would duplicate the first call's event from the second block's line.
      if (emittedCallIds.has(id)) continue;
      const call = calls.get(id);
      if (call === undefined) continue;
      emittedCallIds.add(id);

      const paired = results.get(id);
      if (paired === undefined) {
        // Reported once per call, at the original `tool_use` line.
        if (!reportedUnmatched.has(id)) {
          reportedUnmatched.add(id);
          diagnostics.push({ line, code: "tool-call-without-result", detail: safeToken(call.name) });
        }
      } else {
        consumedResults.add(id);
      }

      const input = call.input;
      const path = input === null ? null : asString(input.file_path);
      const command = input === null ? null : asString(input.command);
      const intent = input === null ? null : asString(input.description);
      if (call.name === "Bash" && command === null) {
        diagnostics.push({ line, code: "tool-input-shape", detail: "bash-command" });
      }
      if ((call.name === "Read" || call.name === "Write" || call.name === "Edit") && path === null) {
        diagnostics.push({ line, code: "tool-input-shape", detail: "file-path" });
      }
      let safePath = path;
      if (path !== null && !representablePath(path)) {
        diagnostics.push({ line, code: "path-unrepresentable", detail: "scope-root" });
        safePath = null;
      }

      const isError = paired?.isError === true;
      // The call and its result are separate physical lines, and only the result line carries
      // the failure text. Declaring both keeps a `cmd.failed`/`error.raised` fact backed by the
      // line its data actually came from, not just by the line the call was announced on.
      const pairedLine = paired === undefined ? null : physical[paired.line - 1];
      const sources: NormalizedEventSource[] =
        paired === undefined || pairedLine === null || pairedLine === undefined
          ? []
          : [{ line: paired.line, rawLine: pairedLine.bytes }];
      // Error text is display text: the signature normalizer collapses whitespace anyway, and
      // raw newlines/tabs would otherwise render as replacement characters in the pack. The
      // untruncated bytes remain available through `evidence`, so nothing is lost.
      const errorMessage = paired === undefined ? null : paired.text.replace(CONTROL_WHITESPACE, " ").trim();
      const event: NormalizedToolEvent = {
        type: "tool",
        entry,
        line,
        rawLine,
        timestamp,
        toolCallId: id,
        toolName: call.name,
        ...(intent === null ? {} : { intent }),
        ...(safePath === null ? {} : { path: safePath }),
        ...(command === null ? {} : { command }),
        isError,
        ...(isError && errorMessage !== null && errorMessage.length > 0 ? { errorMessage } : {}),
        ...(paired === undefined ? { resultObserved: false } : {}),
        ...(sources.length === 0 ? {} : { sources }),
      };
      events.push(event);

      // No result means no observed outcome: a todo would assert a state or identity that was
      // never confirmed by the transcript.
      const todo = paired === undefined ? null : todoEventFor(call, paired, rawLine, sources, diagnostics);
      if (todo !== null) events.push(todo);
    }
  }

  for (const [id, result] of results) {
    if (consumedResults.has(id)) continue;
    diagnostics.push({ line: result.line, code: "tool-result-without-call", detail: "result" });
  }

  // Diagnostics are returned in physical order so callers see a stable list that does not
  // depend on which pass noticed the problem.
  const orderedDiagnostics = [...diagnostics].sort(
    (left, right) => left.line - right.line || left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail),
  );

  return {
    events,
    diagnostics: orderedDiagnostics,
    session: { sessionId, cwd: sessionCwd, version: sessionVersion },
    toolNames: [...toolNames].sort(),
    recordCount,
    conversationRecords,
    toolCalls: calls.size,
    toolResults: results.size,
  };
}

/**
 * Task tools carry their meaning in the paired result, not in the call input: `TaskCreate`
 * returns the assigned id and `TaskUpdate` reports the new status. No result, no todo event —
 * a todo without an id would be an invented identity.
 */
function todoEventFor(
  call: PendingCall,
  paired: PairedResult,
  rawLine: Uint8Array,
  sources: readonly NormalizedEventSource[],
  diagnostics: ClaudeDiagnostic[],
): NormalizedTodoEvent | null {
  if (call.name === "TaskCreate") {
    const subject = call.input === null ? null : asString(call.input.subject);
    if (subject === null) {
      diagnostics.push({ line: call.line, code: "tool-input-shape", detail: "task-subject" });
      return null;
    }
    const task = isObject(paired.result) ? paired.result.task : null;
    const item = isObject(task) ? taskItemId(task.id) : null;
    if (item === null) {
      diagnostics.push({ line: call.line, code: "task-result-shape", detail: "task-create" });
      return null;
    }
    return {
      type: "todo",
      entry: call.entry,
      line: call.line,
      rawLine,
      timestamp: call.timestamp,
      state: "open",
      text: subject,
      item,
      // The task's identity is assigned in the result line, so that line is evidence too.
      ...(sources.length === 0 ? {} : { sources }),
    };
  }

  if (call.name === "TaskUpdate") {
    const status = call.input === null ? null : asString(call.input.status);
    const item = call.input === null ? null : taskItemId(call.input.taskId);
    if (status === null || item === null) {
      diagnostics.push({ line: call.line, code: "tool-input-shape", detail: "task-update" });
      return null;
    }
    const state = taskStatusState(status);
    if (state === null) {
      diagnostics.push({ line: call.line, code: "task-status-unknown", detail: safeToken(status) });
      return null;
    }
    return {
      type: "todo",
      entry: call.entry,
      line: call.line,
      rawLine,
      timestamp: call.timestamp,
      state,
      text: status,
      item,
      ...(sources.length === 0 ? {} : { sources }),
    };
  }

  return null;
}

/**
 * Declare the tool map for the tools this transcript actually contains.
 *
 * Derived rather than fixed so the MCP prefix rule can apply without teaching core a wildcard,
 * and so `coverage_ppm` stays a real signal: a name that is neither in {@link CLAUDE_TOOL_KINDS}
 * nor an MCP name is left out of the map and core counts it as an unmapped call.
 */
export function claudeToolKinds(toolNames: readonly string[]): Record<string, ToolKind> {
  const kinds: Record<string, ToolKind> = {};
  for (const name of toolNames) {
    const declared = CLAUDE_TOOL_KINDS[name];
    if (declared !== undefined) kinds[name] = declared;
    else if (name.startsWith(MCP_TOOL_PREFIX)) kinds[name] = "ignored";
  }
  return kinds;
}

/**
 * Extraction inputs derived only from transcript evidence.
 *
 * `path_base: "cwd"` with `repoRoot: null` is the honest reading of P6a: the transcript names
 * a session cwd but nothing that proves a repository root, and probing the filesystem in
 * extraction is a determinism bug (SCHEMA §5.2 rule 5). Scope roots are empty because cwd is
 * the session cwd; any path outside it becomes the opaque external form.
 */
export function claudeExtractConfig(parse: ClaudeParseResult): ExtractConfig {
  const cwd = parse.session.cwd;
  if (cwd === null || cwd.length === 0) {
    throw new ClaudeTranscriptRefusal(
      "missing-session-cwd",
      "The transcript records no session cwd, so paths cannot be normalized without guessing.",
    );
  }
  const scopeRoots: ScopeRoot[] = [];
  return {
    adapterId: CLAUDE_ADAPTER_ID,
    toolKinds: claudeToolKinds(parse.toolNames),
    scopeRoots,
    cwd,
    repoRoot: null,
    pathBase: "cwd",
    decisionCues: CLAUDE_DECISION_CUES,
  };
}
