/**
 * Adapter definitions — the data half of an adapter, loaded and validated.
 *
 * Adding an agent is a definition file plus a mapper function. The definition carries
 * everything an agent version can change without changing mapping logic: where the agent keeps
 * its configuration, which hook entries `install` writes, what each hook event means, the
 * transcript layout hints, the tool-name vocabulary, the decision lexicon, and the fixtures the
 * vocabulary was verified against. The mapper (see `mappers.ts`) turns transcript bytes into
 * normalized events and extraction inputs using that data. `extractWithAdapter` is the seam
 * between the two halves, and the only place the framework drives them.
 *
 * Two rules shape this module:
 *
 * 1. A broken definition is *data about a broken definition*, never an exception thrown at a
 *    caller reading a different adapter. `loadAdapterDirectory` reports each failure and keeps
 *    every definition that parsed. A caller that cannot proceed without one named definition
 *    asks through `requireAdapterDefinition`, which throws `AdapterDefinitionRefusal` — explicit
 *    and typed, so a CLI can refuse with a message rather than a stack.
 * 2. Definitions are extraction inputs, not ambient state. Nothing here reads the clock, the
 *    cwd, or `$HOME`, and no definition field may be filled in from the filesystem: adapter data
 *    plus transcript bytes are the whole input set (SCHEMA §6.1, CONCEPT §11.4).
 *
 * A definition file is user-editable (CONCEPT §11.5), so every value that reaches a diagnostic
 * is bounded before it is echoed.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractPayloadWithHealth } from "../core/extract/index.js";
import type {
  AdapterId,
  DegradedState,
  ExtractConfig,
  NormalizedEvent,
  Payload,
  ScopeRoot,
  ToolKind,
} from "../core/types.js";
import { coverageReport, type CoverageReport } from "./coverage.js";
import { detectDrift, SHAPE_TOKEN, type DriftReport } from "./drift.js";

/** Exhaustive at compile time: a new `AdapterId` cannot be added without appearing here. */
const ADAPTER_IDS: Record<AdapterId, true> = { claude: true, codex: true, omp: true, generic: true };

/** Exhaustive at compile time: a definition may only declare a kind the extractors understand. */
const TOOL_KINDS: Record<ToolKind, true> = {
  "file.modified": true,
  "file.read": true,
  "file.created": true,
  "file.deleted": true,
  command: true,
  "cmd.run": true,
  "cmd.failed": true,
  todo: true,
  ignored: true,
};

export interface AdapterConfigPaths {
  readonly user_settings: string;
  readonly project_settings: readonly string[];
  readonly config_dir_env: string | null;
  readonly transcript_directory: string;
}

export interface AdapterVersionProbe {
  readonly command: string;
  readonly args: readonly string[];
}

/** A hook entry `install` writes. `output` is the agent-side contract, `null` when ignored. */
export interface AdapterHookEntry {
  readonly event: string;
  readonly matcher: string | null;
  readonly output: string | null;
  readonly evidence: string;
}

/**
 * What one hook event means at runtime. `registered` distinguishes the entries the installed
 * hook set contains from an event a development integration drives without registering it.
 */
export interface AdapterEventRoute {
  readonly hook: string;
  readonly match: readonly string[];
  readonly action: string;
  readonly injects: boolean;
  readonly registered: boolean;
  readonly evidence: string;
}

/**
 * The record types the transcript declares: the ones the mapper walks for conversation content,
 * and the ones it recognizes and deliberately carries no fact for. Together they are the
 * declared shape `drift.ts` compares a transcript against.
 */
export interface AdapterRecordVocabulary {
  readonly conversational: readonly string[];
  readonly non_conversational: readonly string[];
}

export interface AdapterTranscriptHints {
  readonly format: string;
  readonly records: AdapterRecordVocabulary;
}

export interface AdapterToolPrefix {
  readonly prefix: string;
  readonly kind: ToolKind;
}

