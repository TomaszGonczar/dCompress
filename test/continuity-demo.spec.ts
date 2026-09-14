import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claudeExtractConfig, parseClaudeTranscript } from "../src/adapters/claude.js";
import { run, type CliIo } from "../src/cli.js";
import { extractPayloadWithHealth } from "../src/core/extract/index.js";
import { payloadHash } from "../src/core/hash.js";

/**
 * `docs/demo/claude-continuity-0001.md` is published evidence for the continuity slice: it quotes
 * five streams, a table of byte counts and hashes, and two payload hashes, and invites a reader to
 * reproduce all of them. Nothing else in the suite renders that document, so without this test a
 * change to the adapter, the merge, or the renderer could leave stale bytes in public documentation
 * behind a green build.
 *
 * The test replays the document's own command sequence through `run` — the same entry point the CLI
 * uses — against a disposable store, then asserts that every quoted stream, row, and hash equals
 * what was rendered. It is a drift test, not a feature test: the loop's semantics are covered by
 * `continuity.spec.ts` and `continuity-cli.spec.ts`.
 *
 * The store is a `mkdtemp` directory removed in `afterAll`. The `snapshot` output names the file it
 * wrote, so its absolute store path is the one byte that cannot be published; the document prints
 * `<store>` instead and this test masks the same prefix before comparing. Every other byte of every
 * stream is compared exactly.
 */
const repositoryRoot = process.cwd();
const demoPath = join(repositoryRoot, "docs", "demo", "claude-continuity-0001.md");
const fixtureDirectory = join("test", "fixtures", "claude", "continuity-0001");
const sessionId = "fixture-continuity-0001";
const demo = readFileSync(demoPath, "utf8");

interface Step {
  /** The document's block marker and this test's lookup key. */
  readonly id: string;
  /** The document's checksum-table row label, reproduced verbatim. */
  readonly label: string;
  readonly argv: (store: string) => string[];
  readonly stdin: string | null;
  /** Which stream the document records for this step. */
  readonly stream: "stdout" | "stderr";
}

const hookInput = (transcript: string, source: "compact" | "resume" | null): string =>
  JSON.stringify({
    session_id: sessionId,
    transcript_path: join(fixtureDirectory, transcript),
    ...(source === null ? { hook_event_name: "PreCompact" } : { source }),
  });

/**
 * The document's command sequence, in the document's order. Order is load-bearing: the hook calls
 * mutate the injection ledger, so a replay that reordered them would not render the same bytes.
 */
const steps: readonly Step[] = [
  {
    id: "snapshot-1",
    label: "`snapshot` (epoch 1)",
    argv: (store) => ["snapshot", "--session", sessionId, "--transcript", join(fixtureDirectory, "precompact.jsonl"), "--store", store],
    stdin: null,
    stream: "stdout",
  },
  {
    id: "precompact-1",
    label: "`hook --event precompact` (epoch 1)",
    argv: (store) => ["hook", "--event", "precompact", "--store", store],
    stdin: hookInput("precompact.jsonl", null),
    stream: "stdout",
  },
  {
    id: "session-start-1",
    label: "`hook --event session-start` compact (epoch 1)",
    argv: (store) => ["hook", "--event", "session-start", "--store", store],
    stdin: hookInput("precompact.jsonl", "compact"),
    stream: "stdout",
  },
  {
    id: "session-start-1-repeat",
    label: "`hook --event session-start` compact, repeated (epoch 1)",
    argv: (store) => ["hook", "--event", "session-start", "--store", store],
    stdin: hookInput("precompact.jsonl", "compact"),
    stream: "stdout",
  },
  {
    id: "precompact-2",
    label: "`hook --event precompact` (epoch 2)",
    argv: (store) => ["hook", "--event", "precompact", "--store", store],
    stdin: hookInput("transcript.jsonl", null),
    stream: "stdout",
  },
  {
    id: "session-start-2",
    label: "`hook --event session-start` compact (epoch 2)",
    argv: (store) => ["hook", "--event", "session-start", "--store", store],
    stdin: hookInput("transcript.jsonl", "compact"),
    stream: "stdout",
  },
  {
    id: "session-start-2-repeat",
    label: "`hook --event session-start` compact, repeated (epoch 2)",
    argv: (store) => ["hook", "--event", "session-start", "--store", store],
    stdin: hookInput("transcript.jsonl", "compact"),
    stream: "stdout",
  },
  {
    id: "session-start-2-resume",
    label: "`hook --event session-start` resume (epoch 2)",
    argv: (store) => ["hook", "--event", "session-start", "--store", store],
    stdin: hookInput("transcript.jsonl", "resume"),
    stream: "stdout",
  },
  {
    id: "snapshot-2",
    label: "`snapshot` (epoch 2, the hook's own checkpoint)",
    argv: (store) => ["snapshot", "--session", sessionId, "--transcript", join(fixtureDirectory, "transcript.jsonl"), "--store", store],
    stdin: null,
    stream: "stdout",
  },
  {
    id: "restore-default",
    label: "`restore` (default budget)",
    argv: (store) => ["restore", "--session", sessionId, "--store", store],
    stdin: null,
    stream: "stdout",
  },
  {
    id: "restore-mid",
    label: "`restore --max-bytes 1400`",
    argv: (store) => ["restore", "--session", sessionId, "--store", store, "--max-bytes", "1400"],
    stdin: null,
    stream: "stdout",
  },
  {
    id: "restore-bounded",
    label: "`restore --max-bytes 640`",
    argv: (store) => ["restore", "--session", sessionId, "--store", store, "--max-bytes", "640"],
    stdin: null,
    stream: "stdout",
  },
  {
    id: "restore-evidence",
    label: "`restore --include-evidence`",
    argv: (store) => ["restore", "--session", sessionId, "--store", store, "--include-evidence"],
    stdin: null,
    stream: "stdout",
  },
  {
    id: "restore-too-small",
    label: "`restore --max-bytes 200`",
    argv: (store) => ["restore", "--session", sessionId, "--store", store, "--max-bytes", "200"],
    stdin: null,
    stream: "stderr",
  },
];

