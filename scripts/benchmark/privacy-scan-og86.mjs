import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "docs/benchmark/og86-medium-v1");
const patterns = [
  ["macOS home path", /\/Users\/[A-Za-z0-9._-]+\//g],
  ["Linux home path", /\/home\/[A-Za-z0-9._-]+\//g],
  ["Windows user path", /[A-Za-z]:\\Users\\[^\\\s]+\\/g],
  ["session UUID", /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi],
  ["API token prefix", /\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g],
  ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
];

function files(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).sort().flatMap((name) => files(join(path, name)));
}

const findings = [];
for (const path of files(root)) {
  const text = readFileSync(path, "utf8");
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push({ file: relative(root, path), label });
  }
}

if (findings.length > 0) {
  process.stderr.write(`${JSON.stringify({ ok: false, findings }, null, 2)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, files: files(root).length })}\n`);
}
