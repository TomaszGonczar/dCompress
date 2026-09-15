import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const scanner = fileURLToPath(new URL("../scripts/privacy-scan.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

interface Finding {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly commit?: string;
}

interface Report {
  readonly ok: boolean;
  readonly mode: "tree" | "history";
  readonly scanned: Record<string, number>;
  readonly identity: readonly Record<string, unknown>[];
  readonly allowlisted: readonly { readonly id: string; readonly occurrences: number }[];
  readonly findings: readonly Finding[];
}

function runScanner(args: readonly string[], cwd: string) {
  return spawnSync(process.execPath, [scanner, ...args], { cwd, encoding: "utf8" });
}

function reportFrom(args: readonly string[], cwd: string): { status: number | null; stdout: string; stderr: string; report: Report } {
  const result = runScanner(["--json", ...args], cwd);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, report: JSON.parse(result.stdout) as Report };
}

// Secrets are assembled from fragments so that this file — which the gate scans along with the rest
// of the repository — holds no secret-shaped literal. An exemption for a secret is the one thing
// the exemption table must never grow, and a committed fixture would force one.
const assemble = (...parts: string[]): string => parts.join("");

const POSIX_HOME = ["", "Users", "fixturelogin", "private", "notes.txt"].join("/");
const WINDOWS_HOME = ["C:", "Users", "FixtureLogin", "private", "notes.txt"].join("\\");
const SESSION_UUID = ["7b1d9f04", "3c2a", "4e5b", "9f01", "a2b3c4d5e6f7"].join("-");
const BEARER_TOKEN = assemble("Bearer ", "A1b2C3d4E5f6G7h8I9j0K1l2");
const API_KEY = assemble("ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6");
const EMAIL = ["fixture.person", "example.test"].join("@");
const NEAR_MISS = assemble("/Users/alice", "2/private/notes.txt");
const ACCOUNT = userInfo().username;
const TILDE_HOME = assemble("~", ACCOUNT, "/notes.md");
const HOSTNAME = hostname();
const HOST_REFERENCE = assemble(HOSTNAME, ":9200");

const SECRETS = [POSIX_HOME, WINDOWS_HOME, SESSION_UUID, BEARER_TOKEN, API_KEY, EMAIL, TILDE_HOME, HOST_REFERENCE];

const temporaryDirectories: string[] = [];

function makeFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "privacy-scan-"));
  temporaryDirectories.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "pipe" });
}

