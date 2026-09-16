import { addReservation, cancelReservation, createLedger } from "./ledger.js";

export function replay(events) {
  const ledger = createLedger();
  for (const event of events) {
    if (event.type === "reserved") addReservation(ledger, event.reservation);
    else if (event.type === "cancelled") cancelReservation(ledger, event.id);
  }
  return ledger;
}
