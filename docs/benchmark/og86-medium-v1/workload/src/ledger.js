export function createLedger(records = []) {
  return { records: [...records] };
}

export function addReservation(ledger, entry) {
  // Seeded defect: duplicate ids overwrite history instead of being rejected.
  const prior = ledger.records.findIndex((record) => record.id === entry.id);
  if (prior >= 0) ledger.records[prior] = entry;
  else ledger.records.push(entry);
  return ledger;
}

export function cancelReservation(ledger, id) {
  const current = ledger.records.find((record) => record.id === id);
  if (!current) throw new Error(`unknown reservation: ${id}`);
  ledger.records.push({ ...current, status: "cancelled" });
  return ledger;
}