const stepById: Readonly<Record<string, Step>> = Object.fromEntries(steps.map((step) => [step.id, step]));

/** Steps the document states as equations with an earlier block instead of quoting again. */
const unquotedStep: Readonly<Record<string, true>> = { "session-start-2-resume": true, "restore-default": true };

interface Recorded {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

const store = mkdtempSync(join(tmpdir(), "dcompact-continuity-demo-"));
const rendered = new Map<string, Recorded>();

beforeAll(() => {
  for (const step of steps) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = {
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      stdin: () => step.stdin ?? "",
    };
    // `run` must finish before the sinks are joined: an object literal would evaluate the joins
    // first and capture empty streams.
    const status = run(step.argv(store), io);
    rendered.set(step.id, { stdout: stdout.join(""), stderr: stderr.join(""), status });
  }
});

afterAll(() => {
  rmSync(store, { recursive: true, force: true });
});

function outputOf(id: string, stream: Step["stream"]): string {
  const record = rendered.get(id);
  if (record === undefined) throw new TypeError(`step ${id} was never run`);
  return record[stream];
}

/**
 * The fenced block between the two HTML markers, as the bytes the CLI wrote to the stream. A fenced
 * block ends `…content\n\`\`\``, so the newline before the closing fence is content: returning
 * `content + "\n"` is the byte-faithful reconstruction.
 */
function documentedStream(id: string): string {
  const start = `<!-- demo:${id}:start -->`;
  const end = `<!-- demo:${id}:end -->`;
  const from = demo.indexOf(start);
  const to = demo.indexOf(end);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  const fenced = /^\n```text\n([\s\S]*?)\n```\n$/.exec(demo.slice(from + start.length, to));
  expect(fenced).not.toBeNull();
  return `${fenced![1]}\n`;
}

interface Manifest {
  readonly transcriptBytes: number;
  readonly transcriptLines: number;
  readonly sanitizedSha256: string;
  readonly companionTranscript: {
    readonly path: string;
    readonly bytes: number;
    readonly lines: number;
    readonly sanitizedSha256: string;
  };
  readonly expected: Record<string, unknown>;
  readonly expectedPreCompact: Record<string, unknown>;
}

const manifest = JSON.parse(readFileSync(join(fixtureDirectory, "fixture.manifest.json"), "utf8")) as Manifest;

function physicalLines(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? lines + 1 : lines;
}

/** The manifest's declared reading of one transcript, recomputed through the entry points the CLI uses. */
function readingOf(path: string): Record<string, unknown> {
  const bytes = new Uint8Array(readFileSync(path));
  const parse = parseClaudeTranscript(bytes);
  const { payload, degraded } = extractPayloadWithHealth(parse.events, claudeExtractConfig(parse));
  return {
    physicalLines: physicalLines(bytes),
    conversationRecords: parse.recordCount,
    recordsWithRecognizedBlocks: parse.conversationRecords,
    toolCalls: parse.toolCalls,
    toolResults: parse.toolResults,
    normalizedEvents: parse.events.length,
    parseDiagnostics: parse.diagnostics.length,
    degraded,
    pathBase: payload.path_base,
    sourceToolCalls: payload.counters.source_tool_calls,
    unmappedToolCalls: payload.counters.unmapped_tool_calls,
    coveragePpm: payload.counters.coverage_ppm,
    externalPathCount: payload.counters.external_path_count,
    facts: payload.counters.facts,
    factsByKind: payload.counters.by_kind,
  };
}

