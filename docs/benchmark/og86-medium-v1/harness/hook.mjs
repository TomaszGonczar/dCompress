import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * OG-86 continuation sandbox.
 *
 * The tool gate is an exact boundary, not a prefix allowance:
 *  - Bash accepts one frozen command string exactly, with no trimming, so
 *    surrounding whitespace is a different command and is denied.
 *  - Glob/Grep require an explicit workload `path` and every other string or
 *    string-array field must be traversal-inert.
 *  - Read/Edit/Write require an in-workload `file_path`.
 *  - Every path outside the workload is classified into a named forbidden
 *    location class (transcript, profile, store, rubric, scorer, capture) and
 *    denied with that class in the recorded reason.
 *
 * The treatment gate is equally exact. PostCompact runs after
 * SessionStart(source=compact) in Claude Code 2.1.270, so arm B/C treatment is
 * delivered on an explicit resume — and every other call in the series (phase
 * prompt, `/compact`, score-fork probe) is also a resume. The controller
 * therefore arms exactly one upcoming resume per checkpoint with
 * `--arm-treatment`, and that arming is consumed by its first injection. A
 * resume that was not armed injects nothing, and a second resume after a
 * consumption is suppressed with `duplicateSuppressed: true`.
 *
 * `probeMatrix()` derives the observed allow/deny matrix that a Stage-0 rerun
 * must execute; the hook entry point stays fail-open (AGENTS invariant 6).
 */

export const TREATMENT_MAX_BYTES = 16_384;

/**
 * Exact-match allowlist. Adding an argument, chaining, or surrounding
 * whitespace is a different command string.
 */
export const ALLOWED_BASH_COMMANDS = Object.freeze(["npm test"]);

export const LOCATION_CLASSES = Object.freeze([
  "workload",
  "transcript",
  "profile",
  "store",
  "rubric",
  "scorer",
  "capture",
]);

export const CAPABILITIES = Object.freeze(["read", "edit", "write", "glob", "grep", "bash"]);

/** Bash probes: an exact match is the only allow. */
export const BASH_PROBES = Object.freeze([
  { name: "bash-exact-frozen-test", command: "npm test", expected: "allow" },
  { name: "bash-leading-whitespace", command: " npm test", expected: "deny" },
  { name: "bash-trailing-whitespace", command: "npm test ", expected: "deny" },
  { name: "bash-tab-padded", command: "\tnpm test\t", expected: "deny" },
  { name: "bash-inner-double-space", command: "npm  test", expected: "deny" },
  { name: "bash-newline-padded", command: "npm test\n", expected: "deny" },
  { name: "bash-test-with-arguments", command: "npm test -- --test-name-pattern=../../forbidden-canary.txt", expected: "deny" },
  { name: "bash-node-test-absolute", command: "node --test /etc/passwd", expected: "deny" },
  { name: "bash-node-test-relative", command: "node --test ../../forbidden-canary.txt", expected: "deny" },
  { name: "bash-test-then-chained-read", command: "npm test; cat ../forbidden-canary.txt", expected: "deny" },
  { name: "bash-test-then-and-read", command: "npm test && cat ../forbidden-canary.txt", expected: "deny" },
  { name: "bash-raw-read", command: "cat ../forbidden-canary.txt", expected: "deny" },
  { name: "bash-environment-dump", command: "env", expected: "deny" },
  { name: "bash-empty", command: "", expected: "deny" },
]);

const TEXT_TOOLS = new Set(["Read", "Edit", "Write"]);
const SEARCH_TOOLS = new Set(["Glob", "Grep"]);

function underRoot(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** Reject any search field that could name a path outside the declared root. */
export function traversalInert(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 512) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.includes("..") || value.includes("~") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return true;
}

