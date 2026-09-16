#!/usr/bin/env node
/**
 * Repository privacy scan — the publication gate.
 *
 * Why it looks like this:
 *
 * - **Deleting a file does not undo a leak.** GitHub keeps reachable objects, so a path or token
 *   added in one commit and removed in the next is still readable from the repository. That is why
 *   `--history` reads the content commits *added* instead of the checked-out tree, and why a
 *   deleted file is still a finding.
 * - **A scanner that prints what it found has published it.** CI logs of a public repository are
 *   public. Every report carries the rule, the file, and the line, never the matched text.
 * - **An exemption must not be able to hide a leak it does not name.** Each allowlist entry is one
 *   exact literal with a reason. The literal is blanked to spaces — same length, so line numbers
 *   and columns survive — before matching, and the number of blanked occurrences is reported, so a
 *   reader can see exactly how much latitude an entry has bought. Nothing here is a pattern.
 * - **Identity rules are machine-derived.** The login name and host name come from the running
 *   user, so the scan means something on a contributor's laptop and not only in CI. They match only
 *   the syntax in which an identity actually leaks — home paths, account references, host
 *   references — because matching the bare word would fire on ordinary prose ("the test runner" on
 *   a CI runner whose login name is `runner`) and leave a contributor with nothing to do but weaken
 *   the gate.
 * - **A blind spot is a failure, not a pass.** A file the scan cannot read is reported as a finding
 *   of its own kind, so the gate fails closed rather than reporting a clean tree it did not read.
 *
 * Usage:
 *   node scripts/privacy-scan.mjs [path ...] [--json]
 *   node scripts/privacy-scan.mjs --history <range> [--json]
 *
 * Streams: the report is the only stdout output, so `--json` is safe to parse. Usage errors go to
 * stderr. Exit: 0 clean, 1 findings (or an unscanned file), 2 usage error.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, join, relative, resolve } from "node:path";
// Imported rather than taken from the global scope: the lint config treats the ambient `process`
// as undefined, and an explicit import is what keeps the file lint-clean without touching it.
import process from "node:process";

const EXIT_CLEAN = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;

/** Directories that hold generated or tool-owned content, never a committed artifact. */
const SKIPPED_DIRECTORY = { node_modules: true, dist: true, ".git": true };

/**
 * Exact literals the repository is allowed to contain, each with the reason it is not a leak.
 *
 * These are the repository's own placeholders and sandbox identities, and each is a fixed string
 * that names no real person: tests that prove the sanitizer strips `/Users/alice/...` have to
 * contain it, and the development sandbox really does run as `/home/agent`. A finding that is not
 * one of these is a finding.
 */
const ALLOWLIST = [
  {
    id: "sanitizer-test-home",
    literal: "/Users/alice",
    reason: "placeholder login used by the path-sanitizer tests, which must contain a host path to prove it is stripped",
  },
  {
    id: "sanitizer-test-linux-home",
    literal: "/home/alice",
    reason: "the Linux form of the same placeholder, asserted by the same tests",
  },
  {
    id: "sanitizer-test-windows-home",
    // Assembled from fragments on purpose. A separator written in source is two characters, so a
    // literal here would appear in this file as the doubled spelling — which the Windows rule
    // matches, and which this entry, holding the two-character spelling the tests contain, could
    // not blank. That would leave the scan's own source reported by its own gate.
    literal: ["C:", "\\", "\\", "Users", "\\", "\\", "Ada"].join(""),
    reason: "the Windows form of the same placeholder; doubled separators are how it appears in TypeScript source",
  },
  {
    id: "sandbox-home",
    literal: "/home/agent",
    reason: "the development sandbox's own fixed home directory in tools/sandbox and tools/agent-run; not a contributor's machine",
  },
  {
    id: "sandbox-git-identity",
    literal: "agent@dcompress.local",
    reason: "the sandbox's throwaway git identity, committed by tools/agent-run; a non-routable mDNS name, not an address",
  },
  {
    id: "sandbox-git-identity-pre-rebrand",
    literal: "agent@dcompact.local",
    reason: "the sandbox's throwaway git identity under the tool's former name, present in history before the dcompact-to-dcompress rebrand; the same non-routable mDNS name as sandbox-git-identity, spelled the old way",
  },
  {
    id: "og86-fixture-git-identity",
    literal: "og86-fixture@example.invalid",
    reason: "throwaway git identity for a disposable temp-directory repo the OG-86 seed-manifest tests create and destroy per test; example.invalid is the IANA-reserved domain for exactly this (RFC 2606), not a routable address",
  },
];

