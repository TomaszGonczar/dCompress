import type {
  CanonicalValue,
  ErrorClass,
  Fact,
  NormalizedPath,
  PathNormalizationOptions,
} from "./types.js";

const FACT_PRIORITIES: Record<Fact["kind"], number> = {
  "decision.stated": 5,
  "error.raised": 10,
  "error.fixed": 15,
  "file.created": 20,
  "file.deleted": 20,
  "file.modified": 30,
  "cmd.failed": 40,
  "cmd.run": 50,
  "file.read": 60,
  "todo.state": 70,
  "plan.state": 70,
  "git.state": 80,
  note: 90,
};

const SUMMED_ATTRS = new Set(["edits", "reads", "runs", "count"]);

function assertWellFormedString(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Unpaired surrogate is not valid canonical text");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Unpaired surrogate is not valid canonical text");
    }
  }
  return value.normalize("NFC");
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  const a = Array.from(left, (character) => character.codePointAt(0) as number);
  const b = Array.from(right, (character) => character.codePointAt(0) as number);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

function decimalInteger(value: number): string {
  if (Object.is(value, -0) || value === 0) return "0";
  const text = String(value);
  const exponentIndex = text.search(/[eE]/);
  if (exponentIndex < 0) return text;

  const mantissa = text.slice(0, exponentIndex);
  const exponent = Number(text.slice(exponentIndex + 1));
  const sign = mantissa.startsWith("-") ? "-" : "";
  const unsigned = sign ? mantissa.slice(1) : mantissa;
  const point = unsigned.indexOf(".");
  const digits = point < 0 ? unsigned : unsigned.slice(0, point) + unsigned.slice(point + 1);
  const decimalPosition = (point < 0 ? unsigned.length : point) + exponent;

  if (decimalPosition <= 0) return `${sign}0.${"0".repeat(-decimalPosition)}${digits}`;
  if (decimalPosition >= digits.length) return `${sign}${digits}${"0".repeat(decimalPosition - digits.length)}`;
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

function canonicalizeValue(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(assertWellFormedString(value));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new TypeError("Canonical numbers must be finite integers");
    }
    return decimalInteger(value);
  }
  if (typeof value === "undefined") throw new TypeError("undefined is not canonical");
  if (typeof value !== "object") throw new TypeError("Unsupported canonical value");
  if (stack.has(value)) throw new TypeError("Circular canonical value");
  stack.add(value);

  let result: string;
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      items.push(canonicalizeValue(value[index], stack));
    }
    result = `[${items.join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      stack.delete(value);
      throw new TypeError("Unsupported canonical object");
    }
    const keys = Object.keys(value);
    const normalized = new Map<string, string>();
    for (const key of keys) {
      const normalizedKey = assertWellFormedString(key);
      if (normalized.has(normalizedKey)) {
        stack.delete(value);
        throw new TypeError(`NFC key collision for ${normalizedKey}`);
      }
      normalized.set(normalizedKey, key);
    }
    const ordered = [...normalized.keys()].sort(compareCodePoints);
    result = `{${ordered
      .map((key) => `${JSON.stringify(key)}:${canonicalizeValue((value as Record<string, unknown>)[normalized.get(key) as string], stack)}`)
      .join(",")}}`;
  }
  stack.delete(value);
  return result;
}

/** Encode a canonical JSON value without locale, clock, or host state. */
export function canonicalize(value: unknown): string {
  return canonicalizeValue(value, new Set<object>());
}

function firstEvidenceLine(fact: Fact): number {
  if (fact.evidence.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...fact.evidence.map((entry) => entry.line));
}

function factTieBreak(fact: Fact): string {
  return canonicalize({
    attrs: fact.attrs,
    evidence: fact.evidence,
    key: fact.key,
    scope: fact.scope ?? null,
    snippet: fact.snippet,
    unbacked: fact.unbacked,
  });
}

function factComparator(left: Fact, right: Fact): number {
  const priority = FACT_PRIORITIES[left.kind] - FACT_PRIORITIES[right.kind];
  if (priority !== 0) return priority;
  const kind = compareCodePoints(left.kind, right.kind);
  if (kind !== 0) return kind;
  const key = compareCodePoints(left.key, right.key);
  if (key !== 0) return key;
  const entry = left.at.entry - right.at.entry;
  if (entry !== 0) return entry;
  const line = firstEvidenceLine(left) - firstEvidenceLine(right);
  if (line !== 0) return line;
  return compareCodePoints(factTieBreak(left), factTieBreak(right));
}

export function sortFacts(facts: readonly Fact[]): Fact[] {
  for (const fact of facts) {
    if (!(fact.kind in FACT_PRIORITIES)) throw new TypeError(`Unknown fact kind: ${String(fact.kind)}`);
  }
  return [...facts].sort(factComparator);
}

function occurrenceOrder(fact: Fact): [number, number, string] {
  return [fact.at.entry, firstEvidenceLine(fact), factTieBreak(fact)];
}

function compareOccurrence(left: Fact, right: Fact): number {
  const a = occurrenceOrder(left);
  const b = occurrenceOrder(right);
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return compareCodePoints(a[2], b[2]);
}

function mergeGroup(group: readonly Fact[]): Fact {
  const ordered = [...group].sort(compareOccurrence);
  const earliest = ordered[0];
  const attrs: Record<string, CanonicalValue> = {};
  const attrNames = new Set<string>();
  for (const fact of ordered) for (const name of Object.keys(fact.attrs)) attrNames.add(name);

  for (const name of [...attrNames].sort(compareCodePoints)) {
    const values = ordered.filter((fact) => Object.prototype.hasOwnProperty.call(fact.attrs, name)).map((fact) => fact.attrs[name]);
    if (SUMMED_ATTRS.has(name)) {
      if (values.every((value) => typeof value === "number" && Number.isFinite(value) && Number.isInteger(value))) {
        attrs[name] = values.reduce<number>((sum, value) => sum + (value as number), 0);
        continue;
      }
    }
    if (name === "tools" && values.every(Array.isArray)) {
      const tools = new Map<string, string>();
      for (const value of values as CanonicalValue[][]) {
        for (const item of value) {
          if (typeof item !== "string") continue;
          const normalized = assertWellFormedString(item);
          tools.set(normalized, normalized);
        }
      }
      attrs[name] = [...tools.keys()].sort(compareCodePoints);
      continue;
    }
    const latestWithField = [...ordered].reverse().find((fact) => Object.prototype.hasOwnProperty.call(fact.attrs, name));
    if (latestWithField) attrs[name] = latestWithField.attrs[name];
  }

  const evidence = [...ordered.flatMap((fact) => fact.evidence)]
    .map((entry) => ({ line: entry.line, sha256: assertWellFormedString(entry.sha256) }))
    .sort((left, right) => left.line - right.line || compareCodePoints(left.sha256, right.sha256))
    .filter((entry, index, all) => index === 0 || entry.line !== all[index - 1].line || entry.sha256 !== all[index - 1].sha256)
    .slice(0, 5);
  const snippet = ordered.map((fact) => fact.snippet).find((value) => value.length > 0) ?? "";

  return {
    kind: earliest.kind,
    key: earliest.key,
    ...(earliest.scope === undefined ? {} : { scope: earliest.scope }),
    at: earliest.at,
    attrs,
    evidence,
    snippet,
    unbacked: ordered.some((fact) => fact.unbacked),
  };
}

export function mergeFacts(facts: readonly Fact[]): Fact[] {
  const groups = new Map<string, Fact[]>();
  for (const fact of facts) {
    if (!(fact.kind in FACT_PRIORITIES)) throw new TypeError(`Unknown fact kind: ${fact.kind}`);
    const groupKey = `${fact.kind}\u0000${fact.key}`;
    const group = groups.get(groupKey);
    if (group) group.push(fact);
    else groups.set(groupKey, [fact]);
  }
  return sortFacts([...groups.values()].map((group) => mergeGroup(group)));
}

interface ParsedUri {
  readonly scheme: string;
  readonly path: string;
  readonly suffix: string;
}

function parseUri(input: string): ParsedUri | null {
  if (/^[A-Za-z]:[\\/]/.test(input)) return null;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(input);
  if (!match) return null;
  const scheme = match[1];
  const rest = match[2];
  let remainder = rest;
  if (remainder.startsWith("//")) {
    const authority = remainder.slice(2);
    const authorityEnd = authority.search(/[/?#]/);
    remainder = authorityEnd < 0 ? "" : authority.slice(authorityEnd);
  }
  const suffixStart = remainder.search(/[?#]/);
  if (suffixStart < 0) return { scheme, path: remainder, suffix: "" };
  return { scheme, path: remainder.slice(0, suffixStart), suffix: remainder.slice(suffixStart) };
}

function nonFileUri(parsed: ParsedUri): string {
  const scheme = assertWellFormedString(parsed.scheme).toLowerCase();
  const path = assertWellFormedString(parsed.path).normalize("NFC");
  const suffix = assertWellFormedString(parsed.suffix).normalize("NFC");
  return `${scheme}:${path}${suffix}`;
}

function slash(input: string): string {
  return input.replaceAll("\\", "/");
}

function lexicalNormalize(input: string): string {
  const value = slash(input);
  const drive = /^[A-Za-z]:/.test(value) ? value.slice(0, 2) : "";
  const absolute = value.startsWith("/") || drive.length > 0;
  const body = drive ? value.slice(2) : value;
  const segments = body.split("/");
  const output: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (output.length > 0 && output[output.length - 1] !== "..") output.pop();
      else if (!absolute) output.push("..");
      continue;
    }
    output.push(segment);
  }
  const joined = output.join("/");
  if (drive) return `${drive}/${joined}`.replace(/\/$/, "");
  if (absolute) return `/${joined}`.replace(/\/$/, "") || "/";
  return joined;
}

function joinLexical(base: string, input: string): string {
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(input)) return lexicalNormalize(input);
  return lexicalNormalize(`${base}/${input}`);
}

function pathWithin(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}

function relativeTo(path: string, root: string): string {
  if (path === root) return ".";
  return path.slice(root.endsWith("/") ? root.length : root.length + 1);
}

function dirnameAsSupplied(input: string): string {
  const index = Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\"));
  return index < 0 ? "." : input.slice(0, index) || (/^[\\/]/.test(input) ? input.slice(0, 1) : ".");
}

function basenameLexical(input: string): string {
  const value = lexicalNormalize(input);
  const index = value.lastIndexOf("/");
  return value.slice(index + 1) || ".";
}

function normalizeFilesystemPath(input: string, options: PathNormalizationOptions, externalIdentityInput = input): NormalizedPath {
  const raw = slash(input);
  const absolute = joinLexical(options.cwd, raw);
  const suppliedRoots = [
    ...(options.scopeRoots ?? []),
    ...(options.repoRoot ? [{ root: options.repoRoot, scope: "repo" as const }] : []),
    { root: options.cwd, scope: "cwd" as const },
  ];
  const scopeRank = (scope: "repo" | "cwd" | "granted"): number => scope === "repo" ? 0 : scope === "cwd" ? 1 : 2;
  const deduped = new Map<string, { root: (typeof suppliedRoots)[number]; normalized: string }>();
  for (const root of suppliedRoots) {
    const normalized = joinLexical(options.cwd, root.root);
    const current = deduped.get(normalized);
    if (!current || scopeRank(root.scope) < scopeRank(current.root.scope) ||
      (scopeRank(root.scope) === scopeRank(current.root.scope) && compareCodePoints(root.root, current.root.root) < 0)) {
      deduped.set(normalized, { root, normalized });
    }
  }
  const roots = [...deduped.values()];
  const matching = roots
    .filter((root) => pathWithin(absolute, root.normalized))
    .sort((left, right) => scopeRank(left.root.scope) - scopeRank(right.root.scope) ||
      right.normalized.length - left.normalized.length || compareCodePoints(left.root.root, right.root.root))[0];
  if (matching) {
    const relative = relativeTo(absolute, matching.normalized);
    if (relative === "." || relative.length === 0) throw new TypeError("A scope-root-only path has no relative key");
    return { path: assertWellFormedString(relative), scope: matching.root.scope };
  }

  const externalRoot = dirnameAsSupplied(externalIdentityInput);
  const scopeId = sha256Hex(externalRoot).slice(0, 12);
  return { path: `${scopeId}:${assertWellFormedString(basenameLexical(raw))}`, scope: "external" };
}

function pathTokenBoundary(input: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s"'`(){}\u005b\u005d,;|&<>=$:]/.test(input[index - 1]);
}

