import { amountToUnits, unitsToAmount } from './payment.js';

const BPS = 10_000;

/**
 * Deterministically allocate a gross order amount using basis points.
 * No transfer is performed here; this is a calculation/preview only.
 * Any rounding remainder is assigned by largest fractional remainder,
 * with the original allocation order as a stable tie-breaker.
 */
export function allocateOrder({ totalAmount, vendors, platformFeeBps }) {
  if (!Array.isArray(vendors) || vendors.length === 0) {
    throw new Error('At least one vendor allocation is required');
  }
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > BPS) {
    throw new Error('Invalid platform fee basis points');
  }

  const seen = new Set();
  const entries = vendors.map((vendor, index) => {
    if (!vendor || typeof vendor.vendorId !== 'string' || !vendor.vendorId.trim()) {
      throw new Error('Vendor ID is required');
    }
    if (seen.has(vendor.vendorId)) throw new Error('Duplicate vendor ID');
    seen.add(vendor.vendorId);
    if (!Number.isInteger(vendor.bps) || vendor.bps < 0 || vendor.bps > BPS) {
      throw new Error('Invalid vendor basis points');
    }
    return { id: vendor.vendorId, bps: vendor.bps, index, kind: 'vendor' };
  });

  const totalBps = entries.reduce((sum, entry) => sum + entry.bps, platformFeeBps);
  if (totalBps !== BPS) throw new Error('Vendor allocations plus platform fee must equal 10000 bps');

  entries.push({ id: 'platform', bps: platformFeeBps, index: entries.length, kind: 'platform' });
  const grossUnits = amountToUnits(totalAmount);
  if (grossUnits <= 0n) throw new Error('Order amount must be positive');

  let allocated = 0n;
  const calculated = entries.map(entry => {
    const numerator = grossUnits * BigInt(entry.bps);
    const units = numerator / BigInt(BPS);
    allocated += units;
    return { ...entry, units, remainder: numerator % BigInt(BPS) };
  });

  let remaining = grossUnits - allocated;
  const remainderOrder = [...calculated].sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });
  for (let i = 0; remaining > 0n; i++, remaining--) {
    remainderOrder[i % remainderOrder.length].units += 1n;
  }

  const allocations = calculated.map(({ id, kind, bps, units }) => ({
    id, kind, bps, amount: unitsToAmount(units)
  }));
  const sumUnits = allocations.reduce((sum, item) => sum + amountToUnits(item.amount), 0n);
  if (sumUnits !== grossUnits) throw new Error('Allocation reconciliation failed');

  return { totalAmount: unitsToAmount(grossUnits), allocations };
}