/**
 * The tool-name vocabulary. An exact table and a prefix table, not one wildcard matcher: an MCP
 * tool set is unbounded, while a bare name that was never observed must stay unmapped so it
 * lowers `coverage_ppm` instead of being absorbed by a guess.
 *
 * Both tables are null-prototype objects. A tool name is transcript data, so a name like
 * `constructor` must miss the table rather than reach `Object.prototype`.
 */
export interface AdapterToolVocabulary {
  readonly exact: Readonly<Record<string, ToolKind>>;
  readonly prefixes: readonly AdapterToolPrefix[];
}

/** A fixture the vocabulary was verified against, with the shape recorded from its bytes. */
export interface AdapterFixtureRecord {
  readonly path: string;
  readonly sha256: string;
  readonly shape: readonly string[];
}

/**
 * OG-81 capability declaration: whether this adapter provides the context-watermark guardrail
 * and the exact hook-payload fields it reads `used`/`limit` telemetry from. `null` field names
 * mean the fields are `[unverified]` in `ADAPTER-SPEC.md` — the guardrail must degrade to
 * `threshold-unsupported` rather than guess one, even when `supported` is `true`.
 */
export interface AdapterContextWatermarkCapability {
  readonly supported: boolean;
  readonly used_tokens_field: string | null;
  readonly context_limit_tokens_field: string | null;
  readonly source_event: string | null;
  readonly evidence: string;
}

export interface AdapterDefinition {
  readonly schema_version: 1;
  readonly adapter: AdapterId;
  readonly display_name: string;
  readonly last_verified_version: string;
  readonly verified_at: string;
  /** Section → source marker, in the `docs:`/`observed:` vocabulary of `ADAPTER-SPEC.md`. */
  readonly evidence: Readonly<Record<string, string>>;
  readonly config_paths: AdapterConfigPaths;
  readonly version_probe: AdapterVersionProbe;
  readonly hooks: readonly AdapterHookEntry[];
  readonly event_map: readonly AdapterEventRoute[];
  readonly transcript: AdapterTranscriptHints;
  readonly tools: AdapterToolVocabulary;
  readonly decision_cues: readonly string[];
  readonly fixtures: readonly AdapterFixtureRecord[];
  /** `null` when the definition declares no watermark capability at all. */
  readonly context_watermark: AdapterContextWatermarkCapability | null;
}

export interface AdapterDiagnostic {
  readonly line: number;
  readonly code: string;
  readonly detail: string;
}

export interface AdapterSession {
  readonly sessionId: string | null;
  readonly cwd: string | null;
  readonly version: string | null;
}

/** What a mapper reports about one transcript, before any extraction input is derived. */
export interface AdapterParseResult {
  readonly events: readonly NormalizedEvent[];
  readonly diagnostics: readonly AdapterDiagnostic[];
  readonly session: AdapterSession;
  /** Every tool name observed in the transcript, sorted and deduplicated. */
  readonly toolNames: readonly string[];
  readonly recordCount: number;
  readonly conversationRecords: number;
  readonly toolCalls: number;
  readonly toolResults: number;
}

export interface AdapterRead<TP extends AdapterParseResult = AdapterParseResult> {
  readonly parse: TP;
  readonly config: ExtractConfig;
}

/**
 * Bytes and declared data in, normalized events and extraction inputs out.
 *
 * Parameterized by the parse type so an adapter's own narrower diagnostics survive the
 * framework: Claude's report is ordered by a known code list, and only its mapper can produce
 * that list.
 */
export type AdapterMapper<TP extends AdapterParseResult = AdapterParseResult> = (bytes: Uint8Array, definition: AdapterDefinition) => AdapterRead<TP>;

export interface AdapterExtraction<TP extends AdapterParseResult = AdapterParseResult> extends AdapterRead<TP> {
  readonly payload: Payload;
  /** Health for this run only: never part of the payload, so never part of the hash. */
  readonly degraded: readonly DegradedState[];
  readonly drift: DriftReport;
  readonly coverage: CoverageReport;
}

