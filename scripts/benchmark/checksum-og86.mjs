import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "docs/benchmark/og86-medium-v1");

function files(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).sort().flatMap((name) => files(join(path, name)));
}

const manifestPath = join(root, "checksums.sha256");
const rows = files(root)
  .filter((path) => path !== manifestPath && !relative(root, path).startsWith(`arms${process.platform === "win32" ? "\\" : "/"}`))
  .map((path) => `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${relative(root, path).replaceAll("\\", "/")}`);
writeFileSync(manifestPath, `${rows.join("\n")}\n`, "utf8");
