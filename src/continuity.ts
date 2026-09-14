import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { parseClaudeTranscript, claudeExtractConfig, ClaudeTranscriptRefusal } from "./adapters/claude.js";
import { mergeCheckpointPayloads } from "./core/continuity.js";
import { canonicalize } from "./core/canonical.js";
import { extractPayloadWithHealth } from "./core/extract/index.js";
import { payloadHash } from "./core/hash.js";
import { DEFAULT_MAX_BYTES, minimumPackBytes, renderPack } from "./core/pack.js";
import type { DegradedState, Envelope, PackOptions, Payload, Snapshot } from "./core/types.js";

const STORE_SCHEMA = "1.0.0";
const CANONICALIZATION = 3;
const EXTRACTOR_VERSION = "0.1.0";

export class ContinuityRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ContinuityRefusal";
    this.code = code;
  }
}

export class CorruptCheckpointError extends ContinuityRefusal {
  constructor(path: string, reason: string) {
    super("corrupt-checkpoint", `Refusing corrupt checkpoint ${JSON.stringify(path)}: ${reason}`);
    this.name = "CorruptCheckpointError";
  }
}

export interface ContinuityStoreOptions {
  readonly root: string;
  readonly now?: () => number;
}

export interface CheckpointOptions extends ContinuityStoreOptions {
  readonly sessionId: string;
  readonly transcriptPath: string;
}

export interface CheckpointResult {
  readonly snapshot: Snapshot;
  readonly path: string;
  readonly created: boolean;
}

export interface RestoreOptions extends ContinuityStoreOptions, Partial<Pick<PackOptions, "maxBytes" | "maxFacts" | "includeEvidence">> {
  readonly sessionId: string;
  readonly degraded?: readonly DegradedState[];
}

function safeSessionId(sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
    throw new ContinuityRefusal("invalid-session-id", "session id must be an explicit bounded token");
  }
  return sessionId;
}

function ensureStoreRoot(root: string): string {
  if (root.trim() === "") throw new ContinuityRefusal("empty-store", "--store must be a non-empty task-owned directory; pass an explicit disposable path");
  const absolute = resolve(root);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new ContinuityRefusal("symlink-state", `Refusing symlinked store root ${JSON.stringify(absolute)}`);
    if (!stat.isDirectory()) throw new ContinuityRefusal("state-not-directory", `State path is not a directory: ${JSON.stringify(absolute)}`);
  } catch (error) {
    if (error instanceof ContinuityRefusal) throw error;
    const refusal = statePathRefusal(error, absolute, "store root");
    if (refusal) throw refusal;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      mkdirSync(absolute, { recursive: true, mode: 0o700 });
    } catch (mkdirError) {
      const refusal = statePathRefusal(mkdirError, absolute, "store root");
      if (refusal) throw refusal;
      throw mkdirError;
    }
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(absolute);
    } catch (statError) {
      const refusal = statePathRefusal(statError, absolute, "store root");
      if (refusal) throw refusal;
      throw statError;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ContinuityRefusal("symlink-state", `Refusing invalid store root ${JSON.stringify(absolute)}`);
  }
  try {
    chmodSync(absolute, 0o700);
  } catch (error) {
    const refusal = statePathRefusal(error, absolute, "store root");
    if (refusal) throw refusal;
    throw error;
  }
  return absolute;
}

function ensurePrivateDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new ContinuityRefusal("symlink-state", `Refusing symlinked state directory ${JSON.stringify(path)}`);
    if (!stat.isDirectory()) throw new ContinuityRefusal("state-not-directory", `State path is not a directory: ${JSON.stringify(path)}`);
    chmodSync(path, 0o700);
  } catch (error) {
    if (error instanceof ContinuityRefusal) throw error;
    const refusal = statePathRefusal(error, path, "state directory");
    if (refusal) throw refusal;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      mkdirSync(path, { recursive: false, mode: 0o700 });
      chmodSync(path, 0o700);
    } catch (createError) {
      const refusal = statePathRefusal(createError, path, "state directory");
      if (refusal) throw refusal;
      throw createError;
    }
  }
}