export interface AdapterExtractionInputs {
  readonly cwd: string;
  readonly repoRoot: string | null;
  readonly pathBase: "repo" | "cwd";
  readonly scopeRoots: readonly ScopeRoot[];
  readonly toolNames: readonly string[];
}

export interface AdapterLoadFailure {
  readonly path: string;
  readonly problems: readonly string[];
}

export type AdapterLoadOutcome =
  | { readonly ok: true; readonly path: string; readonly definition: AdapterDefinition }
  | { readonly ok: false; readonly path: string; readonly problems: readonly string[] };

export type AdapterDefinitionParse =
  | { readonly ok: true; readonly definition: AdapterDefinition }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Raised only when a caller named one definition and cannot run without it. */
export class AdapterDefinitionRefusal extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "AdapterDefinitionRefusal";
    this.code = code;
    this.path = path;
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Control characters must never reach a diagnostic; a definition file is user-editable text. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Control characters never reach a diagnostic, and neither does an unbounded value. */
function bounded(value: string, limit = 48): string {
  const printable = value.replace(CONTROL_CHARACTERS, "");
  if (printable.length === 0) return "<empty>";
  return printable.length <= limit ? printable : `${Array.from(printable).slice(0, limit).join("")}…`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

/** Copy into a null-prototype table so a lookup key from the transcript cannot hit a prototype. */
function lookupTable<T>(entries: readonly (readonly [string, T])[]): Readonly<Record<string, T>> {
  const table = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) table[key] = value;
  return table;
}

class ProblemList {
  private readonly entries: string[] = [];

  at(where: string, message: string): void {
    this.entries.push(`${where}: ${message}`);
  }

  string(source: JsonObject, key: string, where: string): string | null {
    const value = source[key];
    if (typeof value !== "string") {
      this.at(where, "expected a string");
      return null;
    }
    return value;
  }

  strings(source: JsonObject, key: string, where: string): string[] | null {
    const value = source[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      this.at(where, "expected an array of strings");
      return null;
    }
    return value as string[];
  }

  object(source: JsonObject, key: string, where: string): JsonObject | null {
    const value = source[key];
    if (!isObject(value)) {
      this.at(where, "expected an object");
      return null;
    }
    return value;
  }

  all(): readonly string[] {
    return this.entries;
  }

  get empty(): boolean {
    return this.entries.length === 0;
  }
}

function optionalString(source: JsonObject, key: string, where: string, problems: ProblemList): string | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    problems.at(where, "expected a string or null");
    return null;
  }
  return value;
}

function toolKind(value: unknown, where: string, problems: ProblemList): ToolKind | null {
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(TOOL_KINDS, value)) {
    problems.at(where, "expected a declared tool kind");
    return null;
  }
  return value as ToolKind;
}

/** The marker vocabulary `ADAPTER-SPEC.md` uses: an unsourced claim is not a definition input. */
const EVIDENCE_MARKER = /^(docs|observed):\S+$/;

/**
 * Validate one definition. Pure: no I/O, no defaults invented for a missing field. A definition
 * that omits something the mapper needs is rejected rather than completed.
 */