/**
 * Classify an absolute-or-relative path into exactly one location class.
 *
 * The workload is tested first because it lives inside the capture root. Among
 * the forbidden classes the **most specific** matching root wins, measured by
 * root path length, so a file that sits inside a broader class reports the
 * narrower one. Without that ordering a transcript at
 * `<profile>/projects/<slug>/<id>.jsonl` could be denied as `profile` — the
 * right verdict with the wrong class, which makes a claimed denial
 * unverifiable.
 *
 * Ties break on the class name so the result never depends on key order.
 */
export function classifyLocation(value, { workloadRoot, forbidden }) {
  if (typeof value !== "string" || value.length === 0) return "outside";
  const candidate = resolve(value);
  if (underRoot(candidate, resolve(workloadRoot))) return "workload";
  let best = null;
  for (const [label, roots] of Object.entries(forbidden ?? {})) {
    const list = Array.isArray(roots) ? roots : [roots];
    for (const root of list) {
      if (typeof root !== "string" || !underRoot(candidate, resolve(root))) continue;
      const specificity = resolve(root).length;
      if (best === null || specificity > best.specificity
        || (specificity === best.specificity && label < best.label)) {
        best = { label, specificity };
      }
    }
  }
  return best === null ? "outside" : best.label;
}

/** Pure decision function. Returns `{ allowed, reason }`; never throws. */
export function toolDecision({ tool, input, workloadRoot, forbidden }) {
  const toolInput = input && typeof input === "object" ? input : {};
  if (tool === "Bash") {
    // Exact match, deliberately without trimming: " npm test" and "npm test "
    // are different command strings, and a shell would run them differently.
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    const allowed = ALLOWED_BASH_COMMANDS.includes(command);
    return {
      allowed,
      reason: allowed
        ? "OG-86 frozen exact test command"
        : "OG-86 allows only the frozen exact test command with no arguments or surrounding whitespace",
    };
  }
  if (SEARCH_TOOLS.has(tool)) {
    if (typeof toolInput.path !== "string") {
      return { allowed: false, reason: `OG-86 requires an explicit workload path for ${tool}` };
    }
    const location = classifyLocation(toolInput.path, { workloadRoot, forbidden });
    if (location !== "workload") {
      return { allowed: false, reason: `OG-86 denies ${tool} outside the workload (${location})` };
    }
    for (const [key, value] of Object.entries(toolInput)) {
      if (key === "path" || value === undefined || value === null) continue;
      if (typeof value === "number" || typeof value === "boolean") continue;
      if (Array.isArray(value)) {
        if (!value.every((entry) => traversalInert(String(entry)))) {
          return { allowed: false, reason: `OG-86 denies a traversal-capable ${tool} field "${key}"` };
        }
        continue;
      }
      if (typeof value === "string") {
        if (!traversalInert(value)) {
          return { allowed: false, reason: `OG-86 denies a traversal-capable ${tool} field "${key}"` };
        }
        continue;
      }
      return { allowed: false, reason: `OG-86 denies an unconstrained ${tool} field "${key}"` };
    }
    return { allowed: true, reason: "OG-86 workload-scoped search" };
  }
  if (TEXT_TOOLS.has(tool)) {
    const location = classifyLocation(toolInput.file_path, { workloadRoot, forbidden });
    const allowed = location === "workload";
    return {
      allowed,
      reason: allowed ? "OG-86 workload boundary" : `OG-86 denies ${tool} outside the workload (${location})`,
    };
  }
  return { allowed: false, reason: "OG-86 denies every tool outside the frozen capability matrix" };
}

/**
 * Glob/Grep probe input for one location.
 *
 * The path is the declared root itself, never its parent directory. Walking up
 * to the parent would place a `transcript` probe inside the enclosing `profile`
 * root, and the hook would then correctly deny it as `profile` — the right
 * verdict with the wrong class, which is exactly the confusion the observed
 * class check exists to catch.
 */
function searchInput(capability, entry) {
  if (capability === "glob") return { path: entry.path, pattern: "**/*.json" };
  return { path: entry.path, pattern: "reservation" };
}

