export function reservation(id, guest, cents, status = "active") {
  if (!id || !guest) throw new TypeError("id and guest are required");
  if (!Number.isSafeInteger(cents) || cents < 0) throw new TypeError("cents must be a non-negative integer");
  if (status !== "active" && status !== "cancelled") throw new TypeError("invalid reservation status");
  return { id, guest, cents, status };
}
