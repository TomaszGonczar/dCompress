import { errorSignature, mergeFacts, normalizeCommand, normalizePath, sanitizeText } from "../canonical.js";
import { lineHash } from "../hash.js";
import type { CanonicalValue, DegradedState, ExtractConfig, Fact, FactKind, NormalizedEvent, Payload, PayloadCounters, ToolKind } from "../types.js";

export interface ExtractionResult {
  readonly facts: Fact[];
  readonly counters: PayloadCounters;
  readonly degraded: DegradedState[];
}

const isFactKind = (kind: ToolKind): kind is Exclude<ToolKind, "command" | "ignored"> => kind !== "command" && kind !== "ignored";

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  const a = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const b = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

function rawText(raw: string | Uint8Array): string {
  return typeof raw === "string" ? raw : new TextDecoder().decode(raw);
}

function makeFact(kind: FactKind, key: string, event: NormalizedEvent, attrs: Record<string, CanonicalValue>, snippet: string, scope: Fact["scope"] | undefined): Fact {
  return {
    kind,
    key,
    ...(scope === undefined ? {} : { scope }),
    at: { entry: event.entry, ts: event.timestamp },
    attrs,
    evidence: [{ line: event.line, sha256: lineHash(event.rawLine) }],
    snippet,
    unbacked: false,
  };
}

function firstSentence(text: string): string {
  const match = text.match(/^[\s\S]*?(?:[.!?](?:\s|$)|$)/);
  return (match?.[0] ?? text).replace(/[\t\r\n ]+/g, " ").trim();
}

function truncateCodePoints(text: string, limit: number): string {
  const characters = Array.from(text);
  return characters.length <= limit ? text : characters.slice(0, limit).join("");
}

function decisionFact(event: Extract<NormalizedEvent, { type: "user" }>, config: ExtractConfig): Fact | null {
  const normalized = sanitizeText(firstSentence(event.text), config);
  if (normalized === null) return null;
  const sentence = truncateCodePoints(normalized, 200);
  const cue = config.decisionCues.find((candidate) => sentence.toLowerCase().includes(candidate.toLowerCase()));
  return cue === undefined ? null : makeFact("decision.stated", sentence, event, { cue }, sentence, undefined);
}

function errorClass(signature: string): string {
  const separator = signature.indexOf(":");
  return separator < 0 ? signature : signature.slice(0, separator);
}

function commandFact(event: Extract<NormalizedEvent, { type: "tool" }>, command: string, failed: boolean, signature: string, config: ExtractConfig): Fact {
  const toolName = sanitizeText(event.toolName, config) ?? "";
  const snippet = event.intent === undefined ? `${toolName} ${command}` : normalizeCommand(event.intent, config) ?? "";
  return failed
    ? makeFact("cmd.failed", command, event, { runs: 1, last_error_class: errorClass(signature) }, snippet, undefined)
    : makeFact("cmd.run", command, event, { runs: 1, failed: false }, snippet, undefined);
}

function sortedEvents(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  return [...events].sort((left, right) => left.entry - right.entry || left.line - right.line || compareText(rawText(left.rawLine), rawText(right.rawLine)));
}

export function coveragePpm(sourceToolCalls: number, unmappedToolCalls: number): number {
  if (!Number.isSafeInteger(sourceToolCalls) || sourceToolCalls < 0 || !Number.isSafeInteger(unmappedToolCalls) || unmappedToolCalls < 0 || unmappedToolCalls > sourceToolCalls) {
    throw new RangeError("impossible tool-call counters");
  }
  if (sourceToolCalls === 0) return 0;
  const ppm = (BigInt(sourceToolCalls - unmappedToolCalls) * 1_000_000n) / BigInt(sourceToolCalls);
  if (ppm < 0n || ppm > 1_000_000n) throw new RangeError("coverage is outside parts-per-million bounds");
  const result = Number(ppm);
  if (!Number.isSafeInteger(result)) throw new RangeError("coverage cannot be represented safely");
  return result;
}