export function parseAdapterDefinition(value: unknown): AdapterDefinitionParse {
  if (!isObject(value)) return { ok: false, problems: ["root: expected an object"] };
  const problems = new ProblemList();

  const schemaVersion = value.schema_version;
  if (schemaVersion !== 1) problems.at("schema_version", "expected 1");
  const adapterValue = value.adapter;
  if (typeof adapterValue !== "string" || !Object.prototype.hasOwnProperty.call(ADAPTER_IDS, adapterValue)) {
    problems.at("adapter", "expected a declared adapter id");
  }
  const displayName = problems.string(value, "display_name", "display_name");
  const lastVerifiedVersion = problems.string(value, "last_verified_version", "last_verified_version");
  const verifiedAt = problems.string(value, "verified_at", "verified_at");
  if (verifiedAt !== null && !/^\d{4}-\d{2}-\d{2}$/.test(verifiedAt)) problems.at("verified_at", "expected YYYY-MM-DD");

  const evidenceSource = problems.object(value, "evidence", "evidence");
  const evidenceEntries: Array<readonly [string, string]> = [];
  if (evidenceSource !== null) {
    for (const [key, marker] of Object.entries(evidenceSource)) {
      if (typeof marker !== "string" || !EVIDENCE_MARKER.test(marker)) {
        problems.at(`evidence.${bounded(key)}`, "expected a docs: or observed: marker");
        continue;
      }
      evidenceEntries.push([key, marker]);
    }
  }

  const configSource = problems.object(value, "config_paths", "config_paths");
  const userSettings = configSource === null ? null : problems.string(configSource, "user_settings", "config_paths.user_settings");
  const projectSettings = configSource === null ? null : problems.strings(configSource, "project_settings", "config_paths.project_settings");
  const configDirEnv = configSource === null ? null : optionalString(configSource, "config_dir_env", "config_paths.config_dir_env", problems);
  const transcriptDirectory = configSource === null ? null : problems.string(configSource, "transcript_directory", "config_paths.transcript_directory");

  const probeSource = problems.object(value, "version_probe", "version_probe");
  const probeCommand = probeSource === null ? null : problems.string(probeSource, "command", "version_probe.command");
  if (probeCommand !== null && (probeCommand.length === 0 || /\s/.test(probeCommand))) {
    problems.at("version_probe.command", "expected a bare executable name");
  }
  const probeArgs = probeSource === null ? null : problems.strings(probeSource, "args", "version_probe.args");

  const hooksSource = value.hooks;
  const hooks: AdapterHookEntry[] = [];
  if (!Array.isArray(hooksSource)) {
    problems.at("hooks", "expected an array");
  } else {
    hooksSource.forEach((raw, index) => {
      const hook = isObject(raw) ? raw : null;
      if (hook === null) {
        problems.at(`hooks[${index}]`, "expected an object");
        return;
      }
      const event = problems.string(hook, "event", `hooks[${index}].event`);
      const matcher = optionalString(hook, "matcher", `hooks[${index}].matcher`, problems);
      const output = optionalString(hook, "output", `hooks[${index}].output`, problems);
      const marker = problems.string(hook, "evidence", `hooks[${index}].evidence`);
      if (event === null || marker === null) return;
      if (!EVIDENCE_MARKER.test(marker)) {
        problems.at(`hooks[${index}].evidence`, "expected a docs: or observed: marker");
        return;
      }
      hooks.push({ event, matcher, output, evidence: marker });
    });
  }

  const routesSource = value.event_map;
  const routes: AdapterEventRoute[] = [];
  if (!Array.isArray(routesSource)) {
    problems.at("event_map", "expected an array");
  } else {
    routesSource.forEach((raw, index) => {
      const route = isObject(raw) ? raw : null;
      if (route === null) {
        problems.at(`event_map[${index}]`, "expected an object");
        return;
      }
      const hook = problems.string(route, "hook", `event_map[${index}].hook`);
      const match = problems.strings(route, "match", `event_map[${index}].match`);
      const action = problems.string(route, "action", `event_map[${index}].action`);
      const marker = problems.string(route, "evidence", `event_map[${index}].evidence`);
      const injects = route.injects;
      const registered = route.registered;
      if (typeof injects !== "boolean") problems.at(`event_map[${index}].injects`, "expected a boolean");
      if (typeof registered !== "boolean") problems.at(`event_map[${index}].registered`, "expected a boolean");
      if (hook === null || match === null || action === null || marker === null) return;
      if (typeof injects !== "boolean" || typeof registered !== "boolean") return;
      if (!EVIDENCE_MARKER.test(marker)) {
        problems.at(`event_map[${index}].evidence`, "expected a docs: or observed: marker");
        return;
      }
      routes.push({ hook, match, action, injects, registered, evidence: marker });
    });
  }

  const transcriptSource = problems.object(value, "transcript", "transcript");
  const transcriptFormat = transcriptSource === null ? null : problems.string(transcriptSource, "format", "transcript.format");
  const recordsSource = transcriptSource === null ? null : problems.object(transcriptSource, "records", "transcript.records");
  const conversational = recordsSource === null ? null : problems.strings(recordsSource, "conversational", "transcript.records.conversational");
  const nonConversational = recordsSource === null ? null : problems.strings(recordsSource, "non_conversational", "transcript.records.non_conversational");
  // A record name outside the token alphabet could not be told apart from an undescribed record
  // when the transcript is checked against the declaration, so declaring one is refused rather
  // than silently widening what drift accepts.
  for (const [field, names] of [["conversational", conversational], ["non_conversational", nonConversational]] as const) {
    if (names === null) continue;
    for (const name of names) {
      if (!SHAPE_TOKEN.test(name)) problems.at(`transcript.records.${field}`, `expected a shape token, received ${bounded(name)}`);
    }
  }

  const toolsSource = problems.object(value, "tools", "tools");
  const exactEntries: Array<readonly [string, ToolKind]> = [];
  if (toolsSource !== null) {
    const exactSource = problems.object(toolsSource, "exact", "tools.exact");
    if (exactSource !== null) {
      for (const [name, kind] of Object.entries(exactSource)) {
        const resolved = toolKind(kind, `tools.exact.${bounded(name)}`, problems);
        if (resolved !== null) exactEntries.push([name, resolved]);
      }
    }
  }
  const prefixesSource = toolsSource === null ? null : toolsSource.prefixes;
  const prefixes: AdapterToolPrefix[] = [];
  if (!Array.isArray(prefixesSource)) {
    problems.at("tools.prefixes", "expected an array");
  } else {
    prefixesSource.forEach((raw, index) => {
      const prefix = isObject(raw) ? raw : null;
      if (prefix === null) {
        problems.at(`tools.prefixes[${index}]`, "expected an object");
        return;
      }
      const value = problems.string(prefix, "prefix", `tools.prefixes[${index}].prefix`);
      const resolved = toolKind(prefix.kind, `tools.prefixes[${index}].kind`, problems);
      if (value === null || resolved === null) return;
      prefixes.push({ prefix: value, kind: resolved });
    });
  }

  const decisionCues = problems.strings(value, "decision_cues", "decision_cues");
  if (decisionCues !== null && decisionCues.some((cue) => cue.length === 0)) {
    problems.at("decision_cues", "expected non-empty cues");
  }

  const fixturesSource = value.fixtures;
  const fixtures: AdapterFixtureRecord[] = [];
  if (!Array.isArray(fixturesSource)) {
    problems.at("fixtures", "expected an array");
  } else {
    fixturesSource.forEach((raw, index) => {
      const fixture = isObject(raw) ? raw : null;
      if (fixture === null) {
        problems.at(`fixtures[${index}]`, "expected an object");
        return;
      }
      const path = problems.string(fixture, "path", `fixtures[${index}].path`);
      const sha256 = problems.string(fixture, "sha256", `fixtures[${index}].sha256`);
      const shape = problems.strings(fixture, "shape", `fixtures[${index}].shape`);
      if (sha256 !== null && !/^sha256:[0-9a-f]{64}$/.test(sha256)) {
        problems.at(`fixtures[${index}].sha256`, "expected sha256:<64 lowercase hex>");
      }
      if (path === null || sha256 === null || shape === null) return;
      fixtures.push({ path, sha256, shape });
    });
  }

  if (fixtures.length === 0) problems.at("fixtures", "expected at least one verified fixture");

  const contextWatermarkSource = value.context_watermark;
  let contextWatermark: AdapterContextWatermarkCapability | null = null;
  if (contextWatermarkSource !== undefined) {
    const watermarkObject = isObject(contextWatermarkSource) ? contextWatermarkSource : null;
    if (watermarkObject === null) {
      problems.at("context_watermark", "expected an object");
    } else {
      const supported = watermarkObject.supported;
      if (typeof supported !== "boolean") problems.at("context_watermark.supported", "expected a boolean");
      const usedTokensField = optionalString(watermarkObject, "used_tokens_field", "context_watermark.used_tokens_field", problems);
      const contextLimitTokensField = optionalString(watermarkObject, "context_limit_tokens_field", "context_watermark.context_limit_tokens_field", problems);
      const sourceEvent = optionalString(watermarkObject, "source_event", "context_watermark.source_event", problems);
      const marker = problems.string(watermarkObject, "evidence", "context_watermark.evidence");
      if (marker !== null && !EVIDENCE_MARKER.test(marker)) problems.at("context_watermark.evidence", "expected a docs: or observed: marker");
      if (typeof supported === "boolean" && marker !== null && EVIDENCE_MARKER.test(marker)) {
        contextWatermark = { supported, used_tokens_field: usedTokensField, context_limit_tokens_field: contextLimitTokensField, source_event: sourceEvent, evidence: marker };
      }
    }
  }

  // The null checks repeat what the readers above already recorded; they exist so the compiler
  // can see the narrowing. A missing value is always a recorded problem, so a failure here never
  // reports an empty problem list.
  if (
    !problems.empty ||
    adapterValue === undefined ||
    displayName === null ||
    lastVerifiedVersion === null ||
    verifiedAt === null ||
    userSettings === null ||
    projectSettings === null ||
    transcriptDirectory === null ||
    probeCommand === null ||
    probeArgs === null ||
    transcriptFormat === null ||
    conversational === null ||
    nonConversational === null ||
    decisionCues === null
  ) {
    return { ok: false, problems: problems.all() };
  }

  const definition: AdapterDefinition = {
    schema_version: 1,
    adapter: adapterValue as AdapterId,
    display_name: displayName,
    last_verified_version: lastVerifiedVersion,
    verified_at: verifiedAt,
    evidence: lookupTable(evidenceEntries),
    config_paths: {
      user_settings: userSettings,
      project_settings: [...projectSettings],
      config_dir_env: configDirEnv,
      transcript_directory: transcriptDirectory,
    },
    version_probe: { command: probeCommand, args: [...probeArgs] },
    hooks,
    event_map: routes,
    transcript: {
      format: transcriptFormat,
      records: { conversational: [...conversational], non_conversational: [...nonConversational] },
    },
    tools: { exact: lookupTable(exactEntries), prefixes },
    decision_cues: [...decisionCues],
    fixtures,
    context_watermark: contextWatermark,
  };
  return { ok: true, definition: deepFreeze(definition) };
}