const publishedStreams = steps.filter((step) => unquotedStep[step.id] !== true).map((step) => step.id);

describe("continuity demo document", () => {
  it.each(publishedStreams)("quotes the %s stream byte-for-byte as the CLI renders it", (id) => {
    const step = stepById[id];
    // `snapshot` names the file it wrote, so the disposable store path is the one byte the document
    // replaces with a placeholder; every other byte is compared as rendered.
    expect(documentedStream(id)).toBe(outputOf(id, step.stream).split(resolve(store)).join("<store>"));
  });

  it.each(steps.map((step) => step.id))("records the %s byte count and hash it publishes", (id) => {
    const step = stepById[id];
    const text = outputOf(id, step.stream).split(resolve(store)).join("<store>");
    const bytes = new TextEncoder().encode(text).byteLength;
    const sha = createHash("sha256").update(text).digest("hex");
    expect(demo).toContain(`| ${step.label} | ${step.stream} | ${bytes} | \`${sha}\` |`);
  });

  it("states two equalities it does not quote, and both hold", () => {
    // Step 8: a resume re-injects the identical stdout. Step 10: restore renders that same payload
    // as Markdown. Both are prose in the document, so they are asserted rather than left implied.
    expect(demo).toContain("Step 8's stdout is byte-equal to step 6's");
    expect(outputOf("session-start-2-resume", "stdout")).toBe(outputOf("session-start-2", "stdout"));
    expect(outputOf("restore-default", "stdout")).toBe(
      (JSON.parse(outputOf("session-start-2", "stdout")) as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext,
    );
  });

  it("publishes the bytes, lines, and hashes of both committed transcripts", () => {
    const committed: ReadonlyArray<readonly [string, Buffer]> = [
      ["transcript.jsonl", readFileSync(join(fixtureDirectory, "transcript.jsonl"))],
      ["precompact.jsonl", readFileSync(join(fixtureDirectory, "precompact.jsonl"))],
    ];
    for (const [name, bytes] of committed) {
      const lines = physicalLines(new Uint8Array(bytes));
      const sha = createHash("sha256").update(bytes).digest("hex");
      expect(demo).toMatch(new RegExp(`\\| \`${name.replace(".", "\\.")}\` \\|[^\\n]*\\| ${bytes.byteLength} \\| ${lines} \\| \`${sha}\` \\|`));
    }
    // The manifest is the fixture's own record of the same two files, so the document cannot cite a
    // hash the committed fixture does not carry.
    const [transcript, precompact] = committed;
    expect(transcript[1].byteLength).toBe(manifest.transcriptBytes);
    expect(physicalLines(new Uint8Array(transcript[1]))).toBe(manifest.transcriptLines);
    expect(`sha256:${createHash("sha256").update(transcript[1]).digest("hex")}`).toBe(manifest.sanitizedSha256);
    expect(precompact[1].byteLength).toBe(manifest.companionTranscript.bytes);
    expect(physicalLines(new Uint8Array(precompact[1]))).toBe(manifest.companionTranscript.lines);
    expect(`sha256:${createHash("sha256").update(precompact[1]).digest("hex")}`).toBe(manifest.companionTranscript.sanitizedSha256);
  });

  it("keeps the pre-compaction transcript a byte prefix of the final one, which is what makes the chain cumulative", () => {
    // The document's reading of the loop rests on this: the newest checkpoint is cut from a file that
    // still contains epoch 1, so the restore is a superset of its own earlier checkpoint and the
    // `unbacked` marker never appears. If a fixture ever dropped the pre-boundary records, the demo's
    // "what the pack lost" section would be wrong and this fails first.
    expect(demo).toContain("`transcript.jsonl` begins with the exact bytes of `precompact.jsonl`");
    const transcript = readFileSync(join(fixtureDirectory, "transcript.jsonl"));
    const precompact = readFileSync(join(fixtureDirectory, "precompact.jsonl"));
    expect(transcript.subarray(0, precompact.byteLength).equals(precompact)).toBe(true);
  });

  it("agrees with the fixture manifest's declared counters for both transcripts", () => {
    expect(readingOf(join(fixtureDirectory, "transcript.jsonl"))).toEqual(manifest.expected);
    expect(readingOf(join(fixtureDirectory, "precompact.jsonl"))).toEqual(manifest.expectedPreCompact);
  });

  it("publishes the payload hash of each checkpoint, equal to what the CLI computed", () => {
    const first = JSON.parse(outputOf("snapshot-1", "stdout")) as { hash: string; created: boolean };
    const second = JSON.parse(outputOf("snapshot-2", "stdout")) as { hash: string; created: boolean };

    expect(first.created).toBe(true);
    // The second call names the checkpoint the PreCompact hook wrote: same bytes, same hash, no
    // second file — the idempotence the document claims.
    expect(second.created).toBe(false);
    expect(demo).toContain(`| Checkpoint 1, \`precompact.jsonl\` | \`${first.hash}\` |`);
    expect(demo).toContain(`| Checkpoint 2, \`transcript.jsonl\` | \`${second.hash}\` |`);

    // The pack marker is the first 12 hex digits of the payload hash, and the document prints both.
    const pack = (JSON.parse(outputOf("session-start-2", "stdout")) as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(pack).toContain(`[dcompact:${second.hash.slice(7, 19)}]`);
    expect(demo).toContain(`[dcompact:${second.hash.slice(7, 19)}]`);
    expect(demo).toContain(manifest.sanitizedSha256.replace(/^sha256:/, ""));
  });

  it("leaves exactly the store the document describes, chained and ledgered", () => {
    const checkpoints = join(store, "claude", sessionId, "checkpoints");
    const first = JSON.parse(outputOf("snapshot-1", "stdout")) as { hash: string };
    const second = JSON.parse(outputOf("snapshot-2", "stdout")) as { hash: string };
    const marker = `## dcompact context [dcompact:${second.hash.slice(7, 19)}]`;

    expect(readdirSync(checkpoints).sort()).toEqual([
      ".injection-epoch",
      ".last-injected",
      `${second.hash.slice(7)}.json`,
      `${first.hash.slice(7)}.json`,
    ]);
    // Two PreCompact events, two delivered epochs, and the marker of the pack delivered for the
    // second one: the ledger the document prints at the end of the walkthrough.
    expect(readFileSync(join(checkpoints, ".injection-epoch"), "utf8")).toBe("2 delivered\n");
    expect(readFileSync(join(checkpoints, ".last-injected"), "utf8")).toBe(`${marker}\n`);
    expect(demo).toContain("2 delivered");
    expect(demo).toContain(marker);

    // A stored checkpoint must chain to the previous one and hash to its own name, or the document's
    // claim that the two files form one verified chain is unbacked.
    const storedFirst = JSON.parse(readFileSync(join(checkpoints, `${first.hash.slice(7)}.json`), "utf8")) as {
      envelope: { previous_hash: string | null };
      payload: unknown;
    };
    const storedSecond = JSON.parse(readFileSync(join(checkpoints, `${second.hash.slice(7)}.json`), "utf8")) as {
      envelope: { previous_hash: string | null };
      payload: unknown;
    };
    expect(storedFirst.envelope.previous_hash).toBeNull();
    expect(storedSecond.envelope.previous_hash).toBe(first.hash);
    expect(payloadHash(storedFirst.payload as never)).toBe(first.hash);
    expect(payloadHash(storedSecond.payload as never)).toBe(second.hash);
  });

  it("names the commands a reader reproduces, and keeps real host paths out of the document", () => {
    expect(demo).toContain('node dist/cli.js snapshot --session "$SID" --transcript "$FIX/precompact.jsonl" --store "$STORE"');
    expect(demo).toContain('node dist/cli.js restore --session "$SID" --store "$STORE" --include-evidence');
    expect(demo).toContain('node dist/cli.js hook --event session-start --store "$STORE"');
    expect(demo).toContain("synthetic");
    expect(demo).toContain("<store>");
    expect(demo).not.toMatch(/\/Users\/[^<\s]/);
    expect(demo).not.toMatch(/\.claude\/projects\/(?!<)/);
  });

  it("refuses a budget below the floor with a next step, and exits 4", () => {
    const record = rendered.get("restore-too-small");
    if (record === undefined) throw new TypeError("restore-too-small was never run");
    expect(record.status).toBe(4);
    expect(record.stdout).toBe("");
    expect(record.stderr).toContain("Pass --max-bytes");
  });
});