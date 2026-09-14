import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

const event = argument("--event");
const arm = argument("--arm");
const stateRoot = resolve(argument("--state"));
const workloadRoot = resolve(argument("--workload"));
const dcompact = resolve(argument("--dcompact"));
const maxBytes = 16_384;

mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
chmodSync(stateRoot, 0o700);

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.stdout.write("{}\n");
  process.exit(0);
}

if (typeof input.transcript_path === "string") privateWrite("transcript-path.txt", `${input.transcript_path}\n`);

function privateWrite(name, bytes) {
  const path = resolve(stateRoot, name);
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function audit(kind, extra = {}) {
  const row = {
    kind,
    source: typeof input.source === "string" ? input.source : null,
    monotonicNs: process.hrtime.bigint().toString(),
    claudeParentPid: process.ppid,
    ...extra,
  };
  const path = resolve(stateRoot, "events.jsonl");
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function dcompactHook(kind) {
  const result = spawnSync(process.execPath, [dcompact, "hook", "--event", kind, "--store", resolve(stateRoot, "store")], {
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error) return "{}";
  return result.stdout.trim() || "{}";
}

function insideWorkload(value) {
  if (typeof value !== "string") return false;
  const path = resolve(value);
  return path === workloadRoot || path.startsWith(`${workloadRoot}${sep}`);
}

function preToolDecision() {
  const tool = input.tool_name;
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  let allowed = false;
  if (tool === "Read" || tool === "Edit" || tool === "Write") {
    allowed = insideWorkload(toolInput.file_path);
  } else if (tool === "Glob" || tool === "Grep") {
    allowed = toolInput.path === undefined || insideWorkload(toolInput.path);
  } else if (tool === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command.trim() : "";
    allowed = /^(?:npm test|node --test)(?:\s|$)/.test(command) && !/[;&|`$<>]/.test(command);
  }
  audit("PreToolUse", { tool, allowed });
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: allowed ? "allow" : "deny",
      permissionDecisionReason: allowed ? "OG-86 workload boundary" : "OG-86 denies access outside the workload and frozen test command",
    },
  };
}

try {
  if (event === "PreToolUse") {
    process.stdout.write(`${JSON.stringify(preToolDecision())}\n`);
  } else if (event === "PreCompact") {
    let transcript = Buffer.alloc(0);
    if (typeof input.transcript_path === "string") transcript = readFileSync(input.transcript_path);
    audit("PreCompact", {
      trigger: typeof input.trigger === "string" ? input.trigger : null,
      transcriptBytes: transcript.byteLength,
      transcriptLines: transcript.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0),
      transcriptSha256: digest(transcript),
    });
    process.stdout.write(`${arm === "C" ? dcompactHook("precompact") : "{}"}\n`);
  } else if (event === "PostCompact") {
    const summary = typeof input.compact_summary === "string" ? input.compact_summary : "";
    privateWrite("native-summary.txt", summary);
    audit("PostCompact", { summaryBytes: Buffer.byteLength(summary), summarySha256: digest(summary) });
    process.stdout.write("{}\n");
  } else if (event === "SessionStart") {
    audit("SessionStart");
    // PostCompact runs after SessionStart(source=compact) in Claude Code 2.1.270.
    // Both active treatments therefore use the next explicit resume.
    if (input.source !== "resume" || arm === "A") {
      audit("Treatment", { treatmentBytes: 0, treatmentSha256: null });
      process.stdout.write("{}\n");
    } else if (arm === "B") {
      const summary = readFileSync(resolve(stateRoot, "native-summary.txt"), "utf8");
      if (Buffer.byteLength(summary) > maxBytes) throw new Error("native summary exceeds frozen budget");
      audit("Treatment", { treatmentBytes: Buffer.byteLength(summary), treatmentSha256: digest(summary) });
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: summary } })}\n`);
    } else {
      const output = dcompactHook("session-start");
      const parsed = JSON.parse(output);
      const treatment = parsed?.hookSpecificOutput?.additionalContext ?? "";
      if (Buffer.byteLength(treatment) > maxBytes) throw new Error("dcompact pack exceeds frozen budget");
      privateWrite("dcompact-treatment.txt", treatment);
      audit("Treatment", { treatmentBytes: Buffer.byteLength(treatment), treatmentSha256: digest(treatment) });
      process.stdout.write(`${output}\n`);
    }
  } else {
    process.stdout.write("{}\n");
  }
} catch (error) {
  audit("HookError", { name: error instanceof Error ? error.name : "unknown" });
  process.stdout.write("{}\n");
}
