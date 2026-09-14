import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
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
const hook = resolve(new URL("./hook.mjs", import.meta.url).pathname);

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
