/**
 * Claude Code transcript adapter — the mapper half of the Claude adapter.
 *
 * Scope: map the JSONL transcript Claude Code writes under
 * `~/.claude/projects/<slug>/<session>.jsonl` to normalized events, and declare the extraction
 * inputs (`ExtractConfig`) those events are extracted with.
 *
 * Everything an agent version can change without changing mapping *logic* lives in
 * `adapters/claude.json` and arrives here as an `AdapterDefinition`: the record vocabulary, the
 * tool-name table and its prefix rule, the decision lexicon, the fixtures the vocabulary was
 * verified against, and the version those fixtures were measured on. What stays in code is the
 * parsing: which block fields carry a path or a command, how a call is paired with its result,
 * and which record shapes are recognized-but-skipped. That split is the P5 contract — an adapter
 * is a JSON file plus a mapper function.
 *
 * This module never probes the filesystem and never reads the clock: every value it emits comes
 * from the transcript bytes and the supplied definition. Transcript content is untrusted data;
 * nothing here is executed, evaluated, or interpolated into a shell.
 *
 * Mapping decisions in code, keyed to names observed on Claude Code 2.1.238 (ADAPTER-SPEC §2):
 *
 * - a call is paired with its result by `tool_use.id` ↔ `tool_result.tool_use_id`, never by line
 *   adjacency; real transcripts separate the two with `attachment` records;
 * - a failure comes from the paired result's `is_error`, never from an exit code, which the
 *   transcript does not carry;
 * - `Write` and `Edit` both map to `file.modified`; `file.created` is never inferred, because a
 *   `Write` result does not prove the file was absent;
 * - `TaskCreate`/`TaskUpdate` carry their meaning in the paired result, not in the call: the task
 *   id and the status arrive with the result, so no result means no todo;
 * - the compaction boundary and the summary after it are recognized and skipped: the summary is
 *   not a deterministic fact source and must never reach the payload through a cue or snippet;
 * - a recognized call whose result never arrived is emitted with `resultObserved: false`, so it
 *   still counts toward coverage while producing no effect fact.
 *
 * The tool kinds themselves are the definition's. A name that is neither in its exact table nor
 * matched by its prefix table stays out of the map, so the extractor counts it as
 * `unmapped_tool_calls` and `coverage_ppm` reports the drift instead of a guess absorbing it.
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
  ToolKind,
} from "../core/types.js";
import { buildExtractConfig, toolKindsFor } from "./registry.js";
import type { AdapterDefinition, AdapterDiagnostic, AdapterParseResult, AdapterSession } from "./registry.js";

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
 *
 * The code set is Claude's; the framework only requires that a diagnostic exists, because any
 * diagnostic means the declaration does not cover what the transcript contained (see
 * `registry.ts`).
 */
export interface ClaudeDiagnostic extends AdapterDiagnostic {
  readonly code: ClaudeDiagnosticCode;
}

/**
 * `AdapterParseResult` with Claude's narrower diagnostic codes, so the CLI can order its report
 * by a known code list while the framework stays adapter-agnostic.
 */
export interface ClaudeParseResult extends AdapterParseResult {
  /** Normalized events in physical line order; `entry` is the 0-based record index. */
  readonly events: NormalizedEvent[];
  readonly diagnostics: ClaudeDiagnostic[];
  readonly session: AdapterSession;
  /** Every `tool_use.name` observed, sorted and deduplicated. */
  readonly toolNames: string[];
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
 * Map Claude JSONL bytes to normalized events against one adapter definition.
 *
 * Pairing is by `tool_use.id` ↔ `tool_result.tool_use_id`, never by line adjacency; results
 * are physically separated from their calls by `attachment` records in real transcripts.
 * Evidence line numbers are 1-based physical lines and `rawLine` is the exact line bytes, so
 * `lineHash` reflects the bytes on disk rather than a re-serialization.
 *
 * The record vocabulary is the definition's, so a new record type is a declared change rather
 * than a code change — and so the same vocabulary decides what `drift.ts` accepts as known.
 */
export function parseClaudeTranscript(bytes: Uint8Array, definition: AdapterDefinition): ClaudeParseResult {
  const records = definition.transcript.records;
  // Membership is tested by `Set`, not by an object lookup: a transcript-supplied `type` such as
  // `constructor` must miss, which an object literal inherited from `Object.prototype` cannot
  // promise.
  const conversational = new Set(records.conversational);
  const nonConversational = new Set(records.non_conversational);
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
    if (nonConversational.has(type)) continue;
    if (!conversational.has(type)) {
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
    if (parsed === null || !conversational.has(asString(parsed.type) ?? "")) continue;
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
 * Derived rather than fixed so the definition's prefix rule can apply without teaching the
 * engine a wildcard, and so `coverage_ppm` stays a real signal: a name in neither of the
 * definition's tables is left out of the map and the extractor counts it as an unmapped call.
 */
export function claudeToolKinds(toolNames: readonly string[], definition: AdapterDefinition): Record<string, ToolKind> {
  return toolKindsFor(definition.tools, toolNames);
}

/**
 * Extraction inputs derived only from transcript evidence.
 *
 * `path_base: "cwd"` with `repoRoot: null` is the honest reading of P6a: the transcript names
 * a session cwd but nothing that proves a repository root, and probing the filesystem in
 * extraction is a determinism bug (SCHEMA §5.2 rule 5). Scope roots are empty because cwd is
 * the session cwd; any path outside it becomes the opaque external form.
 *
 * The vocabulary and the decision lexicon come from the definition, through the framework's
 * assembler, so no adapter-specific copy of them can drift.
 */
export function claudeExtractConfig(parse: ClaudeParseResult, definition: AdapterDefinition): ExtractConfig {
  const cwd = parse.session.cwd;
  if (cwd === null || cwd.length === 0) {
    throw new ClaudeTranscriptRefusal(
      "missing-session-cwd",
      "The transcript records no session cwd, so paths cannot be normalized without guessing.",
    );
  }
  return buildExtractConfig(definition, {
    cwd,
    repoRoot: null,
    pathBase: "cwd",
    scopeRoots: [],
    toolNames: parse.toolNames,
  });
}