/** Read and validate one definition. Returns the failure as data; never throws for I/O or JSON. */
export function loadAdapterDefinition(path: string): AdapterLoadOutcome {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, path, problems: ["unreadable"] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, path, problems: ["invalid-json"] };
  }
  const parsed = parseAdapterDefinition(value);
  return parsed.ok ? { ok: true, path, definition: parsed.definition } : { ok: false, path, problems: parsed.problems };
}

/** Load one definition a caller cannot proceed without, refusing with the path it looked at. */
export function requireAdapterDefinition(path: string): AdapterDefinition {
  const outcome = loadAdapterDefinition(path);
  if (outcome.ok) return outcome.definition;
  throw new AdapterDefinitionRefusal(
    "adapter-definition-invalid",
    path,
    `The adapter definition ${JSON.stringify(path)} could not be used (${outcome.problems.join("; ")}). Repair the file, or reinstall it from a known-good copy.`,
  );
}

export interface AdapterDirectoryLoad {
  readonly definitions: readonly AdapterDefinition[];
  readonly failures: readonly AdapterLoadFailure[];
}

/**
 * Load every `*.json` in a directory. One broken file is reported and skipped: an adapter that
 * parses is still usable beside it, which is the difference between a degraded install and a
 * dead one.
 */
export function loadAdapterDirectory(directory: string): AdapterDirectoryLoad {
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return { definitions: [], failures: [{ path: directory, problems: ["unreadable-directory"] }] };
  }
  const definitions: AdapterDefinition[] = [];
  const failures: AdapterLoadFailure[] = [];
  const declaredBy = new Map<AdapterId, string>();
  for (const name of names) {
    const path = join(directory, name);
    const outcome = loadAdapterDefinition(path);
    if (!outcome.ok) {
      failures.push({ path, problems: outcome.problems });
      continue;
    }
    const previous = declaredBy.get(outcome.definition.adapter);
    if (previous !== undefined) {
      failures.push({ path, problems: [`duplicate adapter id ${bounded(outcome.definition.adapter)}, already declared by ${bounded(previous, 96)}`] });
      continue;
    }
    declaredBy.set(outcome.definition.adapter, path);
    definitions.push(outcome.definition);
  }
  return { definitions, failures };
}

