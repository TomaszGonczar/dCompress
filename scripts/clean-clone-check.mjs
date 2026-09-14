#!/usr/bin/env node
/**
 * Clean-clone reproduction gate — the publication gate for the README's "Try it in 60 seconds"
 * claim.
 *
 * Why this exists: every test in this repository runs inside a developer checkout that already
 * has `node_modules` installed and `dist/` built from a prior run. None of them prove that a
 * stranger who has never run `npm ci` gets the exact bytes and hash the README promises. This
 * script performs the README's own steps — clone, install, build, run the documented command —
 * inside a fresh temporary clone with no inherited `node_modules`, then diffs the result against
 * the values README.md itself states. The expected command, byte count, and hash are parsed out
 * of README.md, never hand-copied here: a copy would keep passing after the README started
 * lying, which is the one failure mode this gate exists to catch.
 *
 * The clone source is this checkout's own `.git` history at HEAD — exactly what `git clone
 * <url>` would fetch for the tip commit — never a network fetch from GitHub.
 *
 * Usage:
 *   node scripts/clean-clone-check.mjs [--json]
 *
 * Streams: --json prints one machine-readable report to stdout; otherwise a short human summary.
 * Exit: 0 reproduced, 1 the clone reproduced a different result than README.md claims, 2 usage or
 * internal error (README shape the parser does not recognize, or a clone/install/build failure).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// Imported rather than taken from the global scope: the lint config treats ambient globals as
// undefined, and an explicit import is what keeps the file lint-clean without touching the rule.
import process from "node:process";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;
const EXIT_ERROR = 2;

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export class UsageError extends Error {}

/**
 * Pulls the documented command sequence and the claims made about its output straight out of
 * README.md's "Try it in 60 seconds" section. Each `throw` below names a shape the section is
 * expected to have; a change to the section that breaks one of them is exactly the kind of drift
 * this gate must fail loudly on rather than silently skip.
 */
export function parseReadme(readmeText) {
  const heading = "## Try it in 60 seconds";
  const headingIndex = readmeText.indexOf(heading);
  if (headingIndex < 0) throw new UsageError(`README.md has no ${JSON.stringify(heading)} section to reproduce`);
  const section = readmeText.slice(headingIndex);

  const shFence = /```sh\n([\s\S]*?)\n```/.exec(section);
  if (shFence === null) throw new UsageError("README's 60-second section has no ```sh command block");
  const commandLines = shFence[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // The clone and the directory change are replaced by the controlled local clone below; every
  // other line is executed exactly as written, so a README edit to the setup steps is exercised
  // rather than silently bypassed.
  const steps = commandLines.filter((line) => !/^git clone\b/.test(line) && !/^cd\b/.test(line));
  if (steps.length === 0) throw new UsageError("README's command block has no steps beyond `git clone` and `cd`");
  const finalCommand = steps.at(-1);
  if (finalCommand === undefined || !/^node\s/.test(finalCommand)) {
    throw new UsageError(`README's last documented step is not a \`node\` invocation: ${JSON.stringify(finalCommand)}`);
  }
  const setupCommands = steps.slice(0, -1);
  const finalArgv = finalCommand.split(/\s+/);

  const transcriptMatch = /--transcript\s+(\S+)/.exec(finalCommand);
  if (transcriptMatch === null) throw new UsageError(`README's documented command names no --transcript fixture: ${JSON.stringify(finalCommand)}`);

  const byteClaim = /Expected stdout[^\n]*?(\d+) bytes for this fixture/.exec(section);
  if (byteClaim === null) throw new UsageError("README does not state an expected stdout byte count for the fixture");
  const expectedBytes = Number(byteClaim[1]);

  // The quoted stdout fence is the mandatory header only, not the whole pack — the byte count
  // above is the claim about the full pack. So the fence is a prefix claim and the byte count is
  // a length claim, checked against different slices of the same real output.
  const afterByteClaim = section.slice(section.indexOf(byteClaim[0]));
  const stdoutFence = /```text\n([\s\S]*?)\n```/.exec(afterByteClaim);
  if (stdoutFence === null) throw new UsageError("README does not quote the expected stdout as a ```text block");
  const expectedStdoutPrefix = `${stdoutFence[1]}\n`;

  const afterStdoutFence = afterByteClaim.slice(afterByteClaim.indexOf(stdoutFence[0]) + stdoutFence[0].length);
  const stderrFence = /```text\n([\s\S]*?)\n```/.exec(afterStdoutFence);
  if (stderrFence === null) throw new UsageError("README does not quote the expected stderr payload hash as a ```text block");
  const hashClaim = /payload hash: (sha256:[0-9a-f]+)/.exec(stderrFence[1]);
  if (hashClaim === null) throw new UsageError("README's quoted stderr block states no payload hash");

  return {
    setupCommands,
    finalArgv,
    transcript: transcriptMatch[1],
    expectedBytes,
    expectedStdoutPrefix,
    expectedHash: hashClaim[1],
  };
}

/**
 * Strips the variables that describe *this* invocation's environment rather than the clone's own:
 * `NODE_PATH` is the only channel by which Node module resolution reaches outside the current
 * directory tree, and `npm_*`/`INIT_CWD` describe the developer checkout when this script itself
 * runs under `npm test`. Leaving them set would let the clone's install or build silently borrow
 * the developer checkout's `node_modules` or configuration instead of building its own.
 */
export function isolatedEnv(source = process.env) {
  const env = { ...source };
  delete env.NODE_PATH;
  delete env.INIT_CWD;
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_")) delete env[key];
  }
  return env;
}