function textInput(capability, entry) {
  const target = entry.kind === "directory" ? resolve(entry.path, "probe-target.txt") : entry.path;
  return { file_path: target };
}

/** Every enabled capability against every location class. */
export const MATRIX_PLAN = Object.freeze([
  ...LOCATION_CLASSES.flatMap((location) => ["read", "edit", "write", "glob", "grep"].map((capability) => ({
    name: `${capability}-${location}`,
    capability,
    location,
    tool: { read: "Read", edit: "Edit", write: "Write", glob: "Glob", grep: "Grep" }[capability],
    expected: location === "workload" ? "allow" : "deny",
  }))),
  ...BASH_PROBES.map((probe) => ({ ...probe, capability: "bash", location: "command", tool: "Bash" })),
]);

/**
 * Shape probes: calls that omit a required field or use a tool outside the
 * matrix. They carry their own inputs because no location root applies, and the
 * expected verdict is "deny" for every one of them.
 */
export const SHAPE_PLAN = Object.freeze([
  { name: "glob-without-path", capability: "glob", location: "workload", tool: "Glob", expected: "deny", input: { pattern: "**/*.json" } },
  { name: "grep-without-path", capability: "grep", location: "workload", tool: "Grep", expected: "deny", input: { pattern: "reservation" } },
  { name: "read-missing-path", capability: "read", location: "workload", tool: "Read", expected: "deny", input: {} },
  { name: "edit-missing-path", capability: "edit", location: "workload", tool: "Edit", expected: "deny", input: { old_string: "a", new_string: "b" } },
  { name: "write-missing-path", capability: "write", location: "workload", tool: "Write", expected: "deny", input: { content: "x" } },
  { name: "unknown-tool-webfetch", capability: "unknown", location: "outside", tool: "WebFetch", expected: "deny", input: { url: "https://example.invalid" } },
  { name: "unknown-tool-task", capability: "unknown", location: "outside", tool: "Task", expected: "deny", input: { prompt: "do something" } },
]);

/** Traversal-shaped escape attempts; built against the real workload root. */
export const TRAVERSAL_PLAN = Object.freeze([
  { name: "glob-traversal-pattern", capability: "glob", location: "workload", tool: "Glob", expected: "deny",
    build: (workload) => ({ path: workload, pattern: "../forbidden-canary.txt" }) },
  { name: "grep-traversal-pattern", capability: "grep", location: "workload", tool: "Grep", expected: "deny",
    build: (workload) => ({ path: workload, pattern: "../../etc/passwd" }) },
  { name: "grep-traversal-glob-field", capability: "grep", location: "workload", tool: "Grep", expected: "deny",
    build: (workload) => ({ path: workload, pattern: "reservation", glob: "../../../*.json" }) },
  { name: "read-traversal", capability: "read", location: "workload", tool: "Read", expected: "deny",
    build: (workload) => ({ file_path: resolve(workload, "../../forbidden-canary.txt") }) },
  { name: "write-traversal", capability: "write", location: "workload", tool: "Write", expected: "deny",
    build: (workload) => ({ file_path: resolve(workload, "../escaped.txt") }) },
]);

/** Names and verdicts only — root-independent, so a dry run can assert them. */
/**
 * The preregistered verdict for every probe.
 *
 * `classChecked` marks the rows whose denial must report a specific named
 * location class. Only the location-class grid qualifies: shape probes are
 * denied before any path is resolved, Bash probes carry a command rather than a
 * path, and allowed rows have no denial to attribute.
 */
export function matrixExpectations() {
  // Only the location grid: those probes hand the hook a resolvable path inside
  // a declared class, so a denial can be attributed to that class. Traversal
  // probes are denied for being traversal-shaped rather than for where they
  // resolve, and shape/Bash probes carry no path at all.
  const classChecked = new Set(
    MATRIX_PLAN
      .filter((plan) => plan.expected === "deny" && plan.location !== "command" && plan.location !== "outside")
      .map((plan) => plan.name),
  );
  return [...MATRIX_PLAN, ...SHAPE_PLAN, ...TRAVERSAL_PLAN].map((plan) => ({
    name: plan.name,
    capability: plan.capability,
    location: plan.location,
    expected: plan.expected,
    classChecked: classChecked.has(plan.name),
  }));
}

