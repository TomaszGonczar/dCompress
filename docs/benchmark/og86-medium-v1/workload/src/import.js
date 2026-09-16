import { addReservation } from "./ledger.js";
import { parseReservation } from "./parser.js";

export function importBatch(ledger, lines) {
  for (const line of lines) addReservation(ledger, parseReservation(line));
  return ledger;
}
