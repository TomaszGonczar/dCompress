import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { extract, extractPayload } from "../../src/core/extract/index.js";
import type { ExtractConfig, NormalizedEvent, Payload, ToolKind } from "../../src/core/types.js";

export interface FixtureMetadata {
  readonly name: string;
  readonly adapterId: ExtractConfig["adapterId"];
  readonly toolKinds: Record<string, ToolKind>;
  readonly scopeRoots: ExtractConfig["scopeRoots"];
  readonly cwd: string;
  readonly repoRoot: string | null;
  readonly pathBase: ExtractConfig["pathBase"];
  readonly decisionCues: readonly string[];
  readonly expectedDegraded?: readonly string[];
  readonly equivalentTo?: string;
}

export interface VectorFixture {
  readonly directory: string;
  readonly metadata: FixtureMetadata;
  readonly transcriptBytes: Uint8Array;
  readonly events: NormalizedEvent[];
}

const textDecoder = new TextDecoder();

export const defaultMetadata = (name: string): FixtureMetadata => ({
  name,
  adapterId: "generic",
  toolKinds: {
    write: "file.modified",
    read: "file.read",
    bash: "command",
    ignored: "ignored",
  },
  scopeRoots: [{ root: "/workspace/repo", scope: "repo" }],
  cwd: "/workspace/repo",
  repoRoot: "/workspace/repo",
  pathBase: "repo",
  decisionCues: ["we will", "must", "always", "never", "don’t", "don't"],
});

function parseLines(bytes: Uint8Array): Array<{ readonly bytes: Uint8Array; readonly line: number }> {
  const lines: Array<{ bytes: Uint8Array; line: number }> = [];
  let start = 0;
  let line = 1;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    lines.push({ bytes: bytes.slice(start, index + 1), line });
    start = index + 1;
    line += 1;
  }
  if (start < bytes.length) lines.push({ bytes: bytes.slice(start), line });
  return lines;
}

function normalizedEvent(value: unknown, line: number, rawLine: Uint8Array): NormalizedEvent {
  if (value === null || typeof value !== "object" || !("type" in value)) throw new TypeError(`Fixture line ${line} is not a normalized event`);
  const event = value as Record<string, unknown>;
  const type = event.type;
  if (typeof type !== "string" || !["tool", "user", "todo", "plan", "git", "ignored"].includes(type)) throw new TypeError(`Fixture line ${line} has an unknown event type`);
  const entry = event.entry === undefined ? line - 1 : event.entry;
  if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) throw new TypeError(`Fixture line ${line} has an invalid entry`);
  return { ...event, entry, line, rawLine, timestamp: event.timestamp === undefined ? null : event.timestamp } as NormalizedEvent;
}

export function parseTranscript(bytes: Uint8Array): NormalizedEvent[] {
  return parseLines(bytes).map(({ bytes: rawLine, line }) => {
    const source = textDecoder.decode(rawLine);
    return normalizedEvent(JSON.parse(source), line, rawLine);
  });
}

/**
 * The normalized-event golden vectors: every top-level fixture directory that declares
 * `fixture.json`.
 *
 * The declaration is what makes a directory a vector. A fixture directory that ships something
 * else — an adapter transcript slice with `fixture.manifest.json`, the framework's adapter
 * definitions under `adapters/` — has no transcript/config pair to extract and must not be
 * enumerated as one: `readFixture` would fail on it, and a vector count would be wrong.
 */
export function vectorFixtureNames(fixturesDirectory = resolve(process.cwd(), "test/fixtures")): string[] {
  return readdirSync(fixturesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(fixturesDirectory, entry.name, "fixture.json")))
    .map((entry) => entry.name)
    .sort();
}

export function readFixture(name: string, fixturesDirectory = resolve(process.cwd(), "test/fixtures")): VectorFixture {
  const directory = join(fixturesDirectory, name);
  const metadata = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8")) as FixtureMetadata;
  if (metadata.name !== name) throw new TypeError(`Fixture metadata name mismatch: ${name}`);
  const transcriptBytes = readFileSync(join(directory, "transcript.jsonl"));
  if (transcriptBytes.length > 0) {
    const finalByte = transcriptBytes[transcriptBytes.length - 1];
    if (finalByte === 0x0a || finalByte === 0x0d) throw new TypeError(`Fixture transcript must not end with a newline: ${name}`);
  }
  return { directory, metadata, transcriptBytes, events: parseTranscript(transcriptBytes) };
}

export function configForFixture(fixture: VectorFixture): ExtractConfig {
  const { metadata } = fixture;
  return {
    adapterId: metadata.adapterId,
    toolKinds: metadata.toolKinds,
    scopeRoots: metadata.scopeRoots,
    cwd: metadata.cwd,
    repoRoot: metadata.repoRoot,
    pathBase: metadata.pathBase,
    decisionCues: metadata.decisionCues,
  };
}

export function extractFixture(fixture: VectorFixture): Payload {
  return extractPayload(fixture.events, configForFixture(fixture));
}

export function extractFixtureResult(fixture: VectorFixture) {
  return extract(fixture.events, configForFixture(fixture));
}

export function expectedHash(name: string, fixturesDirectory = resolve(process.cwd(), "test/fixtures")): string {
  const fixture = readFixture(name, fixturesDirectory);
  const target = fixture.metadata.equivalentTo ?? name;
  return readFileSync(join(fixturesDirectory, target, `${target}.hash`), "utf8").trimEnd();
}
