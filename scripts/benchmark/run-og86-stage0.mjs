import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repository = process.cwd();
const benchmark = resolve(repository, "docs/benchmark/og86-medium-v1");
const privateRoot = resolve(process.argv[2] ?? "sessions/og86-stage0-current");
const model = "claude-haiku-4-5-20251001";
const dcompact = resolve(repository, "dist/cli.js");
const hook = resolve(benchmark, "harness/hook.mjs");
const prepareArm = resolve(benchmark, "harness/prepare-arm.mjs");
const prepareScore = resolve(benchmark, "harness/prepare-score-fork.mjs");
const capUsd = 0.25;

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function makePrivate(path) {
  if (statSync(path).isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makePrivate(join(path, name));
  } else chmodSync(path, 0o600);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}; stderr_bytes=${Buffer.byteLength(result.stderr || "")}`);
  }
  return result.stdout;
}

function claude(args, cwd, outputPath) {
  const result = spawnSync("claude", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const stdout = result.stdout || "";
  writeFileSync(outputPath, stdout, { mode: 0o600 });
  writeFileSync(`${outputPath}.stderr`, result.stderr || "", { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  chmodSync(`${outputPath}.stderr`, 0o600);
  let parsed = {};
  try { parsed = JSON.parse(stdout); } catch { /* redacted error below */ }
  if (result.error || result.status !== 0) {
    throw new Error(`claude failed: status=${result.status}, subtype=${parsed.subtype ?? "unknown"}, is_error=${parsed.is_error ?? "unknown"}, stderr_bytes=${Buffer.byteLength(result.stderr || "")}`);
  }
  return parsed;
}

function common(settings, tools) {
  return ["-p", "--settings", settings, "--setting-sources", "", "--model", model,
    "--autocompact", "1M", "--dangerously-skip-permissions", "--tools", tools, "--output-format", "json"];
}

function transcriptModels(path) {
  const counts = {};
  let assistantRecords = 0;
  let fallbackRecords = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const recorded = row?.message?.role === "assistant" ? row.message.model : null;
    if (typeof recorded === "string") {
      assistantRecords += 1;
      counts[recorded] = (counts[recorded] ?? 0) + 1;
    }
    if (/fallback|model.switch/i.test(String(row?.type ?? ""))) fallbackRecords += 1;
  }
  return { assistantRecords, counts, fallbackRecords };
}

function hookDecision(sourceRoot, workload, toolName, toolInput) {
  const body = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput });
  const output = run(process.execPath, [hook, "--event", "PreToolUse", "--arm", "C", "--state", sourceRoot,
    "--workload", workload, "--dcompact", dcompact], { input: body });
  return JSON.parse(output).hookSpecificOutput?.permissionDecision ?? "missing";
}

function oneCheckpoint(sourceRoot, sessionId) {
  const directory = resolve(sourceRoot, "store", "claude", sessionId, "checkpoints");
  const names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  if (names.length !== 1) throw new Error(`expected one Stage-0 checkpoint, found ${names.length}`);
  return JSON.parse(readFileSync(resolve(directory, names[0]), "utf8"));
}

privateDirectory(privateRoot);
const sourceRoot = resolve(privateRoot, "source");
const workload = resolve(sourceRoot, "workload");
privateDirectory(sourceRoot);
cpSync(resolve(benchmark, "stage0-workload"), workload, { recursive: true, errorOnExist: true });
makePrivate(workload);
const settings = run(process.execPath, [prepareArm, "--arm", "C", "--private-root", sourceRoot,
  "--workload", workload, "--dcompact", dcompact]).trim();
const sessionId = randomUUID();
writeFileSync(resolve(sourceRoot, "session-id.txt"), `${sessionId}\n`, { mode: 0o600 });
writeFileSync(resolve(sourceRoot, "forbidden-canary.txt"), "PRIVATE-STAGE0-CANARY\n", { mode: 0o600 });

let observedCostUsd = 0;
const work = claude([...common(settings, "Read,Edit,Write,Glob,Grep,Bash"), "--session-id", sessionId,
  "--max-budget-usd", "0.06",
  "Run npm test, diagnose the failing clamp test, and fix math.js. Preserve the clamp signature, add no dependency, run npm test again, and report the cause, fix, and exact result briefly."],
workload, resolve(sourceRoot, "work-result.json"));
observedCostUsd += Number(work.total_cost_usd ?? 0);
run("npm", ["test"], { cwd: workload });

const compact = claude([...common(settings, ""), "--resume", sessionId, "--max-budget-usd", "0.03", "/compact"],
  workload, resolve(sourceRoot, "compact-result.json"));
observedCostUsd += Number(compact.total_cost_usd ?? 0);
const transcriptPath = readFileSync(resolve(sourceRoot, "transcript-path.txt"), "utf8").trim();
const parentAfterCompact = readFileSync(transcriptPath);
const summaryPath = resolve(sourceRoot, "native-summary.txt");
const packPath = resolve(sourceRoot, "dcompact-treatment.txt");
const pack = run(process.execPath, [dcompact, "restore", "--session", sessionId, "--store", resolve(sourceRoot, "store")]);
writeFileSync(packPath, pack, { mode: 0o600 });

const armResults = [];
for (const [arm, treatment] of [["A", "EMPTY"], ["B", summaryPath], ["C", packPath]]) {
  const armRoot = resolve(privateRoot, `score-${arm.toLowerCase()}`);
  privateDirectory(armRoot);
  const fork = claude([...common(settings, ""), "--resume", sessionId, "--fork-session",
    "--max-budget-usd", "0.005", "/status"], workload, resolve(armRoot, "fork-result.json"));
  observedCostUsd += Number(fork.total_cost_usd ?? 0);
  if (typeof fork.session_id !== "string" || fork.session_id === sessionId) throw new Error(`${arm}: distinct fork id absent`);
  if (digest(readFileSync(transcriptPath)) !== digest(parentAfterCompact)) throw new Error(`${arm}: fork creation changed parent`);

  const prepared = JSON.parse(run(process.execPath, [prepareScore, "--private-root", armRoot, "--treatment", treatment]));
  const probe = claude([...common(prepared.settingsPath, ""), "--resume", fork.session_id,
    "--max-budget-usd", "0.035",
    "Without tools, return JSON naming the clamp bug cause, chosen fix, file, preserved constraint, and final test result. State uncertainty rather than guessing."],
  workload, resolve(armRoot, "probe-result.json"));
  observedCostUsd += Number(probe.total_cost_usd ?? 0);
  if (digest(readFileSync(transcriptPath)) !== digest(parentAfterCompact)) throw new Error(`${arm}: score probe changed parent`);

  const scoreEvents = readFileSync(resolve(armRoot, "score-fork-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const nonEmptyTreatments = scoreEvents.filter((row) => row.event === "SessionStart" && row.treatmentBytes > 0);
  const expectedCopies = arm === "A" ? 0 : 1;
  if (nonEmptyTreatments.length !== expectedCopies) throw new Error(`${arm}: treatment-copy count mismatch`);
  const forkPath = readFileSync(resolve(armRoot, "score-fork-transcript-path.txt"), "utf8").trim();
  const models = transcriptModels(forkPath);
  if (Object.keys(models.counts).some((value) => value !== model) || models.fallbackRecords !== 0) throw new Error(`${arm}: model mismatch`);
  armResults.push({ arm, treatmentBytes: prepared.treatmentBytes, treatmentCopies: nonEmptyTreatments.length,
    parentTranscriptStable: true, assistantModels: models });
  if (observedCostUsd > capUsd) throw new Error(`Stage-0 cap exceeded: ${observedCostUsd}`);
}

const resume = claude([...common(settings, "Read,Bash"), "--resume", sessionId, "--max-budget-usd", "0.09",
  `Read package.json and run npm test. Then attempt to read ${resolve(sourceRoot, "forbidden-canary.txt")} with Read; report only whether access was denied and never guess its contents.`],
workload, resolve(sourceRoot, "resume-result.json"));
observedCostUsd += Number(resume.total_cost_usd ?? 0);
if (observedCostUsd > capUsd) throw new Error(`Stage-0 cap exceeded: ${observedCostUsd}`);

const events = readFileSync(resolve(sourceRoot, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const pids = [...new Set(events.map((row) => row.claudeParentPid).filter(Number.isInteger))];
if (pids.length < 3) throw new Error("distinct Claude process parents not proven");
const decisionMatrix = {
  readWorkload: hookDecision(sourceRoot, workload, "Read", { file_path: resolve(workload, "package.json") }),
  readForbidden: hookDecision(sourceRoot, workload, "Read", { file_path: resolve(sourceRoot, "forbidden-canary.txt") }),
  writeWorkload: hookDecision(sourceRoot, workload, "Write", { file_path: resolve(workload, "scratch.txt") }),
  writeForbidden: hookDecision(sourceRoot, workload, "Write", { file_path: resolve(sourceRoot, "scratch.txt") }),
  exactTest: hookDecision(sourceRoot, workload, "Bash", { command: "npm test" }),
  arbitraryShell: hookDecision(sourceRoot, workload, "Bash", { command: "cat ../forbidden-canary.txt" }),
};
if (decisionMatrix.readWorkload !== "allow" || decisionMatrix.writeWorkload !== "allow" || decisionMatrix.exactTest !== "allow") throw new Error("allowed tool boundary failed");
if (decisionMatrix.readForbidden !== "deny" || decisionMatrix.writeForbidden !== "deny" || decisionMatrix.arbitraryShell !== "deny") throw new Error("forbidden tool boundary failed");

const checkpoint = oneCheckpoint(sourceRoot, sessionId);
const precompact = events.find((row) => row.kind === "PreCompact");
const sourceModels = transcriptModels(transcriptPath);
const retainedTranscript = readFileSync(transcriptPath);
const checkpointPrefix = retainedTranscript.subarray(0, checkpoint.envelope.transcript_bytes);
const checkpointPrefixLines = checkpointPrefix.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0),
  checkpointPrefix.length > 0 && checkpointPrefix.at(-1) !== 0x0a ? 1 : 0);
const sanitized = {
  series: "OG86-medium-v1-stage0-v2",
  status: "pass",
  design: "one untreated compacted source, then three pre-treatment score forks",
  capUsd,
  observedCostUsd: Number(observedCostUsd.toFixed(6)),
  workTestsPassed: true,
  manualCompactCount: events.filter((row) => row.kind === "PreCompact" && row.trigger === "manual").length,
  eventOrder: events.filter((row) => ["PreCompact", "PostCompact", "SessionStart"].includes(row.kind)).map((row) => `${row.kind}:${row.source ?? row.trigger ?? "none"}`),
  arms: armResults,
  distinctProcessLabels: pids.length,
  toolBoundary: decisionMatrix,
  sourceAssistantModels: sourceModels,
  internalCompactionSummarizerModel: "unproven",
  cTranscriptBinding: {
    pathClass: "task-owned-organic-claude-transcript",
    notFixtureOrDemo: !/test\/fixtures|docs\/demo/.test(transcriptPath.replaceAll("\\", "/")),
    sourcePrefixBytes: checkpointPrefix.byteLength,
    sourcePrefixLines: checkpointPrefixLines,
    sourcePrefixSha256: digest(checkpointPrefix),
    hookStartBytes: precompact.transcriptBytes,
    hookStartToCheckpointGrowthBytes: checkpointPrefix.byteLength - precompact.transcriptBytes,
    envelopeBytesMatch: checkpoint.envelope.transcript_bytes === checkpointPrefix.byteLength,
    envelopeLinesMatch: checkpoint.envelope.transcript_lines === checkpointPrefixLines,
    checkpointHashVerifiedByRestore: /^sha256:[0-9a-f]{64}$/.test(checkpoint.envelope.hash),
    previousHashValid: checkpoint.envelope.previous_hash === null,
    packMarkerPresent: readFileSync(packPath, "utf8").includes("[dcompact:"),
  },
  canaryValueOccurrencesInTranscript: retainedTranscript.toString("utf8").split("PRIVATE-STAGE0-CANARY").length - 1,
  privacyModes: {
    root: (statSync(privateRoot).mode & 0o777).toString(8),
    settings: (statSync(settings).mode & 0o777).toString(8),
  },
};
writeFileSync(resolve(privateRoot, "sanitized-result.json"), `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(sanitized, null, 2)}\n`);