function factsAndState(events: readonly NormalizedEvent[], config: ExtractConfig): { facts: Fact[]; sourceToolCalls: number; unmappedToolCalls: number; git: Payload["git"]; plan: Payload["plan"] } {
  const facts: Fact[] = [];
  const failedCommands = new Map<string, Set<string>>();
  let sourceToolCalls = 0;
  let unmappedToolCalls = 0;
  let git: Payload["git"] = null;
  let plan: Payload["plan"] = null;

  for (const event of sortedEvents(events)) {
    switch (event.type) {
      case "tool": {
        sourceToolCalls += 1;
        const mapping = config.toolKinds[event.toolName];
        if (mapping === undefined) {
          unmappedToolCalls += 1;
          break;
        }
        if (mapping === "ignored") break;
        if (mapping === "command" || mapping === "cmd.run" || mapping === "cmd.failed") {
          const command = normalizeCommand(event.command ?? "", config);
          if (command === null) break;
          const signature = errorSignature(event.errorMessage ?? "unknown", undefined, config);
          facts.push(commandFact(event, command, event.isError, signature, config));
          if (event.isError) {
            const errorText = sanitizeText(event.errorMessage ?? "", config);
            if (errorText !== null) facts.push(makeFact("error.raised", signature, event, { count: 1, class: errorClass(signature) }, errorText, undefined));
            const signatures = failedCommands.get(command) ?? new Set<string>();
            signatures.add(signature);
            failedCommands.set(command, signatures);
          } else {
            const signatures = failedCommands.get(command);
            if (signatures !== undefined) {
              for (const previous of [...signatures].sort(compareText)) facts.push(makeFact("error.fixed", previous, event, { count: 1, fixed_by: command }, `fixed by ${command}`, undefined));
              failedCommands.delete(command);
            }
          }
          break;
        }
        if (isFactKind(mapping)) {
          if (mapping === "file.modified" || mapping === "file.read" || mapping === "file.created" || mapping === "file.deleted") {
            if (event.path === undefined) break;
            const normalized = normalizePath(event.path, config);
            const toolName = sanitizeText(event.toolName, config);
            if (toolName === null) break;
            const attrs: Record<string, CanonicalValue> = mapping === "file.modified"
              ? { edits: 1, tools: [toolName] }
              : mapping === "file.read" ? { reads: 1 } : {};
            facts.push(makeFact(mapping, normalized.path, event, attrs, `${toolName} ${normalized.path}`, normalized.scope));
          } else {
            const safeToolName = sanitizeText(event.toolName, config);
            if (safeToolName === null) break;
            const snippet = event.intent === undefined ? safeToolName : normalizeCommand(event.intent, config) ?? "";
            facts.push(makeFact(mapping, safeToolName, event, {}, snippet, undefined));
          }
        }
        break;
      }
      case "user": {
        const decision = decisionFact(event, config);
        if (decision !== null) facts.push(decision);
        break;
      }
      case "todo":
        {
          const text = sanitizeText(event.text, config);
          if (text === null) break;
          facts.push(makeFact("todo.state", event.item === undefined ? event.state : `item:${event.item}`, event, { text }, text, undefined));
        }
        break;
      case "plan":
        plan = { todos: event.todos, done: event.done, items: event.items.map((item) => sanitizeText(item, config)).filter((item): item is string => item !== null) };
        facts.push(makeFact("plan.state", "plan", event, { todos: event.todos, done: event.done }, plan.items.join(", "), undefined));
        break;
      case "git":
        git = { head: sanitizeText(event.head, config) ?? "", branch: sanitizeText(event.branch, config) ?? "", dirty: event.dirty, status_hash: sanitizeText(event.statusHash, config) ?? "", diff_stat: { ...event.diffStat } };
        facts.push(makeFact("git.state", "head", event, {}, git.head, undefined));
        facts.push(makeFact("git.state", "status", event, { dirty: event.dirty, status_hash: git.status_hash }, git.branch, undefined));
        facts.push(makeFact("git.state", "diff", event, { ...event.diffStat }, `${event.diffStat.files} files`, undefined));
        break;
      case "ignored":
        break;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }
  return { facts: mergeFacts(facts), sourceToolCalls, unmappedToolCalls, git, plan };
}

function extraction(events: readonly NormalizedEvent[], config: ExtractConfig): ExtractionResult & { git: Payload["git"]; plan: Payload["plan"] } {
  const result = factsAndState(events, config);
  if (result.unmappedToolCalls > result.sourceToolCalls) throw new RangeError("unmapped tool calls exceed source tool calls");
  const byKind: Record<string, number> = {};
  for (const fact of result.facts) byKind[fact.kind] = (byKind[fact.kind] ?? 0) + 1;
  const counters: PayloadCounters = {
    facts: result.facts.length,
    by_kind: byKind,
    source_entries: events.length,
    source_tool_calls: result.sourceToolCalls,
    unmapped_tool_calls: result.sourceToolCalls === 0 ? 0 : result.unmappedToolCalls,
    coverage_ppm: coveragePpm(result.sourceToolCalls, result.unmappedToolCalls),
    external_path_count: result.facts.filter((fact) => fact.scope === "external").length,
  };
  return { facts: result.facts, counters, degraded: events.length === 0 ? ["extraction-empty"] : [], git: result.git, plan: result.plan };
}

export function extract(events: readonly NormalizedEvent[], config: ExtractConfig): ExtractionResult {
  const result = extraction(events, config);
  return { facts: result.facts, counters: result.counters, degraded: result.degraded };
}

export function extractFacts(events: readonly NormalizedEvent[], config: ExtractConfig): Fact[] {
  return extraction(events, config).facts;
}

export function extractPayload(events: readonly NormalizedEvent[], config: ExtractConfig): Payload {
  const result = extraction(events, config);
  return { facts: result.facts, counters: result.counters, git: result.git, plan: result.plan, path_base: config.pathBase, version: 1 };
}

export default extractFacts;