/** Forbidden location classes the controller must supply a root for. */
export function requiredLocationClasses() {
  return [...new Set(MATRIX_PLAN.map((plan) => plan.location))]
    .filter((location) => location !== "command" && location !== "outside" && location !== "workload");
}

/** Traversal-shaped escape attempts, built against the real roots. */
function traversalProbes({ workloadRoot }) {
  const workload = resolve(workloadRoot);
  return TRAVERSAL_PLAN.map((plan) => ({ ...plan, input: plan.build(workload) }));
}

/**
 * Observed probe matrix: every enabled capability against every location class,
 * plus traversal-shaped escape attempts. Each row carries its expected verdict.
 */
export function probeMatrix({ workloadRoot, forbidden }) {
  const entries = {
    workload: { path: resolve(workloadRoot), kind: "directory" },
    ...forbidden,
  };
  const probes = MATRIX_PLAN.map((plan) => {
    if (plan.capability === "bash") return { ...plan, input: { command: plan.command } };
    const entry = entries[plan.location];
    if (entry === undefined) throw new Error(`missing probe location class: ${plan.location}`);
    const input = plan.capability === "glob" || plan.capability === "grep"
      ? searchInput(plan.capability, entry)
      : textInput(plan.capability, entry);
    return { ...plan, input };
  });
  return [...probes, ...SHAPE_PLAN.map((plan) => ({ ...plan })), ...traversalProbes({ workloadRoot })];
}

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
 * Pure treatment decision. Treatment reaches the source only when the
 * controller has armed exactly this resume for this arm and that arming has not
 * already been consumed. Every other resume — the phase prompt, the `/compact`
 * call, the score-fork probe — and every non-resume session start injects zero.
 */
export function treatmentDecision({ arm, source, armed, consumedTokens }) {
  if (arm === "A") return { action: "absent", reason: "control-arm" };
  if (source !== "resume") return { action: "absent", reason: "not-an-explicit-resume" };
  if (armed === null || armed === undefined) return { action: "absent", reason: "not-armed" };
  if (armed.arm !== arm) return { action: "absent", reason: "armed-for-a-different-arm" };
  if (new Set(consumedTokens ?? []).has(armed.token)) return { action: "suppress", reason: "arming-already-consumed" };
  return { action: "inject", kind: arm === "B" ? "native-summary" : "dcompact-pack" };
}