/** Splits a documented command line into argv. README's own commands never quote or escape. */
function splitCommand(line) {
  return line.split(/\s+/);
}

function describeFailure(action, result) {
  const stderr = (result.stderr ?? "").toString().trim().split("\n").slice(0, 5).join("\n");
  return `${action} failed (exit ${result.status ?? "signal " + result.signal}): ${stderr || result.error?.message || "<no stderr>"}`;
}

export function runCleanCloneCheck() {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  const claim = parseReadme(readme);
  const env = isolatedEnv();

  const cloneRoot = mkdtempSync(join(tmpdir(), "dcompact-clean-clone-"));
  try {
    // A local path clone reads the same commit graph a network clone would fetch for HEAD; it
    // never contacts a remote, and the working tree it checks out never includes the developer
    // checkout's untracked `node_modules` or `dist`, since neither is tracked by git.
    const clone = spawnSync("git", ["clone", "--quiet", "--", REPO_ROOT, cloneRoot], { cwd: REPO_ROOT, env, encoding: "utf8" });
    if (clone.status !== 0) throw new Error(describeFailure("git clone", clone));
    const clonedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: cloneRoot, encoding: "utf8" }).trim();

    for (const command of claim.setupCommands) {
      const [program, ...args] = splitCommand(command);
      const step = spawnSync(program, args, { cwd: cloneRoot, env, encoding: "utf8" });
      if (step.status !== 0) throw new Error(describeFailure(command, step));
    }

    const [program, ...args] = claim.finalArgv;
    const final = spawnSync(program, args, { cwd: cloneRoot, env, encoding: "utf8" });
    if (final.status !== 0) throw new Error(describeFailure(claim.finalArgv.join(" "), final));

    const mismatches = [];
    const actualBytes = Buffer.byteLength(final.stdout, "utf8");
    if (actualBytes !== claim.expectedBytes) {
      mismatches.push(`stdout is ${actualBytes} bytes; README claims ${claim.expectedBytes} bytes`);
    }
    if (!final.stdout.startsWith(claim.expectedStdoutPrefix)) {
      mismatches.push("stdout does not start with the header README quotes");
    }
    const hashMatch = /payload hash: (sha256:[0-9a-f]+)/.exec(final.stderr);
    const actualHash = hashMatch?.[1] ?? null;
    if (actualHash !== claim.expectedHash) {
      mismatches.push(`stderr payload hash is ${JSON.stringify(actualHash)}; README claims ${JSON.stringify(claim.expectedHash)}`);
    }

    return {
      ok: mismatches.length === 0,
      command: claim.finalArgv.join(" "),
      transcript: claim.transcript,
      clonedHead,
      expected: { bytes: claim.expectedBytes, hash: claim.expectedHash },
      actual: { bytes: actualBytes, hash: actualHash },
      mismatches,
    };
  } finally {
    // Cleanup runs even on a thrown setup failure, so a broken build never leaves a stray clone
    // behind; nothing this script does ever writes outside `cloneRoot`.
    rmSync(cloneRoot, { recursive: true, force: true });
  }
}

function usage() {
  return [
    "dcompact clean-clone reproduction gate",
    "",
    "Usage:",
    "  node scripts/clean-clone-check.mjs [--json]",
    "",
    "Clones this repository's own HEAD into a temporary directory (never a network clone),",
    "installs from the lockfile and builds there with no inherited node_modules, runs the exact",
    "command README.md documents, and compares stdout, its byte count, and the stderr payload",
    "hash against the values README.md itself states.",
    "",
    "Options:",
    "  --json      Print one machine-readable report on stdout instead of the human summary.",
    "  --help, -h  Print this usage.",
    "",
    `Exit: ${EXIT_OK} reproduced, ${EXIT_MISMATCH} mismatch against README.md, ${EXIT_ERROR} usage or internal error.`,
  ].join("\n");
}

function summarize(report) {
  if (report.ok) {
    return `clean-clone-check: reproduced — ${report.command} at ${report.clonedHead.slice(0, 12)} matches README.md (${report.actual.bytes} bytes, ${report.actual.hash})`;
  }
  return ["clean-clone-check: mismatch", ...report.mismatches.map((line) => `  ${line}`)].join("\n");
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return EXIT_OK;
  }
  const unknown = argv.find((flag) => flag !== "--json");
  if (unknown !== undefined) throw new UsageError(`Unknown argument: ${JSON.stringify(unknown)}`);

  const report = runCleanCloneCheck();
  const output = argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : `${summarize(report)}\n`;
  process.stdout.write(output);
  return report.ok ? EXIT_OK : EXIT_MISMATCH;
}

// Only the direct CLI invocation runs the gate; `import`ing this module (as the test does) must
// not clone and build as a side effect of module load.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${usage()}\n`);
    } else {
      process.stderr.write(`clean-clone-check: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = EXIT_ERROR;
  }
}
