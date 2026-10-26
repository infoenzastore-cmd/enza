import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateOrder } from '../settlement.js';
import { amountToUnits } from '../payment.js';

test('allocations reconcile exactly to gross amount using integer stroops', () => {
  const result = allocateOrder({
    totalAmount: '100.0000000',
    vendors: [{ vendorId: 'maker-a', bps: 5500 }, { vendorId: 'maker-b', bps: 2500 }, { vendorId: 'maker-c', bps: 1000 }],
    platformFeeBps: 1000
  });
  assert.deepEqual(result.allocations.map(x => x.amount), ['55.0000000', '25.0000000', '10.0000000', '10.0000000']);
  assert.equal(result.allocations.reduce((sum, x) => sum + amountToUnits(x.amount), 0n), amountToUnits(result.totalAmount));
});

test('largest-remainder rounding is deterministic and conserves every stroop', () => {
  const input = { totalAmount: '0.0000002', vendors: [{ vendorId: 'a', bps: 3333 }, { vendorId: 'b', bps: 3333 }], platformFeeBps: 3334 };
  const first = allocateOrder(input);
  const second = allocateOrder(input);
  assert.deepEqual(first, second);
  assert.equal(first.allocations.reduce((sum, x) => sum + amountToUnits(x.amount), 0n), 2n);
  assert.equal(first.allocations.length, 3);
});

test('rejects invalid percentages and duplicate vendor identifiers', () => {
  assert.throws(() => allocateOrder({ totalAmount: '10', vendors: [{ vendorId: 'a', bps: 9000 }], platformFeeBps: 500 }));
  assert.throws(() => allocateOrder({ totalAmount: '10', vendors: [{ vendorId: 'a', bps: 5000 }, { vendorId: 'a', bps: 4000 }], platformFeeBps: 1000 }));
  assert.throws(() => allocateOrder({ totalAmount: '10', vendors: [{ vendorId: 'a', bps: -1 }], platformFeeBps: 10001 }));
});

test('rejects zero-value orders and missing vendor allocations', () => {
  assert.throws(() => allocateOrder({ totalAmount: '0', vendors: [{ vendorId: 'a', bps: 9000 }], platformFeeBps: 1000 }));
  assert.throws(() => allocateOrder({ totalAmount: '10', vendors: [], platformFeeBps: 10000 }));
});