/** Arm exactly one upcoming resume, for one arm and one checkpoint. */
export function armTreatment(stateRoot, { arm, checkpoint, token }) {
  if (!new Set(["B", "C"]).has(arm)) throw new Error("--arm-treatment requires arm B or C");
  if (!Number.isInteger(checkpoint) || checkpoint < 1 || checkpoint > 4) {
    throw new Error("--arm-treatment requires an integer checkpoint in 1..4");
  }
  if (typeof token !== "string" || token.length === 0) throw new Error("--arm-treatment requires a non-empty token");
  const path = resolve(stateRoot, "treatment-arming.json");
  writeFileSync(path, `${JSON.stringify({ arm, checkpoint, token })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function readArming(stateRoot) {
  try {
    const parsed = JSON.parse(readFileSync(resolve(stateRoot, "treatment-arming.json"), "utf8"));
    if (typeof parsed?.token !== "string" || typeof parsed?.arm !== "string") return null;
    return { arm: parsed.arm, checkpoint: Number(parsed.checkpoint), token: parsed.token };
  } catch {
    return null;
  }
}

/**
 * Consumed tokens, read from the append-only ledger only.
 *
 * The ledger records tokens that reached an *injection*, so absence here does
 * not mean unconsumed: a token can be claimed (see `isTokenClaimed`) without an
 * injection having completed. Suppression is therefore decided by the claim
 * file, and this list is corroboration, not proof.
 */
function readConsumedTokens(stateRoot) {
  const tokens = new Set();
  try {
    for (const line of readFileSync(resolve(stateRoot, "treatment-consumed.jsonl"), "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      const token = JSON.parse(line).token;
      if (typeof token === "string") tokens.add(token);
    }
  } catch {
    // No ledger yet: the claim files are the authority on suppression.
  }
  return [...tokens];
}

/** True when this token has already been claimed, whatever the ledger says. */
function isTokenClaimed(stateRoot, token) {
  if (typeof token !== "string" || token.length === 0) return false;
  return existsSync(claimPath(stateRoot, token));
}

/** A claim file name is derived from the token, so one token claims one file. */
function claimPath(stateRoot, token) {
  return resolve(stateRoot, `treatment-claim-${createHash("sha256").update(token).digest("hex")}`);
}

/**
 * Claim an arming atomically.
 *
 * `writeFileSync` with `flag: "wx"` fails if the path exists, and the create is
 * atomic on POSIX, so exactly one caller can win the claim for a token. A
 * read-then-append sequence would let two concurrent resumes both observe "not
 * consumed" and both inject; this cannot.
 *
 * Returns the ledger row when the claim is won, or null when the token was
 * already claimed by someone else.
 */
function consumeArming(stateRoot, { token, sha256, checkpoint }) {
  const claim = claimPath(stateRoot, token);
  try {
    writeFileSync(claim, `${JSON.stringify({ token, checkpoint, treatmentSha256: sha256, claudeParentPid: process.ppid })}\n`,
      { mode: 0o600, flag: "wx" });
  } catch (error) {
    // EEXIST is a lost race, which is a suppression, not a failure.
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  chmodSync(claim, 0o600);
  appendFileSync(resolve(stateRoot, "treatment-consumed.jsonl"),
    `${JSON.stringify({ token, checkpoint, treatmentSha256: sha256, monotonicNs: process.hrtime.bigint().toString(), claudeParentPid: process.ppid })}\n`,
    { mode: 0o600 });
  chmodSync(resolve(stateRoot, "treatment-consumed.jsonl"), 0o600);
  return true;
}

/**
 * Block until the armed token is consumed or the timeout elapses. The host runs
 * the hook to completion before the resumed process starts, so a caller needs a
 * way to know whether that resume injected rather than racing it with a sleep.
 */
function awaitInjection(stateRoot, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const token = readArming(stateRoot)?.token ?? null;
  const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const consumed = readConsumedTokens(stateRoot);
    if (token === null || consumed.includes(token)) return { token, consumed };
    if (Date.now() >= deadline) return { token, consumed, timedOut: true };
    Atomics.wait(sleepBuffer, 0, 0, 25);
  }
}

function argument(name, required = true) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  return process.argv[index + 1];
}

/** `--flag=value` form, used by the controller-facing verbs. */
function parameter(name, required = true) {
  const prefix = `${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  if (found === undefined) {
    if (required) throw new Error(`${name}=<value> is required`);
    return undefined;
  }
  return found.slice(prefix.length);
}

/** `--forbid<label>=<absolute path>`; a label may be repeated and collects roots. */
function repeatedForbidden() {
  const forbidden = {};
  for (const value of process.argv) {
    if (!value.startsWith("--forbid")) continue;
    const spec = value.slice("--forbid".length);
    if (!spec.includes("=")) continue;
    const separator = spec.indexOf("=");
    const label = spec.slice(0, separator);
    const root = resolve(spec.slice(separator + 1));
    if (forbidden[label] === undefined) forbidden[label] = [root];
    else if (!forbidden[label].includes(root)) forbidden[label].push(root);
  }
  return forbidden;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function main() {
  const event = argument("--event");
  const arm = argument("--arm");
  const stateRoot = resolve(argument("--state"));
  const workloadRoot = resolve(argument("--workload"));
  const dcompact = resolve(argument("--dcompact"));
  const forbidden = repeatedForbidden();

  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);

  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  function privateWrite(name, bytes) {
    const path = resolve(stateRoot, name);
    writeFileSync(path, bytes, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  if (typeof input.transcript_path === "string") privateWrite("transcript-path.txt", `${input.transcript_path}\n`);

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

  function dcompactHook(kind) {
    const result = spawnSync(process.execPath, [dcompact, "hook", "--event", kind, "--store", resolve(stateRoot, "store")], {
      input: JSON.stringify(input),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || result.error) return "{}";
    return result.stdout.trim() || "{}";
  }

  /**
   * Transcript and profile are only knowable once the host has reported them.
   * Claude Code stores a transcript at `<profile>/projects/<slug>/<id>.jsonl`,
   * so the profile root is the ancestor that holds `projects`; without that
   * shape the transcript's own directory is the narrowest safe answer.
   */
  function liveForbidden() {
    const recorded = resolve(stateRoot, "transcript-path.txt");
    const others = { ...forbidden };
    delete others.transcript;
    delete others.profile;
    if (!existsSync(recorded)) return { ...forbidden };
    let transcript = null;
    try {
      const value = readFileSync(recorded, "utf8").trim();
      if (value.length > 0) transcript = resolve(value);
    } catch {
      // An unreadable record leaves the static classes in force.
    }
    if (transcript === null) return { ...forbidden };
    const segments = transcript.split(sep);
    const marker = segments.lastIndexOf("projects");
    const profile = marker > 0 ? segments.slice(0, marker).join(sep) : dirname(transcript);
    // The transcript file is classified before the profile directory that holds it.
    return { transcript, profile, ...others };
  }

  function preToolDecision() {
    const tool = input.tool_name;
    const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
    const classes = liveForbidden();
    const location = TEXT_TOOLS.has(tool)
      ? classifyLocation(toolInput.file_path, { workloadRoot, forbidden: classes })
      : SEARCH_TOOLS.has(tool)
        ? classifyLocation(toolInput.path, { workloadRoot, forbidden: classes })
        : "command";
    const decision = toolDecision({ tool, input: toolInput, workloadRoot, forbidden: classes });
    audit("PreToolUse", { tool, allowed: decision.allowed, location, reason: decision.reason });
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.allowed ? "allow" : "deny",
        permissionDecisionReason: decision.reason,
      },
    };
  }

  /**
   * The dcompact pack for this session start. `restore` re-validates the
   * checkpoint payload hash and refuses a corrupt store, so a non-empty pack on
   * exit 0 is the recomputation gate for the checkpoint the pack came from.
   */
  function dcompactTreatment() {
    const output = dcompactHook("session-start");
    const parsed = JSON.parse(output);
    const treatment = parsed?.hookSpecificOutput?.additionalContext ?? "";
    return Buffer.from(treatment, "utf8");
  }

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
    // PostCompact runs after SessionStart(source=compact) in Claude Code 2.1.270,
    // so arm B/C treatment is delivered on an explicit resume. Every resume in
    // the series uses `--resume`: the phase prompt, the `/compact` call, the
    // score-fork probe, and the source continuation. Treatment therefore reaches
    // the source only for the resume the controller armed, and that arming is
    // consumed by its first injection.
    const armed = readArming(stateRoot);
    const token = armed?.token ?? null;
    const decision = treatmentDecision({
      arm,
      source: input.source,
      armed,
      // The claim file is the atomic gate, so it is what decides suppression.
      consumedTokens: readConsumedTokens(stateRoot).concat(isTokenClaimed(stateRoot, token) ? [token] : []),
    });
    if (decision.action !== "inject") {
      audit("Treatment", {
        treatmentBytes: 0,
        treatmentSha256: null,
        armed: armed !== null,
        duplicateSuppressed: decision.action === "suppress",
        reason: decision.reason,
      });
      process.stdout.write("{}\n");
    } else {
      const bytes = decision.kind === "native-summary"
        ? Buffer.from(readFileSync(resolve(stateRoot, "native-summary.txt"), "utf8"), "utf8")
        : dcompactTreatment();
      if (bytes.byteLength > TREATMENT_MAX_BYTES) throw new Error("treatment exceeds frozen budget");
      const treatmentSha256 = digest(bytes);
      if (decision.kind === "dcompact-pack") privateWrite("dcompact-treatment.txt", bytes.toString("utf8"));
      // The claim decides, not the pre-read. Two concurrent resumes can both
      // observe an unconsumed arming; only the one that creates the claim file
      // emits. Losing the race is a suppression, so nothing is injected.
      const claimed = consumeArming(stateRoot, { token: armed.token, sha256: treatmentSha256, checkpoint: armed.checkpoint });
      if (claimed !== true) {
        audit("Treatment", {
          treatmentBytes: 0,
          treatmentSha256: null,
          armed: true,
          checkpoint: armed.checkpoint,
          token: armed.token,
          duplicateSuppressed: true,
          reason: "arming-claimed-by-another-process",
        });
        process.stdout.write("{}\n");
      } else {
        audit("Treatment", {
          treatmentBytes: bytes.byteLength,
          treatmentSha256,
          armed: true,
          checkpoint: armed.checkpoint,
          token: armed.token,
          duplicateSuppressed: false,
        });
        process.stdout.write(bytes.byteLength === 0
          ? "{}\n"
          : `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: bytes.toString("utf8") } })}\n`);
      }
    }
  } else {
    process.stdout.write("{}\n");
  }
}

/**
 * Controller-facing verbs. `--arm-treatment` arms exactly one upcoming resume
 * for one arm and checkpoint; `--await-treatment` blocks until that arming is
 * consumed, so a caller can observe whether the resume injected rather than
 * guessing with a delay.
 */
export function armTreatmentFile(stateRoot, { arm, checkpoint, token }) {
  return armTreatment(resolve(stateRoot), { arm, checkpoint, token });
}

/** Read the arming ledger, for callers that only want the observed outcome. */
export function treatmentLedger(stateRoot) {
  const root = resolve(stateRoot);
  return { armed: readArming(root), consumed: readConsumedTokens(root) };
}

if (isDirectExecution()) {
  const armToken = argument("--arm-treatment", false);
  if (armToken !== undefined) {
    try {
      const stateRoot = resolve(argument("--state"));
      const armedArm = argument("--treatment-arm");
      const checkpoint = Number(argument("--treatment-checkpoint"));
      armTreatment(stateRoot, { arm: armedArm, checkpoint, token: armToken });
      const awaited = parameter("--await-treatment", false) === "true"
        ? awaitInjection(stateRoot, { timeoutMs: Number(parameter("--await-timeout-ms", false) ?? 30_000) })
        : null;
      process.stdout.write(`${JSON.stringify({
        armed: { arm: armedArm, checkpoint, token: armToken },
        injected: awaited === null ? null : awaited.consumed.includes(armToken),
        timedOut: awaited?.timedOut === true,
      })}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  } else {
    try {
      main();
    } catch (error) {
      // A hook never fails its host: report a degraded state and exit 0.
      try {
        const stateRoot = resolve(argument("--state", false) ?? ".");
        mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
        appendFileSync(resolve(stateRoot, "events.jsonl"), `${JSON.stringify({
          kind: "HookError",
          name: error instanceof Error ? error.name : "unknown",
          monotonicNs: process.hrtime.bigint().toString(),
          claudeParentPid: process.ppid,
        })}\n`, { mode: 0o600 });
      } catch {
        // Reporting is best effort; availability of the host outranks recording.
      }
      process.stdout.write("{}\n");
    }
  }
}
