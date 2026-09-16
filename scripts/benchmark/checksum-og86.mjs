import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * OG-86 freeze manifest generator.
 *
 * The manifest covers everything that can change a result: the benchmark
 * directory recursively, plus an explicit allowlist of execution utilities
 * outside it. Two curated sources, one row format, no repo walk.
 *
 * Four guards make an unsafe path unreachable:
 *
 *  1. tracked-only   — every covered path must be tracked by Git, so private
 *                      spill (sessions/, dist/, node_modules/) can never enter
 *  2. no symlinks    — `lstatSync` is used, never `statSync`
 *  3. containment    — every resolved path stays inside the repository root,
 *                      and is not ignored by Git
 *  4. exclusions     — the manifest itself and `arms/` are excluded, and an
 *                      empty row set is refused rather than written
 *
 * The manifest never hashes itself. It is bound by the commit tree instead: any
 * tampering changes the file, and the tree hash covers it. The generator *is* a
 * covered row, which is not a paradox — it is a different file from the manifest
 * it writes.
 *
 * Row format is unchanged: `<64-hex>  <path relative to the benchmark dir>`.
 * An external file therefore appears as `../../../<repo-path>`, which the
 * existing benchmark spec already parses and verifies.
 */

/** Execution utilities that can change a result, in repo-relative form. */
export const EXTERNAL_ALLOWLIST = Object.freeze([
  "scripts/benchmark/checksum-og86.mjs",
  "scripts/benchmark/generate-og86-inputs.mjs",
  "scripts/benchmark/og86-binding.mjs",
  "scripts/benchmark/privacy-scan-og86.mjs",
  "scripts/benchmark/run-og86-medium.mjs",
  "scripts/benchmark/run-og86-stage0.mjs",
  "scripts/benchmark/score-og86.mjs",
  "test/og86-benchmark.spec.ts",
  "test/og86-controller.spec.ts",
  "vitest.config.ts",
  "eslint.config.js",
  "tsconfig.json",
  "package.json",
  "package-lock.json",
]);

export const BENCHMARK_RELATIVE = "docs/benchmark/og86-medium-v1";

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

/** True when Git tracks this path. The load-bearing guard against private spill. */
export function isTracked(repository, absolutePath, relativePath = null) {
  const label = relativePath ?? relative(repository, absolutePath);
  const result = git(["ls-files", "--error-unmatch", "--", label], repository);
  return result.status === 0;
}

/**
 * True when Git ignores this path, which forbids it from the manifest.
 *
 * A gitignore pattern written with a trailing slash (`sessions/`, `dist/`)
 * only ever matches a directory, and Git can only tell the bare name is a
 * directory when one actually exists on disk at query time -- so checking
 * only the bare name makes this function's answer depend on incidental
 * filesystem state (measured: `dist` matches bare because a build had
 * already produced it; `sessions`, never created in this repository, does
 * not, even though both are directory-only patterns in the same file).
 * Checking the path with a trailing slash as well is Git's own documented
 * way to ask "would this be ignored as a directory" without requiring one
 * to exist, and makes the answer the same whether or not a prior step
 * happened to create it.
 */
export function isIgnored(repository, relativePath) {
  const bare = git(["check-ignore", "--quiet", "--", relativePath], repository);
  // check-ignore exits 0 when ignored, 1 when not ignored, 128 on error.
  if (bare.status === 0) return true;
  const asDirectory = git(["check-ignore", "--quiet", "--", `${relativePath}/`], repository);
  return asDirectory.status === 0;
}

/**
 * Every file under the benchmark directory, recursively, excluding the manifest
 * and `arms/`. Symlinks are reported rather than followed.
 */
export function collectBenchmarkFiles(benchmarkRoot) {
  const manifestPath = join(benchmarkRoot, "checksums.sha256");
  const files = [];
  const symlinks = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        symlinks.push(path);
        continue;
      }
      if (stats.isDirectory()) {
        if (relative(benchmarkRoot, path) === "arms") continue;
        walk(path);
        continue;
      }
      if (path === manifestPath) continue;
      files.push(path);
    }
  };
  walk(benchmarkRoot);
  return { files, symlinks };
}

/**
 * Build the manifest rows.
 *
 * Returns the rows plus a report of anything the guards refused, so a caller can
 * fail loudly instead of silently shipping a short manifest.
 */
/**
 * Validate the benchmark root itself before walking it.
 *
 * The root is the anchor every in-tree row is relative to, so a symlinked or
 * out-of-repository root would silently relocate the whole manifest. `lstatSync`
 * is used so a link is seen rather than followed.
 */