/**
 * Shape rules. Each is a transcript-independent pattern for something that must never be published:
 * a host path, a session identifier, a credential, or an address.
 */
const SHAPE_RULES = [
  {
    id: "posix-home-path",
    label: "POSIX home directory path",
    // The trailing separator is not required: an exported `HOME=/Users/<name>` is the same leak as a
    // path that continues into a file.
    pattern: /(?:\/Users|\/home)\/[A-Za-z0-9._-]+/g,
  },
  {
    id: "windows-user-path",
    label: "Windows user profile path",
    // The `(?<!\w)` guard keeps a URI scheme's `Users` segment out: `file:\Users\x` is the URI
    // form, not a drive path, while a drive letter is always preceded by a boundary.
    pattern: /(?<!\w)[A-Za-z]:\\+Users\\+[^\\\s"'`]+/g,
  },
  {
    id: "session-uuid",
    label: "session-id-shaped UUID",
    // Versions 1-8 with a valid RFC 4122 variant nibble: Claude session ids are v4, and v6-v8 are
    // the modern forms. A looser shape would report any dashed hex run, including fixtures' own
    // hashes.
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  },
  {
    id: "bearer-token",
    label: "bearer token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  },
  {
    id: "api-key",
    label: "API key or access token",
    // Prefixes that vendors reserve for issued credentials. The bodies are long, so the length
    // floor keeps ordinary identifiers such as `npm_config_cache` out of the report.
    pattern: /\b(?:sk-|gsk_|hf_|pypi-|npm_|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|dckr_pat_|xox[abpros]-|AKIA|ASIA|AIza|ya29\.)[A-Za-z0-9_-]{16,}/g,
  },
  {
    id: "email-address",
    label: "email address",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  },
];

/** A short host label is only evidence when it is long enough not to be an ordinary word. */
const SHORTEST_HOST_LABEL = 6;

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The scan's own identity: the account and host it runs as, turned into rules scoped to the syntax
 * that carries an identity. See the module comment for why bare words are not matched.
 */
function identityRules() {
  const account = userInfo().username;
  const host = hostname();
  const shortHost = host.includes(".") ? host.slice(0, host.indexOf(".")) : "";
  const needles = [
    { kind: "user-name", value: account, minimum: 1, scope: "account" },
    { kind: "host-name", value: host, minimum: 1, scope: "host" },
    { kind: "host-label", value: shortHost, minimum: SHORTEST_HOST_LABEL, scope: "host" },
  ];

  const rules = [];
  const report = [];
  for (const needle of needles) {
    const active = needle.value.length >= needle.minimum;
    report.push({
      kind: needle.kind,
      length: needle.value.length,
      active,
      // The value itself is never reported: it is the identity the scan exists to protect.
      ...(active ? {} : { skipped: `shorter than ${needle.minimum} characters, which would match ordinary prose` }),
    });
    if (!active) continue;
    const escaped = escapeRegExp(needle.value);
    const pattern = needle.scope === "account"
      // A home or account reference: a POSIX home prefix, a tilde prefix, a drive-qualified profile
      // prefix, a UNC server, or an account. Prose that merely mentions the word is not evidence.
      ? new RegExp(`(?:~|/Users/|/home/|[A-Za-z]:\\\\+Users\\\\+|\\\\)${escaped}(?![A-Za-z0-9._-])|\\b${escaped}@`, "gi")
      // A host reference: user@HOST, \\HOST, HOST:path, HOST/path, HOST\share.
      : new RegExp(`(?:@|\\\\)${escaped}(?![A-Za-z0-9._-])|(?<![A-Za-z0-9._-])${escaped}(?=[:/\\\\])`, "gi");
    rules.push({ id: `local-${needle.kind}`, label: `this machine's ${needle.kind.replace("-", " ")}`, pattern });
  }
  return { rules, report };
}

/**
 * Blank every allowlisted literal, keeping its length so line and column numbers do not move.
 *
 * An occurrence is exempt only when it ends at a token boundary. Without that check an exempted
 * login placeholder would also hide a different, unexempted login that merely starts with the same
 * characters — an exemption must not be able to cover a leak it does not name.
 */
function applyAllowlist(text) {
  const occurrences = [];
  let stripped = text;
  for (const entry of ALLOWLIST) {
    let count = 0;
    let index = stripped.indexOf(entry.literal);
    while (index >= 0) {
      const after = stripped[index + entry.literal.length];
      if (after !== undefined && /[A-Za-z0-9._-]/.test(after)) {
        index = stripped.indexOf(entry.literal, index + 1);
        continue;
      }
      count += 1;
      stripped = `${stripped.slice(0, index)}${" ".repeat(entry.literal.length)}${stripped.slice(index + entry.literal.length)}`;
      index = stripped.indexOf(entry.literal, index + entry.literal.length);
    }
    occurrences.push({ id: entry.id, occurrences: count });
  }
  return { stripped, occurrences };
}

/**
 * Scan one chunk of text, folding how much of it the allowlist absorbed into the run's totals.
 *
 * Both modes call this and nothing else, so tree and history scans cannot drift apart in what they
 * exempt or in what they count.
 */
function scanText(text, rules, file, extra, allowlisted) {
  const { stripped, occurrences } = applyAllowlist(text);
  for (const entry of occurrences) {
    allowlisted.set(entry.id, (allowlisted.get(entry.id) ?? 0) + entry.occurrences);
  }
  const findings = [];
  // A chunk that is one added line carries its own number in the new file; the chunk alone cannot
  // say where it sits, so the caller passes it and the report stops claiming line 1 for everything.
  const { baseLine = 0, ...rest } = extra;
  for (const [offset, line] of stripped.split("\n").entries()) {
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      let match = rule.pattern.exec(line);
      while (match !== null) {
        findings.push({ rule: rule.id, file, line: baseLine + offset + 1, ...rest });
        if (match[0].length === 0) rule.pattern.lastIndex += 1;
        match = rule.pattern.exec(line);
      }
    }
  }
  return findings;
}

/** A NUL byte in the first block is the usual signal that a file is not text we can reason about. */
function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

function walk(root, state) {
  const files = [];
  const visit = (path) => {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      state.unreadable.push(relative(root, path));
      return;
    }
    if (stats.isSymbolicLink()) {
      state.symlinks += 1;
      return;
    }
    if (stats.isDirectory()) {
      let names;
      try {
        names = readdirSync(path).sort();
      } catch {
        state.unreadable.push(relative(root, path));
        return;
      }
      for (const name of names) {
        if (SKIPPED_DIRECTORY[name] === true) continue;
        visit(join(path, name));
      }
      return;
    }
    if (!stats.isFile()) return;
    files.push(path);
  };
  visit(root);
  return files;
}

