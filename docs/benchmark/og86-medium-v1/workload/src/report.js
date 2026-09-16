export function activeRevenue(ledger) {
  // Seeded defect for phase 3: superseded and cancelled rows are both counted.
  return ledger.records.reduce((sum, record) => sum + record.cents, 0);
}

export function report(ledger) {
  return { rows: ledger.records.length, activeRevenueCents: activeRevenue(ledger) };
}
