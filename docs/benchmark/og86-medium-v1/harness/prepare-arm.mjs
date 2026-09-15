import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function argument(name, required = true) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  return process.argv[index + 1];
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const arm = argument("--arm");
if (!new Set(["A", "B", "C"]).has(arm)) throw new Error("--arm must be A, B, or C");
const privateRoot = resolve(argument("--private-root"));
const workload = resolve(argument("--workload"));
const dcompact = resolve(argument("--dcompact"));
const repository = resolve(argument("--repository", false) ?? process.cwd());
const benchmark = resolve(argument("--benchmark", false) ?? resolve(repository, "docs/benchmark/og86-medium-v1"));
const hook = resolve(new URL("./hook.mjs", import.meta.url).pathname);

/**
 * Every forbidden location class is named here, so the hook can say which class a
 * denied path belongs to. The transcript and its profile directory are unknown
 * until the host reports them, so the hook adds those two at decision time.
 */
const forbidden = {
  profile: resolve(privateRoot, "profile"),
  store: resolve(privateRoot, "store"),
  capture: resolve(privateRoot, "sessions"),
  rubric: resolve(benchmark, "rubric.json"),
  scorer: resolve(repository, "scripts/benchmark/score-og86.mjs"),
};

mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
chmodSync(privateRoot, 0o700);
const command = (event) => [
  process.execPath,
  hook,
  "--event", event,
  "--arm", arm,
  "--state", privateRoot,
  "--workload", workload,
  "--dcompact", dcompact,
  ...Object.entries(forbidden).map(([label, path]) => `--forbid${label}=${path}`),
].map(shellQuote).join(" ");

const settings = {
  hooks: {
    PreCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: command("PreCompact"), timeout: 30 }] }],
    PostCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: command("PostCompact"), timeout: 30 }] }],
    SessionStart: [{ matcher: "resume|compact", hooks: [{ type: "command", command: command("SessionStart"), timeout: 30 }] }],
    PreToolUse: [{ matcher: "Read|Edit|Write|Glob|Grep|Bash", hooks: [{ type: "command", command: command("PreToolUse"), timeout: 10 }] }],
  },
};

const settingsPath = resolve(privateRoot, "settings.json");
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
chmodSync(settingsPath, 0o600);
process.stdout.write(`${settingsPath}\n`);