function scanPaths(paths) {
  const identity = identityRules();
  const rules = [...SHAPE_RULES, ...identity.rules];
  const findings = [];
  const allowlisted = new Map(ALLOWLIST.map((entry) => [entry.id, 0]));
  const state = { symlinks: 0, unreadable: [] };
  let scannedFiles = 0;
  let scannedBytes = 0;
  let binary = 0;

  for (const target of paths) {
    const root = resolve(target);
    try {
      statSync(root);
    } catch {
      // A path the caller named and the process cannot see is a mistake in the invocation, not a
      // finding: say so instead of reporting a clean tree over nothing.
      throw new UsageError(`Cannot read ${JSON.stringify(target)}: pass a path that exists`);
    }
    for (const file of walk(root, state)) {
      let buffer;
      try {
        buffer = readFileSync(file);
      } catch {
        state.unreadable.push(relative(root, file));
        continue;
      }
      if (isBinary(buffer)) {
        binary += 1;
        continue;
      }
      scannedFiles += 1;
      scannedBytes += buffer.byteLength;
      findings.push(...scanText(buffer.toString("utf8"), rules, relative(root, file) || basename(file), {}, allowlisted));
    }
  }

  for (const path of state.unreadable) {
    findings.push({ rule: "scan-incomplete", file: path, line: 0 });
  }
  findings.sort(compareFindings);
  return {
    mode: "tree",
    roots: paths,
    scanned: { files: scannedFiles, bytes: scannedBytes, binary, symlinks: state.symlinks, unreadable: state.unreadable.length },
    identity: identity.report,
    allowlisted: [...allowlisted].map(([id, occurrences]) => ({ id, occurrences })),
    findings,
  };
}

