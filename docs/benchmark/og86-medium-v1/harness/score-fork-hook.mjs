import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

const event = argument("--event");
const state = resolve(argument("--state"));
const treatmentPath = argument("--treatment");
const expected = argument("--sha256");
const input = JSON.parse(readFileSync(0, "utf8"));

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function audit(row) {
  const path = resolve(state, "score-fork-events.jsonl");
  appendFileSync(path, `${JSON.stringify({ ...row, claudeParentPid: process.ppid })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

if (typeof input.transcript_path === "string") {
  const path = resolve(state, "score-fork-transcript-path.txt");
  writeFileSync(path, `${input.transcript_path}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

if (event === "PreToolUse") {
  audit({ event, tool: input.tool_name, allowed: false });
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "OG-86 recall probes have zero tools",
  } })}\n`);
} else if (event === "SessionStart" && input.source === "resume") {
  const marker = resolve(state, "score-fork-injected");
  let alreadyInjected = false;
  try {
    alreadyInjected = readFileSync(marker, "utf8").trim() === expected;
  } catch {
    // A missing marker is the only state that permits the frozen treatment.
  }
  if (alreadyInjected) {
    audit({ event, source: input.source, treatmentBytes: 0, duplicateSuppressed: true });
    process.stdout.write("{}\n");
  } else {
    const treatment = treatmentPath === "EMPTY" ? Buffer.alloc(0) : readFileSync(resolve(treatmentPath));
    if (digest(treatment) !== expected) throw new Error("frozen treatment digest mismatch");
    if (treatment.byteLength > 16_384) throw new Error("frozen treatment exceeds 16 KiB");
    writeFileSync(marker, `${expected}\n`, { mode: 0o600 });
    chmodSync(marker, 0o600);
    const treatmentText = treatment.toString("utf8");
    const output = treatment.byteLength === 0 ? {} : {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: treatmentText },
    };
    // The channel is derived from the object actually emitted, not declared:
    // the audit row names the event and the output field that carried the
    // treatment, so a change to the emitted shape is visible in the record.
    const specific = output.hookSpecificOutput;
    const outputFields = specific === undefined ? [] : Object.keys(specific);
    // Derived, not declared: the field that actually carries the treatment is
    // the first whose value is the treatment text, whatever it is named.
    const carrier = specific === undefined
      ? undefined
      : Object.entries(specific).find(([name, value]) => name !== "hookEventName" && value === treatmentText);
    const treatmentField = carrier === undefined ? null : carrier[0];
    audit({
      event,
      source: input.source,
      treatmentBytes: treatment.byteLength,
      treatmentSha256: expected,
      duplicateSuppressed: false,
      hookEventName: specific?.hookEventName ?? null,
      outputFields,
      treatmentField,
      // The full output as emitted, so the recorded channel is checkable against
      // the bytes that reached the host.
      outputSha256: digest(Buffer.from(JSON.stringify(output), "utf8")),
    });
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
} else {
  process.stdout.write("{}\n");
}