function ensureStoreDirectories(root: string, sessionId: string): string {
  const store = ensureStoreRoot(root);
  const claude = join(store, "claude");
  const session = join(claude, safeSessionId(sessionId));
  const checkpoints = join(session, "checkpoints");
  ensurePrivateDirectory(claude);
  ensurePrivateDirectory(session);
  ensurePrivateDirectory(checkpoints);
  return checkpoints;
}

function refuseSymlink(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new ContinuityRefusal("symlink-state", `Refusing symlinked ${label} ${JSON.stringify(path)}`);
  } catch (error) {
    if (error instanceof ContinuityRefusal) throw error;
    const refusal = statePathRefusal(error, path, label);
    if (refusal) throw refusal;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Convert filesystem failures on explicitly named continuity state into user-actionable refusals. */
function statePathRefusal(error: unknown, path: string, label: string): ContinuityRefusal | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOTDIR" || code === "EISDIR") {
    return new ContinuityRefusal("state-not-directory", `State path is not a directory: ${JSON.stringify(path)}; pass an explicit disposable --store directory or repair the ${label}.`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ContinuityRefusal("state-unreadable", `Cannot access ${label} ${JSON.stringify(path)}: permission denied; repair its permissions or pass an explicit disposable --store directory.`);
  }
  return null;
}

function sessionDirectory(root: string, sessionId: string): string {
  return join(resolve(root), "claude", safeSessionId(sessionId), "checkpoints");
}

function checkpointPath(root: string, sessionId: string, hash: string): string {
  return join(sessionDirectory(root, sessionId), `${hash.slice(7)}.json`);
}

function hashId(snapshot: Snapshot): string {
  return snapshot.envelope.hash.slice(7);
}

function orderCheckpoints(snapshots: readonly Snapshot[], sessionId: string): Snapshot[] {
  const byHash = new Map<string, Snapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.envelope.session_id !== sessionId) throw new CorruptCheckpointError(sessionId, "session id does not match its store directory");
    const hash = hashId(snapshot);
    if (byHash.has(hash)) throw new CorruptCheckpointError(sessionId, "duplicate checkpoint hash");
    byHash.set(hash, snapshot);
  }
  const ordered: Snapshot[] = [];
  let previous: string | null = null;
  while (ordered.length < snapshots.length) {
    const next = [...byHash.values()].find((snapshot) => snapshot.envelope.previous_hash === previous);
    if (next === undefined) throw new CorruptCheckpointError(sessionId, "checkpoint ancestry is incomplete or forked");
    ordered.push(next);
    byHash.delete(hashId(next));
    previous = next.envelope.hash;
  }
  return ordered;
}

function iso(now: () => number): string {
  return new Date(now()).toISOString().replace(/\.000Z$/, "Z");
}

function readTranscript(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ContinuityRefusal("transcript-unreadable", `Cannot read explicitly supplied transcript ${JSON.stringify(path)}: ${reason}`);
  }
}

function assertSession(parse: ReturnType<typeof parseClaudeTranscript>, sessionId: string): void {
  if (parse.session.sessionId === null) {
    throw new ClaudeTranscriptRefusal("missing-session-id", "the explicitly supplied transcript contains no session id");
  }
  if (parse.session.sessionId !== sessionId) {
    throw new ContinuityRefusal("session-mismatch", `transcript session ${JSON.stringify(parse.session.sessionId)} does not match explicit session ${JSON.stringify(sessionId)}`);
  }
}