function compareFindings(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.rule.localeCompare(right.rule) ||
    String(left.commit ?? "").localeCompare(String(right.commit ?? ""))
  );
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Added content only: a line that no longer exists in the worktree still exists in the object
 * store and in any GitHub-retained ref, so the diff — not the checkout — is the thing to read.
 */
function addedLinesFromPatch(patch, commit) {
  const entries = [];
  let file = null;
  let line = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).trim();
      file = path === "/dev/null" ? null : path.replace(/^b\//, "");
      continue;
    }
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk !== null) {
      line = Number(hunk[1]);
      continue;
    }
    if (file === null) continue;
    if (raw.startsWith("+")) {
      entries.push({ file, line, text: raw.slice(1), commit });
      line += 1;
    }
  }
  return entries;
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const reason = (error.stderr ?? error.message ?? "").toString().split("\n")[0].trim();
    throw new UsageError(`git ${args[0]} failed for ${JSON.stringify(args.at(-1) ?? "")}: ${reason}`);
  }
}

function scanHistory(range) {
  const identity = identityRules();
  const rules = [...SHAPE_RULES, ...identity.rules];
  const commits = git(["log", "--format=%H", range]).split("\n").filter((line) => line.length > 0);
  const findings = [];
  const allowlisted = new Map(ALLOWLIST.map((entry) => [entry.id, 0]));
  let addedLines = 0;
  const files = new Set();

  for (const commit of commits) {
    // `-m --first-parent` makes a merge report the content it introduced relative to the branch it
    // landed on; without it a merge commit contributes no diff at all.
    const patch = git(["show", "--format=", "--no-color", "--unified=0", "--no-renames", "--diff-filter=ACMR", "-m", "--first-parent", commit]);
    for (const entry of addedLinesFromPatch(patch, commit)) {
      addedLines += 1;
      files.add(entry.file);
      findings.push(...scanText(entry.text, rules, entry.file, { commit: commit.slice(0, 12), baseLine: entry.line - 1 }, allowlisted));
    }
  }

  findings.sort(compareFindings);
  return {
    mode: "history",
    range,
    scanned: { commits: commits.length, files: files.size, addedLines },
    identity: identity.report,
    allowlisted: [...allowlisted].map(([id, occurrences]) => ({ id, occurrences })),
    findings,
  };
}

export class UsageError extends Error {}