function commit(cwd: string, message: string): void {
  // Signing is disabled per invocation: a contributor with gpgsign on would otherwise fail the
  // throwaway repository, and the test is about what the commit contains, not who made it.
  git(cwd, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
}

const SECRET_TREE = makeFixture({
  "paths.txt": `${POSIX_HOME}\n${WINDOWS_HOME}\n`,
  "session.json": `{"sessionId": "${SESSION_UUID}"}\n`,
  "credentials.env": `${BEARER_TOKEN}\n${API_KEY}\n`,
  "contacts.md": `${EMAIL}\n${TILDE_HOME}\n${HOST_REFERENCE}\n`,
});
const CLEAN_TREE = makeFixture({ "module.ts": "export const answer: number = 42;\n" });
const BINARY_TREE = makeFixture({ "blob.bin": `\u0000${API_KEY}\n` });
const EXEMPTION_TREE = makeFixture({
  "docs/SCHEMA.md": `${NEAR_MISS}\n`,
});

let historyRepository = "";

beforeAll(() => {
  historyRepository = mkdtempSync(join(tmpdir(), "privacy-scan-history-"));
  temporaryDirectories.push(historyRepository);
  git(historyRepository, ["init", "-q"]);
  git(historyRepository, ["config", "user.name", "privacy scan"]);
  git(historyRepository, ["config", "user.email", assemble("privacy-scan", "example.invalid")]);
  writeFileSync(join(historyRepository, "readme.md"), "baseline\n");
  git(historyRepository, ["add", "-A"]);
  commit(historyRepository, "baseline");
  writeFileSync(join(historyRepository, "notes.txt"), `${API_KEY}\n`);
  git(historyRepository, ["add", "-A"]);
  commit(historyRepository, "add notes");
  rmSync(join(historyRepository, "notes.txt"));
  git(historyRepository, ["add", "-A"]);
  commit(historyRepository, "remove notes");
});

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("privacy scan of a tree", () => {
  it("detects each class of secret it claims to detect", () => {
    const { status, report } = reportFrom([SECRET_TREE], repositoryRoot);
    expect(status).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.mode).toBe("tree");
    const rules = [...new Set(report.findings.map((finding) => finding.rule))].sort();
    expect(rules).toEqual(
      expect.arrayContaining([
        "posix-home-path",
        "windows-user-path",
        "session-uuid",
        "bearer-token",
        "api-key",
        "email-address",
        "local-user-name",
        "local-host-name",
      ]),
    );
    for (const finding of report.findings) {
      expect(finding.line).toBeGreaterThan(0);
    }
  });

  it("reports where a finding is without ever repeating what was found", () => {
    const human = runScanner([SECRET_TREE], repositoryRoot);
    const machine = runScanner(["--json", SECRET_TREE], repositoryRoot);
    for (const output of [human.stdout, human.stderr, machine.stdout, machine.stderr]) {
      for (const secret of SECRETS) {
        expect(output).not.toContain(secret);
      }
    }
    const report = JSON.parse(machine.stdout) as Report;
    expect(report.findings.length).toBeGreaterThan(0);
    // The identity the scan runs as is itself confidential for the same reason: a report that named
    // it would leak the account it was protecting.
    const identity = JSON.stringify(report.identity);
    expect(identity).not.toContain(ACCOUNT);
    expect(identity).not.toContain(HOSTNAME);
  });

  it("passes a tree with nothing to find", () => {
    const { status, report } = reportFrom([CLEAN_TREE], repositoryRoot);
    expect(status).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("counts a binary file as unscanned instead of reporting it clean", () => {
    const { status, report } = reportFrom([BINARY_TREE], repositoryRoot);
    expect(status).toBe(0);
    expect(report.scanned.binary).toBe(1);
    expect(report.scanned.files).toBe(0);
  });

  it("exempts the literal it names and nothing that merely starts with it", () => {
    const { status, report } = reportFrom([EXEMPTION_TREE], repositoryRoot);
    expect(status).toBe(1);
    expect(report.findings.map((finding) => finding.rule)).toEqual(["posix-home-path"]);
    expect(report.findings[0]?.file).toBe("docs/SCHEMA.md");
  });

  it("refuses a history range that git would read as an option", () => {
    const result = runScanner(["--history", "-n1"], repositoryRoot);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--history requires a git range");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails closed on a file it cannot read, rather than calling the tree clean",
    () => {
      // A gate that skips what it could not open is a gate that passes on exactly the file someone
      // hid. Permission bits are what make it unreadable and root ignores them, so there is nothing
      // to assert under root: this is skipped there rather than weakened.
      const locked = makeFixture({ "unreadable.txt": "content the scan never gets to read\n" });
      const file = join(locked, "unreadable.txt");
      chmodSync(file, 0o000);
      try {
        const { status, report } = reportFrom([locked], repositoryRoot);
        expect(status).toBe(1);
        expect(report.findings).toEqual([{ rule: "scan-incomplete", file: "unreadable.txt", line: 0 }]);
      } finally {
        chmodSync(file, 0o600);
      }
    },
  );
});

describe("privacy scan of added history", () => {
  it("finds a secret that a later commit deleted, and finds nothing in the tree", () => {
    const tree = reportFrom([historyRepository], repositoryRoot);
    expect(tree.status).toBe(0);
    expect(tree.report.findings).toEqual([]);

    const history = reportFrom(["--history", "HEAD"], historyRepository);
    expect(history.status).toBe(1);
    const findings = history.report.findings.filter((finding) => finding.rule === "api-key");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("notes.txt");
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.commit).toBeDefined();
    expect(history.report.scanned.commits).toBe(3);
  });

  it("scans only the commits the range names", () => {
    // The newest commit only removes the file, so a scan of that commit alone must be clean even
    // though the commit before it added the secret.
    const deletion = reportFrom(["--history", "HEAD~1..HEAD"], historyRepository);
    expect(deletion.status).toBe(0);
    expect(deletion.report.findings).toEqual([]);
    expect(deletion.report.scanned.addedLines).toBe(0);
  });
});

describe("privacy policy of this repository", () => {
  it("has nothing to find and no exemption it no longer needs", () => {
    const { status, report } = reportFrom(["."], repositoryRoot);
    expect(status).toBe(0);
    expect(report.findings).toEqual([]);
    expect(report.allowlisted.length).toBeGreaterThan(0);
    for (const entry of report.allowlisted) {
      // An exemption that suppresses nothing is a standing permission that nobody is watching.
      expect(entry.occurrences).toBeGreaterThan(0);
    }
  });
});