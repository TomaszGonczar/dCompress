import { readFileSync } from "node:fs";

export function normalize(value) {
  return String(value ?? "")
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/[\t\r\n ]+/g, " ")
    .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fieldText(response, field) {
  const parts = field.split(".");
  let values = [response];
  for (const part of parts) {
    values = values.flatMap((value) => {
      if (Array.isArray(value)) return value.flatMap((item) => item && typeof item === "object" ? [item[part]] : []);
      return value && typeof value === "object" ? [value[part]] : [];
    }).filter((value) => value !== undefined);
  }
  return normalize(values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
}

export function score(atoms, response, checkpoint) {
  const eligible = atoms.filter((atom) => atom.availableAfterCheckpoint <= checkpoint);
  const rows = eligible.map((atom) => {
    const text = fieldText(response, atom.responseField);
    const contradiction = atom.contradictions.some((phrase) => text.includes(normalize(phrase)));
    const exact = atom.accepted.some((alternative) => alternative.every((phrase) => text.includes(normalize(phrase))));
    const partial = atom.partial.some((phrase) => text.includes(normalize(phrase)));
    const outcome = contradiction ? "contradiction" : exact ? "exact" : partial ? "partial" : "missing";
    const points = outcome === "exact" ? 1 : outcome === "partial" ? 0.5 : 0;
    return { id: atom.id, category: atom.category, outcome, points, critical: atom.continuationCritical };
  });
  const points = rows.reduce((sum, row) => sum + row.points, 0);
  const byCategory = Object.fromEntries([...new Set(rows.map((row) => row.category))].sort().map((category) => {
    const selected = rows.filter((row) => row.category === category);
    return [category, {
      points: selected.reduce((sum, row) => sum + row.points, 0),
      total: selected.length,
      exact: selected.filter((row) => row.outcome === "exact").length,
    }];
  }));
  return {
    checkpoint,
    points,
    denominator: rows.length,
    recall: rows.length === 0 ? 0 : points / rows.length,
    exact: rows.filter((row) => row.outcome === "exact").length,
    partial: rows.filter((row) => row.outcome === "partial").length,
    missing: rows.filter((row) => row.outcome === "missing").length,
    falseFacts: rows.filter((row) => row.outcome === "contradiction").length,
    criticalExact: rows.filter((row) => row.critical).every((row) => row.outcome === "exact"),
    byCategory,
    rows,
  };
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0 || argv[index + 1] === undefined) throw new Error(`${flag} is required`);
  return argv[index + 1];
}

if (process.argv[1]?.endsWith("score-og86.mjs")) {
  const atoms = JSON.parse(readFileSync(valueAfter(process.argv, "--atoms"), "utf8"));
  const response = JSON.parse(readFileSync(valueAfter(process.argv, "--response"), "utf8"));
  const checkpoint = Number(valueAfter(process.argv, "--checkpoint"));
  if (!Number.isInteger(checkpoint) || checkpoint < 1 || checkpoint > 4) throw new Error("checkpoint must be 1..4");
  process.stdout.write(`${JSON.stringify(score(atoms, response, checkpoint), null, 2)}\n`);
}
