/**
 * Parent side of the process-level store tests: a child-runnable build of the store, and the
 * bounded waiting that keeps a stuck child a failure instead of a hung suite.
 *
 * `npm test` runs TypeScript through vitest, so there is no built `dist/` for a child `node` to
 * import. Transpiling the same sources into a temporary tree keeps those tests on the shipped
 * writer rather than a hand-written stand-in for it: the store's own `./x.js` specifiers resolve
 * inside the tree, and only types are removed.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** What a child needs to run the store: the engine, the store, and the writer it drives. */
const CHILD_ENTRY = "test/helpers/store-child.ts";
const CHILD_SOURCES = ["src", "test/helpers/store.ts", CHILD_ENTRY];

/** A child that has not finished by now is stuck, and the test says so instead of waiting. */
export const CHILD_TIMEOUT_MS = 60_000;

export interface ChildResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ChildRun {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly done: Promise<ChildResult>;
}

function typescriptFiles(root: string): string[] {
  const found: string[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, dirent.name);
    if (dirent.isDirectory()) found.push(...typescriptFiles(path));
    else if (dirent.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

function emit(source: string, build: string): void {
  const { outputText } = ts.transpileModule(readFileSync(source, "utf8"), {
    fileName: source,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const target = join(build, relative(REPOSITORY_ROOT, source).replace(/\.ts$/, ".js"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, outputText);
}

let build: string | null = null;

/** The transpiled tree, built once per process and removed by `closeStoreBuild`. */
export function storeBuild(): string {
  if (build === null) {
    const root = mkdtempSync(join(tmpdir(), "dcompress-og58-build-"));
    for (const source of CHILD_SOURCES) {
      const path = join(REPOSITORY_ROOT, source);
      for (const file of source.endsWith(".ts") ? [path] : typescriptFiles(path)) emit(file, root);
    }
    // The emitted files are `.js` with ESM syntax, and Node reads `.js` as CommonJS unless a
    // package.json says otherwise.
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    build = root;
  }
  return build;
}

export function closeStoreBuild(): void {
  if (build === null) return;
  rmSync(build, { recursive: true, force: true });
  build = null;
}

/** Start one child writer; `mode` and `options` are the two arguments `store-child.ts` expects. */
export function startChild(mode: string, options: unknown): ChildRun {
  const child = spawn(process.execPath, [join(storeBuild(), CHILD_ENTRY.replace(/\.ts$/, ".js")), mode, JSON.stringify(options)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const done = new Promise<ChildResult>((resolve) => {
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
  if (child.pid === undefined) throw new Error("the child process did not start");
  return { child, pid: child.pid, done };
}

/** Fail the test rather than hang it when a child stops making progress. */
export async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish within ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Wait for a condition a peer process produces; the condition is the signal, not the interval. */
export async function pollUntil(check: () => boolean, milliseconds: number, label: string): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${label} was not observed within ${milliseconds} ms`);
    // Node 20 has no `Promise.withResolvers`, so the executor form is the portable one here.
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** The single JSON line a child writer reports its outcome on. */
export function childReport(result: ChildResult, label: string): Record<string, unknown> {
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  if (line === "") throw new Error(`${label} reported nothing on stdout (exit ${String(result.code)}, stderr: ${result.stderr})`);
  return JSON.parse(line) as Record<string, unknown>;
}