function snapshotFrom(options: CheckpointOptions, bytes: Uint8Array, previousHash: string | null): Snapshot {
  const parse = parseClaudeTranscript(bytes);
  assertSession(parse, options.sessionId);
  const config = claudeExtractConfig(parse);
  const extracted = extractPayloadWithHealth(parse.events, config);
  const degraded: DegradedState[] = [...new Set<DegradedState>([
    ...(parse.diagnostics.length > 0 ? ["schema-drift" as const] : []),
    ...extracted.degraded,
  ])].sort();
  const hash = payloadHash(extracted.payload);
  ensureStoreDirectories(options.root, options.sessionId);
  const now = options.now ?? Date.now;
  const envelope: Envelope = {
    schema_version: STORE_SCHEMA,
    canonicalization: CANONICALIZATION,
    extractor_version: EXTRACTOR_VERSION,
    created_at: iso(now),
    adapter: "claude",
    adapter_version: parse.session.version,
    session_id: options.sessionId,
    transcript_path: options.transcriptPath,
    transcript_bytes: bytes.byteLength,
    transcript_lines: bytes.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), bytes.length > 0 && bytes.at(-1) !== 0x0a ? 1 : 0),
    transcript_mtime: null,
    host: { os: process.platform, arch: process.arch, node: process.version },
    store: { cwd: parse.session.cwd ?? "", repo_root: null },
    degraded,
    previous_hash: previousHash,
    duration_ms: 0,
    hash,
  };
  return { envelope, payload: extracted.payload };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

const FACT_KINDS = new Set(["file.modified", "file.read", "file.created", "file.deleted", "cmd.run", "cmd.failed", "error.raised", "error.fixed", "decision.stated", "todo.state", "plan.state", "git.state", "note"]);
const FACT_SCOPES = new Set(["repo", "cwd", "granted", "external", "uri"]);

function integer(value: unknown, label: string, path: string, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new CorruptCheckpointError(path, `${label} must be a non-negative integer`);
}