function pathTokenEnd(input: string, start: number): number {
  const quote = start > 0 && (input[start - 1] === "'" || input[start - 1] === '"') ? input[start - 1] : null;
  for (let index = start; index < input.length; index += 1) {
    const character = input[index];
    if (quote !== null) {
      if (character === quote) return index;
      continue;
    }
    if (/[\s"'`(){}\u005b\u005d,;|&<>]/.test(character)) return index;
  }
  return input.length;
}

const NON_FILE_URI_SCHEMES = new Set(["xd", "skill", "ssh", "http", "https", "ftp", "sftp", "git"]);

function pathCandidateAt(input: string, index: number): { end: number; value: string } | null {
  if (!pathTokenBoundary(input, index)) return null;
  const rest = input.slice(index);
  const isDrivePath = /^[A-Za-z]:[\\/]/.test(rest);
  const isUncPath = /^\\\\|^\/\//.test(rest);
  const isPosixPath = rest.startsWith("/") && !rest.startsWith("//");
  const uriScheme = /^([A-Za-z][A-Za-z0-9+.-]*):(?=\/|\\)/.exec(rest);
  const isUri = uriScheme !== null && (rest.startsWith(`${uriScheme[1]}://`) || uriScheme[1].toLowerCase() === "file" || NON_FILE_URI_SCHEMES.has(uriScheme[1].toLowerCase()));
  const isScpPath = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+:(?=\/|\\)/.test(rest);
  const isTildePath = /^~(?:[A-Za-z0-9._-]+)?[\\/]/.test(rest);
  if (!isDrivePath && !isUncPath && !isPosixPath && !isUri && !isScpPath && !isTildePath) return null;
  const end = pathTokenEnd(input, index);
  return { end, value: input.slice(index, end) };
}

function sanitizePathToken(value: string, options: PathNormalizationOptions): string {
  // `~/...` and `~user/...` are home paths even though they are not absolute in POSIX syntax.
  // Treat it as an opaque filesystem path so the username cannot become a basename
  // of the public representation's scope text.
  const canonicalUri = /^([A-Za-z][A-Za-z0-9+.-]*):\/(?!\/)/.exec(value);
  if (canonicalUri && NON_FILE_URI_SCHEMES.has(canonicalUri[1].toLowerCase())) {
    return normalizePath(value, options).path;
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) return normalizePath(value, options).path;
  const scpPath = value.includes("://") ? null : /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+:([\\/].*)$/s.exec(value);
  if (scpPath) {
    const prefix = value.slice(0, value.indexOf(":")).toLowerCase();
    if (!value.includes("@") && !["enoent", "error", "fatal", "warning", "permission"].includes(prefix)) throw new TypeError("Ambiguous host path");
    return normalizePath(scpPath[1], options).path;
  }
  const pathInput = /^~(?:[A-Za-z0-9._-]+)?[\\/]/.test(value)
    ? `/${value.startsWith("~/") || value.startsWith("~\\") ? value.slice(2) : value.slice(1)}`
    : value;
  return normalizePath(pathInput, options).path;
}

/**
 * Replace filesystem paths and URI authorities embedded in transcript text with
 * the same relative/opaque representation used by normalizePath. A null result
 * means the text contained a path-like value that could not be represented safely.
 */
export function sanitizeText(input: string, options: PathNormalizationOptions): string | null {
  try {
    const normalized = assertWellFormedString(input);
    let output = "";
    let index = 0;
    while (index < normalized.length) {
      const candidate = pathCandidateAt(normalized, index);
      if (candidate === null) {
        output += normalized[index];
        index += 1;
        continue;
      }
      output += sanitizePathToken(candidate.value, options);
      index = candidate.end;
    }
    return output;
  } catch {
    return null;
  }
}

function utf8(input: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = input.charCodeAt(++index);
      const point = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
      bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

function sha256Hex(input: string): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = utf8(input);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let shift = 7; shift >= 0; shift -= 1) bytes.push(Math.floor(bitLength / 2 ** (shift * 8)) & 0xff);
  let hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64).fill(0);
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      words[index] = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const smallSigma0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const smallSigma1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      words[index] = (words[index - 16] + smallSigma0 + words[index - 7] + smallSigma1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + bigSigma1 + choose + constants[index] + words[index]) | 0;
      const bigSigma0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    hash = hash.map((value, index) => (value + [a, b, c, d, e, f, g, h][index]) | 0);
  }
  return hash.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}