function usage() {
  return [
    "dcompress privacy scan — the repository publication gate",
    "",
    "Usage:",
    "  node scripts/privacy-scan.mjs [path ...] [--json]",
    "  node scripts/privacy-scan.mjs --history <range> [--json]",
    "",
    "Modes:",
    "  (default)   Scan the given paths, or the working tree when none are given.",
    `              ${Object.keys(SKIPPED_DIRECTORY).join(", ")} are never entered. Binary files are skipped.`,
    "  --history   Scan the content added by the commits in a git range, e.g. origin/main..HEAD.",
    "              Added lines only: a secret added and later deleted is still reachable.",
    "",
    "Options:",
    "  --json      Print one machine-readable report on stdout instead of the human summary.",
    "  --help, -h  Print this usage.",
    "",
    "Rules: host paths, session-id-shaped UUIDs, bearer tokens, API key prefixes, email addresses,",
    "and the user name and host name of the machine this runs on. Reports carry the rule, file, and",
    "line only — never the matched text, because CI logs are public.",
    "",
    `Exit: ${EXIT_CLEAN} clean, ${EXIT_FINDINGS} findings or an unscanned file, ${EXIT_USAGE} usage error.`,
  ].join("\n");
}

function parseArgs(argv) {
  const paths = [];
  let json = false;
  let range = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return "help";
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--history") {
      const value = argv[index + 1];
      // A range never starts with a dash, and git would read one as an option rather than a
      // revision, so this is refused before it reaches the argument array.
      if (value === undefined || value.startsWith("-")) throw new UsageError("--history requires a git range, e.g. origin/main..HEAD");
      range = value;
      index += 1;
      continue;
    }
    if (flag.startsWith("--")) throw new UsageError(`Unknown argument: ${JSON.stringify(flag)}`);
    paths.push(flag);
  }
  if (range !== null && paths.length > 0) throw new UsageError("--history scans commits, so it takes no paths");
  if (range !== null && range.trim() === "") throw new UsageError("--history requires a non-empty git range");
  return { json, range, paths };
}

function summarize(report) {
  const lines = [];
  const where = report.mode === "history"
    ? `the commits in ${report.range} (${report.scanned.commits} commits, ${report.scanned.files} files, ${report.scanned.addedLines} added lines)`
    : `${report.scanned.files} files in ${report.roots.join(" ")}`;
  if (report.findings.length === 0) {
    lines.push(`privacy-scan: clean — no finding across ${where}`);
  } else {
    lines.push(`privacy-scan: ${report.findings.length} finding${report.findings.length === 1 ? "" : "s"} across ${where}`);
    for (const finding of report.findings) {
      const commit = finding.commit === undefined ? "" : ` (${finding.commit})`;
      const line = finding.line === 0 ? "" : `:${finding.line}`;
      lines.push(`  ${finding.rule} ${finding.file}${line}${commit}`);
    }
  }
  const allowed = report.allowlisted.filter((entry) => entry.occurrences > 0);
  for (const entry of allowed) lines.push(`privacy-scan: allowlist ${entry.id} suppressed ${entry.occurrences} occurrence(s)`);
  for (const needle of report.identity) {
    const state = needle.active ? "active" : `skipped (${needle.skipped})`;
    lines.push(`privacy-scan: identity ${needle.kind} ${state}`);
  }
  if (report.mode === "tree" && report.scanned.binary > 0) lines.push(`privacy-scan: ${report.scanned.binary} binary file(s) not scanned`);
  return lines.join("\n");
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed === "help") {
    process.stdout.write(`${usage()}\n`);
    return EXIT_CLEAN;
  }
  const report = parsed.range === null ? scanPaths(parsed.paths.length > 0 ? parsed.paths : ["."]) : scanHistory(parsed.range);
  const output = parsed.json ? `${JSON.stringify({ ok: report.findings.length === 0, ...report }, null, 2)}\n` : `${summarize(report)}\n`;
  process.stdout.write(output);
  return report.findings.length === 0 ? EXIT_CLEAN : EXIT_FINDINGS;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = EXIT_USAGE;
  } else {
    process.stderr.write(`privacy-scan: internal error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT_USAGE;
  }
}