/**
 * Where shipped definitions live: `adapters/` two levels above this module, which is
 * `<repo>/adapters` when running from source and `<pkg>/adapters` when running from a build
 * emitted under `<pkg>/dist`. The published package ships `adapters/` beside `dist/`.
 *
 * Resolved from this module's own URL, never from the cwd: where a process was started must not
 * decide which vocabulary extraction uses (SCHEMA §6.1).
 */
export function adapterDirectory(): string {
  return fileURLToPath(new URL("../../adapters", import.meta.url));
}

/** Definitions by adapter id, with the failures that must not take the working ones down. */
export class AdapterRegistry {
  private readonly byAdapter = new Map<AdapterId, AdapterDefinition>();
  private readonly loadFailures: readonly AdapterLoadFailure[];

  constructor(definitions: readonly AdapterDefinition[], failures: readonly AdapterLoadFailure[] = []) {
    for (const definition of definitions) this.byAdapter.set(definition.adapter, definition);
    this.loadFailures = [...failures];
  }

  static load(directory: string): AdapterRegistry {
    const loaded = loadAdapterDirectory(directory);
    return new AdapterRegistry(loaded.definitions, loaded.failures);
  }

  get(adapter: AdapterId): AdapterDefinition | null {
    return this.byAdapter.get(adapter) ?? null;
  }