export function normalizePath(input: string, options: PathNormalizationOptions): NormalizedPath {
  assertWellFormedString(input);
  const parsed = parseUri(input);
  if (parsed && parsed.scheme.toLowerCase() !== "file") return { path: nonFileUri(parsed), scope: "uri" };
  if (parsed) {
    let filePath = parsed.path;
    if (filePath.length === 0) throw new TypeError("A file URI must contain a path");
    if (/^\/[A-Za-z]:[\\/]/.test(filePath)) filePath = filePath.slice(1);
    return normalizeFilesystemPath(filePath, options, input);
  }
  return normalizeFilesystemPath(input, options);
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]|\u001B[@-_])/g;

export function normalizeCommand(input: string, options?: PathNormalizationOptions): string | null {
  const stripped = assertWellFormedString(input).replace(ANSI_ESCAPE, "");
  const safe = options === undefined ? stripped : sanitizeText(stripped, options);
  if (safe === null) return null;
  const clean = safe.trim().replace(/[ \t]+/g, " ");
  if (clean.length === 0) return null;
  if (Array.from(clean).length <= 512) return clean;
  const characters = Array.from(clean);
  let end = 511;
  let boundary = -1;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (characters[index] === " " || characters[index] === "\t") {
      boundary = index;
      break;
    }
  }
  if (boundary > 0) end = boundary;
  return `${characters.slice(0, end).join("").trimEnd()}…`;
}

