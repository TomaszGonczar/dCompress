import { reservation } from "./types.js";

export function parseReservation(line) {
  const [id, guest, amount, status = "active"] = line.split("|");
  // Seeded defect: floating-point multiplication is not exact integer-cent parsing.
  const cents = Number(amount) * 100;
  return reservation(id, guest, cents, status);
}