  definitions(): readonly AdapterDefinition[] {
    return [...this.byAdapter.values()];
  }

  failures(): readonly AdapterLoadFailure[] {
    return this.loadFailures;
  }

  /**
   * The state a caller must stamp on anything produced while these failures stand.
   *
   * A definition that cannot be parsed is a declared shape the adapter can no longer honor —
   * the `schema-drift` class, whose recorded recovery is "adapter definition update + version
   * stamp" (CONCEPT §11.3). It is reported, never thrown, and never fatal to another adapter.
   */
  degraded(): readonly DegradedState[] {
    return this.loadFailures.length === 0 ? [] : ["schema-drift"];
  }
}

/**
 * The tool kinds for the names this transcript actually contains.
 *
 * Derived rather than fixed so a prefix rule can apply without teaching the engine a wildcard,
 * and so `coverage_ppm` stays a real signal: a name in neither table is left out of the map, and
 * the extractor counts it as an unmapped call.
 */
export function toolKindsFor(vocabulary: AdapterToolVocabulary, toolNames: readonly string[]): Record<string, ToolKind> {
  const kinds = Object.create(null) as Record<string, ToolKind>;
  for (const name of toolNames) {
    const exact = vocabulary.exact[name];
    if (exact !== undefined) {
      kinds[name] = exact;
      continue;
    }
    const prefixed = vocabulary.prefixes.find((candidate) => name.startsWith(candidate.prefix));
    if (prefixed !== undefined) kinds[name] = prefixed.kind;
  }
  return kinds;
}