export function validateBenchmarkRoot({ repository, benchmarkRoot }) {
  const failures = [];
  const repoRoot = resolve(repository);
  const root = resolve(benchmarkRoot);
  if (root !== repoRoot && !root.startsWith(`${repoRoot}${sep}`)) failures.push("outside-repository");
  let stats = null;
  try {
    stats = lstatSync(root);
  } catch {
    return { ok: false, failures: ["missing"], benchmarkRoot: root };
  }
  if (stats.isSymbolicLink()) failures.push("symlink");
  else if (!stats.isDirectory()) failures.push("not-a-directory");
  return { ok: failures.length === 0, failures, benchmarkRoot: root };
}

export function buildManifest({ repository, benchmarkRoot }) {
  const refusals = [];
  const root = validateBenchmarkRoot({ repository, benchmarkRoot });
  if (!root.ok) {
    for (const failure of root.failures) refusals.push({ path: relative(repository, root.benchmarkRoot) || ".", reason: `benchmark-root:${failure}` });
    return { rows: [], refusals };
  }

  const { files, symlinks } = collectBenchmarkFiles(benchmarkRoot);
  for (const path of symlinks) refusals.push({ path: relative(repository, path), reason: "symlink" });

  const covered = [];
  for (const path of files) {
    const rel = relative(repository, path);
    const absolute = resolve(path);
    // The same containment, ignore, and tracked guard the external allowlist
    // carries. An in-tree row is not privileged just because it sits under the
    // benchmark directory.
    if (absolute !== resolve(repository) && !absolute.startsWith(`${resolve(repository)}${sep}`)) {
      refusals.push({ path: rel, reason: "outside-repository" });
      continue;
    }
    if (isIgnored(repository, rel)) {
      refusals.push({ path: rel, reason: "git-ignored" });
      continue;
    }
    if (!isTracked(repository, absolute, rel)) {
      refusals.push({ path: rel, reason: "untracked" });
      continue;
    }
    covered.push({ absolute, relativeToBenchmark: relative(benchmarkRoot, path) });
  }

  for (const rel of EXTERNAL_ALLOWLIST) {
    const absolute = resolve(repository, rel);
    // Containment: a resolved path must stay inside the repository.
    if (absolute !== resolve(repository) && !absolute.startsWith(`${resolve(repository)}${sep}`)) {
      refusals.push({ path: rel, reason: "outside-repository" });
      continue;
    }
    if (!isTracked(repository, absolute, rel)) {
      refusals.push({ path: rel, reason: "untracked" });
      continue;
    }
    if (isIgnored(repository, rel)) {
      refusals.push({ path: rel, reason: "git-ignored" });
      continue;
    }
    let stats = null;
    try {
      stats = lstatSync(absolute);
    } catch {
      refusals.push({ path: rel, reason: "missing" });
      continue;
    }
    if (stats.isSymbolicLink()) {
      refusals.push({ path: rel, reason: "symlink" });
      continue;
    }
    if (!stats.isFile()) {
      refusals.push({ path: rel, reason: "not-a-file" });
      continue;
    }
    covered.push({ absolute, relativeToBenchmark: relative(benchmarkRoot, absolute) });
  }

  const rows = covered
    .map((entry) => ({
      digest: createHash("sha256").update(readFileSync(entry.absolute)).digest("hex"),
      path: entry.relativeToBenchmark.replaceAll("\\", "/"),
    }))
    // Deterministic ordering, independent of discovery order.
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  return { rows, refusals };
}

/** Serialize rows in the frozen `digest  path` format. */
export function renderManifest(rows) {
  return `${rows.map((row) => `${row.digest}  ${row.path}`).join("\n")}\n`;
}

function main() {
  const repository = resolve(process.cwd());
  const benchmarkRoot = resolve(process.argv[2] ?? BENCHMARK_RELATIVE);
  const manifestPath = join(benchmarkRoot, "checksums.sha256");
  const { rows, refusals } = buildManifest({ repository, benchmarkRoot });

  if (refusals.length > 0) {
    process.stderr.write(`${JSON.stringify({ ok: false, refusals }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  // A short manifest is worse than none: refuse rather than write one.
  if (rows.length === 0) {
    throw new Error("refusing to write an empty manifest");
  }
  if (rows.some((row) => resolve(benchmarkRoot, row.path) === manifestPath)) {
    throw new Error("refusing to hash the manifest itself");
  }
  writeFileSync(manifestPath, renderManifest(rows), "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, rows: rows.length })}\n`);
}

if (process.argv[1]?.endsWith("checksum-og86.mjs")) main();
