import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const privateRoot = resolve(argument("--private-root"));
const treatmentArgument = argument("--treatment");
const treatment = treatmentArgument === "EMPTY" ? Buffer.alloc(0) : await import("node:fs").then(({ readFileSync }) => readFileSync(resolve(treatmentArgument)));
const treatmentPath = treatmentArgument === "EMPTY" ? "EMPTY" : resolve(treatmentArgument);
const expected = `sha256:${createHash("sha256").update(treatment).digest("hex")}`;
const hook = resolve(new URL("./score-fork-hook.mjs", import.meta.url).pathname);

mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
chmodSync(privateRoot, 0o700);
const command = (event) => [process.execPath, hook, "--event", event, "--state", privateRoot, "--treatment", treatmentPath, "--sha256", expected]
  .map(shellQuote).join(" ");
const settings = {
  hooks: {
    SessionStart: [{ matcher: "resume", hooks: [{ type: "command", command: command("SessionStart"), timeout: 10 }] }],
    PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: command("PreToolUse"), timeout: 10 }] }],
  },
};
const settingsPath = resolve(privateRoot, "settings.json");
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
chmodSync(settingsPath, 0o600);
process.stdout.write(`${JSON.stringify({ settingsPath, expectedSha256: expected, treatmentBytes: treatment.byteLength })}\n`);