function validatePayload(value: Record<string, unknown>, path: string): void {
  if (Object.keys(value).some((key) => !["facts", "counters", "git", "plan", "path_base", "version"].includes(key))) {
    throw new CorruptCheckpointError(path, "payload contains an unknown field");
  }
  if (value.version !== 1) throw new CorruptCheckpointError(path, "payload.version must be exactly 1");
  if (value.path_base !== "repo" && value.path_base !== "cwd") throw new CorruptCheckpointError(path, "payload.path_base must be repo or cwd");
  if (!Array.isArray(value.facts)) throw new CorruptCheckpointError(path, "payload.facts must be an array");
  const counters = objectRecord(value.counters);
  if (counters === null) throw new CorruptCheckpointError(path, "payload.counters must be an object");
  integer(counters.facts, "counters.facts", path);
  if (counters.facts !== value.facts.length) throw new CorruptCheckpointError(path, "counters.facts must equal facts.length");
  integer(counters.source_entries, "counters.source_entries", path);
  integer(counters.source_tool_calls, "counters.source_tool_calls", path);
  integer(counters.unmapped_tool_calls, "counters.unmapped_tool_calls", path);
  if ((counters.unmapped_tool_calls as number) > (counters.source_tool_calls as number)) throw new CorruptCheckpointError(path, "unmapped_tool_calls cannot exceed source_tool_calls");
  integer(counters.coverage_ppm, "counters.coverage_ppm", path);
  if ((counters.coverage_ppm as number) > 1_000_000) throw new CorruptCheckpointError(path, "coverage_ppm cannot exceed 1000000");
  const expectedCoverage = counters.source_tool_calls === 0 ? 0 : Math.floor(((counters.source_tool_calls as number) - (counters.unmapped_tool_calls as number)) * 1_000_000 / (counters.source_tool_calls as number));
  if (counters.coverage_ppm !== expectedCoverage) throw new CorruptCheckpointError(path, "coverage_ppm is inconsistent with source counters");
  integer(counters.external_path_count, "counters.external_path_count", path);
  const byKind = objectRecord(counters.by_kind);
  if (byKind === null) throw new CorruptCheckpointError(path, "counters.by_kind must be an object");
  const counts: Record<string, number> = {};
  let external = 0;
  for (const raw of value.facts) {
    const fact = objectRecord(raw);
    if (fact === null || typeof fact.kind !== "string" || !FACT_KINDS.has(fact.kind) || typeof fact.key !== "string") throw new CorruptCheckpointError(path, "fact kind/key is invalid");
    const at = objectRecord(fact.at);
    const attrs = objectRecord(fact.attrs);
    if (at === null || attrs === null) throw new CorruptCheckpointError(path, "fact at/attrs must be objects");
    integer(at.entry, "fact.at.entry", path);
    if (at.ts !== null && typeof at.ts !== "string") throw new CorruptCheckpointError(path, "fact.at.ts must be a string or null");
    if (fact.scope !== undefined && (typeof fact.scope !== "string" || !FACT_SCOPES.has(fact.scope))) throw new CorruptCheckpointError(path, "fact.scope is invalid");
    if (fact.scope === "external") external += 1;
    if (!Array.isArray(fact.evidence) || fact.evidence.length > 5) throw new CorruptCheckpointError(path, "fact.evidence must be an array of at most five entries");
    for (const rawEvidence of fact.evidence) {
      const evidence = objectRecord(rawEvidence);
      if (evidence === null) throw new CorruptCheckpointError(path, "fact evidence must be an object");
      integer(evidence.line, "evidence.line", path, 1);
      if (!isHash(evidence.sha256)) throw new CorruptCheckpointError(path, "evidence.sha256 must be sha256:<64 lowercase hex characters>");
      if (Object.keys(evidence).some((key) => key !== "line" && key !== "sha256")) throw new CorruptCheckpointError(path, "evidence contains an unknown field");
    }
    if (typeof fact.snippet !== "string" || typeof fact.unbacked !== "boolean") throw new CorruptCheckpointError(path, "fact snippet/unbacked has invalid shape");
    const required: Record<string, (value: unknown) => boolean> = {
      "file.modified": (item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0,
      "file.read": (item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0,
      "cmd.run": (item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0,
      "cmd.failed": (item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0,
      "error.raised": (item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0,
      "error.fixed": (item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0,
    };
    const numericAttr = required[fact.kind];
    const numericName = fact.kind === "file.modified" ? "edits" : fact.kind === "file.read" ? "reads" : fact.kind === "error.raised" || fact.kind === "error.fixed" ? "count" : "runs";
    if (numericAttr && !numericAttr(attrs[numericName])) throw new CorruptCheckpointError(path, `${fact.kind} requires integer attrs.${numericName}`);
    if (fact.kind === "file.modified" && (!Array.isArray(attrs.tools) || attrs.tools.some((item) => typeof item !== "string"))) throw new CorruptCheckpointError(path, "file.modified requires string attrs.tools[]");
    if (fact.kind === "cmd.run" && typeof attrs.failed !== "boolean") throw new CorruptCheckpointError(path, "cmd.run requires boolean attrs.failed");
    if (fact.kind === "cmd.failed" && typeof attrs.last_error_class !== "string") throw new CorruptCheckpointError(path, "cmd.failed requires attrs.last_error_class");
    if (fact.kind === "error.raised" && typeof attrs.class !== "string") throw new CorruptCheckpointError(path, "error.raised requires attrs.class");
    if (fact.kind === "error.fixed" && typeof attrs.fixed_by !== "string") throw new CorruptCheckpointError(path, "error.fixed requires attrs.fixed_by");
    if (fact.kind === "decision.stated" && typeof attrs.cue !== "string") throw new CorruptCheckpointError(path, "decision.stated requires attrs.cue");
    if (fact.kind === "todo.state" && typeof attrs.text !== "string") throw new CorruptCheckpointError(path, "todo.state requires attrs.text");
    if (fact.kind === "plan.state" && (typeof attrs.todos !== "number" || typeof attrs.done !== "number" || !Array.isArray(attrs.items))) throw new CorruptCheckpointError(path, "plan.state requires todos/done/items attrs");
    if (fact.kind === "note" && typeof attrs.text !== "string") throw new CorruptCheckpointError(path, "note requires attrs.text");
    counts[fact.kind] = (counts[fact.kind] ?? 0) + 1;
  }
  if (counters.external_path_count !== external) throw new CorruptCheckpointError(path, "external_path_count is inconsistent with facts");
  const countKeys = Object.keys(counts).sort();
  const byKindKeys = Object.keys(byKind).sort();
  if (JSON.stringify(countKeys) !== JSON.stringify(byKindKeys) || countKeys.some((kind) => byKind[kind] !== counts[kind])) throw new CorruptCheckpointError(path, "counters.by_kind is inconsistent with facts");
  if (value.git !== null && objectRecord(value.git) === null) throw new CorruptCheckpointError(path, "payload.git must be null or an object");
  if (value.plan !== null && objectRecord(value.plan) === null) throw new CorruptCheckpointError(path, "payload.plan must be null or an object");
}

function validateSnapshot(value: unknown, path: string): Snapshot {
  const snapshot = objectRecord(value);
  if (snapshot !== null && Object.keys(snapshot).some((key) => key !== "envelope" && key !== "payload")) {
    throw new CorruptCheckpointError(path, "snapshot contains an unknown field");
  }
  const envelope = objectRecord(snapshot?.envelope);
  const payload = objectRecord(snapshot?.payload);
  if (snapshot === null || envelope === null || payload === null) {
    throw new CorruptCheckpointError(path, "missing envelope or payload");
  }
  if (envelope.schema_version !== STORE_SCHEMA) {
    throw new CorruptCheckpointError(path, `schema_version must be exactly ${STORE_SCHEMA}`);
  }
  if (envelope.canonicalization !== CANONICALIZATION) {
    throw new CorruptCheckpointError(path, `canonicalization must be exactly ${CANONICALIZATION}`);
  }
  if (envelope.extractor_version !== EXTRACTOR_VERSION) {
    throw new CorruptCheckpointError(path, `extractor_version must be exactly ${EXTRACTOR_VERSION}`);
  }
  if (envelope.adapter !== "claude") {
    throw new CorruptCheckpointError(path, "adapter must be exactly claude");
  }
  integer(envelope.transcript_bytes, "envelope.transcript_bytes", path);
  integer(envelope.transcript_lines, "envelope.transcript_lines", path);
  if (typeof envelope.session_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(envelope.session_id)) {
    throw new CorruptCheckpointError(path, "session_id must be an explicit bounded token");
  }
  if (!isHash(envelope.hash)) {
    throw new CorruptCheckpointError(path, "hash must have the shape sha256:<64 lowercase hex characters>");
  }
  if (envelope.previous_hash !== null && !isHash(envelope.previous_hash)) {
    throw new CorruptCheckpointError(path, "previous_hash must be null or sha256:<64 lowercase hex characters>");
  }
  const degradedStates = new Set<DegradedState>(["ok", "schema-drift", "extraction-empty", "provenance-broken", "budget-exceeded", "internal-error", "unavailable:agent-not-installed", "unavailable:store", "untrusted:hook-pending-review", "no-pre-compaction-hook"]);
  if (!Array.isArray(envelope.degraded) || envelope.degraded.some((state) => typeof state !== "string" || !degradedStates.has(state as DegradedState))) {
    throw new CorruptCheckpointError(path, "envelope.degraded must contain only known state tokens");
  }
  validatePayload(payload, path);
  try {
    const actual = payloadHash(payload as unknown as Payload);
    if (envelope.hash !== actual) throw new CorruptCheckpointError(path, `payload hash ${actual} does not match envelope`);
    if (basename(path) !== `${envelope.hash.slice(7)}.json`) throw new CorruptCheckpointError(path, "checkpoint filename is not bound to envelope.hash");
    canonicalize(payload);
  } catch (error) {
    if (error instanceof CorruptCheckpointError) throw error;
    throw new CorruptCheckpointError(path, error instanceof Error ? error.message : String(error));
  }
  return { envelope: envelope as unknown as Envelope, payload: payload as unknown as Payload };
}

export function readCheckpoint(path: string): Snapshot {
  try {
    refuseSymlink(path, "checkpoint file");
    const name = basename(path);
    if (!/^[0-9a-f]{64}\.json$/.test(name)) throw new CorruptCheckpointError(path, "checkpoint filename must be the 64-hex payload hash");
    return validateSnapshot(JSON.parse(readFileSync(path, "utf8")) as unknown, path);
  } catch (error) {
    if (error instanceof ContinuityRefusal) throw error;
    const refusal = statePathRefusal(error, path, "checkpoint file");
    if (refusal) throw refusal;
    if (error instanceof CorruptCheckpointError) throw error;
    throw new CorruptCheckpointError(path, error instanceof Error ? error.message : String(error));
  }
}

export function listCheckpoints(options: ContinuityStoreOptions & { readonly sessionId: string }): Snapshot[] {
  if (options.root.trim() === "") throw new ContinuityRefusal("empty-store", "--store must be a non-empty task-owned directory; pass an explicit disposable path");
  const store = resolve(options.root);
  refuseSymlink(store, "store root");
  const claude = join(store, "claude");
  const session = join(claude, safeSessionId(options.sessionId));
  const dir = sessionDirectory(store, options.sessionId);
  refuseSymlink(claude, "Claude state directory");
  refuseSymlink(session, "session state directory");
  refuseSymlink(dir, "checkpoint directory");
  refuseSymlink(injectionMarkerPath(options.root, options.sessionId), "injection marker");
  refuseSymlink(injectionEpochPath(options.root, options.sessionId), "injection epoch");
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (error) {
    const refusal = statePathRefusal(error, dir, "checkpoint directory");
    if (refusal) throw refusal;
    throw error;
  }
  for (const name of names) refuseSymlink(join(dir, name), "checkpoint entry");
  const snapshots = names.filter((name) => name.endsWith(".json")).map((name) => readCheckpoint(join(dir, name)));
  return orderCheckpoints(snapshots, options.sessionId);
}

export function checkpoint(options: CheckpointOptions): CheckpointResult {
  const sessionId = safeSessionId(options.sessionId);
  const existing = listCheckpoints({ root: options.root, sessionId });
  const previousHash = existing.at(-1)?.envelope.hash ?? null;
  const snapshot = snapshotFrom({ ...options, sessionId }, readTranscript(options.transcriptPath), previousHash);
  const path = checkpointPath(options.root, sessionId, snapshot.envelope.hash);
  refuseSymlink(path, "checkpoint file");
  if (existsSync(path)) {
    chmodSync(path, 0o600);
    return { snapshot: readCheckpoint(path), path, created: false };
  }
  const temp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, `${canonicalize(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    const refusal = statePathRefusal(error, path, "checkpoint file");
    if (refusal) throw refusal;
    throw error;
  }
  return { snapshot, path, created: true };
}

export function mergedPayload(options: ContinuityStoreOptions & { readonly sessionId: string }): Payload {
  const snapshots = listCheckpoints(options);
  if (snapshots.length === 0) throw new ContinuityRefusal("no-checkpoint", "no checkpoint exists for the explicitly supplied session");
  return mergeCheckpointPayloads(snapshots.map((snapshot) => snapshot.payload));
}

function mergedRestore(options: RestoreOptions): { readonly payload: Payload; readonly degraded: DegradedState[] } {
  const snapshots = listCheckpoints(options);
  if (snapshots.length === 0) throw new ContinuityRefusal("no-checkpoint", "no checkpoint exists for the explicitly supplied session");
  const merged = mergeCheckpointPayloads(snapshots.map((snapshot) => snapshot.payload));
  const degraded = [...new Set<DegradedState>([
    ...snapshots.flatMap((snapshot) => snapshot.envelope.degraded),
    ...(options.degraded ?? []),
    ...(merged.facts.some((fact) => fact.unbacked) ? ["provenance-broken" as const] : []),
  ])].sort();
  return { payload: merged, degraded };
}

function markerFor(pack: string): string | null {
  return /^## dcompact context \[dcompact:[0-9a-f]{12}\]/m.exec(pack)?.[0] ?? null;
}

export function injectPack(existing: string, pack: string): { readonly text: string; readonly injected: boolean } {
  const marker = markerFor(pack);
  if (marker !== null && existing.includes(marker)) return { text: existing, injected: false };
  if (existing.length === 0) return { text: pack, injected: true };
  return { text: `${existing.replace(/\s+$/, "")}\n\n${pack}`, injected: true };
}

function injectionMarkerPath(root: string, sessionId: string): string {
  return join(sessionDirectory(root, sessionId), ".last-injected");
}

function injectionEpochPath(root: string, sessionId: string): string {
  return join(sessionDirectory(root, sessionId), ".injection-epoch");
}

function readInjectionEpoch(path: string): { readonly epoch: number; readonly pending: boolean } {
  refuseSymlink(path, "injection epoch");
  try {
    const value = readFileSync(path, "utf8").trim().split(/\s+/);
    const epoch = Number(value[0]);
    if (!Number.isSafeInteger(epoch) || epoch < 0 || (value[1] !== "pending" && value[1] !== "delivered")) return { epoch: 0, pending: true };
    return { epoch, pending: value[1] === "pending" };
  } catch {
    return { epoch: 0, pending: false };
  }
}

function writeInjectionEpoch(path: string, epoch: number, pending: boolean): void {
  refuseSymlink(path, "injection epoch");
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${epoch} ${pending ? "pending" : "delivered"}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function restore(options: RestoreOptions): { readonly pack: string; readonly payload: Payload } {
  const merged = mergedRestore(options);
  const payload = merged.payload;
  const degraded = merged.degraded;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const minimum = minimumPackBytes(payload, { degraded });
  if (maxBytes < minimum) {
    throw new ContinuityRefusal("max-bytes-too-small", `--max-bytes must be at least ${minimum} for this restore (the mandatory header plus the elision notice); received ${maxBytes}. Pass --max-bytes ${minimum} or omit the flag for the default ${DEFAULT_MAX_BYTES}.`);
  }
  const pack = renderPack(payload, {
    maxBytes,
    maxFacts: options.maxFacts,
    includeEvidence: options.includeEvidence,
    degraded,
  });
  return { pack, payload };
}

export interface HookInput {
  readonly session_id?: unknown;
  readonly transcript_path?: unknown;
  readonly hook_event_name?: unknown;
  readonly source?: unknown;
}

export function runHook(input: HookInput, event: "precompact" | "session-start", options: ContinuityStoreOptions): string {
  try {
    if (typeof input.session_id !== "string" || typeof input.transcript_path !== "string") {
      throw new ContinuityRefusal("missing-hook-identity", "Claude hook input must supply session_id and transcript_path");
    }
    const sessionId = safeSessionId(input.session_id);
    if (event === "precompact") {
      checkpoint({ ...options, sessionId, transcriptPath: input.transcript_path });
      const epochPath = injectionEpochPath(options.root, sessionId);
      const epoch = readInjectionEpoch(epochPath);
      writeInjectionEpoch(epochPath, epoch.epoch + 1, true);
      return JSON.stringify({});
    }
    const source = input.source;
    if (source !== "compact" && source !== "resume") return JSON.stringify({});
    const result = restore({ ...options, sessionId });
    const marker = markerFor(result.pack);
    const markerPath = injectionMarkerPath(options.root, sessionId);
    const epochPath = injectionEpochPath(options.root, sessionId);
    refuseSymlink(markerPath, "injection marker");
    if (marker !== null) {
      let previousMarker = "";
      try {
        previousMarker = readFileSync(markerPath, "utf8");
      } catch {
        // Missing marker means the pack has not been injected in this disposable store.
      }
      // Only an exact marker is valid. Corrupt or unreadable state must never suppress a pack.
      const epoch = readInjectionEpoch(epochPath);
      // Compact delivery is one-shot per PreCompact epoch. Resume is always a fresh context,
      // so it must inject even when the payload marker is unchanged.
      if (source === "compact" && !epoch.pending && previousMarker.trim() === marker) return JSON.stringify({});
      const tempMarkerPath = `${markerPath}.tmp-${process.pid}`;
      writeFileSync(tempMarkerPath, `${marker}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(tempMarkerPath, 0o600);
      renameSync(tempMarkerPath, markerPath);
      writeInjectionEpoch(epochPath, epoch.epoch, false);
    }
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: result.pack } });
  } catch {
    // Hook availability outranks recording. Claude must always be allowed to continue.
    return JSON.stringify({});
  }
}