const ERROR_CLASSES: Array<[ErrorClass, readonly string[]]> = [
  ["permission", ["permission", "eacces", "eperm", "access denied", "not permitted"]],
  ["not_found", ["not found", "enoent", "no such file", "cannot find"]],
  ["timeout", ["timeout", "timed out", "deadline exceeded"]],
  ["connection", ["connection", "connect", "econn", "network", "socket", "refused"]],
  ["syntax", ["syntax", "parse error", "unexpected token"]],
  ["type", ["typeerror", "type error", "invalid type"]],
  ["assertion", ["assertion", "assert"]],
  ["quota", ["quota", "rate limit", "too many requests"]],
  ["conflict", ["conflict", "already exists", "eexist"]],
  ["cancelled", ["cancel", "cancelled", "aborted", "abort", "interrupt"]],
];

function errorClass(message: string, hint?: ErrorClass): ErrorClass {
  if (hint && Object.prototype.hasOwnProperty.call(FACT_ERROR_CLASSES, hint)) return hint;
  const lower = message.toLowerCase().trim();
  for (const [kind, prefixes] of ERROR_CLASSES) if (prefixes.some((prefix) => lower.startsWith(prefix))) return kind;
  return "unknown";
}

const FACT_ERROR_CLASSES: Record<ErrorClass, true> = {
  permission: true, not_found: true, timeout: true, connection: true, syntax: true, type: true,
  assertion: true, quota: true, conflict: true, cancelled: true, unknown: true,
};

