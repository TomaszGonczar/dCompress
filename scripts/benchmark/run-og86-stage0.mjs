import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { restoreVerifiedBinding, digest, retainedPrefix } from "./og86-binding.mjs";
import { assistantIdentities, identityAttribution, ledgerCursor, rowsAfter, transcriptDelta, spawnPrivateChild } from "./run-og86-medium.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeMatrix, requiredLocationClasses } from "../../docs/benchmark/og86-medium-v1/harness/hook.mjs";
import { matrixExpectations, matrixMismatches } from "./run-og86-medium.mjs";

const repository = process.cwd();
const benchmark = resolve(repository, "docs/benchmark/og86-medium-v1");
const privateRoot = resolve(process.argv[2] ?? "sessions/og86-stage0-current");
const model = "claude-haiku-4-5-20251001";
const dcompact = resolve(repository, "dist/cli.js");
const hook = resolve(benchmark, "harness/hook.mjs");
const prepareArm = resolve(benchmark, "harness/prepare-arm.mjs");
const prepareScore = resolve(benchmark, "harness/prepare-score-fork.mjs");
const capUsd = 0.25;

/**
 * Stage 0 derives its verdict from gates. `assert(gate, label)` accumulates the
 * failing labels; the manifest is written only when the list is empty, so a
 * false gate can never be reported as `status: pass`.
 */
const failedGates = [];

export function assert(gate, label) {
  if (gate !== true) failedGates.push(label);
  return gate === true;
}

/**
 * Abort immediately when any gate failed.
 *
 * `assert` accumulates so a run can report every failure at once, but that is
 * only correct for gates evaluated *after* the work. A structural preflight
 * evaluated before the first model call must stop the run there: recording a
 * failure and continuing would spend real money against a series whose structure
 * was already known-invalid.
 */
export function requireNoFailedGates(phase) {
  if (failedGates.length > 0) {
    throw new Error(`Stage-0 refused to continue: ${failedGates.length} gate(s) failed before ${phase}: ${failedGates.join(",")}`);
  }
}

/** Reset the accumulator. Tests and repeated in-process runs need a clean slate. */
export function resetFailedGates() {
  failedGates.length = 0;
}

/**
 * Refuse to write into a symlinked or already-populated private root.
 *
 * `mkdirSync({recursive:true})` follows a symlink and would apply modes to the
 * link target, so the check must happen before any write. Mirrors the medium
 * controller's guard so both runners share one refusal rule.
 */
