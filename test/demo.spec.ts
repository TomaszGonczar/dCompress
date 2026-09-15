import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { preview, run, type CliIo } from "../src/cli.js";
import { payloadHash } from "../src/core/hash.js";

/**
 * The demo document is published evidence: it quotes a pack, a report, and the hashes of both,
 * and a reader is invited to reproduce them. Nothing else in the suite renders that document, so
 * without this test a canonicalization or extractor change could leave stale bytes and stale
 * hashes in public documentation with a green build.
 *
 * The test renders the documented command's two streams through the same `preview` function the
 * CLI calls, then asserts the document quotes them byte-for-byte. It reads the fixture, so it
 * also fails if the fixture changes without the demo being regenerated.
 */
const repositoryRoot = process.cwd();
const demoPath = join(repositoryRoot, "docs", "demo", "claude-slice-0001.md");
const fixturePath = join("test", "fixtures", "claude", "slice-0001", "transcript.jsonl");
const demo = readFileSync(demoPath, "utf8");

const PACK_START = "<!-- demo-pack:start -->";
const PACK_END = "<!-- demo-pack:end -->";

/**
 * The fenced block between the two HTML markers, as the bytes the CLI writes to stdout.
 *
 * A fenced block ends `…content\n\`\`\``, so the newline before the closing fence is content, not
 * fence — the renderer terminates the pack with exactly one newline. Returning `content + "\n"`
 * is therefore the byte-faithful reconstruction, and it is why the assertion compares whole
 * strings rather than trimmed lines.
 */
function documentedPack(): string {
  const start = demo.indexOf(PACK_START);
  const end = demo.indexOf(PACK_END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = demo.slice(start + PACK_START.length, end);
  const fenced = /```text\n([\s\S]*?)\n```\n?$/.exec(body);
  expect(fenced).not.toBeNull();
  return `${fenced![1]}\n`;
}

/** The single ```text block under the stderr heading, which has no HTML markers. */
function documentedReport(): string {
  const heading = demo.indexOf("## Diagnostic report (stderr)");
  expect(heading).toBeGreaterThanOrEqual(0);
  const fenced = /```text\n([\s\S]*?)\n```/.exec(demo.slice(heading));
  expect(fenced).not.toBeNull();
  return `${fenced![1]}\n`;
}

const JSON_START = "<!-- demo-json:start -->";
const JSON_END = "<!-- demo-json:end -->";

/** The fenced ```json block between its two HTML markers, as `--json` writes it to stdout. */
function documentedJson(): string {
  const start = demo.indexOf(JSON_START);
  const end = demo.indexOf(JSON_END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = demo.slice(start + JSON_START.length, end);
  const fenced = /```json\n([\s\S]*?)\n```\n?$/.exec(body);
  expect(fenced).not.toBeNull();
  return `${fenced![1]}\n`;
}

function runCapture(argv: readonly string[]): { readonly stdout: string; readonly stderr: string } {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) };
  run(argv, io);
  return { stdout, stderr };
}

describe("demo document", () => {
  // The documented command passes this exact repository-relative path, and `preview` echoes it
  // into the report. Using the same string here is what makes the assertion byte-faithful.
  const result = preview({ transcript: fixturePath, pack: {} });
  const jsonRun = runCapture(["preview", "--transcript", fixturePath, "--json"]);

  it("quotes the pack byte-for-byte as the CLI renders it", () => {
    expect(documentedPack()).toBe(result.pack);
  });

  it("quotes the diagnostic report byte-for-byte as the CLI renders it", () => {
    expect(documentedReport()).toBe(result.report);
  });

  it("quotes the --json output byte-for-byte as the CLI renders it, with no separate stderr stream", () => {
    expect(jsonRun.stderr).toBe("");
    expect(documentedJson()).toBe(jsonRun.stdout);
  });

  it("documents the checksums it publishes, and each one matches the rendered bytes", () => {
    const encoder = new TextEncoder();
    const packSha = createHash("sha256").update(result.pack).digest("hex");
    const reportSha = createHash("sha256").update(result.report).digest("hex");
    const jsonSha = createHash("sha256").update(jsonRun.stdout).digest("hex");
    const fixtureSha = createHash("sha256").update(readFileSync(fixturePath)).digest("hex");
    const hash = payloadHash(result.payload);

    // Asserted per table row, not merely "appears somewhere": the payload hash also occurs inside
    // the quoted report, so a loose `toContain` would let a corrupted checksum table pass.
    expect(demo).toContain(`| Input SHA-256 | \`${fixtureSha}\` |`);
    expect(demo).toContain(`| stdout pack size | ${encoder.encode(result.pack).byteLength} bytes, ${result.pack.split("\n").length - 1} lines |`);
    expect(demo).toContain(`| stdout pack SHA-256 | \`${packSha}\` |`);
    expect(demo).toContain(`| stderr report SHA-256 | \`${reportSha}\` |`);
    expect(demo).toContain(`| stdout json size (\`--json\`) | ${encoder.encode(jsonRun.stdout).byteLength} bytes, ${jsonRun.stdout.split("\n").length - 1} lines |`);
    expect(demo).toContain(`| stdout json SHA-256 (\`--json\`) | \`${jsonSha}\` |`);
    expect(demo).toContain(`| Payload hash (in the stderr report and the \`--json\` output) | \`${hash}\` |`);
    expect(demo).toContain(`[dcompress:${hash.slice(7, 19)}]`);
  });

  it("publishes the fixture hash that the committed manifest records", () => {
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, "test", "fixtures", "claude", "slice-0001", "fixture.manifest.json"), "utf8"),
    ) as { sanitizedSha256: string };

    expect(demo).toContain(manifest.sanitizedSha256.replace(/^sha256:/, ""));
  });

  it("labels the demo input as synthetic and names the reproduction command", () => {
    expect(demo).toContain("node dist/cli.js preview --transcript test/fixtures/claude/slice-0001/transcript.jsonl");
    expect(demo).toContain("node dist/cli.js preview --transcript test/fixtures/claude/slice-0001/transcript.jsonl --json");
    expect(demo).toContain("synthetic");
    // A published demo must not leak a real host path or a resolved private transcript location.
    expect(demo).not.toMatch(/\/Users\/[^<\s]/);
    expect(demo).not.toMatch(/\.claude\/projects\/(?!<)/);
  });

  it("renders a byte-identical pack under perturbed timezone, locale, and HOME", () => {
    // The README tells a reader the demo reproduces under environment perturbation, so that claim
    // is asserted here rather than left to the general golden-vector suite, which does not render
    // the preview path. `preview` reads only the transcript, so any difference is a real defect.
    const keys = ["TZ", "LANG", "LC_ALL", "HOME"] as const;
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    const before = preview({ transcript: fixturePath, pack: {} });
    try {
      process.env.TZ = "Pacific/Kiritimati";
      process.env.LANG = "tr_TR.UTF-8";
      process.env.LC_ALL = "C";
      process.env.HOME = join(tmpdir(), "dcompress-demo-no-such-home");
      const after = preview({ transcript: fixturePath, pack: {} });

      expect(after.pack).toBe(before.pack);
      expect(after.coverage).toEqual(before.coverage);
      expect(payloadHash(after.payload)).toBe(payloadHash(before.payload));
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