function normalizeErrorMessage(message: string, options?: PathNormalizationOptions): string {
  let value = assertWellFormedString(message).normalize("NFC");
  if (options !== undefined) {
    const safe = sanitizeText(value, options);
    if (safe === null) return "<opaque>";
    value = safe;
  }
  value = value.replace(/(?:[A-Za-z]:[\\/]|~[\\/]|\/(?:[^\s/]+[\\/])+)[^\s]*/g, "<path>");
  value = value.replace(/\b(?:0x)?[0-9a-f]{8,}\b/gi, "<hex>");
  value = value.replace(/(["'“”‘’])(?:(?!\1).)*\1/g, '"…"');
  value = value.replace(/\b(?:line|column|col)\s*[:#]?\s*\d+\b/gi, (part) => part.replace(/\d+/g, "N"));
  value = value.replace(/:\d+(?::\d+)?\b/g, (part) => part.replace(/\d+/g, "N"));
  value = value.replace(/\d{2,}/g, "N");
  return value.replace(/[ \t\r\n]+/g, " ").trim();
}

export function errorSignature(message: string, classHint?: ErrorClass, options?: PathNormalizationOptions): string {
  const kind = errorClass(message, classHint);
  const signature = `${kind}:${normalizeErrorMessage(message, options)}`;
  return Array.from(signature).slice(0, 200).join("");
}