export function assertStage0PrivateRootWritable(privateRoot) {
  let stats = null;
  try {
    stats = lstatSync(privateRoot);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) throw new Error(`refusing to write into a symlinked private root: ${privateRoot}`);
  if (stats.isDirectory() && readdirSync(privateRoot).length > 0) {
    throw new Error(`refusing to write into a non-empty private root: ${privateRoot}`);
  }
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

/**
 * Directory and file modes for the private tree.
 *
 * A symlink is neither a directory nor a file here: `lstatSync` does not follow
 * it, so the walk previously returned early and the link went uncounted. A
 * symlink in a private run tree is a privacy hazard in its own right — it can
 * point outside the tree at material the modes then fail to protect — so links
 * are counted and gated to zero rather than silently skipped.
 */
export function privacyModes(root) {
  const modes = { directories: new Set(), files: new Set() };
  const symlinks = [];
  const walk = (path, relative) => {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      symlinks.push(relative);
      return;
    }
    if (stats.isDirectory()) {
      modes.directories.add((stats.mode & 0o777).toString(8));
      for (const name of readdirSync(path)) walk(join(path, name), relative === "" ? name : `${relative}/${name}`);
    } else {
      modes.files.add((stats.mode & 0o777).toString(8));
    }
  };
  walk(root, "");
  return {
    directories: [...modes.directories].sort(),
    files: [...modes.files].sort(),
    symlinkCount: symlinks.length,
    symlinks: symlinks.sort(),
    zeroSymlinks: symlinks.length === 0,
    allDirectoriesOwnerOnly: [...modes.directories].every((mode) => mode === "700"),
    allFilesOwnerOnly: [...modes.files].every((mode) => mode === "600"),
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}; stderr_bytes=${Buffer.byteLength(result.stderr || "")}`);
  }
  return result.stdout;
}

export function claudeCall(args, cwd, outputPath) {
  const started = process.hrtime.bigint();
  // The child inherits the umask, and the agent's tools name no mode, so the
  // umask is what decides whether a file it creates lands 0600 or 0644. Running
  // the child under a restrictive umask for its whole lifetime is what keeps the
  // end-of-run `owner-only-modes` assertion true; the parent's umask is restored
  // in `finally`, so a throw cannot leak the restriction.
  const result = spawnPrivateChild("claude", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const wallSeconds = Number(process.hrtime.bigint() - started) / 1e9;
  const stdout = result.stdout || "";
  writeFileSync(outputPath, stdout, { mode: 0o600 });
  writeFileSync(`${outputPath}.stderr`, result.stderr || "", { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  chmodSync(`${outputPath}.stderr`, 0o600);
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    // The thrown errors below report the shape rather than the payload.
    parseError = error instanceof Error ? error.message : String(error);
  }
  // The JSON envelope, when present, is the authoritative outcome -- including
  // for a call that exhausted its budget or otherwise reported failure through
  // `is_error`. The CLI's exit code duplicates that same signal and must never
  // be checked ahead of a parseable envelope, or a real, diagnosable result
  // (e.g. `error_max_budget_usd`) reads as an opaque process crash instead of
  // the named failure it actually is. Exit code is the fallback of last
  // resort, only for a call that produced no usable envelope at all.
  if (parseError === null && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    // A zero exit status is not success either: the envelope's own `is_error`
    // is what decides, in both directions.
    if (parsed.is_error !== false) {
      throw new Error(`claude reported is_error=${parsed.is_error ?? "missing"}: subtype=${parsed.subtype ?? "unknown"}, api_error_status=${parsed.api_error_status ?? "none"}, errors=${JSON.stringify(parsed.errors ?? null)}`);
    }
    if (typeof parsed.total_cost_usd !== "number" || !Number.isFinite(parsed.total_cost_usd) || parsed.total_cost_usd < 0) {
      throw new Error(`claude reported an invalid total_cost_usd: ${JSON.stringify(parsed.total_cost_usd ?? null)}`);
    }
    parsed.wallSeconds = wallSeconds;
    return parsed;
  }
  if (result.error || result.status !== 0) {
    throw new Error(`claude failed: status=${result.status}, stderr_bytes=${Buffer.byteLength(result.stderr || "")}`);
  }
  if (parseError !== null) throw new Error(`claude returned an unparseable envelope: ${parseError}`);
  throw new Error(`claude envelope is not an object: ${Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed}`);
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
  const matchingModelRecords = counts[model] ?? 0;
  return { assistantRecords, counts, fallbackRecords, matchingModelRecords };
}

function oneCheckpoint(sourceRoot, sessionId) {
  const directory = resolve(sourceRoot, "store", "claude", sessionId, "checkpoints");
  const names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  if (names.length !== 1) throw new Error(`expected one Stage-0 checkpoint, found ${names.length}`);
  return JSON.parse(readFileSync(resolve(directory, names[0]), "utf8"));
}

/**
 * Observed tool boundary. The real hook decides; this runner only records what
 * it decided — and records the *class* it decided under, not just the verdict.
 *
 * Two things the earlier version got wrong, both fixed here:
 *
 *  1. It never read the hook's audit `location`, so a probe denied for the wrong
 *     reason looked identical to a correct denial. The class is now compared
 *     against the preregistered label for every location-class row.
 *  2. Its declared `transcript`/`profile` roots did not match the hook's own
 *     geometry. The hook deletes the declared pair and re-derives both from the
 *     host-reported transcript path (`<profile>/projects/<slug>/<id>.jsonl`), so
 *     the declared roots were unreachable and those rows were denied as
 *     `outside`. The roots are now derived exactly as the hook derives them.
 */
export function observedToolMatrix({ sourceRoot, workload, transcriptPath }) {
  // Mirror the hook's own derivation so the declared roots are the ones the hook
  // will actually classify against.
  const segments = resolve(transcriptPath).split(sep);
  const marker = segments.lastIndexOf("projects");
  const profile = marker > 0 ? segments.slice(0, marker).join(sep) : dirname(resolve(transcriptPath));
  const forbidden = {
    transcript: { path: resolve(transcriptPath), kind: "file" },
    profile: { path: profile, kind: "directory" },
    store: { path: resolve(sourceRoot, "store"), kind: "directory" },
    rubric: { path: resolve(benchmark, "rubric.json"), kind: "file" },
    scorer: { path: resolve(repository, "scripts/benchmark/score-og86.mjs"), kind: "file" },
    capture: { path: resolve(sourceRoot, "sessions"), kind: "directory" },
  };
  const missing = requiredLocationClasses().filter((label) => forbidden[label] === undefined);
  if (missing.length > 0) throw new Error(`no forbidden root declared for: ${missing.join(",")}`);
  const probes = probeMatrix({ workloadRoot: workload, forbidden });
  const flags = Object.entries(forbidden).map(([label, entry]) => `--forbid${label}=${entry.path}`);
  const expectations = new Map(matrixExpectations().map((plan) => [plan.name, plan]));

  const rows = [];
  for (const probe of probes) {
    // The hook appends its own audit row, so the cursor bounds the read to what
    // this invocation wrote rather than to every row ever recorded.
    const cursor = ledgerCursor(readLedgerRows(sourceRoot));
    const body = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: probe.tool, tool_input: probe.input });
    const output = run(process.execPath, [hook, "--event", "PreToolUse", "--arm", "C", "--state", sourceRoot,
      "--workload", workload, "--dcompact", dcompact, ...flags], { input: body });
    const parsed = JSON.parse(output).hookSpecificOutput;
    const decision = parsed?.permissionDecision ?? "missing";
    const auditRow = rowsAfter(readLedgerRows(sourceRoot), cursor).find((row) => row.kind === "PreToolUse") ?? {};
    const expected = expectations.get(probe.name) ?? {};
    rows.push({
      name: probe.name,
      capability: probe.capability,
      location: probe.location,
      expected: probe.expected,
      decision,
      allowed: decision === "allow",
      // The hook's own recorded class, and the reason it recorded.
      observedClass: auditRow.location ?? "unreported",
      reason: auditRow.reason ?? parsed?.permissionDecisionReason ?? "unreported",
      // Carried so the shared comparison can require a class where one applies.
      classChecked: expected.classChecked === true,
      revocationCheck: expected.expected ?? probe.expected,
    });
  }
  return rows;
}

/** Every hook audit row recorded so far, oldest first. */
export function readLedgerRows(stateRoot) {
  const path = resolve(stateRoot, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

/**
 * Executable entry point only when run directly. Importing this module must be
 * inert: the body performs model calls and writes a private run directory, so an
 * unguarded top level would run Stage 0 as a side effect of an import.
 */
function isDirectExecution() {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  const entry = pathToFileURL(invoked).href;
  if (entry === import.meta.url) return true;
  try {
    return pathToFileURL(resolve(invoked)).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
  } catch {
    return false;
  }
}

/**
 * Dependency ancestry.
 *
 * The plan declares "dependency ancestry" and the runner previously asserted
 * nothing. The base commit and the explicit OG-84/OG-85 merge commits come from
 * the plan's machine-readable fields, and each must exist locally and be an
 * ancestor of HEAD.
 */
export function ancestryPreflight({ repository, plan }) {
  const base = plan?.dependencyBaseCommit;
  const dependencies = Array.isArray(plan?.dependencyCommits) ? plan.dependencyCommits : [];
  const failures = [];
  const runGit = (args) => spawnSync("git", args, { cwd: repository, encoding: "utf8" });

  const check = (label, commit) => {
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
      failures.push(`${label}:not-40-hex`);
      return;
    }
    if (runGit(["cat-file", "-e", `${commit}^{commit}`]).status !== 0) {
      failures.push(`${label}:missing`);
      return;
    }
    // `merge-base --is-ancestor` exits 0 when the first commit is an ancestor.
    if (runGit(["merge-base", "--is-ancestor", commit, "HEAD"]).status !== 0) {
      failures.push(`${label}:not-an-ancestor`);
    }
  };
  check("dependencyBaseCommit", base);
  for (const commit of dependencies) check("dependencyCommit", commit);
  if (dependencies.length === 0) failures.push("dependencyCommits:empty");
  return {
    dependencyBaseCommit: base ?? null,
    dependencyCommits: dependencies,
    failures,
    ok: failures.length === 0,
  };
}

/**
 * A deterministic scorer mutation preflight.
 *
 * Narrowly selected rather than exhaustive: one omission must lose exactly one
 * point, and a canonical response must score full marks. This is the property
 * the plan declares, checked locally before any model call.
 */
export function scorerPreflight({ scorerPath, atomsPath, scratchRoot, checkpoint = 4 }) {
  // The caller supplies the scratch directory. A module-global default would
  // create a real session path during an offline test or an import, which is a
  // side effect no pure preflight may have.
  if (typeof scratchRoot !== "string" || scratchRoot.length === 0) {
    throw new Error("scorerPreflight requires an explicit scratchRoot");
  }
  const atoms = JSON.parse(readFileSync(atomsPath, "utf8"));
  const response = {};
  for (const atom of atoms) {
    const [first, second] = atom.responseField.split(".");
    if (second) {
      response[first] = response[first] ?? {};
      (response[first][second] = response[first][second] ?? []).push(atom.canonical);
    } else {
      (response[first] = response[first] ?? []).push(atom.canonical);
    }
  }
  const scoreOf = (candidate) => {
    const result = spawnSync(process.execPath, [scorerPath, "--atoms", atomsPath, "--response", candidate, "--checkpoint", String(checkpoint)],
      { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`scorer preflight failed: ${(result.stderr || "").trim().slice(0, 120)}`);
    return JSON.parse(result.stdout);
  };
  const scratch = scratchRoot;
  privateDirectory(scratch);
  const write = (name, value) => {
    const path = resolve(scratch, name);
    writeFileSync(path, `${JSON.stringify(value)}
`, { mode: 0o600 });
    return path;
  };
  const canonical = scoreOf(write("canonical.json", response));
  const omitted = { ...response };
  const eligible = atoms.filter((atom) => atom.availableAfterCheckpoint <= checkpoint);
  const victim = eligible[eligible.length - 1];
  const field = victim.responseField.split(".");
  if (field.length === 2) {
    omitted[field[0]] = { ...omitted[field[0]], [field[1]]: omitted[field[0]][field[1]].filter((text) => text !== victim.canonical) };
  } else {
    omitted[field[0]] = omitted[field[0]].filter((text) => text !== victim.canonical);
  }
  const mutated = scoreOf(write("omitted.json", omitted));
  const failures = [];
  if (canonical.points !== canonical.denominator) failures.push("canonical-not-full-marks");
  if (mutated.points !== canonical.points - 1) failures.push("omission-did-not-cost-exactly-one");
  if (mutated.missing !== canonical.missing + 1) failures.push("omission-did-not-mark-one-missing");
  return {
    checkpoint,
    omittedAtom: victim.id,
    canonical: { points: canonical.points, denominator: canonical.denominator },
    mutated: { points: mutated.points, missing: mutated.missing },
    failures,
    ok: failures.length === 0,
  };
}

/**
 * The public privacy scanner, run as a preflight over the benchmark tree.
 * No host path or identifier is recorded — only the outcome and a file count.
 */
export function privacyPreflight({ benchmarkRoot }) {
  const result = spawnSync(process.execPath, [resolve(repository, "scripts/benchmark/privacy-scan-og86.mjs"), benchmarkRoot],
    { encoding: "utf8" });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  return {
    ok: result.status === 0 && parsed?.ok === true,
    scannedFiles: typeof parsed?.files === "number" ? parsed.files : null,
    failureCount: Array.isArray(parsed?.findings) ? parsed.findings.length : null,
  };
}

/**
 * The channel the treatment actually arrived on, read from the hook's own audit
 * rows.
 *
 * This is the only place the channel is decided. A constant here would compare a
 * literal to a literal and could never fail, so the value comes from the record
 * the hook wrote about the object it actually emitted.
 */
export function treatmentChannelEvidence(scoreEvents) {
  const injection = [...scoreEvents].reverse().find((row) => row.event === "SessionStart"
    && (row.treatmentBytes ?? 0) > 0) ?? null;
  return {
    treatmentEvent: injection?.source === "resume" ? "SessionStart" : null,
    treatmentChannel: injection?.treatmentField ?? null,
    treatmentHookEventName: injection?.hookEventName ?? null,
    treatmentOutputFields: Array.isArray(injection?.outputFields) ? injection.outputFields : [],
  };
}

/**
 * The two treatment channels.
 *
 * B re-surfaces the host's own summary and C injects the dcompact pack, but both
 * must arrive through the same `hookSpecificOutput.additionalContext` field on
 * the same event. The comparison is recorded per arm so a channel change cannot
 * pass silently.
 */
export function channelPreflight({ arms }) {
  const observed = arms.map((arm) => ({
    arm: arm.arm,
    event: arm.treatmentEvent ?? null,
    channel: arm.treatmentChannel ?? null,
    // The full field list the hook actually wrote, so a change to the emitted
    // shape is caught even if the treatment field itself kept its name.
    outputFields: Array.isArray(arm.treatmentOutputFields) ? arm.treatmentOutputFields : [],
    delivered: (arm.treatmentCopies ?? 0) > 0,
  }));
  const active = observed.filter((entry) => entry.arm !== "A");
  const control = observed.filter((entry) => entry.arm === "A");
  const channels = new Set(active.filter((entry) => entry.delivered).map((entry) => `${entry.event}|${entry.channel}`));
  const failures = [];
  if (channels.size !== 1) failures.push("active-arms-do-not-share-one-channel");
  // A null channel means the hook never recorded which field carried the
  // treatment, so the comparison would be vacuous.
  if (active.some((entry) => entry.delivered && typeof entry.channel !== "string")) {
    failures.push("treatment-channel-unobserved");
  }
  if (active.some((entry) => entry.delivered && !entry.outputFields.includes("additionalContext"))) {
    failures.push("treatment-field-absent-from-output");
  }
  if (active.some((entry) => !entry.delivered)) failures.push("active-arm-missing-treatment");
  if (control.some((entry) => entry.delivered)) failures.push("control-arm-received-treatment");
  return { observed, sharedChannel: channels.size === 1 ? [...channels][0] : null, failures, ok: failures.length === 0 };
}

function main() {
  // Refuse a symlinked or populated root before the first write.
  assertStage0PrivateRootWritable(privateRoot);

  // Structural preflights run first, and any failure aborts before the first
  // model call. The two that write nothing run before the private root is even
  // created, so a plan or privacy failure costs zero writes as well as zero
  // calls; the scorer preflight needs a scratch directory, so it runs after.
  const plan = JSON.parse(readFileSync(resolve(benchmark, "stage0-plan.json"), "utf8"));
  const ancestry = ancestryPreflight({ repository, plan });
  for (const failure of ancestry.failures) assert(false, `ancestry:${failure}`);
  const privacyCheck = privacyPreflight({ benchmarkRoot: benchmark });
  assert(privacyCheck.ok, "privacy-preflight");
  requireNoFailedGates("the first write");

  privateDirectory(privateRoot);
  const scorerCheck = scorerPreflight({
    scorerPath: resolve(repository, "scripts/benchmark/score-og86.mjs"),
    atomsPath: resolve(benchmark, "atoms.json"),
    scratchRoot: resolve(privateRoot, "preflight"),
  });
  for (const failure of scorerCheck.failures) assert(false, `scorer-preflight:${failure}`);

  // Every structural preflight is evaluated; now refuse to continue if any of
  // them failed. This is the point that makes them gates rather than notes.
  requireNoFailedGates("any model call");

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
  const processLabels = [];
  let workTestsPassed = false;
  const startedAtNs = process.hrtime.bigint();

  const work = claudeCall([...common(settings, "Read,Edit,Write,Glob,Grep,Bash"), "--session-id", sessionId,
    "--max-budget-usd", "0.06",
    "Run npm test, diagnose the failing clamp test, and fix math.js. Preserve the clamp signature, add no dependency, run npm test again, and report the cause, fix, and exact result briefly."],
  workload, resolve(sourceRoot, "work-result.json"));
  observedCostUsd += Number(work.total_cost_usd ?? 0);
  // The transcript is cumulative, so each labeled process reports the difference
  // between its own reading and the previous one rather than a raw total.
  let previousModels = null;
  const workModels = transcriptModels(readFileSync(resolve(sourceRoot, "transcript-path.txt"), "utf8").trim());
  const workDelta = transcriptDelta(previousModels, workModels);
  previousModels = workModels;
  const workTests = spawnSync("npm", ["test"], { cwd: workload, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  workTestsPassed = workTests.status === 0;
  processLabels.push({
    label: "source-work", role: "work", incarnation: 1,
    assistantRecords: workDelta.assistantRecords,
    matchingModelRecords: workDelta.matchingModelRecords,
    fallbackOrModelSwitchRecords: workDelta.fallbackRecords,
    cumulativeAssistantRecords: workDelta.cumulative.assistantRecords,
    wallSeconds: work.wallSeconds,
  });

  const compact = claudeCall([...common(settings, ""), "--resume", sessionId, "--max-budget-usd", "0.03", "/compact"],
    workload, resolve(sourceRoot, "compact-result.json"));
  observedCostUsd += Number(compact.total_cost_usd ?? 0);
  const compactModels = transcriptModels(readFileSync(resolve(sourceRoot, "transcript-path.txt"), "utf8").trim());
  const compactDelta = transcriptDelta(previousModels, compactModels);
  previousModels = compactModels;
  processLabels.push({
    label: "source-compact", role: "compact", incarnation: 1,
    assistantRecords: compactDelta.assistantRecords,
    matchingModelRecords: compactDelta.matchingModelRecords,
    fallbackOrModelSwitchRecords: compactDelta.fallbackRecords,
    cumulativeAssistantRecords: compactDelta.cumulative.assistantRecords,
    wallSeconds: compact.wallSeconds,
  });
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
    const fork = claudeCall([...common(settings, ""), "--resume", sessionId, "--fork-session",
      "--max-budget-usd", "0.005", "/status"], workload, resolve(armRoot, "fork-result.json"));
    observedCostUsd += Number(fork.total_cost_usd ?? 0);
    if (typeof fork.session_id !== "string" || fork.session_id === sessionId) throw new Error(`${arm}: distinct fork id absent`);
    const sourceAtFork = readFileSync(transcriptPath);
    if (digest(sourceAtFork) !== digest(parentAfterCompact)) throw new Error(`${arm}: fork creation changed parent`);
    // The fork's own transcript, as reported by its SessionStart, and the
    // identities it holds right after creation. That set is the probe baseline:
    // attribution is by record identity, because the fork file is a fresh file
    // whose row count (4 against the source's 30) says nothing about either
    // invocation on its own.
    // The fork creation call runs under the source's plain settings (not the
    // score-fork settings, which are prepared below and must engage only for
    // the probe resume). The plain hook.mjs writes `transcript-path.txt`
    // unconditionally on every event carrying `transcript_path`, including
    // this fork's own SessionStart -- overwriting the source's own prior
    // entry, which is why the source path was already captured into
    // `transcriptPath` above rather than re-read from this file. Reading it
    // right now, before anything else can overwrite it again, is the only
    // place the fork's own path is ever knowable (run-og86-medium.mjs uses
    // this exact same mechanism for the medium-series controller).
    const forkPath = readFileSync(resolve(sourceRoot, "transcript-path.txt"), "utf8").trim();
    if (forkPath === transcriptPath) throw new Error(`${arm}: fork transcript path matches the source`);
    const forkIdentitiesAfterCreation = assistantIdentities(forkPath);

    const prepared = JSON.parse(run(process.execPath, [prepareScore, "--private-root", armRoot, "--treatment", treatment]));
    const probe = claudeCall([...common(prepared.settingsPath, ""), "--resume", fork.session_id,
      "--max-budget-usd", "0.035",
      "Without tools, return JSON naming the clamp bug cause, chosen fix, file, preserved constraint, and final test result. State uncertainty rather than guessing."],
    workload, resolve(armRoot, "probe-result.json"));
    observedCostUsd += Number(probe.total_cost_usd ?? 0);
    const sourceAfterProbe = readFileSync(transcriptPath);
    const stable = digest(sourceAfterProbe) === digest(parentAfterCompact);

    const scoreEvents = readFileSync(resolve(armRoot, "score-fork-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const nonEmptyTreatments = scoreEvents.filter((row) => row.event === "SessionStart" && row.treatmentBytes > 0);
    // The hook's own record of the injection, including the output field it wrote.
    const channelEvidence = treatmentChannelEvidence(scoreEvents);
    const expectedCopies = arm === "A" ? 0 : 1;
    if (nonEmptyTreatments.length !== expectedCopies) throw new Error(`${arm}: treatment-copy count mismatch`);
    const toolUse = scoreEvents.filter((row) => row.event === "PreToolUse" && row.allowed === true);
    if (toolUse.length > 0) throw new Error(`${arm}: score fork used tools`);
    // The probe's own work, by identity against the post-creation baseline.
    const forkIdentitiesAfterProbe = assistantIdentities(forkPath);
    const probeAttribution = identityAttribution({
      before: forkIdentitiesAfterCreation,
      after: forkIdentitiesAfterProbe,
      requiredModel: model,
      relationship: "append-only",
    });
    if (!probeAttribution.proven) throw new Error(`${arm}: probe attribution unproven (${probeAttribution.refusal})`);
    const models = transcriptModels(forkPath);
    if (Object.keys(models.counts).some((value) => value !== model) || models.fallbackRecords !== 0) throw new Error(`${arm}: model mismatch`);
    const prefixAtFork = retainedPrefix(sourceAtFork, parentAfterCompact.byteLength);
    const prefixAfterProbe = retainedPrefix(sourceAfterProbe, parentAfterCompact.byteLength);
    armResults.push({
      arm,
      treatmentBytes: prepared.treatmentBytes,
      treatmentSha256: prepared.expectedSha256,
      treatmentCopies: nonEmptyTreatments.length,
      parentTranscriptStable: stable,
      sourceTranscriptBytesBefore: sourceAtFork.byteLength,
      sourceTranscriptBytesAfter: sourceAfterProbe.byteLength,
      sourceTranscriptSha256Before: digest(sourceAtFork),
      sourceTranscriptSha256After: digest(sourceAfterProbe),
      sourceTranscriptLinesBefore: prefixAtFork.retainedPrefixLines,
      sourceTranscriptLinesAfter: prefixAfterProbe.retainedPrefixLines,
      elapsedWallSeconds: fork.wallSeconds + probe.wallSeconds,
      probeToolUseCount: toolUse.length,
      assistantModels: models,
      // The channel the treatment actually arrived on, derived from the hook's
      // own audit rows; see treatmentChannelEvidence.
      ...channelEvidence,
    });
    // The probe's own records, attributed by identity rather than by reading the
    // fork file's total, which also carries the creation invocation's records.
    processLabels.push({
      label: `score-${arm}-probe`, role: "probe", incarnation: 1,
      assistantRecords: probeAttribution.assistantRecords,
      matchingModelRecords: probeAttribution.matchingModelRecords,
      fallbackOrModelSwitchRecords: probeAttribution.fallbackRecords,
      cumulativeAssistantRecords: forkIdentitiesAfterProbe.assistantRecords,
      baselineAssistantRecords: forkIdentitiesAfterCreation.assistantRecords,
      wallSeconds: probe.wallSeconds,
    });
    if (observedCostUsd > capUsd) throw new Error(`Stage-0 cap exceeded: ${observedCostUsd}`);
  }

  const resume = claudeCall([...common(settings, "Read,Bash"), "--resume", sessionId, "--max-budget-usd", "0.09",
    `Read package.json and run npm test. Then attempt to read ${resolve(sourceRoot, "forbidden-canary.txt")} with Read; report only whether access was denied and never guess its contents.`],
  workload, resolve(sourceRoot, "resume-result.json"));
  observedCostUsd += Number(resume.total_cost_usd ?? 0);
  if (observedCostUsd > capUsd) throw new Error(`Stage-0 cap exceeded: ${observedCostUsd}`);

  const events = readFileSync(resolve(sourceRoot, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const pids = [...new Set(events.map((row) => row.claudeParentPid).filter(Number.isInteger))];
  const resumeModels = transcriptModels(transcriptPath);
  const resumeDelta = transcriptDelta(previousModels, resumeModels);
  processLabels.push({
    label: "source-resume", role: "continuation", incarnation: 1,
    assistantRecords: resumeDelta.assistantRecords,
    matchingModelRecords: resumeDelta.matchingModelRecords,
    fallbackOrModelSwitchRecords: resumeDelta.fallbackRecords,
    cumulativeAssistantRecords: resumeDelta.cumulative.assistantRecords,
    wallSeconds: resume.wallSeconds,
  });
  // The host-reported transcript path is the geometry the hook classifies
  // against, so it is the one the probe roots must mirror.
  const toolMatrix = observedToolMatrix({ sourceRoot, workload, transcriptPath });
  // Shared comparison: verdict for every row, plus the named class for every
  // location-class denial. A verdict-only filter would accept a row denied for
  // the wrong reason.
  const boundaryMismatches = matrixMismatches(toolMatrix);

  const checkpoint = oneCheckpoint(sourceRoot, sessionId);
  const precompact = events.find((row) => row.kind === "PreCompact");
  const sourceModels = transcriptModels(transcriptPath);
  const retainedTranscript = readFileSync(transcriptPath);
  // Binding is recomputed from the retained transcript, and the checkpoint body is
  // verified by dcompact's own restore, which re-derives the payload hash and
  // refuses a mismatch. The shape check alone can never refute a tampered payload,
  // so both are recorded and both are gated.
  const binding = restoreVerifiedBinding({
    transcriptPath,
    checkpoint,
    restore: () => {
      const result = spawnSync(process.execPath, [dcompact, "restore", "--session", sessionId,
        "--store", resolve(sourceRoot, "store")], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      return {
        status: result.status,
        pack: result.stdout,
        refusalCode: result.status === 0 ? null : (/corrupt-checkpoint/.test(result.stderr || "") ? "corrupt-checkpoint" : "restore-failed"),
        detail: (result.stderr || "").trim().slice(0, 200),
      };
    },
  });
  const canary = readFileSync(resolve(sourceRoot, "forbidden-canary.txt"), "utf8").trim();
  const canaryOccurrences = retainedTranscript.toString("utf8").split(canary).length - 1;
  const compactMarkers = events.filter((row) => row.kind === "PreCompact");
  const manualCompactions = compactMarkers.filter((row) => row.trigger === "manual").length;
  const unscheduled = compactMarkers.filter((row) => row.trigger !== "manual").length;
  const modes = privacyModes(privateRoot);
  // The hook records a digest of the captured summary; recompute it from the file
  // and require the two to agree, so the capture is verified rather than assumed.
  const postCompact = events.find((row) => row.kind === "PostCompact") ?? null;
  const summaryBytes = readFileSync(summaryPath);
  const nativeSummaryVerified = postCompact !== null
    && postCompact.summarySha256 === digest(summaryBytes)
    && postCompact.summaryBytes === summaryBytes.byteLength;
  const channelCheck = channelPreflight({ arms: armResults });
  const wallSeconds = Number(process.hrtime.bigint() - startedAtNs) / 1e9;

  // Every gate is asserted before `status` is decided. A false gate throws and no
  // manifest is written, so a partial result can never be published as a pass.
  assert(workTestsPassed, "work-tests-passed");
  assert(unscheduled === 0, "no-unscheduled-compaction");
  assert(manualCompactions === 1, "one-manual-compaction");
  assert(pids.length >= 3, "distinct-process-parents");
  assert(processLabels.length >= 5, "labeled-processes");
  assert(canaryOccurrences === 0, "canary-absent-from-transcript");
  assert(modes.allDirectoriesOwnerOnly && modes.allFilesOwnerOnly, "owner-only-modes");
  assert(modes.zeroSymlinks, "zero-symlinks");
  assert(boundaryMismatches.length === 0, "observed-tool-boundary");
  assert(toolMatrix.filter((row) => row.allowed).length === 6, "exactly-six-allowed-capabilities");
  assert(binding.envelopeBytesMatch, "checkpoint-envelope-bytes");
  assert(binding.envelopeLinesMatch, "checkpoint-envelope-lines");
  assert(binding.checkpointEvidenceEntriesMatched === binding.checkpointEvidenceEntriesRequired, "checkpoint-evidence-bound");
  assert(binding.checkpointEvidenceEntriesRequired > 0, "checkpoint-evidence-present");
  assert(binding.checkpointHashShapeValid, "checkpoint-hash-shape");
  assert(binding.checkpointHashRecomputedByRestore, "checkpoint-hash-recomputed-by-restore");
  assert(binding.pathClassExcludesFixtureAndReplay, "path-class-not-fixture");
  assert(readFileSync(packPath, "utf8").includes("[dcompress:"), "dcompress-pack-marker");
  assert(sourceModels.assistantRecords > 0 && sourceModels.matchingModelRecords === sourceModels.assistantRecords, "source-model-attribution");
  assert(sourceModels.fallbackRecords === 0, "no-source-fallback-records");
  assert(armResults.every((arm) => arm.assistantModels.assistantRecords > 0
    && arm.assistantModels.matchingModelRecords === arm.assistantModels.assistantRecords), "fork-model-attribution");
  assert(armResults.every((arm) => arm.parentTranscriptStable), "source-stable-through-probing");
  assert(armResults.every((arm) => arm.treatmentCopies === (arm.arm === "A" ? 0 : 1)), "one-treatment-copy");
  assert(armResults.every((arm) => arm.probeToolUseCount === 0), "probes-used-no-tools");
  assert(observedCostUsd <= capUsd, "stage0-cap");
  const eventOrder = events
    .filter((row) => ["PreCompact", "PostCompact", "SessionStart"].includes(row.kind))
    .map((row) => `${row.kind}:${row.source ?? row.trigger ?? "none"}`);
  assert(eventOrder.indexOf("PostCompact:none") > eventOrder.indexOf("SessionStart:compact"), "postcompact-after-compact-sessionstart");
  assert(nativeSummaryVerified, "native-summary-digest-verified");
  for (const failure of channelCheck.failures) assert(false, `treatment-channel:${failure}`);

  if (failedGates.length > 0) {
    throw new Error(`Stage-0 refused to emit: ${failedGates.length} gate(s) failed: ${failedGates.join(",")}`);
  }

  const sanitized = {
    series: "OG86-medium-v1-stage0-v3",
    status: "pass",
    design: "one untreated compacted source, then three pre-treatment score forks",
    capUsd,
    observedCostUsd: Number(observedCostUsd.toFixed(6)),
    wallSeconds,
    workTestsPassed,
    manualCompactCount: manualCompactions,
    unscheduledCompactionCount: unscheduled,
    eventOrder,
    arms: armResults,
    distinctProcessLabels: pids.length,
    processes: processLabels,
    toolBoundary: {
      observed: toolMatrix,
      mismatches: boundaryMismatches,
      allowedCapabilities: toolMatrix.filter((row) => row.allowed).map((row) => row.name),
      locationClasses: requiredLocationClasses(),
    },
    sourceAssistantModels: sourceModels,
    internalCompactionSummarizerModel: "unproven",
    cTranscriptBinding: {
      pathClass: "task-owned-organic-claude-transcript",
      ...binding,
      hookStartBytes: precompact.transcriptBytes,
      hookStartToCheckpointGrowthBytes: binding.retainedPrefixBytes - precompact.transcriptBytes,
      packMarkerPresent: readFileSync(packPath, "utf8").includes("[dcompress:"),
    },
    canaryValueOccurrencesInTranscript: canaryOccurrences,
    privacyModes: {
      directories: modes.directories,
      files: modes.files,
      symlinkCount: modes.symlinkCount,
      symlinks: modes.symlinks,
      zeroSymlinks: modes.zeroSymlinks,
      allDirectoriesOwnerOnly: modes.allDirectoriesOwnerOnly,
      allFilesOwnerOnly: modes.allFilesOwnerOnly,
    },
    preflights: {
    ancestry: { ok: ancestry.ok, dependencyBaseCommit: ancestry.dependencyBaseCommit, dependencyCommits: ancestry.dependencyCommits, failureCount: ancestry.failures.length },
    scorer: { ok: scorerCheck.ok, checkpoint: scorerCheck.checkpoint, omittedAtom: scorerCheck.omittedAtom, canonical: scorerCheck.canonical, mutated: scorerCheck.mutated },
    privacy: { ok: privacyCheck.ok, scannedFiles: privacyCheck.scannedFiles },
  },
  nativeSummary: {
    bytes: summaryBytes.byteLength,
    sha256: digest(summaryBytes),
    matchesHookRecord: nativeSummaryVerified,
  },
  treatmentChannel: {
    sharedChannel: channelCheck.sharedChannel,
    observed: channelCheck.observed.map((entry) => ({ arm: entry.arm, event: entry.event, channel: entry.channel, delivered: entry.delivered })),
  },
  runnerRevisionDigest: digest(readFileSync(new URL(import.meta.url))),
    scorerRevisionDigest: digest(readFileSync(resolve(repository, "scripts/benchmark/score-og86.mjs"))),
  };
  writeFileSync(resolve(privateRoot, "sanitized-result.json"), `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(sanitized, null, 2)}\n`);
}

if (isDirectExecution()) main();
