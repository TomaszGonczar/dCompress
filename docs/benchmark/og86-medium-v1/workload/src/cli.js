import { readFileSync } from "node:fs";
import { createLedger } from "./ledger.js";
import { importBatch } from "./import.js";
import { report } from "./report.js";

export function run(argv, io = console) {
  const path = argv[0];
  if (!path) throw new Error("usage: reservation-ledger <file>");
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const ledger = importBatch(createLedger(), lines);
  io.log(JSON.stringify(report(ledger)));
  return 0;
}