/**
 * Assemble the extraction inputs from a mapper's transcript evidence and the adapter's declared
 * data. The framework owns this composition because the vocabulary and the lexicon are the
 * definition's; the mapper owns the parts only it can read (cwd, scope evidence) and refuses
 * before calling this when they are missing.
 */
export function buildExtractConfig(definition: AdapterDefinition, inputs: AdapterExtractionInputs): ExtractConfig {
  return {
    adapterId: definition.adapter,
    toolKinds: toolKindsFor(definition.tools, inputs.toolNames),
    scopeRoots: [...inputs.scopeRoots],
    cwd: inputs.cwd,
    repoRoot: inputs.repoRoot,
    pathBase: inputs.pathBase,
    decisionCues: [...definition.decision_cues],
  };
}

/**
 * Drive one adapter end to end: map, check the transcript's shape against the declaration,
 * extract, and account for coverage.
 *
 * Health is the union of three observations, and it stays outside the payload so the payload and
 * its hash remain a function of the transcript and the declared extraction inputs alone:
 *
 * - `drift.ts` compared the transcript's record shapes against the declared ones;
 * - the mapper reported input it could not map to the declared shape; a diagnostic means the
 *   adapter saw something its declaration does not cover, which is drift by definition;
 * - the extractor reported its own states (a recognized but factless transcript is
 *   `extraction-empty`).
 *
 * Both drift sources produce the same token, so a caller cannot tell them apart in the header —
 * which is correct: the user-visible fact is that the transcript no longer matches what the
 * adapter was verified against, and the fix is the same either way. The list is deduplicated and
 * sorted so the same failures always render as the same header (CONCEPT §11.2).
 */
export function extractWithAdapter<TP extends AdapterParseResult>(
  definition: AdapterDefinition,
  mapper: AdapterMapper<TP>,
  bytes: Uint8Array,
): AdapterExtraction<TP> {
  const read = mapper(bytes, definition);
  const drift = detectDrift(definition, bytes);
  const extracted = extractPayloadWithHealth(read.parse.events, read.config);
  const degraded = [...new Set<DegradedState>([
    ...(drift.drifted ? (["schema-drift"] as const) : []),
    ...(read.parse.diagnostics.length > 0 ? (["schema-drift"] as const) : []),
    ...extracted.degraded,
  ])].sort();
  return {
    parse: read.parse,
    config: read.config,
    payload: extracted.payload,
    degraded,
    drift,
    coverage: coverageReport(extracted.payload, read.parse.events, read.config.toolKinds),
  };
}

export interface ContextWatermarkCapability {
  readonly adapter: AdapterId;
  readonly supported: boolean;
  readonly used_tokens_field: string | null;
  readonly context_limit_tokens_field: string | null;
  readonly source_event: string | null;
  /** `null` only when nothing declares this capability at all — never a fabricated marker. */
  readonly evidence: string | null;
}

/**
 * OG-81 capability matrix: whether one adapter provides the context-watermark guardrail, and the
 * exact fields it reads telemetry from. This reads adapter data — the shipped definition, or its
 * absence — rather than branching on the adapter id, so Codex and OMP (no shipped definition;
 * OG-63/OG-64 are unbuilt) and the generic fallback (no hook surface to observe) are
 * `unsupported` because there is nothing to read, never a hardcoded `if (adapter === "claude")`.
 */
export function contextWatermarkCapability(adapter: AdapterId, definition: AdapterDefinition | null): ContextWatermarkCapability {
  const declared = definition?.context_watermark;
  if (declared === null || declared === undefined) {
    return { adapter, supported: false, used_tokens_field: null, context_limit_tokens_field: null, source_event: null, evidence: null };
  }
  return { adapter, ...declared };
}
